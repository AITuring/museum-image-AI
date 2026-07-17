import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import uuid4
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, inspect, or_, select, text
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.db import Base, SessionLocal, engine, get_db
from app.exif_utils import extract_exif_metadata, update_image_exif_metadata
from app.google_photos import (
    build_google_photos_auth_url,
    build_google_photos_status,
    clear_google_photos_token,
    create_google_photos_picker_session,
    current_google_photos_config,
    delete_google_photos_picker_session,
    download_google_photos_image,
    exchange_google_photos_code,
    get_google_photos_media_items_by_ids,
    get_google_photos_picker_session,
    google_photos_enabled,
    list_google_photos_media_items,
    save_google_photos_config,
)
from app.models import (
    Artifact,
    ArtifactExhibition,
    ArtifactImage,
    ArtifactTag,
    EraOption,
    Exhibition,
    Museum,
    PendingArtifact,
)
from app.reference_data import WENWU_ERA_OPTIONS, WENWU_MUSEUM_OPTIONS
from app.reference_data import WENWU_MUSEUM_COORDINATES
from app.oss import upload_image
from app.schemas import (
    ArtifactCreate,
    ArtifactDescriptionCandidateRead,
    ArtifactDescriptionGenerateRead,
    ArtifactDescriptionGenerateRequest,
    ArtifactImageAttach,
    ArtifactMatchRead,
    ArtifactImageRead,
    ArtifactRead,
    ArtifactUpdate,
    BatchIdentifyRequest,
    BatchScanRequest,
    BatchScanResponse,
    CloudArtifactSubmitRequest,
    EraOptionRead,
    ExifArtifactSubmitRequest,
    ExhibitionCreate,
    ExhibitionRead,
    GooglePhotosAuthStartRead,
    GooglePhotosConfigRead,
    GooglePhotosConfigUpdate,
    GooglePhotosImportRead,
    GooglePhotosImportRequest,
    GooglePhotosMediaListRead,
    GooglePhotosPickerSessionCreate,
    GooglePhotosPickerSessionRead,
    GooglePhotosStatusRead,
    HealthRead,
    MuseumCreate,
    MuseumRead,
    MuseumUpdate,
    ParsedArtifactNameRead,
    PendingArtifactRead,
    PendingArtifactSubmitResult,
    PendingArtifactSubmitRequest,
    PendingArtifactUpdate,
    WebBridgeLoginStartRead,
    WebBridgeStatusRead,
    UploadedImageRead,
    VisionAnalyzeRequest,
    VisionAnalyzeResponse,
)
from app.vision import (
    generate_artifact_description,
    generate_artifact_descriptions_parallel,
    get_enabled_providers,
    request_provider_analysis,
    stream_provider_analysis,
)
from app.web_bridge import (
    build_web_bridge_status,
    enabled_sites,
    request_web_candidate,
    start_web_bridge_login,
)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff"}
EDIT_METHOD_OPTIONS = {"简单调整", "堆栈合成"}
ERA_TOKEN_CANDIDATES = [
    "新石器时代",
    "夏",
    "商",
    "西周",
    "东周",
    "春秋",
    "战国",
    "秦",
    "西汉",
    "东汉",
    "汉",
    "三国",
    "西晋",
    "东晋",
    "南北朝",
    "北朝",
    "北魏",
    "隋",
    "唐",
    "五代",
    "北宋",
    "南宋",
    "宋",
    "辽",
    "金",
    "元",
    "明",
    "清",
    "民国",
]
CATALOG_NO_PATTERN = re.compile(r"^[A-Za-z]{2,}[\-_]?\d{3,}$")
MUSEUM_SEGMENT_PATTERN = re.compile(r"(博物馆|纪念馆|美术馆|收藏|馆藏|藏)$")

logger = logging.getLogger("app.vision")

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path("/data") if Path("/data").exists() else BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
LEGACY_BATCH_IMPORTS_DIR = DATA_DIR / "batch_imports"


def report_debug_event(
    *,
    session_id: str,
    hypothesis_id: str,
    location: str,
    message: str,
    data: dict[str, object] | None = None,
    run_id: str = "pre-fix",
) -> None:
    default_url = "http://127.0.0.1:7777/event"
    if Path("/.dockerenv").exists():
        default_url = "http://host.docker.internal:7777/event"

    session_value = session_id
    for env_path in (
        BASE_DIR / ".dbg" / f"{session_id}.env",
        Path(".dbg") / f"{session_id}.env",
    ):
        try:
            if not env_path.exists():
                continue
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                if raw_line.startswith("DEBUG_SERVER_URL="):
                    configured_url = raw_line.split("=", 1)[1].strip()
                    if configured_url:
                        default_url = configured_url
                elif raw_line.startswith("DEBUG_SESSION_ID="):
                    configured_session = raw_line.split("=", 1)[1].strip()
                    if configured_session:
                        session_value = configured_session
        except Exception:
            continue

    if Path("/.dockerenv").exists() and "127.0.0.1:7777" in default_url:
        default_url = default_url.replace("127.0.0.1", "host.docker.internal")

    payload = {
        "sessionId": session_value,
        "runId": run_id,
        "hypothesisId": hypothesis_id,
        "location": location,
        "msg": message,
        "data": data or {},
    }

    try:
        import urllib.request

        request = urllib.request.Request(
            default_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(request, timeout=2).read()
    except Exception:
        return


@dataclass(slots=True)
class ArtifactMatchCandidate:
    artifact: Artifact
    score: float
    reason: str


def run_startup_migrations(connection) -> None:
    inspector = inspect(connection)
    table_names = set(inspector.get_table_names())

    if "museums" in table_names:
        museum_columns = {column["name"] for column in inspector.get_columns("museums")}
        museum_column_definitions = {
            "latitude": "DOUBLE PRECISION",
            "longitude": "DOUBLE PRECISION",
        }
        for column_name, column_type in museum_column_definitions.items():
            if column_name not in museum_columns:
                connection.execute(
                    text(f"ALTER TABLE museums ADD COLUMN {column_name} {column_type}")
                )

    if "artifacts" not in table_names:
        return

    artifact_columns = {column["name"] for column in inspector.get_columns("artifacts")}
    artifact_columns_lower = {column_name.lower() for column_name in artifact_columns}

    if "title" in artifact_columns and "name" not in artifact_columns:
        connection.execute(text("ALTER TABLE artifacts RENAME COLUMN title TO name"))
        artifact_columns.remove("title")
        artifact_columns.add("name")

    if "summary" in artifact_columns and "description" not in artifact_columns:
        connection.execute(text("ALTER TABLE artifacts RENAME COLUMN summary TO description"))
        artifact_columns.remove("summary")
        artifact_columns.add("description")

    if "name" not in artifact_columns:
        connection.execute(text("ALTER TABLE artifacts ADD COLUMN name VARCHAR(255)"))
        if "title" in artifact_columns:
            connection.execute(text("UPDATE artifacts SET name = title WHERE name IS NULL"))

    if "era" not in artifact_columns:
        connection.execute(text("ALTER TABLE artifacts ADD COLUMN era VARCHAR(255)"))

    if "description" not in artifact_columns:
        connection.execute(text("ALTER TABLE artifacts ADD COLUMN description TEXT"))
        if "summary" in artifact_columns:
            connection.execute(text("UPDATE artifacts SET description = summary WHERE description IS NULL"))

    if "unearthed_place" in artifact_columns_lower and "place_of_excavation" not in artifact_columns_lower:
        connection.execute(text('ALTER TABLE artifacts RENAME COLUMN unearthed_place TO "Place_of_Excavation"'))
        artifact_columns.remove("unearthed_place")
        artifact_columns.add("Place_of_Excavation")
        artifact_columns_lower.remove("unearthed_place")
        artifact_columns_lower.add("place_of_excavation")

    if "place_of_excavation" not in artifact_columns_lower:
        connection.execute(text('ALTER TABLE artifacts ADD COLUMN "Place_of_Excavation" VARCHAR(255)'))
        artifact_columns.add("Place_of_Excavation")
        artifact_columns_lower.add("place_of_excavation")

    if "unearthed_at" in artifact_columns_lower:
        connection.execute(
            text(
                """
                UPDATE artifacts
                SET "Place_of_Excavation" = unearthed_at
                WHERE "Place_of_Excavation" IS NULL
                  AND unearthed_at IS NOT NULL
                """
            )
        )

    refreshed_columns = {column["name"] for column in inspect(connection).get_columns("artifacts")}
    if "image_path" in refreshed_columns and "artifact_images" in set(inspect(connection).get_table_names()):
        connection.execute(
            text(
                """
                INSERT INTO artifact_images (artifact_id, url)
                SELECT artifacts.id, artifacts.image_path
                FROM artifacts
                WHERE artifacts.image_path IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM artifact_images
                    WHERE artifact_images.artifact_id = artifacts.id
                      AND artifact_images.url = artifacts.image_path
                  )
                """
            )
        )

    if "artifact_images" not in table_names:
        return

    artifact_image_columns = {
        column["name"] for column in inspect(connection).get_columns("artifact_images")
    }
    image_column_definitions = {
        "image_hash": "VARCHAR(64)",
        "source_hash": "VARCHAR(64)",
        "camera_model": "VARCHAR(255)",
        "lens_model": "VARCHAR(255)",
        "capture_museum_id": "INTEGER",
        "exhibition_id": "INTEGER",
        "capture_location": "VARCHAR(255)",
        "latitude": "DOUBLE PRECISION",
        "longitude": "DOUBLE PRECISION",
        "captured_at": "TIMESTAMP",
        "shutter_speed": "VARCHAR(64)",
        "aperture": "VARCHAR(64)",
        "iso": "INTEGER",
        "edit_method": "VARCHAR(32)",
    }
    for column_name, column_type in image_column_definitions.items():
        if column_name not in artifact_image_columns:
            connection.execute(
                text(f"ALTER TABLE artifact_images ADD COLUMN {column_name} {column_type}")
            )
    connection.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_images_image_hash "
            "ON artifact_images (image_hash)"
        )
    )
    connection.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_images_source_hash "
            "ON artifact_images (source_hash)"
        )
    )
    legacy_image_rows = connection.execute(
        text(
            """
            SELECT id, url
            FROM artifact_images
            WHERE image_hash IS NULL
              AND url IS NOT NULL
            ORDER BY id ASC
            """
        )
    ).mappings()
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        for row in legacy_image_rows:
            url = str(row["url"]).strip()
            if not url.startswith(("http://", "https://")):
                continue
            try:
                response = client.get(url)
                response.raise_for_status()
                connection.execute(
                    text(
                        """
                        UPDATE artifact_images
                        SET image_hash = :image_hash
                        WHERE id = :id
                          AND image_hash IS NULL
                        """
                    ),
                    {"id": row["id"], "image_hash": hash_bytes(response.content)},
                )
            except Exception as exc:  # noqa: BLE001 - keep startup resilient on legacy rows
                logger.warning("backfill image hash for artifact image %s failed: %s", row["id"], exc)

    if "pending_artifacts" not in table_names:
        return

    pending_columns = {
        column["name"] for column in inspect(connection).get_columns("pending_artifacts")
    }
    pending_columns_lower = {column_name.lower() for column_name in pending_columns}
    pending_column_definitions = {
        "image_blob": "BYTEA",
        "image_mime_type": "VARCHAR(128)",
        "camera_model": "VARCHAR(255)",
        "lens_model": "VARCHAR(255)",
        "Place_of_Excavation": "VARCHAR(255)",
        "capture_museum_name": "VARCHAR(255)",
        "exhibition_name": "VARCHAR(255)",
        "capture_location": "VARCHAR(255)",
        "latitude": "DOUBLE PRECISION",
        "longitude": "DOUBLE PRECISION",
        "captured_at": "TIMESTAMP",
        "shutter_speed": "VARCHAR(64)",
        "aperture": "VARCHAR(64)",
        "iso": "INTEGER",
        "edit_method": "VARCHAR(32)",
        "existing_artifact_id": "INTEGER",
    }
    for column_name, column_type in pending_column_definitions.items():
        if column_name.lower() not in pending_columns_lower:
            connection.execute(
                text(f'ALTER TABLE pending_artifacts ADD COLUMN "{column_name}" {column_type}')
            )
            pending_columns.add(column_name)
            pending_columns_lower.add(column_name.lower())

    if "unearthed_at" in pending_columns_lower and "place_of_excavation" in pending_columns_lower:
        connection.execute(
            text(
                """
                UPDATE pending_artifacts
                SET "Place_of_Excavation" = unearthed_at
                WHERE "Place_of_Excavation" IS NULL
                  AND unearthed_at IS NOT NULL
                """
            )
        )

    legacy_rows = connection.execute(
        text(
            """
            SELECT id, source_path, file_name
            FROM pending_artifacts
            WHERE image_blob IS NULL
              AND source_path LIKE :prefix
            """
        ),
        {"prefix": f"{LEGACY_BATCH_IMPORTS_DIR}%"},
    ).mappings()
    for row in legacy_rows:
        path = Path(row["source_path"])
        if not path.exists() or not path.is_file():
            continue
        mime_type = mimetypes.guess_type(row["file_name"])[0] or "image/jpeg"
        connection.execute(
            text(
                """
                UPDATE pending_artifacts
                SET image_blob = :image_blob,
                    image_mime_type = :image_mime_type,
                    source_path = :source_path
                WHERE id = :id
                """
            ),
            {
                "id": row["id"],
                "image_blob": path.read_bytes(),
                "image_mime_type": mime_type,
                "source_path": f"upload:{row['file_name']}",
            },
        )
        path.unlink(missing_ok=True)


def sync_reference_options(connection) -> None:
    for museum_name in WENWU_MUSEUM_OPTIONS:
        longitude, latitude = WENWU_MUSEUM_COORDINATES.get(museum_name, (None, None))
        connection.execute(
            text(
                """
                INSERT INTO museums (name, description, latitude, longitude)
                VALUES (:name, :description, :latitude, :longitude)
                ON CONFLICT (name) DO UPDATE
                SET latitude = CASE
                        WHEN museums.latitude IS NULL OR museums.longitude IS NULL THEN EXCLUDED.latitude
                        WHEN ABS(museums.latitude - :reversed_latitude) < 0.000001
                         AND ABS(museums.longitude - :reversed_longitude) < 0.000001 THEN EXCLUDED.latitude
                        ELSE museums.latitude
                    END,
                    longitude = CASE
                        WHEN museums.latitude IS NULL OR museums.longitude IS NULL THEN EXCLUDED.longitude
                        WHEN ABS(museums.latitude - :reversed_latitude) < 0.000001
                         AND ABS(museums.longitude - :reversed_longitude) < 0.000001 THEN EXCLUDED.longitude
                        ELSE museums.longitude
                    END
                """
            ),
            {
                "name": museum_name,
                "description": "从 wenwu.tsx 参考数据同步",
                "latitude": latitude,
                "longitude": longitude,
                "reversed_latitude": longitude,
                "reversed_longitude": latitude,
            },
        )

    for sort_order, era_name in enumerate(WENWU_ERA_OPTIONS, start=1):
        connection.execute(
            text(
                """
                INSERT INTO era_options (name, sort_order)
                VALUES (:name, :sort_order)
                ON CONFLICT (name) DO UPDATE
                SET sort_order = EXCLUDED.sort_order
                """
            ),
            {
                "name": era_name,
                "sort_order": sort_order,
            },
        )


@asynccontextmanager
async def lifespan(_: FastAPI):
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    with engine.begin() as connection:
        try:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        except Exception:
            pass
        Base.metadata.create_all(bind=connection)
        run_startup_migrations(connection)
        sync_reference_options(connection)
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.mount("/files", StaticFiles(directory=str(DATA_DIR)), name="files")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def artifact_detail_query():
    return select(Artifact).options(
        selectinload(Artifact.museum),
        selectinload(Artifact.tags),
        selectinload(Artifact.images),
        selectinload(Artifact.images).selectinload(ArtifactImage.capture_museum),
        selectinload(Artifact.images)
        .selectinload(ArtifactImage.exhibition)
        .selectinload(Exhibition.museum),
        selectinload(Artifact.exhibition_links)
        .selectinload(ArtifactExhibition.exhibition)
        .selectinload(Exhibition.museum),
    )


def artifact_image_query():
    return select(ArtifactImage).options(
        selectinload(ArtifactImage.artifact).selectinload(Artifact.museum),
        selectinload(ArtifactImage.capture_museum),
        selectinload(ArtifactImage.exhibition).selectinload(Exhibition.museum),
    )


def build_uploaded_file_url(filename: str) -> str:
    return f"/files/uploads/{filename}"


def resolve_uploaded_file_path(image_url: str) -> Path:
    if not image_url.startswith("/files/uploads/"):
        raise HTTPException(status_code=400, detail="仅支持提交本地上传后的图片。")
    relative_path = image_url.removeprefix("/files/").lstrip("/")
    file_path = DATA_DIR / relative_path
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=400, detail="上传图片已不存在，请重新上传后再提交。")
    return file_path


def ensure_museum(db: Session, museum_name: str) -> Museum:
    name = museum_name.strip()
    museum = db.scalar(select(Museum).where(Museum.name == name))
    if museum is not None:
        return museum
    museum = Museum(name=name, description="云端入库自动创建")
    db.add(museum)
    db.commit()
    db.refresh(museum)
    return museum


def ensure_exhibition(
    db: Session,
    museum: Museum,
    exhibition_name: str | None,
    start_at: datetime | None = None,
    end_at: datetime | None = None,
) -> Exhibition:
    name = optional_text(exhibition_name) or "常设"
    exhibition = db.scalar(
        select(Exhibition).where(
            Exhibition.museum_id == museum.id,
            Exhibition.name == name,
        )
    )
    if exhibition is not None:
        if exhibition.start_at is None and start_at is not None:
            exhibition.start_at = start_at
        if exhibition.end_at is None and end_at is not None:
            exhibition.end_at = end_at
        db.flush()
        return exhibition

    exhibition = Exhibition(
        museum_id=museum.id,
        name=name,
        start_at=start_at,
        end_at=end_at,
    )
    db.add(exhibition)
    db.flush()
    return exhibition


def parse_tags(raw: str | None) -> list[str]:
    text_value = (raw or "").strip()
    if not text_value:
        return []
    try:
        parsed = json.loads(text_value)
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
    except (ValueError, TypeError):
        pass
    return [tag.strip() for tag in text_value.split(",") if tag.strip()]


def merge_unique_tags(*tag_groups: list[str]) -> list[str]:
    merged: list[str] = []
    for group in tag_groups:
        for tag in group:
            cleaned = str(tag).strip()
            if cleaned and cleaned not in merged:
                merged.append(cleaned)
    return merged


def build_capture_tags(camera_model: str | None, lens_model: str | None) -> list[str]:
    tags: list[str] = []
    if camera_model and camera_model.strip():
        tags.append(f"机型:{camera_model.strip()}")
    if lens_model and lens_model.strip():
        tags.append(f"镜头:{lens_model.strip()}")
    return tags


def optional_text(value: str | None) -> str | None:
    text_value = (value or "").strip()
    return text_value or None


def normalize_place_of_excavation(value: str | None) -> str | None:
    return optional_text(value)


def normalize_identity_text(value: str | None) -> str | None:
    text_value = optional_text(value)
    return text_value.casefold() if text_value else None


def compact_artifact_name_for_match(value: str | None) -> str | None:
    text_value = optional_text(value)
    if text_value is None:
        return None
    compact = re.sub(
        r"[\s\-_·•,，.。:：;；/\\|()（）\[\]【】<>《》\"'“”‘’]+",
        "",
        text_value.casefold(),
    )
    return compact or None


def longest_common_subsequence_length(left: str, right: str) -> int:
    if not left or not right:
        return 0
    dp = [0] * (len(right) + 1)
    for left_char in left:
        prev = 0
        for index, right_char in enumerate(right, start=1):
            current = dp[index]
            if left_char == right_char:
                dp[index] = prev + 1
            else:
                dp[index] = max(dp[index], dp[index - 1])
            prev = current
    return dp[-1]


def artifact_name_match_score(source_name: str | None, candidate_name: str | None) -> float:
    source_compact = compact_artifact_name_for_match(source_name)
    candidate_compact = compact_artifact_name_for_match(candidate_name)
    if source_compact is None or candidate_compact is None:
        return 0.0
    if source_compact == candidate_compact:
        return 1.0

    shorter, longer = sorted(
        [source_compact, candidate_compact],
        key=len,
    )
    if len(shorter) < 3:
        return 0.0

    lcs_length = longest_common_subsequence_length(shorter, longer)
    shorter_ratio = lcs_length / len(shorter)
    longer_ratio = lcs_length / len(longer)
    if shorter_ratio < 0.66:
        return 0.0
    return round(shorter_ratio * 0.7 + longer_ratio * 0.3, 4)


def optional_float(value: str | float | None, field_name: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, float):
        return value
    text_value = value.strip()
    if not text_value:
        return None
    try:
        return float(text_value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} 格式不正确。") from exc


def optional_int(value: str | int | None, field_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    text_value = value.strip()
    if not text_value:
        return None
    try:
        return int(text_value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} 格式不正确。") from exc


def optional_datetime(value: str | datetime | None, field_name: str) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    text_value = value.strip()
    if not text_value:
        return None
    for normalizer in (lambda item: item, lambda item: item.replace("Z", "+00:00")):
        try:
            parsed = datetime.fromisoformat(normalizer(text_value))
            return parsed.replace(tzinfo=None) if parsed.tzinfo is not None else parsed
        except ValueError:
            continue
    raise HTTPException(status_code=400, detail=f"{field_name} 格式不正确。")


def normalize_edit_method(value: str | None) -> str | None:
    text_value = optional_text(value)
    if text_value is None:
        return None
    if text_value not in EDIT_METHOD_OPTIONS:
        raise HTTPException(status_code=400, detail="修图方式仅支持：简单调整、堆栈合成。")
    return text_value


def normalize_exhibition_name(value: str | None) -> str:
    return optional_text(value) or "常设"


def normalize_era_label(value: str | None) -> str | None:
    text_value = optional_text(value)
    if text_value is None:
        return None
    if text_value.startswith("五代十国"):
        return text_value
    for token in ERA_TOKEN_CANDIDATES:
        if text_value == token or text_value.startswith(token):
            if token.endswith(("代", "时期", "朝")):
                return token
            return f"{token}代"
    return text_value


def normalize_museum_segment(value: str) -> str:
    segment = value.strip()
    if not segment:
        return segment
    if segment.endswith("馆藏") and len(segment) > 2:
        return f"{segment[:-2]}馆"
    return segment


def parse_artifact_compound_name(raw_name: str) -> ParsedArtifactNameRead:
    original_name = raw_name.strip()
    if not original_name:
        raise HTTPException(status_code=400, detail="名称不能为空。")

    normalized_text = re.sub(r"\s+", " ", original_name)
    if Path(normalized_text).suffix.lower() in IMAGE_EXTENSIONS:
        normalized_text = str(Path(normalized_text).with_suffix(""))
    segments = [
        segment.strip()
        for segment in re.split(r"\s*[-_—–]+\s*", normalized_text)
        if segment.strip()
    ]

    era: str | None = None
    artifact_name: str | None = None
    museum_name: str | None = None
    place_of_excavation: str | None = None
    catalog_no: str | None = None
    remaining_segments: list[str] = []

    for segment in segments:
        normalized_era = normalize_era_label(segment)
        if era is None and (
            normalized_era in {normalize_era_label(token) for token in ERA_TOKEN_CANDIDATES}
            or segment.startswith("五代十国")
        ):
            era = normalized_era
            continue
        if catalog_no is None and CATALOG_NO_PATTERN.match(segment):
            catalog_no = segment
            continue
        if museum_name is None and MUSEUM_SEGMENT_PATTERN.search(segment):
            # #region debug-point D:parse-museum-segment
            report_debug_event(
                session_id="exif-submit-parse",
                hypothesis_id="D",
                location="main.py:parse-museum-segment",
                message="[DEBUG] museum segment matched",
                data={"raw_name": original_name, "segment": segment},
            )
            # #endregion
            museum_name = normalize_museum_segment(segment)
            # #region debug-point D:parse-museum-result
            report_debug_event(
                session_id="exif-submit-parse",
                hypothesis_id="D",
                location="main.py:parse-museum-result",
                message="[DEBUG] museum segment normalized",
                data={"segment": segment, "museum_name": museum_name},
            )
            # #endregion
            continue
        if place_of_excavation is None and ("出土" in segment or "墓" in segment or "遗址" in segment):
            place_of_excavation = segment
            continue
        remaining_segments.append(segment)

    if remaining_segments:
        artifact_name = remaining_segments[0]
        if place_of_excavation is None and len(remaining_segments) > 1:
            for segment in remaining_segments[1:]:
                if "年" in segment or "出土" in segment or "墓" in segment or "遗址" in segment:
                    place_of_excavation = segment
                    break

    normalized_parts = [part for part in [era, artifact_name, place_of_excavation, museum_name, catalog_no] if part]
    normalized_name = "-".join(normalized_parts) if normalized_parts else normalized_text

    return ParsedArtifactNameRead(
        original_name=original_name,
        normalized_name=normalized_name,
        era=era,
        artifact_name=artifact_name,
        museum_name=museum_name,
        Place_of_Excavation=place_of_excavation,
        catalog_no=catalog_no,
    )


def build_fallback_description(
    *,
    museum_name: str | None,
    name: str,
    era: str | None,
    Place_of_Excavation: str | None,
) -> str:
    fragments = [name]
    if era:
        fragments.append(f"时代为{era}")
    if Place_of_Excavation:
        fragments.append(f"{Place_of_Excavation}")
    if museum_name:
        fragments.append(f"现藏于{museum_name}")
    return "，".join(fragments) + "。"


def resolve_capture_context(
    db: Session,
    capture_museum_name: str | None,
    exhibition_name: str | None,
) -> tuple[Museum | None, Exhibition | None]:
    capture_museum = (
        ensure_museum(db, capture_museum_name)
        if optional_text(capture_museum_name)
        else None
    )
    exhibition = (
        ensure_exhibition(db, capture_museum, exhibition_name)
        if capture_museum is not None
        else None
    )
    return capture_museum, exhibition


def sync_artifact_links_and_tags(
    artifact: Artifact,
    subject_tags: list[str],
) -> None:
    capture_tags: list[str] = []
    exhibition_ids: set[int] = set()
    for image in artifact.images:
        capture_tags = merge_unique_tags(
            capture_tags,
            build_capture_tags(image.camera_model, image.lens_model),
        )
        if image.exhibition_id is not None:
            exhibition_ids.add(image.exhibition_id)

    merged_tags = merge_unique_tags(subject_tags, capture_tags)
    existing_tags = {tag.name: tag for tag in artifact.tags}
    artifact.tags = [
        existing_tags.get(tag_name) or ArtifactTag(name=tag_name)
        for tag_name in merged_tags
    ]

    existing_links = {
        link.exhibition_id: link for link in artifact.exhibition_links if link.exhibition_id is not None
    }
    artifact.exhibition_links = [
        existing_links.get(exhibition_id)
        or ArtifactExhibition(artifact_id=artifact.id, exhibition_id=exhibition_id)
        for exhibition_id in sorted(exhibition_ids)
    ]


def build_image_metadata(
    *,
    image_bytes: bytes | None = None,
    camera_model: str | None = None,
    lens_model: str | None = None,
    latitude: str | float | None = None,
    longitude: str | float | None = None,
    captured_at: str | datetime | None = None,
    shutter_speed: str | None = None,
    aperture: str | None = None,
    iso: str | int | None = None,
    edit_method: str | None = None,
) -> dict[str, object | None]:
    exif = extract_exif_metadata(image_bytes or b"")
    resolved_camera_model = optional_text(camera_model) or exif.camera_model
    resolved_lens_model = optional_text(lens_model) or exif.lens_model
    resolved_latitude = optional_float(latitude, "纬度")
    if resolved_latitude is None:
        resolved_latitude = exif.latitude
    resolved_longitude = optional_float(longitude, "经度")
    if resolved_longitude is None:
        resolved_longitude = exif.longitude
    resolved_captured_at = optional_datetime(captured_at, "拍摄时间")
    if resolved_captured_at is None:
        resolved_captured_at = exif.captured_at
    resolved_shutter_speed = optional_text(shutter_speed) or exif.shutter_speed
    resolved_aperture = optional_text(aperture) or exif.aperture
    resolved_iso = optional_int(iso, "感光度")
    if resolved_iso is None:
        resolved_iso = exif.iso

    return {
        "camera_model": resolved_camera_model,
        "lens_model": resolved_lens_model,
        "latitude": resolved_latitude,
        "longitude": resolved_longitude,
        "captured_at": resolved_captured_at,
        "shutter_speed": resolved_shutter_speed,
        "aperture": resolved_aperture,
        "iso": resolved_iso,
        "edit_method": normalize_edit_method(edit_method),
    }


def require_ingest_token(authorization: str | None) -> None:
    expected = settings.ingest_token
    if not expected:
        raise HTTPException(status_code=503, detail="云端未配置 INGEST_TOKEN，拒绝写入。")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="无效的鉴权令牌。")


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_bytes(contents: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(contents)
    return digest.hexdigest()


def find_artifact_image_by_hash_local(db: Session, image_hash: str) -> ArtifactImage | None:
    return db.scalar(artifact_image_query().where(ArtifactImage.image_hash == image_hash))


def find_artifact_image_by_source_hash_local(db: Session, source_hash: str | None) -> ArtifactImage | None:
    if not source_hash:
        return None
    return db.scalar(artifact_image_query().where(ArtifactImage.source_hash == source_hash))


def build_duplicate_image_detail(image: ArtifactImage | ArtifactImageRead) -> str:
    meta: list[str] = []
    museum_name = getattr(image, "museum_name", None)
    era = getattr(image, "era", None)
    if museum_name:
        meta.append(str(museum_name))
    if era:
        meta.append(str(era))
    suffix = f"（{' / '.join(meta)}）" if meta else ""
    return f"这张图片已存在于文物「{image.artifact_name}」{suffix}，不能重复上传。"


def build_duplicate_artifact_read(image: ArtifactImage | ArtifactImageRead) -> ArtifactRead:
    detail = build_duplicate_image_detail(image)
    if isinstance(image, ArtifactImageRead):
        artifact = ArtifactRead(
            id=image.artifact_id,
            museum_id=0,
            name=image.artifact_name,
            era=image.era,
            description=None,
            created_at=image.created_at,
            museum_name=image.museum_name,
            tags=[],
            images=[image],
            exhibitions=[],
            duplicate_image_skipped=True,
            duplicate_image_detail=detail,
        )
        return artifact
    artifact = ArtifactRead.model_validate(image.artifact)
    return artifact.model_copy(
        update={
            "duplicate_image_skipped": True,
            "duplicate_image_detail": detail,
        }
    )


def extract_http_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception:
        payload = None
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
    text_body = response.text.strip()
    if text_body:
        return text_body
    return f"HTTP {response.status_code}"


def write_temp_image_file(contents: bytes, filename: str | None = None) -> Path:
    suffix = Path(filename or "").suffix.lower() or ".jpg"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(contents)
    tmp.close()
    return Path(tmp.name)


async def run_vision_analysis(image_urls: list[str], image_name: str | None) -> VisionAnalyzeResponse:
    if not image_urls:
        raise HTTPException(status_code=400, detail="No image urls provided")

    providers, unavailable_providers = get_enabled_providers()
    web_sites = enabled_sites()
    if not providers and not web_sites:
        raise HTTPException(
            status_code=400,
            detail="No vision provider configured. Please set DASHSCOPE_API_KEY or VOLCENGINE_API_KEY.",
        )

    tasks = [
        request_provider_analysis(provider, image_urls, DATA_DIR, image_name)
        for provider in providers
    ]
    task_names = [provider.name for provider in providers]
    for site in web_sites:
        tasks.append(request_web_candidate(site, image_urls, DATA_DIR, image_name))
        task_names.append(site.key)

    results = await asyncio.gather(*tasks, return_exceptions=True)

    candidates = []
    failed_providers = []
    for name, result in zip(task_names, results, strict=False):
        if isinstance(result, Exception):
            failed_providers.append(name)
            logger.warning(
                "Vision provider %s failed: %s",
                name,
                result,
                exc_info=result,
            )
            continue
        candidates.append(result)

    candidates.sort(
        key=lambda item: (
            item.confidence if item.confidence is not None else -1,
            len(item.tags),
        ),
        reverse=True,
    )

    return VisionAnalyzeResponse(
        candidates=candidates,
        unavailable_providers=unavailable_providers,
        failed_providers=failed_providers,
    )


async def submit_artifact_to_cloud(
    *,
    image_bytes: bytes,
    image_name: str,
    content_type: str,
    museum_name: str,
    name: str,
    era: str | None,
    Place_of_Excavation: str | None,
    description: str | None,
    existing_artifact_id: int | None,
    skip_existing_match: bool,
    tags: list[str],
    camera_model: str | None,
    lens_model: str | None,
    capture_museum_name: str | None,
    exhibition_name: str | None,
    capture_location: str | None,
    latitude: float | None,
    longitude: float | None,
    captured_at: datetime | None,
    shutter_speed: str | None,
    aperture: str | None,
    iso: int | None,
    edit_method: str | None,
    source_hash: str | None = None,
) -> ArtifactRead:
    if not settings.cloud_api_base_url:
        raise HTTPException(status_code=400, detail="未配置 CLOUD_API_BASE_URL。")
    if not settings.ingest_token:
        raise HTTPException(status_code=400, detail="未配置 INGEST_TOKEN。")
    if not museum_name.strip():
        raise HTTPException(status_code=400, detail="请填写或确认博物馆名称。")
    if not name.strip():
        raise HTTPException(status_code=400, detail="请填写或确认文物名称。")

    excavation_value = normalize_place_of_excavation(Place_of_Excavation)
    base = settings.cloud_api_base_url.rstrip("/")
    submit_data = {
        "museum_name": museum_name.strip(),
        "name": name.strip(),
        "era": era or "",
        "Place_of_Excavation": excavation_value or "",
        "description": description or "",
        "skip_existing_match": "true" if skip_existing_match else "false",
        "tags": json.dumps(tags, ensure_ascii=False),
        "camera_model": camera_model or "",
        "lens_model": lens_model or "",
        "capture_museum_name": capture_museum_name or "",
        "exhibition_name": normalize_exhibition_name(exhibition_name),
        "capture_location": capture_location or "",
        "latitude": "" if latitude is None else str(latitude),
        "longitude": "" if longitude is None else str(longitude),
        "captured_at": captured_at.isoformat() if captured_at else "",
        "shutter_speed": shutter_speed or "",
        "aperture": aperture or "",
        "iso": "" if iso is None else str(iso),
        "edit_method": edit_method or "",
        "source_hash": source_hash or "",
    }
    if existing_artifact_id is not None:
        submit_data["existing_artifact_id"] = str(existing_artifact_id)

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{base}{settings.api_prefix}/ingest/artifacts",
                files={"image": (image_name, image_bytes, content_type)},
                data=submit_data,
                headers={"Authorization": f"Bearer {settings.ingest_token}"},
            )
            if not response.is_success:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"提交云端失败：{extract_http_error_detail(response)}",
                )
    except Exception as exc:  # noqa: BLE001 - surface submit failure to the operator
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(status_code=502, detail=f"提交云端失败：{exc}") from exc

    return ArtifactRead.model_validate(response.json())


async def generate_artifact_description_payload(
    *,
    image_urls: list[str],
    museum_name: str | None,
    name: str,
    era: str | None,
    Place_of_Excavation: str | None,
) -> ArtifactDescriptionGenerateRead:
    fallback_description = build_fallback_description(
        museum_name=museum_name,
        name=name,
        era=era,
        Place_of_Excavation=Place_of_Excavation,
    )
    try:
        raw_results, unavailable_providers = await generate_artifact_descriptions_parallel(
            image_urls=image_urls,
            data_dir=DATA_DIR,
            artifact_name=name,
            era=era,
            museum_name=museum_name,
            place_of_excavation=Place_of_Excavation,
        )
        candidates: list[ArtifactDescriptionCandidateRead] = []
        preferred_candidate: ArtifactDescriptionCandidateRead | None = None

        for item in raw_results:
            provider = item.get("provider")
            if not hasattr(provider, "name") or not hasattr(provider, "model"):
                continue

            if item.get("error"):
                candidates.append(
                    ArtifactDescriptionCandidateRead(
                        provider=str(provider.name),
                        model=str(provider.model),
                        status="error",
                        error=str(item["error"]),
                    )
                )
                continue

            result = item.get("result")
            if not isinstance(result, dict):
                candidates.append(
                    ArtifactDescriptionCandidateRead(
                        provider=str(provider.name),
                        model=str(provider.model),
                        status="error",
                        error="模型未返回可解析的 JSON 结果。",
                    )
                )
                continue

            description = optional_text(str(result.get("description", ""))) or fallback_description
            tags = [
                str(tag).strip()
                for tag in result.get("tags", [])
                if str(tag).strip()
            ]
            candidate = ArtifactDescriptionCandidateRead(
                provider=str(provider.name),
                model=str(provider.model),
                description=description,
                tags=tags,
                reasoning=optional_text(str(result.get("reasoning", "")))
                or optional_text(str(item.get("reasoning", ""))),
                status="success",
            )
            candidates.append(candidate)

            if preferred_candidate is None or candidate.provider == "qwen":
                preferred_candidate = candidate

        if preferred_candidate is not None:
            return ArtifactDescriptionGenerateRead(
                provider=preferred_candidate.provider,
                model=preferred_candidate.model,
                description=preferred_candidate.description,
                tags=preferred_candidate.tags,
                reasoning=preferred_candidate.reasoning,
                candidates=candidates,
                unavailable_providers=unavailable_providers,
            )

        return ArtifactDescriptionGenerateRead(
            provider="fallback",
            model="fallback",
            description=fallback_description,
            tags=[],
            candidates=candidates,
            unavailable_providers=unavailable_providers,
        )
    except Exception as exc:  # noqa: BLE001 - graceful fallback for copy generation
        logger.warning("generate artifact description failed: %s", exc, exc_info=exc)
        return ArtifactDescriptionGenerateRead(
            provider="fallback",
            model="fallback",
            description=fallback_description,
            tags=[],
            candidates=[],
            unavailable_providers=[],
        )


async def find_duplicate_artifact_image(
    db: Session, image_hash: str
) -> ArtifactImageRead | None:
    if should_proxy_artifact_queries_to_cloud():
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                response = await client.get(
                    f"{base}{settings.api_prefix}/artifact-images/by-hash",
                    params={"image_hash": image_hash},
                )
                if response.status_code == 404:
                    images_response = await client.get(f"{base}{settings.api_prefix}/artifact-images")
                    images_response.raise_for_status()
                    for item in images_response.json():
                        raw_url = str(item.get("url", "")).strip()
                        if not raw_url:
                            continue
                        image_url = (
                            raw_url
                            if raw_url.startswith(("http://", "https://"))
                            else f"{base}{raw_url}"
                        )
                        try:
                            image_response = await client.get(image_url)
                            image_response.raise_for_status()
                        except Exception:  # noqa: BLE001 - skip unreadable legacy assets
                            continue
                        if hash_bytes(image_response.content) == image_hash:
                            return ArtifactImageRead.model_validate(item)
                    return None
                response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - validation failures should surface clearly
            raise HTTPException(status_code=502, detail=f"查询云端重复图片失败：{exc}") from exc
        payload = response.json()
        return ArtifactImageRead.model_validate(payload) if payload else None

    match = find_artifact_image_by_hash_local(db, image_hash)
    return ArtifactImageRead.model_validate(match) if match is not None else None


def scan_pending_items(db: Session) -> list[PendingArtifact]:
    return list(db.scalars(select(PendingArtifact).order_by(PendingArtifact.created_at.desc())))


def register_pending_artifact(
    db: Session,
    *,
    file_hash: str,
    source_path: str,
    file_name: str,
    image_blob: bytes | None = None,
    image_mime_type: str | None = None,
    metadata: dict[str, object | None] | None = None,
) -> PendingArtifact | None:
    existing = db.scalar(select(PendingArtifact).where(PendingArtifact.file_hash == file_hash))
    if existing is not None:
        return None
    row = PendingArtifact(
        source_path=source_path,
        file_hash=file_hash,
        file_name=file_name,
        image_blob=image_blob,
        image_mime_type=image_mime_type,
        status="pending",
        tags=[],
        **(metadata or {}),
    )
    db.add(row)
    db.flush()
    return row


def materialize_pending_artifact_image(row: PendingArtifact) -> tuple[Path, Path | None]:
    if row.image_blob:
        suffix = Path(row.file_name).suffix.lower() or ".jpg"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(row.image_blob)
        tmp.close()
        return Path(tmp.name), Path(tmp.name)
    path = Path(row.source_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="原图文件已不存在。")
    return path, None


def pending_artifact_image_bytes(row: PendingArtifact) -> tuple[bytes, str]:
    if row.image_blob:
        content_type = row.image_mime_type or mimetypes.guess_type(row.file_name)[0] or "image/jpeg"
        return row.image_blob, content_type
    path = Path(row.source_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="原图文件已不存在。")
    content_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    return path.read_bytes(), content_type


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def build_google_photos_callback_html(success: bool, message: str) -> str:
    payload = json.dumps(
        {
            "source": "google-photos-oauth",
            "success": success,
            "message": message,
        },
        ensure_ascii=False,
    )
    title = "Google Photos 已连接" if success else "Google Photos 连接失败"
    return f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <style>
      body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #f8f7f2; color: #2c241c; }}
      .card {{ max-width: 520px; margin: 40px auto; padding: 24px; background: #fff; border-radius: 16px; box-shadow: 0 12px 32px rgba(54, 39, 19, 0.08); }}
      h1 {{ margin: 0 0 12px; font-size: 22px; }}
      p {{ margin: 0; line-height: 1.6; }}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>{title}</h1>
      <p>{message}</p>
    </div>
    <script>
      const payload = {payload};
      try {{
        if (window.opener && !window.opener.closed) {{
          window.opener.postMessage(payload, "*");
        }}
      }} catch (_error) {{
        // Ignore postMessage cross-window failures and still try to close the popup.
      }}
      setTimeout(() => window.close(), 800);
    </script>
  </body>
</html>"""


def should_proxy_artifact_queries_to_cloud() -> bool:
    return settings.app_role == "local" and bool(settings.cloud_api_base_url)


def build_artifact_match_read(match: ArtifactMatchCandidate) -> ArtifactMatchRead:
    return ArtifactMatchRead(
        artifact=ArtifactRead.model_validate(match.artifact),
        match_score=match.score,
        match_reason=match.reason,
    )


def find_existing_artifact_match(
    db: Session,
    *,
    name: str | None,
    museum_name: str | None = None,
    era: str | None = None,
) -> ArtifactMatchCandidate | None:
    normalized_name = normalize_identity_text(name)
    compact_name = compact_artifact_name_for_match(name)
    normalized_museum_name = normalize_identity_text(museum_name)
    normalized_era = normalize_identity_text(era)
    if (
        normalized_name is None
        or compact_name is None
        or normalized_museum_name is None
        or normalized_era is None
    ):
        return None

    base_query = (
        artifact_detail_query()
        .join(Artifact.museum)
        .where(
            func.lower(Museum.name) == normalized_museum_name,
            Artifact.era.is_not(None),
            func.lower(Artifact.era) == normalized_era,
        )
    )

    exact_match = db.scalar(
        base_query.where(func.lower(Artifact.name) == normalized_name).order_by(
            Artifact.created_at.asc(),
            Artifact.id.asc(),
        )
    )
    if exact_match is not None:
        return ArtifactMatchCandidate(
            artifact=exact_match,
            score=1.0,
            reason="名称完全一致，且时代、馆藏一致。",
        )

    if len(compact_name) < 3:
        return None

    candidates = list(
        db.scalars(
            base_query.order_by(
                Artifact.created_at.asc(),
                Artifact.id.asc(),
            )
        )
    )
    best_match = None
    best_score = -1
    for candidate in candidates:
        score = artifact_name_match_score(name, candidate.name)
        if score > best_score:
            best_match = candidate
            best_score = score
    if best_match is None or best_score < 0.68:
        return None
    return ArtifactMatchCandidate(
        artifact=best_match,
        score=best_score,
        reason="名称大部分一致，且时代、馆藏一致。",
    )


async def fetch_cloud_artifact_match(
    *,
    name: str | None,
    museum_name: str | None = None,
    era: str | None = None,
) -> ArtifactMatchRead | None:
    if not settings.cloud_api_base_url:
        return None

    normalized_name = optional_text(name)
    normalized_museum_name = optional_text(museum_name)
    normalized_era = optional_text(era)
    if (
        normalized_name is None
        or normalized_museum_name is None
        or normalized_era is None
    ):
        return None

    params = {
        "name": normalized_name,
        "museum_name": normalized_museum_name,
        "era": normalized_era,
    }

    base = settings.cloud_api_base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            response = await client.get(
                f"{base}{settings.api_prefix}/artifacts/match",
                params=params,
            )
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001 - do not fail the main workflow on preview lookup
        logger.warning("artifact match lookup failed: %s", exc, exc_info=exc)
        return None

    payload = response.json()
    if not payload:
        return None
    return ArtifactMatchRead.model_validate(payload)


@app.get(f"{settings.api_prefix}/health", response_model=HealthRead)
def healthcheck() -> HealthRead:
    return HealthRead(status="ok", environment=settings.app_env, database="connected")


@app.get(f"{settings.api_prefix}/web-bridge/status", response_model=WebBridgeStatusRead)
def web_bridge_status() -> WebBridgeStatusRead:
    site = next((item for item in enabled_sites() if item.key == "qwen_web"), None)
    return build_web_bridge_status(site)


@app.post(f"{settings.api_prefix}/web-bridge/login/start", response_model=WebBridgeLoginStartRead)
def start_web_bridge_login_helper() -> WebBridgeLoginStartRead:
    site = next((item for item in enabled_sites() if item.key == "qwen_web"), None)
    if site is None:
        raise HTTPException(status_code=400, detail="未启用通义网页桥接。")
    result = start_web_bridge_login()
    if not result.started and "Docker 容器" in result.detail:
        raise HTTPException(status_code=409, detail=result.detail)
    return result


@app.post(
    f"{settings.api_prefix}/vision/analyze",
    response_model=VisionAnalyzeResponse,
)
async def analyze_artifact_images(payload: VisionAnalyzeRequest) -> VisionAnalyzeResponse:
    return await run_vision_analysis(payload.image_urls, payload.image_name)


@app.post(
    f"{settings.api_prefix}/vision/analyze/file",
    response_model=VisionAnalyzeResponse,
)
async def analyze_artifact_image_file(
    file: UploadFile = File(...),
    image_name: str | None = Form(None),
) -> VisionAnalyzeResponse:
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="图片内容为空。")
    temp_path = write_temp_image_file(contents, file.filename or image_name)
    try:
        return await run_vision_analysis(
            [str(temp_path)],
            image_name or file.filename or temp_path.name,
        )
    finally:
        temp_path.unlink(missing_ok=True)


@app.post(f"{settings.api_prefix}/vision/analyze/stream")
async def analyze_artifact_images_stream(payload: VisionAnalyzeRequest) -> StreamingResponse:
    if not payload.image_urls:
        raise HTTPException(status_code=400, detail="No image urls provided")

    providers, unavailable_providers = get_enabled_providers()
    web_sites = enabled_sites()
    if not providers and not web_sites:
        raise HTTPException(
            status_code=400,
            detail="No vision provider configured. Please set DASHSCOPE_API_KEY or VOLCENGINE_API_KEY.",
        )

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()

        async def emit(event: dict) -> None:
            await queue.put(event)

        async def run_provider(provider) -> None:
            try:
                await stream_provider_analysis(
                    provider, payload.image_urls, DATA_DIR, payload.image_name, emit
                )
            except Exception as exc:  # noqa: BLE001 - surface failure to the client stream
                logger.warning(
                    "Vision provider %s (%s) failed: %s",
                    provider.name,
                    provider.model,
                    exc,
                    exc_info=exc,
                )
                await emit(
                    {
                        "provider": provider.name,
                        "model": provider.model,
                        "stage": "error",
                        "message": str(exc) or "识图失败",
                    }
                )

        async def run_web_site(site) -> None:
            meta = {"provider": site.key, "model": site.label}
            try:
                await emit({**meta, "stage": "analyzing"})
                candidate = await request_web_candidate(
                    site, payload.image_urls, DATA_DIR, payload.image_name
                )
                await emit({**meta, "stage": "result", "candidate": candidate.model_dump()})
                await emit({**meta, "stage": "done"})
            except Exception as exc:  # noqa: BLE001 - surface failure to the client stream
                logger.warning("Vision provider %s failed: %s", site.key, exc, exc_info=exc)
                await emit({**meta, "stage": "error", "message": str(exc) or "网页端识图失败"})

        tasks = [asyncio.create_task(run_provider(provider)) for provider in providers]
        tasks += [asyncio.create_task(run_web_site(site)) for site in web_sites]

        async def finalize() -> None:
            await asyncio.gather(*tasks, return_exceptions=True)
            await queue.put(None)

        finalize_task = asyncio.create_task(finalize())

        await queue.put(
            {
                "stage": "meta",
                "providers": [provider.name for provider in providers]
                + [site.key for site in web_sites],
                "unavailable_providers": unavailable_providers,
            }
        )

        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            finalize_task.cancel()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post(f"{settings.api_prefix}/uploads/images", response_model=list[UploadedImageRead], status_code=201)
async def upload_images(
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> list[UploadedImageRead]:
    uploaded_images: list[UploadedImageRead] = []

    for file in files:
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="图片内容为空。")
        image_hash = hash_bytes(contents)
        duplicate_image = await find_duplicate_artifact_image(db, image_hash)
        if duplicate_image is not None:
            raise HTTPException(status_code=409, detail=build_duplicate_image_detail(duplicate_image))

        suffix = Path(file.filename or "").suffix.lower()
        generated_name = f"{uuid4().hex}{suffix}"
        target_path = UPLOADS_DIR / generated_name
        target_path.write_bytes(contents)
        image_metadata = build_image_metadata(image_bytes=contents)

        uploaded_images.append(
            UploadedImageRead(
                filename=file.filename or generated_name,
                url=build_uploaded_file_url(generated_name),
                uploaded_at=datetime.now(timezone.utc),
                capture_museum_name=None,
                exhibition_name=None,
                **image_metadata,
            )
        )

    return uploaded_images


@app.get(
    f"{settings.api_prefix}/google-photos/status",
    response_model=GooglePhotosStatusRead,
)
def google_photos_status() -> GooglePhotosStatusRead:
    return build_google_photos_status()


@app.get(
    f"{settings.api_prefix}/google-photos/config",
    response_model=GooglePhotosConfigRead,
)
def google_photos_config() -> GooglePhotosConfigRead:
    return current_google_photos_config()


@app.put(
    f"{settings.api_prefix}/google-photos/config",
    response_model=GooglePhotosConfigRead,
)
def update_google_photos_config(payload: GooglePhotosConfigUpdate) -> GooglePhotosConfigRead:
    return save_google_photos_config(payload)


@app.delete(
    f"{settings.api_prefix}/google-photos/token",
    response_model=GooglePhotosStatusRead,
)
def delete_google_photos_token() -> GooglePhotosStatusRead:
    return clear_google_photos_token()


@app.get(
    f"{settings.api_prefix}/google-photos/auth/start",
    response_model=GooglePhotosAuthStartRead,
)
def google_photos_auth_start() -> GooglePhotosAuthStartRead:
    return GooglePhotosAuthStartRead(auth_url=build_google_photos_auth_url())


@app.get(f"{settings.api_prefix}/google-photos/callback", response_class=HTMLResponse)
def google_photos_auth_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> HTMLResponse:
    if error:
        return HTMLResponse(
            build_google_photos_callback_html(False, f"Google 授权被取消或失败：{error}"),
            status_code=400,
        )
    if not code:
        return HTMLResponse(
            build_google_photos_callback_html(False, "Google 授权回调缺少 code。"),
            status_code=400,
        )
    try:
        exchange_google_photos_code(code, state)
    except HTTPException as exc:
        return HTMLResponse(
            build_google_photos_callback_html(False, str(exc.detail)),
            status_code=exc.status_code,
        )
    return HTMLResponse(build_google_photos_callback_html(True, "Google Photos 已连接，可以回到批量入库页继续导入图片。"))


@app.post(
    f"{settings.api_prefix}/google-photos/picker/sessions",
    response_model=GooglePhotosPickerSessionRead,
)
def google_photos_picker_session_create(
    payload: GooglePhotosPickerSessionCreate,
) -> GooglePhotosPickerSessionRead:
    return create_google_photos_picker_session(payload)


@app.get(
    f"{settings.api_prefix}/google-photos/picker/sessions/{{session_id}}",
    response_model=GooglePhotosPickerSessionRead,
)
def google_photos_picker_session_get(session_id: str) -> GooglePhotosPickerSessionRead:
    normalized = session_id.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Google Photos Picker session_id 不能为空。")
    return get_google_photos_picker_session(normalized)


@app.delete(f"{settings.api_prefix}/google-photos/picker/sessions/{{session_id}}", status_code=204)
def google_photos_picker_session_delete(session_id: str) -> None:
    normalized = session_id.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Google Photos Picker session_id 不能为空。")
    delete_google_photos_picker_session(normalized)


@app.get(
    f"{settings.api_prefix}/google-photos/picker/media-items",
    response_model=GooglePhotosMediaListRead,
)
def google_photos_picker_media_items(
    session_id: str = Query(..., min_length=1),
    page_size: int = Query(default=100, ge=1, le=100),
    page_token: str | None = Query(default=None),
) -> GooglePhotosMediaListRead:
    return list_google_photos_media_items(
        session_id=session_id.strip(),
        page_size=page_size,
        page_token=optional_text(page_token),
    )


@app.post(
    f"{settings.api_prefix}/google-photos/import",
    response_model=GooglePhotosImportRead,
)
def google_photos_import(
    payload: GooglePhotosImportRequest,
    db: Session = Depends(get_db),
) -> GooglePhotosImportRead:
    if not google_photos_enabled():
        raise HTTPException(status_code=400, detail="当前环境不支持 Google Photos 导入。")
    session_id = payload.session_id.strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="Google Photos Picker session_id 不能为空。")
    media_item_ids = [item.strip() for item in payload.media_item_ids if item.strip()]
    if not media_item_ids:
        raise HTTPException(status_code=400, detail="请至少选择一张 Google Photos 图片。")

    imported = 0
    skipped = 0
    warnings: list[str] = []
    imported_ids: list[int] = []

    media_items = get_google_photos_media_items_by_ids(
        session_id=session_id,
        media_item_ids=media_item_ids,
    )

    for media_item in media_items:
        mime_type = (media_item.mime_type or "").lower()
        if not mime_type.startswith("image/"):
            skipped += 1
            warnings.append(f"{media_item.filename} 不是图片，已跳过。")
            continue
        contents = download_google_photos_image(media_item)
        if not contents:
            skipped += 1
            warnings.append(f"{media_item.filename} 下载为空，已跳过。")
            continue
        file_hash = hash_bytes(contents)
        metadata = build_image_metadata(
            image_bytes=contents,
            captured_at=media_item.creation_time.isoformat() if media_item.creation_time else None,
        )
        created = register_pending_artifact(
            db,
            file_hash=file_hash,
            source_path=f"google_photos:{media_item.id}",
            file_name=media_item.filename,
            image_blob=contents,
            image_mime_type=media_item.mime_type or "image/jpeg",
            metadata=metadata,
        )
        if not created:
            skipped += 1
            warnings.append(f"{media_item.filename} 已在待处理列表中，已跳过。")
            continue
        imported += 1
        imported_ids.append(created.id)

    db.commit()
    try:
        delete_google_photos_picker_session(session_id)
    except HTTPException:
        pass
    imported_rows = []
    if imported_ids:
        imported_rows = list(
            db.scalars(
                select(PendingArtifact)
                .where(PendingArtifact.id.in_(imported_ids))
                .order_by(PendingArtifact.created_at.desc())
            )
        )
    return GooglePhotosImportRead(
        imported=imported,
        skipped=skipped,
        warnings=warnings,
        items=[PendingArtifactRead.model_validate(row) for row in imported_rows],
    )


@app.delete(f"{settings.api_prefix}/uploads/images", status_code=204)
def delete_uploaded_image(url: str = Query(..., min_length=1)) -> None:
    path = resolve_uploaded_file_path(url)
    path.unlink(missing_ok=True)


@app.get(
    f"{settings.api_prefix}/artifacts/parse-name",
    response_model=ParsedArtifactNameRead,
)
def parse_artifact_name(name: str = Query(..., min_length=1)) -> ParsedArtifactNameRead:
    return parse_artifact_compound_name(name)


@app.post(
    f"{settings.api_prefix}/artifacts/generate-description",
    response_model=ArtifactDescriptionGenerateRead,
)
async def generate_artifact_description_api(
    payload: ArtifactDescriptionGenerateRequest,
) -> ArtifactDescriptionGenerateRead:
    return await generate_artifact_description_payload(
        image_urls=[payload.image_url] if payload.image_url else [],
        museum_name=payload.museum_name,
        name=payload.name,
        era=payload.era,
        Place_of_Excavation=payload.Place_of_Excavation,
    )


@app.post(
    f"{settings.api_prefix}/artifacts/generate-description-file",
    response_model=ArtifactDescriptionGenerateRead,
)
async def generate_artifact_description_file_api(
    file: UploadFile | None = File(None),
    museum_name: str | None = Form(None),
    name: str = Form(...),
    era: str | None = Form(None),
    Place_of_Excavation: str | None = Form(None),
) -> ArtifactDescriptionGenerateRead:
    image_urls: list[str] = []
    if file is not None:
        image_bytes = await file.read()
        if image_bytes:
            content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "image/jpeg"
            image_urls = [f"data:{content_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"]

    return await generate_artifact_description_payload(
        image_urls=image_urls,
        museum_name=museum_name,
        name=name,
        era=era,
        Place_of_Excavation=Place_of_Excavation,
    )


@app.post(f"{settings.api_prefix}/artifacts/generate-description-stream-file")
async def generate_artifact_description_stream_file_api(
    file: UploadFile | None = File(None),
    museum_name: str | None = Form(None),
    name: str = Form(...),
    era: str | None = Form(None),
    Place_of_Excavation: str | None = Form(None),
) -> StreamingResponse:
    image_urls: list[str] = []
    if file is not None:
        image_bytes = await file.read()
        if image_bytes:
            content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "image/jpeg"
            image_urls = [f"data:{content_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"]

    async def event_generator():
        phases = [
            "已读取文件名与已确认字段，正在建立编目线索",
            "正在观察图像中的材质、器形、纹饰与文字线索",
            "正在组织可核查的研究描述与特征标签",
        ]
        yield f"data: {json.dumps({'type': 'progress', 'message': phases[0]}, ensure_ascii=False)}\n\n"
        task = asyncio.create_task(generate_artifact_description_payload(
            image_urls=image_urls,
            museum_name=museum_name,
            name=name,
            era=era,
            Place_of_Excavation=Place_of_Excavation,
        ))
        phase_index = 1
        while not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=1.2)
            except asyncio.TimeoutError:
                if phase_index < len(phases):
                    yield f"data: {json.dumps({'type': 'progress', 'message': phases[phase_index]}, ensure_ascii=False)}\n\n"
                    phase_index += 1
        result = await task
        yield f"data: {json.dumps({'type': 'result', 'result': result.model_dump()}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post(f"{settings.api_prefix}/artifacts/prepare-exif-file")
async def prepare_artifact_exif_file(
    file: UploadFile = File(...),
    museum_name: str = Form(...),
    name: str = Form(...),
    era: str | None = Form(None),
    Place_of_Excavation: str | None = Form(None),
    description: str | None = Form(None),
    latitude: float | None = Form(None),
    longitude: float | None = Form(None),
) -> Response:
    """Return edited bytes for a user-authorised local overwrite."""
    original_bytes = await file.read()
    if not original_bytes:
        raise HTTPException(status_code=400, detail="图片内容为空。")
    description_text = description or build_fallback_description(
        museum_name=museum_name,
        name=name,
        era=era,
        Place_of_Excavation=Place_of_Excavation,
    )
    image_bytes = update_image_exif_metadata(
        original_bytes,
        artifact_name=name,
        description=description_text,
        latitude=latitude,
        longitude=longitude,
        museum_name=museum_name,
        era=era,
        place_of_excavation=Place_of_Excavation,
    )
    content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "image/jpeg"
    return Response(content=image_bytes, media_type=content_type)


@app.post(
    f"{settings.api_prefix}/artifacts/exif-submit",
    response_model=ArtifactRead,
    status_code=201,
)
async def submit_artifact_with_exif(payload: ExifArtifactSubmitRequest) -> ArtifactRead:
    image_path = resolve_uploaded_file_path(payload.image_url)
    original_bytes = image_path.read_bytes()
    content_type = mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
    description_text = payload.description or build_fallback_description(
        museum_name=payload.museum_name,
        name=payload.name,
        era=payload.era,
        Place_of_Excavation=payload.Place_of_Excavation,
    )
    image_bytes = update_image_exif_metadata(
        original_bytes,
        artifact_name=payload.name,
        description=description_text,
        latitude=payload.latitude,
        longitude=payload.longitude,
        museum_name=payload.museum_name,
        era=payload.era,
        place_of_excavation=payload.Place_of_Excavation,
    )
    image_path.write_bytes(image_bytes)
    return await submit_artifact_to_cloud(
        image_bytes=image_bytes,
        image_name=image_path.name,
        content_type=content_type,
        museum_name=payload.museum_name,
        name=payload.name,
        era=payload.era,
        Place_of_Excavation=payload.Place_of_Excavation,
        description=description_text,
        existing_artifact_id=payload.existing_artifact_id,
        skip_existing_match=payload.skip_existing_match,
        tags=payload.tags,
        camera_model=None,
        lens_model=None,
        capture_museum_name=payload.display_location_name,
        exhibition_name="常设",
        capture_location=payload.display_location_name,
        latitude=payload.latitude,
        longitude=payload.longitude,
        captured_at=None,
        shutter_speed=None,
        aperture=None,
        iso=None,
        edit_method=None,
    )


@app.post(
    f"{settings.api_prefix}/artifacts/exif-submit-file",
    response_model=ArtifactRead,
    status_code=201,
)
async def submit_artifact_with_exif_file(
    file: UploadFile = File(...),
    museum_name: str = Form(...),
    name: str = Form(...),
    era: str | None = Form(None),
    Place_of_Excavation: str | None = Form(None),
    description: str | None = Form(None),
    tags: str = Form("[]"),
    display_location_name: str | None = Form(None),
    exhibition_name: str | None = Form("常设"),
    latitude: float | None = Form(None),
    longitude: float | None = Form(None),
    existing_artifact_id: int | None = Form(None),
    skip_existing_match: bool = Form(False),
) -> ArtifactRead:
    # #region debug-point A:submit-entry
    report_debug_event(
        session_id="exif-submit-parse",
        hypothesis_id="A",
        location="main.py:submit-entry",
        message="[DEBUG] exif submit entry",
        data={
            "filename": file.filename,
            "museum_name": museum_name,
            "name": name,
            "era": era,
            "Place_of_Excavation": Place_of_Excavation,
            "display_location_name": display_location_name,
            "latitude": latitude,
            "longitude": longitude,
            "existing_artifact_id": existing_artifact_id,
            "skip_existing_match": skip_existing_match,
        },
    )
    # #endregion
    original_bytes = await file.read()
    if not original_bytes:
        raise HTTPException(status_code=400, detail="图片内容为空。")
    source_hash = hash_bytes(original_bytes)

    try:
        parsed_tags = json.loads(tags or "[]")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="标签格式不正确。") from exc
    if not isinstance(parsed_tags, list):
        raise HTTPException(status_code=400, detail="标签格式不正确。")
    normalized_tags = [str(tag).strip() for tag in parsed_tags if str(tag).strip()]

    content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "image/jpeg"
    description_text = description or build_fallback_description(
        museum_name=museum_name,
        name=name,
        era=era,
        Place_of_Excavation=Place_of_Excavation,
    )
    image_bytes = update_image_exif_metadata(
        original_bytes,
        artifact_name=name,
        description=description_text,
        latitude=latitude,
        longitude=longitude,
        museum_name=museum_name,
        era=era,
        place_of_excavation=Place_of_Excavation,
    )
    # #region debug-point B:submit-after-exif
    report_debug_event(
        session_id="exif-submit-parse",
        hypothesis_id="B",
        location="main.py:submit-after-exif",
        message="[DEBUG] exif updated before cloud submit",
        data={
            "filename": file.filename,
            "content_type": content_type,
            "original_size": len(original_bytes),
            "updated_size": len(image_bytes),
            "tag_count": len(normalized_tags),
        },
    )
    # #endregion
    try:
        return await submit_artifact_to_cloud(
            image_bytes=image_bytes,
            image_name=file.filename or "photo-exif-upload.jpg",
            content_type=content_type,
            museum_name=museum_name,
            name=name,
            era=era,
            Place_of_Excavation=Place_of_Excavation,
            description=description_text,
            existing_artifact_id=existing_artifact_id,
            skip_existing_match=skip_existing_match,
            tags=normalized_tags,
            camera_model=None,
            lens_model=None,
            capture_museum_name=display_location_name,
            exhibition_name=exhibition_name,
            capture_location=display_location_name,
            latitude=latitude,
            longitude=longitude,
            captured_at=None,
            shutter_speed=None,
            aperture=None,
            iso=None,
            edit_method=None,
            source_hash=source_hash,
        )
    except Exception as exc:
        # #region debug-point B:submit-error
        report_debug_event(
            session_id="exif-submit-parse",
            hypothesis_id="B",
            location="main.py:submit-error",
            message="[DEBUG] exif submit raised exception",
            data={"error_type": type(exc).__name__, "error": str(exc)},
        )
        # #endregion
        raise


# ── Cloud ingest (Alibaba Cloud server): receive a reviewed record + image ────────


@app.post(
    f"{settings.api_prefix}/ingest/artifacts",
    response_model=ArtifactRead,
    status_code=201,
)
async def ingest_artifact(
    image: UploadFile = File(...),
    museum_name: str = Form(...),
    name: str = Form(...),
    era: str | None = Form(None),
    Place_of_Excavation: str | None = Form(None),
    description: str | None = Form(None),
    existing_artifact_id: int | None = Form(None),
    skip_existing_match: bool = Form(False),
    tags: str = Form(""),
    camera_model: str | None = Form(None),
    lens_model: str | None = Form(None),
    capture_museum_name: str | None = Form(None),
    exhibition_name: str | None = Form("常设"),
    capture_location: str | None = Form(None),
    latitude: str | None = Form(None),
    longitude: str | None = Form(None),
    captured_at: str | None = Form(None),
    shutter_speed: str | None = Form(None),
    aperture: str | None = Form(None),
    iso: str | None = Form(None),
    edit_method: str | None = Form(None),
    source_hash: str | None = Form(None),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> Artifact:
    """Store the image in OSS and the metadata in the cloud DB. Bearer-token protected."""
    require_ingest_token(authorization)

    contents = await image.read()
    if not contents:
        raise HTTPException(status_code=400, detail="图片内容为空。")
    image_hash = hash_bytes(contents)
    duplicate_image = find_artifact_image_by_source_hash_local(db, source_hash) or find_artifact_image_by_hash_local(db, image_hash)
    if duplicate_image is not None:
        return build_duplicate_artifact_read(duplicate_image)

    image_metadata = build_image_metadata(
        image_bytes=contents,
        camera_model=camera_model,
        lens_model=lens_model,
        latitude=latitude,
        longitude=longitude,
        captured_at=captured_at,
        shutter_speed=shutter_speed,
        aperture=aperture,
        iso=iso,
        edit_method=edit_method,
    )

    museum = ensure_museum(db, museum_name)
    capture_museum, exhibition = resolve_capture_context(db, capture_museum_name, exhibition_name)
    merged_tags = merge_unique_tags(
        parse_tags(tags),
        build_capture_tags(
            image_metadata.get("camera_model"),
            image_metadata.get("lens_model"),
        ),
    )
    excavation_value = normalize_place_of_excavation(Place_of_Excavation)

    artifact: Artifact | None = None
    if existing_artifact_id is not None:
        artifact = db.scalar(artifact_detail_query().where(Artifact.id == existing_artifact_id))
        if artifact is None:
            raise HTTPException(status_code=404, detail="要更新的文物不存在。")
    elif not skip_existing_match:
        existing_match = find_existing_artifact_match(
            db,
            name=name,
            museum_name=museum_name,
            era=era,
        )
        artifact = existing_match.artifact if existing_match is not None else None

    image_url = upload_image(
        contents, image.filename or "image.jpg", image.content_type
    )

    if artifact is not None:
        artifact.ai_status = "reviewed"
        artifact.museum_id = museum.id
        artifact.name = name.strip()
        artifact.era = optional_text(era)
        artifact.Place_of_Excavation = excavation_value
        artifact.description = optional_text(description)
        existing_tag_names = {tag.name for tag in artifact.tags}
        for tag in merged_tags:
            if tag not in existing_tag_names:
                artifact.tags.append(ArtifactTag(name=tag))
                existing_tag_names.add(tag)
    else:
        artifact = Artifact(
            museum_id=museum.id,
            name=name.strip(),
            era=(era or None),
            Place_of_Excavation=excavation_value,
            description=(description or None),
            ai_status="reviewed",
        )
        artifact.tags = [ArtifactTag(name=tag) for tag in merged_tags]
        db.add(artifact)
        db.flush()

    if exhibition is not None:
        existing_link = db.scalar(
            select(ArtifactExhibition).where(
                ArtifactExhibition.artifact_id == artifact.id,
                ArtifactExhibition.exhibition_id == exhibition.id,
            )
        )
        if existing_link is None:
            db.add(ArtifactExhibition(artifact_id=artifact.id, exhibition_id=exhibition.id))

    artifact.images.append(
        ArtifactImage(
            url=image_url,
            image_hash=image_hash,
            source_hash=source_hash or image_hash,
            capture_museum_id=capture_museum.id if capture_museum is not None else None,
            exhibition_id=exhibition.id if exhibition is not None else None,
            capture_location=optional_text(capture_location),
            **image_metadata,
        )
    )
    db.commit()
    return db.scalar(artifact_detail_query().where(Artifact.id == artifact.id))


@app.post(
    f"{settings.api_prefix}/artifacts/submit-cloud",
    response_model=ArtifactRead,
    status_code=201,
)
async def submit_single_artifact_to_cloud(payload: CloudArtifactSubmitRequest) -> Artifact:
    image_path = resolve_uploaded_file_path(payload.image_url)
    content_type = mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
    return await submit_artifact_to_cloud(
        image_bytes=image_path.read_bytes(),
        image_name=image_path.name,
        content_type=content_type,
        museum_name=payload.museum_name,
        name=payload.name,
        era=payload.era,
        Place_of_Excavation=payload.Place_of_Excavation,
        description=payload.description,
        existing_artifact_id=payload.existing_artifact_id,
        skip_existing_match=payload.skip_existing_match,
        tags=payload.tags,
        camera_model=payload.camera_model,
        lens_model=payload.lens_model,
        capture_museum_name=payload.capture_museum_name,
        exhibition_name=payload.exhibition_name,
        capture_location=payload.capture_location,
        latitude=payload.latitude,
        longitude=payload.longitude,
        captured_at=payload.captured_at,
        shutter_speed=payload.shutter_speed,
        aperture=payload.aperture,
        iso=payload.iso,
        edit_method=payload.edit_method,
    )


@app.post(
    f"{settings.api_prefix}/artifacts/submit-cloud-file",
    response_model=ArtifactRead,
    status_code=201,
)
async def submit_single_artifact_file_to_cloud(
    file: UploadFile = File(...),
    museum_name: str = Form(...),
    name: str = Form(...),
    era: str | None = Form(None),
    Place_of_Excavation: str | None = Form(None),
    description: str | None = Form(None),
    existing_artifact_id: int | None = Form(None),
    skip_existing_match: bool = Form(False),
    tags: str = Form("[]"),
    camera_model: str | None = Form(None),
    lens_model: str | None = Form(None),
    capture_museum_name: str | None = Form(None),
    exhibition_name: str | None = Form(None),
    capture_location: str | None = Form(None),
    latitude: float | None = Form(None),
    longitude: float | None = Form(None),
    captured_at: datetime | None = Form(None),
    shutter_speed: str | None = Form(None),
    aperture: str | None = Form(None),
    iso: int | None = Form(None),
    edit_method: str | None = Form(None),
) -> ArtifactRead:
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="图片内容为空。")
    try:
        parsed_tags = json.loads(tags or "[]")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="标签格式不正确。") from exc
    if not isinstance(parsed_tags, list):
        raise HTTPException(status_code=400, detail="标签格式不正确。")
    normalized_tags = [str(tag).strip() for tag in parsed_tags if str(tag).strip()]
    return await submit_artifact_to_cloud(
        image_bytes=contents,
        image_name=file.filename or "batch-upload.jpg",
        content_type=file.content_type or mimetypes.guess_type(file.filename or "")[0] or "image/jpeg",
        museum_name=museum_name,
        name=name,
        era=era,
        Place_of_Excavation=Place_of_Excavation,
        description=description,
        existing_artifact_id=existing_artifact_id,
        skip_existing_match=skip_existing_match,
        tags=normalized_tags,
        camera_model=camera_model,
        lens_model=lens_model,
        capture_museum_name=capture_museum_name,
        exhibition_name=exhibition_name,
        capture_location=capture_location,
        latitude=latitude,
        longitude=longitude,
        captured_at=captured_at,
        shutter_speed=shutter_speed,
        aperture=aperture,
        iso=iso,
        edit_method=edit_method,
    )


# ── Batch identification (local operator machine) ─────────────────────────────────


@app.post(f"{settings.api_prefix}/batch/scan", response_model=BatchScanResponse)
def batch_scan(payload: BatchScanRequest, db: Session = Depends(get_db)) -> BatchScanResponse:
    root = Path(payload.directory).expanduser()
    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=400, detail=f"目录不存在或不是文件夹：{root}")

    extensions = {ext.lower() for ext in payload.extensions} or IMAGE_EXTENSIONS
    scanned = added = skipped = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in extensions:
            continue
        scanned += 1
        contents = path.read_bytes()
        file_hash = hash_file(path)
        metadata = build_image_metadata(image_bytes=contents)
        created = register_pending_artifact(
            db,
            file_hash=file_hash,
            source_path=str(path),
            file_name=path.name,
            metadata=metadata,
        )
        if not created:
            skipped += 1
            continue
        added += 1
    db.commit()

    items = scan_pending_items(db)
    return BatchScanResponse(scanned=scanned, added=added, skipped=skipped, items=items)


@app.post(
    f"{settings.api_prefix}/batch/scan-files",
    response_model=BatchScanResponse,
)
async def batch_scan_files(
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
) -> BatchScanResponse:
    scanned = added = skipped = 0
    for file in files:
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in IMAGE_EXTENSIONS:
            continue
        contents = await file.read()
        if not contents:
            continue
        scanned += 1
        file_hash = hash_bytes(contents)
        metadata = build_image_metadata(image_bytes=contents)
        file_name = Path(file.filename or f"{file_hash}{suffix}").name
        content_type = file.content_type or mimetypes.guess_type(file_name)[0] or "image/jpeg"
        created = register_pending_artifact(
            db,
            file_hash=file_hash,
            source_path=f"upload:{file_name}",
            file_name=file_name,
            image_blob=contents,
            image_mime_type=content_type,
            metadata=metadata,
        )
        if not created:
            skipped += 1
            continue
        added += 1
    db.commit()
    return BatchScanResponse(
        scanned=scanned,
        added=added,
        skipped=skipped,
        items=scan_pending_items(db),
    )


@app.get(f"{settings.api_prefix}/batch/pending", response_model=list[PendingArtifactRead])
def list_pending(
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[PendingArtifact]:
    query = select(PendingArtifact).order_by(PendingArtifact.created_at.desc())
    if status is not None:
        query = query.where(PendingArtifact.status == status)
    return list(db.scalars(query))


@app.get(f"{settings.api_prefix}/batch/pending/{{pending_id}}/image")
def pending_image(pending_id: int, db: Session = Depends(get_db)) -> Response:
    row = db.get(PendingArtifact, pending_id)
    if row is None:
        raise HTTPException(status_code=404, detail="记录不存在。")
    image_bytes, content_type = pending_artifact_image_bytes(row)
    return Response(content=image_bytes, media_type=content_type)


@app.patch(
    f"{settings.api_prefix}/batch/pending/{{pending_id}}",
    response_model=PendingArtifactRead,
)
def update_pending(
    pending_id: int,
    payload: PendingArtifactUpdate,
    db: Session = Depends(get_db),
) -> PendingArtifact:
    row = db.get(PendingArtifact, pending_id)
    if row is None:
        raise HTTPException(status_code=404, detail="记录不存在。")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, key, value)
    db.commit()
    db.refresh(row)
    return row


@app.delete(f"{settings.api_prefix}/batch/pending/{{pending_id}}", status_code=204)
def delete_pending(pending_id: int, db: Session = Depends(get_db)) -> None:
    row = db.get(PendingArtifact, pending_id)
    if row is not None:
        path = Path(row.source_path)
        if (
            path.is_absolute()
            and path.exists()
            and path.is_file()
            and LEGACY_BATCH_IMPORTS_DIR in path.parents
        ):
            path.unlink(missing_ok=True)
        db.delete(row)
        db.commit()


@app.post(f"{settings.api_prefix}/batch/identify/stream")
async def batch_identify_stream(payload: BatchIdentifyRequest) -> StreamingResponse:
    sites = enabled_sites()
    if not sites:
        raise HTTPException(
            status_code=400,
            detail="未启用网页桥（请设置 QWEN_WEB_ENABLED=true 并完成登录）。",
        )
    site = sites[0]

    async def event_generator():
        db = SessionLocal()
        try:
            query = select(PendingArtifact)
            if payload.ids:
                query = query.where(PendingArtifact.id.in_(payload.ids))
            else:
                query = query.where(PendingArtifact.status.in_(["pending", "failed"]))
            rows = list(db.scalars(query.order_by(PendingArtifact.created_at)))

            yield sse({"stage": "meta", "total": len(rows), "provider": site.key})

            for row in rows:
                yield sse({"stage": "start", "id": row.id, "file_name": row.file_name})
                row.status = "identifying"
                row.error = None
                db.commit()
                temp_path: Path | None = None
                try:
                    image_path, temp_path = materialize_pending_artifact_image(row)
                    candidate = await request_web_candidate(
                        site, [str(image_path)], DATA_DIR, row.file_name
                    )
                    matched_artifact = await fetch_cloud_artifact_match(
                        name=candidate.artifact_name,
                        museum_name=candidate.museum_name,
                        era=candidate.era,
                    )
                    row.museum_name = (
                        matched_artifact.artifact.museum_name
                        if matched_artifact is not None
                        else candidate.museum_name
                    )
                    row.name = (
                        matched_artifact.artifact.name
                        if matched_artifact is not None
                        else candidate.artifact_name
                    )
                    row.era = (
                        matched_artifact.artifact.era
                        if matched_artifact is not None
                        else candidate.era
                    )
                    row.description = (
                        matched_artifact.artifact.description
                        if matched_artifact is not None
                        else candidate.description
                    )
                    row.tags = candidate.tags or []
                    row.confidence = candidate.confidence
                    row.provider = candidate.provider
                    row.analysis = candidate.analysis
                    row.status = "identified"
                    db.commit()
                    db.refresh(row)
                    yield sse(
                        {
                            "stage": "item",
                            "id": row.id,
                            "item": PendingArtifactRead.model_validate(row).model_dump(
                                mode="json"
                            ),
                        }
                    )
                except Exception as exc:  # noqa: BLE001 - surface per-item failure
                    logger.warning("batch identify %s failed: %s", row.id, exc, exc_info=exc)
                    row.status = "failed"
                    row.error = str(exc) or "识别失败"
                    db.commit()
                    yield sse({"stage": "item_error", "id": row.id, "message": row.error})
                finally:
                    if temp_path is not None:
                        temp_path.unlink(missing_ok=True)

            yield sse({"stage": "done"})
        finally:
            db.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post(
    f"{settings.api_prefix}/batch/pending/{{pending_id}}/submit",
    response_model=PendingArtifactSubmitResult,
)
async def submit_pending(
    pending_id: int,
    payload: PendingArtifactSubmitRequest | None = None,
    db: Session = Depends(get_db),
) -> PendingArtifactSubmitResult:
    if not settings.cloud_api_base_url:
        raise HTTPException(status_code=400, detail="未配置 CLOUD_API_BASE_URL。")

    row = db.get(PendingArtifact, pending_id)
    if row is None:
        raise HTTPException(status_code=404, detail="记录不存在。")
    if row.status == "submitted":
        return row
    if row.status == "submitting":
        raise HTTPException(status_code=409, detail="该记录正在提交中，请稍候刷新。")
    if not (row.name and row.name.strip()) or not (row.museum_name and row.museum_name.strip()):
        raise HTTPException(status_code=400, detail="请先填写文物名称和博物馆名称。")

    row.status = "submitting"
    row.error = None
    db.commit()

    image_bytes, content_type = pending_artifact_image_bytes(row)
    base = settings.cloud_api_base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{base}{settings.api_prefix}/ingest/artifacts",
                files={"image": (row.file_name, image_bytes, content_type)},
                data={
                    "museum_name": row.museum_name,
                    "name": row.name,
                    "era": row.era or "",
                    "Place_of_Excavation": row.Place_of_Excavation or "",
                    "description": row.description or "",
                    "tags": json.dumps(row.tags or [], ensure_ascii=False),
                    "camera_model": row.camera_model or "",
                    "lens_model": row.lens_model or "",
                    "capture_museum_name": row.capture_museum_name or "",
                    "exhibition_name": normalize_exhibition_name(row.exhibition_name),
                    "latitude": "" if row.latitude is None else str(row.latitude),
                    "longitude": "" if row.longitude is None else str(row.longitude),
                    "captured_at": row.captured_at.isoformat() if row.captured_at else "",
                    "shutter_speed": row.shutter_speed or "",
                    "aperture": row.aperture or "",
                    "iso": "" if row.iso is None else str(row.iso),
                    "edit_method": row.edit_method or "",
                    "skip_existing_match": (
                        "true" if payload is not None and payload.skip_existing_match else "false"
                    ),
                    **(
                        {"existing_artifact_id": str(row.existing_artifact_id)}
                        if row.existing_artifact_id is not None
                        else {}
                    ),
                },
                headers={"Authorization": f"Bearer {settings.ingest_token}"},
            )
            if not response.is_success:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"提交云端失败：{extract_http_error_detail(response)}",
                )
            created = response.json()
    except Exception as exc:  # noqa: BLE001 - surface submit failure to the operator
        logger.warning("submit pending %s failed: %s", pending_id, exc, exc_info=exc)
        row.status = "failed"
        row.error = (
            exc.detail if isinstance(exc, HTTPException) else f"提交云端失败：{exc}"
        )
        db.commit()
        if isinstance(exc, HTTPException):
            raise HTTPException(status_code=exc.status_code, detail=row.error) from exc
        raise HTTPException(status_code=502, detail=row.error) from exc

    row.cloud_artifact_id = created.get("id")
    row.status = "submitted"
    db.commit()
    db.refresh(row)
    return PendingArtifactSubmitResult(
        item=PendingArtifactRead.model_validate(row),
        duplicate_image_skipped=bool(created.get("duplicate_image_skipped")),
        duplicate_image_detail=created.get("duplicate_image_detail"),
    )


@app.get(f"{settings.api_prefix}/museums", response_model=list[MuseumRead])
def list_museums(
    q: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[Museum]:
    query = (
        select(Museum)
        .options(selectinload(Museum.exhibitions), selectinload(Museum.artifacts))
        .order_by(Museum.name.asc())
    )
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.where(Museum.name.ilike(like))
    return list(db.scalars(query.limit(limit)))


@app.get(f"{settings.api_prefix}/era-options", response_model=list[EraOptionRead])
def list_era_options(db: Session = Depends(get_db)) -> list[EraOption]:
    query = select(EraOption).order_by(EraOption.sort_order.asc(), EraOption.name.asc())
    return list(db.scalars(query))


@app.post(f"{settings.api_prefix}/museums", response_model=MuseumRead, status_code=201)
def create_museum(payload: MuseumCreate, db: Session = Depends(get_db)) -> Museum:
    existing = db.scalar(select(Museum).where(Museum.name == payload.name))
    if existing is not None:
        raise HTTPException(status_code=400, detail="Museum already exists")

    museum = Museum(**payload.model_dump())
    db.add(museum)
    db.commit()
    db.refresh(museum)
    return museum


@app.patch(f"{settings.api_prefix}/museums/{{museum_id}}", response_model=MuseumRead)
def update_museum(
    museum_id: int,
    payload: MuseumUpdate,
    db: Session = Depends(get_db),
) -> Museum:
    museum = db.get(Museum, museum_id)
    if museum is None:
        raise HTTPException(status_code=404, detail="Museum not found")

    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Museum name is required")

    existing = db.scalar(select(Museum).where(Museum.name == name, Museum.id != museum_id))
    if existing is not None:
        raise HTTPException(status_code=400, detail="Museum already exists")

    museum.name = name
    museum.location = optional_text(payload.location)
    museum.latitude = payload.latitude
    museum.longitude = payload.longitude
    museum.description = optional_text(payload.description)
    db.commit()

    refreshed = db.scalar(
        select(Museum)
        .options(selectinload(Museum.exhibitions), selectinload(Museum.artifacts))
        .where(Museum.id == museum_id)
    )
    if refreshed is None:
        raise HTTPException(status_code=404, detail="Museum not found")
    return refreshed


@app.get(f"{settings.api_prefix}/exhibitions", response_model=list[ExhibitionRead])
def list_exhibitions(
    museum_id: int | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[Exhibition]:
    query = (
        select(Exhibition)
        .options(selectinload(Exhibition.museum))
        .order_by(Exhibition.created_at.desc())
    )
    if museum_id is not None:
        query = query.where(Exhibition.museum_id == museum_id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.where(Exhibition.name.ilike(like))
    return list(db.scalars(query.limit(limit)))


@app.post(f"{settings.api_prefix}/exhibitions", response_model=ExhibitionRead, status_code=201)
def create_exhibition(payload: ExhibitionCreate, db: Session = Depends(get_db)) -> Exhibition:
    museum = db.get(Museum, payload.museum_id)
    if museum is None:
        raise HTTPException(status_code=404, detail="Museum not found")
    exhibition = ensure_exhibition(db, museum, payload.name, payload.start_at, payload.end_at)
    db.commit()
    db.refresh(exhibition)
    return exhibition


@app.get(f"{settings.api_prefix}/artifacts", response_model=list[ArtifactRead])
def list_artifacts(
    museum_id: int | None = Query(default=None),
    era: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    q: str | None = Query(default=None),
    captured_after: datetime | None = Query(default=None),
    captured_before: datetime | None = Query(default=None),
    uploaded_after: datetime | None = Query(default=None),
    uploaded_before: datetime | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[Artifact] | list[ArtifactRead]:
    if should_proxy_artifact_queries_to_cloud():
        params = {
            "museum_id": museum_id,
            "era": era,
            "tag": tag,
            "q": q.strip() if q and q.strip() else None,
            "captured_after": captured_after.isoformat() if captured_after else None,
            "captured_before": captured_before.isoformat() if captured_before else None,
            "uploaded_after": uploaded_after.isoformat() if uploaded_after else None,
            "uploaded_before": uploaded_before.isoformat() if uploaded_before else None,
        }
        filtered_params = {
            key: value for key, value in params.items() if value is not None and value != ""
        }
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            with httpx.Client(timeout=30, follow_redirects=True) as client:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifacts",
                    params=filtered_params,
                )
                response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - surface cloud query failure to the operator
            raise HTTPException(status_code=502, detail=f"查询云端图库失败：{exc}") from exc
        return [ArtifactRead.model_validate(item) for item in response.json()]

    query = artifact_detail_query().order_by(Artifact.created_at.desc())
    if museum_id is not None:
        query = query.where(Artifact.museum_id == museum_id)
    if era is not None:
        query = query.where(Artifact.era == era)
    if tag is not None:
        query = query.join(Artifact.tags).where(ArtifactTag.name == tag).distinct()
    if captured_after is not None:
        query = query.join(Artifact.images).where(ArtifactImage.captured_at >= captured_after).distinct()
    if captured_before is not None:
        query = query.join(Artifact.images).where(ArtifactImage.captured_at <= captured_before).distinct()
    if uploaded_after is not None:
        query = query.join(Artifact.images).where(ArtifactImage.created_at >= uploaded_after).distinct()
    if uploaded_before is not None:
        query = query.join(Artifact.images).where(ArtifactImage.created_at <= uploaded_before).distinct()
    if q is not None and q.strip():
        like = f"%{q.strip()}%"
        query = (
            query.join(Artifact.museum)
            .outerjoin(Artifact.images)
            .outerjoin(Artifact.exhibition_links)
            .outerjoin(ArtifactExhibition.exhibition)
            .where(
            or_(
                Artifact.name.ilike(like),
                Artifact.description.ilike(like),
                Artifact.era.ilike(like),
                Artifact.Place_of_Excavation.ilike(like),
                Museum.name.ilike(like),
                ArtifactImage.camera_model.ilike(like),
                ArtifactImage.lens_model.ilike(like),
                ArtifactImage.capture_museum.has(Museum.name.ilike(like)),
                Exhibition.name.ilike(like),
            )
            )
            .distinct()
        )
    return list(db.scalars(query))


@app.patch(f"{settings.api_prefix}/artifacts/{{artifact_id}}", response_model=ArtifactRead)
def update_artifact(
    artifact_id: int,
    payload: ArtifactUpdate,
    db: Session = Depends(get_db),
) -> ArtifactRead:
    if not payload.museum_name.strip():
        raise HTTPException(status_code=400, detail="请填写或确认博物馆名称。")
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="请填写或确认文物名称。")

    if should_proxy_artifact_queries_to_cloud():
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            with httpx.Client(timeout=30, follow_redirects=True) as client:
                response = client.patch(
                    f"{base}{settings.api_prefix}/artifacts/{artifact_id}",
                    json=payload.model_dump(mode="json"),
                )
                response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - surface cloud update failure to the operator
            raise HTTPException(status_code=502, detail=f"更新云端文物失败：{exc}") from exc
        return ArtifactRead.model_validate(response.json())

    artifact = db.scalar(artifact_detail_query().where(Artifact.id == artifact_id))
    if artifact is None:
        raise HTTPException(status_code=404, detail="文物不存在。")

    museum = ensure_museum(db, payload.museum_name)
    artifact.museum_id = museum.id
    artifact.name = payload.name.strip()
    artifact.era = optional_text(payload.era)
    artifact.Place_of_Excavation = normalize_place_of_excavation(payload.Place_of_Excavation)
    artifact.description = optional_text(payload.description)

    target_image = None
    if payload.image_id is not None:
        target_image = next((image for image in artifact.images if image.id == payload.image_id), None)
        if target_image is None:
            raise HTTPException(status_code=404, detail="要编辑的图片不存在。")
    elif artifact.images:
        target_image = artifact.images[0]

    if target_image is not None:
        capture_museum, exhibition = resolve_capture_context(
            db,
            payload.capture_museum_name,
            payload.exhibition_name,
        )
        target_image.camera_model = optional_text(payload.camera_model)
        target_image.lens_model = optional_text(payload.lens_model)
        target_image.capture_museum_id = capture_museum.id if capture_museum is not None else None
        target_image.exhibition_id = exhibition.id if exhibition is not None else None
        target_image.capture_location = optional_text(payload.capture_location)
        target_image.latitude = payload.latitude
        target_image.longitude = payload.longitude
        target_image.captured_at = payload.captured_at
        target_image.shutter_speed = optional_text(payload.shutter_speed)
        target_image.aperture = optional_text(payload.aperture)
        target_image.iso = payload.iso
        target_image.edit_method = normalize_edit_method(payload.edit_method)

    sync_artifact_links_and_tags(
        artifact,
        [tag.strip() for tag in payload.tags if tag.strip()],
    )
    db.commit()
    refreshed = db.scalar(artifact_detail_query().where(Artifact.id == artifact_id))
    if refreshed is None:
        raise HTTPException(status_code=404, detail="文物不存在。")
    return ArtifactRead.model_validate(refreshed)


@app.get(f"{settings.api_prefix}/artifacts/match", response_model=ArtifactMatchRead | None)
def match_artifact(
    name: str = Query(..., min_length=1),
    museum_name: str | None = Query(default=None),
    era: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> ArtifactMatchRead | None:
    normalized_name = optional_text(name)
    normalized_museum_name = optional_text(museum_name)
    normalized_era = optional_text(era)
    if normalized_name is None or normalized_museum_name is None or normalized_era is None:
        return None

    if should_proxy_artifact_queries_to_cloud():
        params = {
            "name": normalized_name,
            "museum_name": normalized_museum_name,
            "era": normalized_era,
        }
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifacts/match",
                    params=params,
                )
                response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - surface lookup failure to the caller
            raise HTTPException(status_code=502, detail=f"查询云端同名文物失败：{exc}") from exc
        payload = response.json()
        return ArtifactMatchRead.model_validate(payload) if payload else None

    match = find_existing_artifact_match(
        db,
        name=normalized_name,
        museum_name=normalized_museum_name,
        era=normalized_era,
    )
    return build_artifact_match_read(match) if match is not None else None


@app.post(f"{settings.api_prefix}/artifacts", response_model=ArtifactRead, status_code=201)
def create_artifact(payload: ArtifactCreate, db: Session = Depends(get_db)) -> Artifact:
    museum = db.get(Museum, payload.museum_id)
    if museum is None:
        raise HTTPException(status_code=404, detail="Museum not found")

    artifact = Artifact(
        museum_id=payload.museum_id,
        name=payload.name,
        era=payload.era,
        Place_of_Excavation=normalize_place_of_excavation(payload.Place_of_Excavation),
        description=payload.description,
    )
    db.add(artifact)
    db.flush()
    capture_tags: list[str] = []
    linked_exhibition_ids: set[int] = set()
    prepared_images: list[ArtifactImage] = []
    for image in payload.images:
        capture_tags = merge_unique_tags(
            capture_tags,
            build_capture_tags(image.camera_model, image.lens_model),
        )
        capture_museum, exhibition = resolve_capture_context(
            db, image.capture_museum_name, image.exhibition_name
        )
        if exhibition is not None and exhibition.id not in linked_exhibition_ids:
            db.add(ArtifactExhibition(artifact_id=artifact.id, exhibition_id=exhibition.id))
            linked_exhibition_ids.add(exhibition.id)
        prepared_images.append(
            ArtifactImage(
                url=image.url,
                camera_model=image.camera_model,
                lens_model=image.lens_model,
                capture_museum_id=capture_museum.id if capture_museum is not None else None,
                exhibition_id=exhibition.id if exhibition is not None else None,
                capture_location=optional_text(image.capture_location),
                latitude=image.latitude,
                longitude=image.longitude,
                captured_at=image.captured_at,
                shutter_speed=image.shutter_speed,
                aperture=image.aperture,
                iso=image.iso,
                edit_method=normalize_edit_method(image.edit_method),
            )
        )
    artifact.tags = [
        ArtifactTag(name=tag)
        for tag in merge_unique_tags(
            [tag.strip() for tag in payload.tags if tag.strip()],
            capture_tags,
        )
    ]
    artifact.images = prepared_images
    db.commit()
    return db.scalar(artifact_detail_query().where(Artifact.id == artifact.id))


@app.get(f"{settings.api_prefix}/artifact-images", response_model=list[ArtifactImageRead])
def list_artifact_images(
    artifact_id: int | None = Query(default=None),
    museum_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[ArtifactImage]:
    query = artifact_image_query().order_by(ArtifactImage.created_at.desc())
    if artifact_id is not None:
        query = query.where(ArtifactImage.artifact_id == artifact_id)
    if museum_id is not None:
        query = query.join(ArtifactImage.artifact).where(Artifact.museum_id == museum_id)
    return list(db.scalars(query))


@app.get(f"{settings.api_prefix}/artifact-images/by-hash", response_model=ArtifactImageRead | None)
def get_artifact_image_by_hash(
    image_hash: str = Query(..., min_length=64, max_length=64),
    db: Session = Depends(get_db),
) -> ArtifactImageRead | None:
    if should_proxy_artifact_queries_to_cloud():
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifact-images/by-hash",
                    params={"image_hash": image_hash},
                )
                response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - surface lookup failure to the caller
            raise HTTPException(status_code=502, detail=f"查询云端重复图片失败：{exc}") from exc
        payload = response.json()
        return ArtifactImageRead.model_validate(payload) if payload else None

    match = find_artifact_image_by_hash_local(db, image_hash)
    return ArtifactImageRead.model_validate(match) if match is not None else None


@app.post(
    f"{settings.api_prefix}/artifact-images",
    response_model=ArtifactImageRead,
    status_code=201,
)
def create_artifact_image(
    payload: ArtifactImageAttach, db: Session = Depends(get_db)
) -> ArtifactImage:
    artifact = db.get(Artifact, payload.artifact_id)
    if artifact is None:
        raise HTTPException(status_code=404, detail="Artifact not found")

    capture_museum, exhibition = resolve_capture_context(
        db, payload.capture_museum_name, payload.exhibition_name
    )
    image = ArtifactImage(
        artifact_id=payload.artifact_id,
        url=payload.url,
        camera_model=payload.camera_model,
        lens_model=payload.lens_model,
        capture_museum_id=capture_museum.id if capture_museum is not None else None,
        exhibition_id=exhibition.id if exhibition is not None else None,
        capture_location=optional_text(payload.capture_location),
        latitude=payload.latitude,
        longitude=payload.longitude,
        captured_at=payload.captured_at,
        shutter_speed=payload.shutter_speed,
        aperture=payload.aperture,
        iso=payload.iso,
        edit_method=normalize_edit_method(payload.edit_method),
    )
    if image.exhibition_id is not None and not db.scalar(
        select(ArtifactExhibition).where(
            ArtifactExhibition.artifact_id == artifact.id,
            ArtifactExhibition.exhibition_id == image.exhibition_id,
        )
    ):
        db.add(ArtifactExhibition(artifact_id=artifact.id, exhibition_id=image.exhibition_id))
    for tag in build_capture_tags(payload.camera_model, payload.lens_model):
        if not any(existing.name == tag for existing in artifact.tags):
            artifact.tags.append(ArtifactTag(name=tag))
    db.add(image)
    db.commit()
    return db.scalar(artifact_image_query().where(ArtifactImage.id == image.id))
