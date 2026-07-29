import asyncio
import base64
import hashlib
import json
import logging
import math
import mimetypes
import re
import tempfile
import time as time_module
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from io import BytesIO
from uuid import uuid4
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Awaitable, BinaryIO, Callable
from urllib.parse import urlparse

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from starlette.concurrency import run_in_threadpool
from sqlalchemy import and_, func, inspect, or_, select, text
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.artifact_research.agent import prompt_sources, run_artifact_research
from app.artifact_research.router import router as artifact_research_router
from app.artifact_research.schemas import ArtifactResearchRequest
from app.db import Base, SessionLocal, engine, get_db
from app.exhibition_db import (
    ExhibitionSessionLocal,
    get_exhibition_db,
    initialize_exhibition_database,
)
from app.exhibition_models import (
    CatalogExhibition,
    ExhibitionSyncRun,
    ExhibitionSyncWorkerState,
)
from app.exhibition_schemas import (
    ExhibitionArtifactSummaryRead,
    ExhibitionCatalogItemRead,
    ExhibitionCatalogDetailRead,
    ExhibitionCatalogListRead,
    ExhibitionFacetRead,
    ExhibitionRecommendationRead,
    HistoricalExhibitionDetailRead,
    ExhibitionSyncAcceptedRead,
    ExhibitionSyncRunRead,
    ExhibitionSyncStatusRead,
    ExhibitionSyncWorkerRead,
    ExhibitionYearFacetRead,
)
from app.exhibition_service import (
    exhibition_backfill_remaining,
    exhibition_catalog_count,
    exhibition_sync_coordinator,
    latest_sync_run,
)
from app.exif_utils import (
    ImageExifData,
    ImageExifWriteError,
    extract_exif_and_preview_from_file,
    extract_exif_metadata,
    fingerprint_distance,
    image_content_fingerprint,
    update_image_exif_metadata,
)
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
from app.reference_data import WENWU_ERA_OPTIONS, WENWU_ERA_TIMELINE, WENWU_MUSEUM_OPTIONS
from app.reference_data import WENWU_MUSEUM_COORDINATES
from app.oss import delete_image, upload_image
from app.schemas import (
    ArtifactCreate,
    ArtifactDescriptionCandidateRead,
    ArtifactDescriptionGenerateRead,
    ArtifactDescriptionGenerateRequest,
    ArtifactFieldWarningRead,
    ArtifactVerifiedClaimRead,
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
    EraTimelineItemRead,
    EraTimelineRead,
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
    MuseumDirectoryRead,
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
    sanitize_generated_tags,
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
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
cloud_http_client: httpx.AsyncClient | None = None
MUSEUM_SEGMENT_PATTERN = re.compile(r"(博物馆|纪念馆|美术馆|收藏|馆藏|藏)$")

logger = logging.getLogger("app.vision")

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path("/data") if Path("/data").exists() else BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
LEGACY_BATCH_IMPORTS_DIR = DATA_DIR / "batch_imports"
IMAGE_VARIANT_CACHE_DIR = DATA_DIR / "image_variants"
MAX_IMAGE_SOURCE_BYTES = 100 * 1024 * 1024
IMAGE_VARIANT_MASTER_SIZE = 1280
IMAGE_VARIANT_LOCKS: dict[str, asyncio.Lock] = {}
IMAGE_VARIANT_WORK_SEMAPHORE = asyncio.Semaphore(
    max(1, settings.image_variant_concurrency)
)


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

    if "exhibitions" in table_names:
        exhibition_columns = {
            column["name"] for column in inspect(connection).get_columns("exhibitions")
        }
        exhibition_column_definitions = {
            "catalog_source_id": "VARCHAR(32)",
            "catalog_exhibition_id": "INTEGER",
        }
        for column_name, column_type in exhibition_column_definitions.items():
            if column_name not in exhibition_columns:
                connection.execute(
                    text(f"ALTER TABLE exhibitions ADD COLUMN {column_name} {column_type}")
                )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_exhibitions_catalog_source_id "
                "ON exhibitions (catalog_source_id)"
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_exhibitions_catalog_exhibition_id "
                "ON exhibitions (catalog_exhibition_id)"
            )
        )

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
        "content_hash": "VARCHAR(64)",
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
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_artifact_images_content_hash "
            "ON artifact_images (content_hash)"
        )
    )
    # Historical image hashing is intentionally not a startup migration.
    # Downloading and decoding every legacy OSS object here used to hold this
    # transaction open for hours, preventing even /health from becoming ready.
    # New uploads populate all hashes during ingest; legacy backfill belongs in
    # an explicit, resumable maintenance job.

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
    global cloud_http_client
    startup_started_at = time_module.perf_counter()
    logger.info("application startup: initializing schema and reference data")
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    IMAGE_VARIANT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with engine.begin() as connection:
        try:
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        except Exception:
            pass
        Base.metadata.create_all(bind=connection)
        run_startup_migrations(connection)
        sync_reference_options(connection)
    logger.info(
        "application startup: primary database ready in %.0fms",
        (time_module.perf_counter() - startup_started_at) * 1000,
    )
    exhibition_catalog_ready = False
    try:
        initialize_exhibition_database()
        exhibition_catalog_ready = True
    except Exception:
        logger.warning(
            "exhibition catalog database is unavailable; catalog API will recover when it is online",
            exc_info=True,
        )
    # Do not run whole-library image maintenance before the application becomes
    # ready. On a large collection this is CPU-bound and blocks every endpoint.
    if settings.exhibition_sync_enabled and exhibition_catalog_ready:
        exhibition_sync_coordinator.start_scheduler()
        with ExhibitionSessionLocal() as exhibition_db:
            catalog_total = exhibition_catalog_count(exhibition_db)
            latest_run = latest_sync_run(exhibition_db)
            discovered_total = latest_run.discovered if latest_run is not None else 0
            if catalog_total == 0 or catalog_total < discovered_total:
                exhibition_sync_coordinator.start(
                    mode="incremental",
                    trigger="bootstrap",
                )
    cloud_http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(120, connect=15),
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    )
    logger.info(
        "application startup complete in %.0fms",
        (time_module.perf_counter() - startup_started_at) * 1000,
    )
    try:
        yield
    finally:
        await cloud_http_client.aclose()
        cloud_http_client = None
        await exhibition_sync_coordinator.stop()


app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.mount("/files", StaticFiles(directory=str(DATA_DIR)), name="files")
app.include_router(artifact_research_router, prefix=settings.api_prefix)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Source-Hash", "Server-Timing"],
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


def is_allowed_remote_image_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False

    hostname = parsed.hostname.lower()
    if hostname == "aliyuncs.com" or hostname.endswith(".aliyuncs.com"):
        return True

    configured_hosts = {
        urlparse(candidate).hostname
        for candidate in (
            settings.cloud_api_base_url,
            settings.oss_endpoint,
            settings.oss_public_base_url,
        )
        if candidate
    }
    return hostname in {host.lower() for host in configured_hosts if host}


async def load_image_source_bytes(image_url: str) -> bytes:
    normalized_url = image_url.strip()
    if normalized_url.startswith("/files/uploads/"):
        if not should_proxy_artifact_queries_to_cloud():
            return resolve_uploaded_file_path(normalized_url).read_bytes()
        normalized_url = f"{settings.cloud_api_base_url.rstrip('/')}{normalized_url}"

    if not is_allowed_remote_image_url(normalized_url):
        raise HTTPException(status_code=400, detail="不支持的图片来源。")

    referer = settings.cors_origins_list[0].rstrip("/") + "/" if settings.cors_origins_list else ""
    request_headers = {
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 MuseumImageDB/1.0",
    }
    if referer:
        request_headers["Referer"] = referer

    try:
        async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
            response = await client.get(normalized_url, headers=request_headers)
            response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"读取图片失败：{exc}") from exc

    if len(response.content) > MAX_IMAGE_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="原图过大，无法生成缩略图。")
    return response.content


def render_image_variant(source_bytes: bytes, target_path: Path, size: int) -> None:
    with Image.open(BytesIO(source_bytes)) as source:
        # JPEG draft mode asks the decoder to load a reduced-resolution image.
        # This substantially lowers peak memory and CPU for 40–100 MP originals
        # while preserving more than enough detail for the 1280 px master.
        source.draft("RGB", (size, size))
        image = ImageOps.exif_transpose(source)
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        if image.mode != "RGB":
            image = image.convert("RGB")

        buffer = BytesIO()
        image.save(
            buffer,
            format="WEBP",
            quality=74 if size <= 480 else 82,
            method=4,
        )

    temporary_path = target_path.with_suffix(f".{uuid4().hex}.tmp")
    temporary_path.write_bytes(buffer.getvalue())
    temporary_path.replace(target_path)


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
    catalog_source_id: str | None = None,
    catalog_exhibition_id: int | None = None,
) -> Exhibition:
    name = optional_text(exhibition_name) or "常设"
    normalized_catalog_source_id = optional_text(catalog_source_id)
    exhibition = None
    if normalized_catalog_source_id:
        exhibition = db.scalar(
            select(Exhibition)
            .where(Exhibition.catalog_source_id == normalized_catalog_source_id)
            .order_by(Exhibition.id.asc())
        )
    if exhibition is None:
        exhibition = db.scalar(
            select(Exhibition).where(
                Exhibition.museum_id == museum.id,
                Exhibition.name == name,
            )
        )
    if exhibition is None:
        normalized_name = normalize_museum_directory_key(name)
        exhibition = next(
            (
                candidate
                for candidate in db.scalars(
                    select(Exhibition)
                    .where(Exhibition.museum_id == museum.id)
                    .order_by(Exhibition.id.asc())
                )
                if normalize_museum_directory_key(candidate.name) == normalized_name
            ),
            None,
        )
    if exhibition is not None:
        if exhibition.start_at is None and start_at is not None:
            exhibition.start_at = start_at
        if exhibition.end_at is None and end_at is not None:
            exhibition.end_at = end_at
        if normalized_catalog_source_id:
            exhibition.catalog_source_id = normalized_catalog_source_id
        if catalog_exhibition_id is not None:
            exhibition.catalog_exhibition_id = catalog_exhibition_id
        db.flush()
        return exhibition

    exhibition = Exhibition(
        museum_id=museum.id,
        name=name,
        catalog_source_id=normalized_catalog_source_id,
        catalog_exhibition_id=catalog_exhibition_id,
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


def normalize_artifact_field_warnings(
    raw_warnings: object,
    *,
    artifact_name: str,
    era: str | None,
    museum_name: str | None,
    place_of_excavation: str | None,
) -> list[ArtifactFieldWarningRead]:
    if not isinstance(raw_warnings, list):
        return []

    field_defaults = {
        "artifact_name": ("文物名称", artifact_name),
        "era": ("时代", era or ""),
        "museum_name": ("馆藏单位", museum_name or ""),
        "place_of_excavation": ("出土地点", place_of_excavation or ""),
    }
    aliases = {
        "name": "artifact_name",
        "artifact": "artifact_name",
        "Place_of_Excavation": "place_of_excavation",
        "excavation": "place_of_excavation",
        "museum": "museum_name",
    }
    normalized: list[ArtifactFieldWarningRead] = []
    for item in raw_warnings:
        if isinstance(item, dict):
            raw_field = str(item.get("field", "")).strip()
            field = aliases.get(raw_field, raw_field)
            if field not in field_defaults:
                continue
            default_label, default_value = field_defaults[field]
            reason = optional_text(str(item.get("reason", "")))
            if reason is None:
                continue
            refs = item.get("source_refs", [])
            normalized.append(
                ArtifactFieldWarningRead(
                    field=field,
                    label=optional_text(str(item.get("label", ""))) or default_label,
                    input_value=optional_text(str(item.get("input_value", ""))) or default_value,
                    suggested_value=optional_text(
                        str(item["suggested_value"])
                        if item.get("suggested_value") is not None
                        else None
                    ),
                    reason=reason,
                    source_refs=[
                        str(ref).strip()
                        for ref in refs
                        if isinstance(ref, (str, int)) and str(ref).strip()
                    ] if isinstance(refs, list) else [],
                )
            )
            continue

        reason = optional_text(str(item))
        if reason is None:
            continue
        lowered = reason.casefold()
        if "出土" in reason or "遗址" in reason:
            field = "place_of_excavation"
        elif "馆藏" in reason or "博物馆" in reason or "博物院" in reason:
            field = "museum_name"
        elif "时代" in reason or "年代" in reason:
            field = "era"
        elif "名称" in reason or "定名" in reason:
            field = "artifact_name"
        else:
            logger.info("ignored unlocatable field warning: %s", lowered)
            continue
        label, input_value = field_defaults[field]
        normalized.append(
            ArtifactFieldWarningRead(
                field=field,
                label=label,
                input_value=input_value,
                reason=reason,
            )
        )
    return normalized


def normalize_verified_claims(
    raw_claims: object,
    description: str,
) -> tuple[str, list[ArtifactVerifiedClaimRead]]:
    claims: list[ArtifactVerifiedClaimRead] = []
    if isinstance(raw_claims, list):
        for item in raw_claims:
            if isinstance(item, dict):
                text_value = optional_text(str(item.get("text", "")))
                refs = item.get("source_refs", [])
            else:
                text_value = optional_text(str(item))
                refs = []
            if text_value is None:
                continue
            clean_text = re.sub(r"\[(?:联网核验|来源\d+)\]", "", text_value).strip()
            if clean_text and clean_text[-1] not in "。！？":
                clean_text += "。"
            source_refs = [
                str(ref).strip()
                for ref in refs
                if isinstance(ref, (str, int)) and str(ref).strip()
            ] if isinstance(refs, list) else []
            if clean_text and not any(existing.text == clean_text for existing in claims):
                claims.append(ArtifactVerifiedClaimRead(text=clean_text, source_refs=source_refs))

    legacy_pattern = re.compile(r"([^。！？\n]+?)\[联网核验\]([。！？]?)")

    def remove_legacy_marker(match: re.Match[str]) -> str:
        claim = match.group(1).strip(" ，,；;")
        punctuation = match.group(2) or "。"
        clean_text = f"{claim}{punctuation}" if claim else ""
        if clean_text and not any(existing.text == clean_text for existing in claims):
            claims.append(
                ArtifactVerifiedClaimRead(
                    text=clean_text,
                    source_refs=["联网核验"],
                )
            )
        return ""

    clean_description = legacy_pattern.sub(remove_legacy_marker, description)
    clean_description = re.sub(r"\[联网核验\]", "", clean_description)
    clean_description = re.sub(r"[ \t]+", " ", clean_description)
    clean_description = re.sub(r"\n{3,}", "\n\n", clean_description)
    clean_description = re.sub(r"^[，,；;。\s]+", "", clean_description).strip()
    return clean_description, claims


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
    if text_value.startswith("五代十国") or any(
        text_value == token or text_value.startswith(token)
        for token in ERA_TOKEN_CANDIDATES
    ):
        # The filename parser may recognize an era, but it must not rewrite the
        # operator's wording. "隋" stays "隋"; an explicitly entered "隋代"
        # stays "隋代".
        return text_value
    return text_value


def normalize_museum_segment(value: str) -> str:
    segment = value.strip()
    if not segment:
        return segment
    if segment.endswith("馆藏") and len(segment) > 2:
        return f"{segment[:-2]}馆"
    if segment.endswith("藏") and segment[:-1].endswith(("博物馆", "博物院", "纪念馆", "美术馆")):
        return segment[:-1]
    return segment


def normalize_museum_directory_key(value: str | None) -> str:
    if not value:
        return ""
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\s·•・,，。．()（）\[\]【】<>《》\-—–_/]+", "", normalized)


def catalog_museum_directory_id(venue: str, city: str, region: str) -> int:
    digest = hashlib.sha256(f"{venue}\0{city}\0{region}".encode("utf-8")).digest()
    return -(int.from_bytes(digest[:8], "big") % 2_000_000_000 + 1)


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
            any(segment == token or segment.startswith(token) for token in ERA_TOKEN_CANDIDATES)
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
        # Tomb names are often part of the artifact title itself, for example
        # “韩休墓北壁《山水图》”. Only explicit excavation/provenance wording
        # should win the place field during the first pass.
        if place_of_excavation is None and ("出土" in segment or "遗址" in segment):
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
    catalog_exhibition_source_id: str | None = None,
    catalog_exhibition_id: int | None = None,
) -> tuple[Museum | None, Exhibition | None]:
    catalog_item: CatalogExhibition | None = None
    normalized_source_id = optional_text(catalog_exhibition_source_id)
    if normalized_source_id or catalog_exhibition_id is not None:
        try:
            with ExhibitionSessionLocal() as catalog_db:
                if normalized_source_id:
                    catalog_item = catalog_db.scalar(
                        select(CatalogExhibition).where(
                            CatalogExhibition.source_id == normalized_source_id
                        )
                    )
                elif catalog_exhibition_id is not None:
                    catalog_item = catalog_db.get(CatalogExhibition, catalog_exhibition_id)
        except Exception:
            logger.warning("resolve catalog exhibition failed", exc_info=True)

    resolved_capture_museum_name = (
        optional_text(catalog_item.museum_name) if catalog_item is not None else None
    ) or optional_text(capture_museum_name)
    if resolved_capture_museum_name is None and catalog_item is not None:
        resolved_capture_museum_name = (
            optional_text(catalog_item.venue)
            or optional_text(catalog_item.city)
        )
    capture_museum = (
        ensure_museum(db, resolved_capture_museum_name)
        if resolved_capture_museum_name
        else None
    )
    resolved_exhibition_name = (
        catalog_item.title if catalog_item is not None else exhibition_name
    )
    exhibition = (
        ensure_exhibition(
            db,
            capture_museum,
            resolved_exhibition_name,
            (
                datetime.combine(catalog_item.start_date, time.min)
                if catalog_item is not None and catalog_item.start_date is not None
                else None
            ),
            (
                datetime.combine(catalog_item.end_date, time.max)
                if catalog_item is not None and catalog_item.end_date is not None
                else None
            ),
            catalog_source_id=(
                catalog_item.source_id if catalog_item is not None else normalized_source_id
            ),
            catalog_exhibition_id=(
                catalog_item.id if catalog_item is not None else catalog_exhibition_id
            ),
        )
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


def persist_upload_and_build_preview(
    source: BinaryIO,
    target_path: Path,
) -> tuple[str, ImageExifData, bytes | None]:
    """Persist an upload without duplicating the full image in process memory."""
    digest = hashlib.sha256()
    source.seek(0)
    with target_path.open("wb") as target:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
            target.write(chunk)
    source.seek(0)
    metadata, preview_bytes = extract_exif_and_preview_from_file(source)
    return digest.hexdigest(), metadata, preview_bytes


def verify_written_gps(image_bytes: bytes, latitude: float | None, longitude: float | None) -> None:
    """Fail loudly instead of uploading an image whose requested GPS was not written."""
    if latitude is None or longitude is None:
        return
    metadata = extract_exif_metadata(image_bytes)
    if (
        metadata.latitude is None
        or metadata.longitude is None
        or abs(metadata.latitude - latitude) > 0.00001
        or abs(metadata.longitude - longitude) > 0.00001
    ):
        raise HTTPException(status_code=500, detail="图片 GPS 写入校验失败，未提交入库。")


def find_artifact_image_by_hash_local(db: Session, image_hash: str) -> ArtifactImage | None:
    return db.scalar(artifact_image_query().where(ArtifactImage.image_hash == image_hash))


def find_artifact_image_by_source_hash_local(db: Session, source_hash: str | None) -> ArtifactImage | None:
    if not source_hash:
        return None
    return db.scalar(artifact_image_query().where(ArtifactImage.source_hash == source_hash))


def find_artifact_images_by_content(
    db: Session,
    content_hash: str | None,
    *,
    max_distance: int = 8,
) -> list[ArtifactImage]:
    if not content_hash:
        return []
    candidates = db.execute(
        select(ArtifactImage.id, ArtifactImage.content_hash)
        .where(ArtifactImage.content_hash.is_not(None))
        .order_by(ArtifactImage.id.asc())
    )
    matched_ids = [
        image_id
        for image_id, candidate_hash in candidates
        if (
            (distance := fingerprint_distance(content_hash, candidate_hash)) is not None
            and distance <= max_distance
        )
    ]
    if not matched_ids:
        return []
    return list(
        db.scalars(
            artifact_image_query()
            .where(ArtifactImage.id.in_(matched_ids))
            .order_by(ArtifactImage.id.asc())
        ).unique()
    )


def cleanup_existing_content_duplicates() -> int:
    """Keep the latest copy when the same photo already exists on one artifact."""
    removed_urls: list[str] = []
    removed_count = 0
    with SessionLocal() as db:
        images = list(
            db.scalars(
                select(ArtifactImage)
                .where(ArtifactImage.content_hash.is_not(None))
                .order_by(ArtifactImage.artifact_id.asc(), ArtifactImage.id.desc())
            )
        )
        keepers: dict[int, list[ArtifactImage]] = {}
        for image in images:
            artifact_keepers = keepers.setdefault(image.artifact_id, [])
            duplicate = any(
                (distance := fingerprint_distance(image.content_hash, keeper.content_hash)) is not None
                and distance <= 8
                for keeper in artifact_keepers
            )
            if not duplicate:
                artifact_keepers.append(image)
                continue
            removed_urls.append(image.url)
            db.delete(image)
            removed_count += 1
        if removed_count:
            db.commit()

    for old_url in set(removed_urls):
        if not old_url.startswith(("http://", "https://")):
            continue
        try:
            delete_image(old_url)
        except Exception as exc:  # noqa: BLE001 - DB cleanup must remain committed
            logger.warning("delete historical duplicate OSS image failed for %s: %s", old_url, exc)
    if removed_count:
        logger.info("cleaned %d historical duplicate artifact images", removed_count)
    return removed_count


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
    catalog_exhibition_source_id: str | None = None,
    catalog_exhibition_id: int | None = None,
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
        "catalog_exhibition_source_id": catalog_exhibition_source_id or "",
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
    if catalog_exhibition_id is not None:
        submit_data["catalog_exhibition_id"] = str(catalog_exhibition_id)

    cloud_url = f"{base}{settings.api_prefix}/ingest/artifacts"
    client = cloud_http_client
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(120, connect=15),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    started_at = time_module.perf_counter()
    try:
        for attempt in range(2):
            try:
                response = await client.post(
                    cloud_url,
                    files={"image": (image_name, image_bytes, content_type)},
                    data=submit_data,
                    headers={"Authorization": f"Bearer {settings.ingest_token}"},
                )
            except httpx.RequestError as exc:
                if attempt == 0:
                    logger.warning("cloud ingest connection failed for %s; retrying once: %s", image_name, exc)
                    await asyncio.sleep(0.8)
                    continue
                raise HTTPException(status_code=502, detail=f"提交云端失败：{exc}") from exc

            if response.status_code in {502, 503, 504} and attempt == 0:
                logger.warning(
                    "cloud ingest returned HTTP %s for %s; retrying once. response=%s",
                    response.status_code,
                    image_name,
                    response.text[:2000],
                )
                await asyncio.sleep(0.8)
                continue
            if not response.is_success:
                detail = extract_http_error_detail(response)
                logger.error(
                    "cloud ingest failed for %s with HTTP %s: %s",
                    image_name,
                    response.status_code,
                    detail,
                )
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"提交云端失败：{detail}",
                )
            break
    except Exception as exc:  # noqa: BLE001 - surface submit failure to the operator
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(status_code=502, detail=f"提交云端失败：{exc}") from exc
    finally:
        if owns_client:
            await client.aclose()
        logger.info(
            "cloud ingest round trip completed for %s in %.0fms",
            image_name,
            (time_module.perf_counter() - started_at) * 1000,
        )

    return ArtifactRead.model_validate(response.json())


async def generate_artifact_description_payload(
    *,
    image_urls: list[str],
    museum_name: str | None,
    name: str,
    era: str | None,
    Place_of_Excavation: str | None,
    event_callback: Callable[[dict[str, object]], Awaitable[None]] | None = None,
) -> ArtifactDescriptionGenerateRead:
    fallback_description = build_fallback_description(
        museum_name=museum_name,
        name=name,
        era=era,
        Place_of_Excavation=Place_of_Excavation,
    )
    try:
        if event_callback is not None:
            await event_callback({
                "type": "research_start",
                "message": "文物检索 Agent 正在规划查询并核对四项字段",
            })
        research = await run_artifact_research(
            ArtifactResearchRequest(
                artifact_name=name,
                era=era,
                museum_name=museum_name,
                place_of_excavation=Place_of_Excavation,
            )
        )
        if event_callback is not None:
            await event_callback({
                "type": "research_complete",
                "message": "联网检索与交叉核验完成",
                "research_id": research.research_id,
                "summary": research.research_summary,
                "source_count": len(research.web_sources) + len(research.knowledge_sources),
            })
        raw_results, unavailable_providers = await generate_artifact_descriptions_parallel(
            image_urls=[],
            data_dir=DATA_DIR,
            artifact_name=name,
            era=era,
            museum_name=museum_name,
            place_of_excavation=Place_of_Excavation,
            search_hits=prompt_sources(research),
            research_summary=research.research_summary,
            event_callback=event_callback,
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
            description, verified_claims = normalize_verified_claims(
                result.get("verified_claims", []),
                description,
            )
            description = description or fallback_description
            tags = sanitize_generated_tags(
                [
                    str(tag).strip()
                    for tag in result.get("tags", [])
                    if str(tag).strip()
                ],
                name,
                era,
                museum_name,
            )
            field_warnings = normalize_artifact_field_warnings(
                result.get("field_warnings", []),
                artifact_name=name,
                era=era,
                museum_name=museum_name,
                place_of_excavation=Place_of_Excavation,
            )
            search_hits = item.get("search_hits", [])
            if not isinstance(search_hits, list):
                search_hits = []
            candidate = ArtifactDescriptionCandidateRead(
                provider=str(provider.name),
                model=str(provider.model),
                description=description,
                tags=tags,
                reasoning=optional_text(str(result.get("reasoning", "")))
                or optional_text(str(item.get("reasoning", ""))),
                research_summary=optional_text(str(item.get("research_summary", ""))),
                field_warnings=field_warnings,
                verified_claims=verified_claims,
                search_hits=search_hits,
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
                research_id=research.research_id,
                candidates=candidates,
                unavailable_providers=unavailable_providers,
            )

        return ArtifactDescriptionGenerateRead(
            provider="fallback",
            model="fallback",
            description=fallback_description,
            tags=[],
            research_id=research.research_id,
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


def fetch_cloud_artifact_payload(
    params: dict[str, object] | None = None,
) -> list[dict]:
    base = settings.cloud_api_base_url.rstrip("/")
    last_error: Exception | None = None
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        for attempt in range(2):
            try:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifacts",
                    params=params,
                )
                if response.status_code in {502, 503, 504} and attempt == 0:
                    continue
                response.raise_for_status()
                payload = response.json()
                return payload if isinstance(payload, list) else []
            except (httpx.RequestError, httpx.HTTPStatusError) as exc:
                last_error = exc
                if attempt == 0:
                    continue
                raise
    if last_error is not None:
        raise last_error
    return []


def build_artifact_match_read(match: ArtifactMatchCandidate) -> ArtifactMatchRead:
    return ArtifactMatchRead(
        artifact=ArtifactRead.model_validate(match.artifact),
        match_score=match.score,
        match_reason=match.reason,
    )


def artifact_read_merge_key(artifact: ArtifactRead) -> tuple[str, str, str] | None:
    museum_key = normalize_identity_text(artifact.museum_name)
    era_key = normalize_identity_text(artifact.era)
    name_key = compact_artifact_name_for_match(artifact.name)
    if museum_key is None or era_key is None or name_key is None:
        return None
    return museum_key, era_key, name_key


def datetime_sort_value(value: datetime | None) -> float:
    if value is None:
        return 0
    try:
        return value.timestamp()
    except (OSError, ValueError):
        return 0


def merge_duplicate_artifact_reads(items: list[Artifact | ArtifactRead | dict]) -> list[ArtifactRead]:
    merged: list[ArtifactRead] = []
    keyed_indexes: dict[tuple[str, str, str], int] = {}

    for raw_item in items:
        item = ArtifactRead.model_validate(raw_item)
        key = artifact_read_merge_key(item)
        if key is None:
            merged.append(item)
            continue

        existing_index = keyed_indexes.get(key)
        if existing_index is None:
            keyed_indexes[key] = len(merged)
            merged.append(item)
            continue

        existing = merged[existing_index]
        images_by_id = {image.id: image for image in existing.images}
        for image in item.images:
            images_by_id.setdefault(image.id, image)
        images = sorted(
            images_by_id.values(),
            key=lambda image: (image.uploaded_at, image.id),
            reverse=True,
        )

        exhibitions_by_id = {exhibition.id: exhibition for exhibition in existing.exhibitions}
        for exhibition in item.exhibitions:
            exhibitions_by_id.setdefault(exhibition.id, exhibition)

        merged[existing_index] = existing.model_copy(
            update={
                "tags": merge_unique_tags(existing.tags, item.tags),
                "images": images,
                "exhibitions": sorted(
                    exhibitions_by_id.values(),
                    key=lambda exhibition: (datetime_sort_value(exhibition.start_at), exhibition.id),
                    reverse=True,
                ),
                "description": existing.description or item.description,
                "Place_of_Excavation": existing.Place_of_Excavation or item.Place_of_Excavation,
            }
        )

    return merged


def enrich_artifact_catalog_links(items: list[ArtifactRead]) -> list[ArtifactRead]:
    missing_names = {
        exhibition.name.strip()
        for item in items
        for exhibition in item.exhibitions
        if exhibition.name.strip() and not exhibition.catalog_source_id
    }
    if not missing_names:
        return items

    try:
        with ExhibitionSessionLocal() as catalog_db:
            catalog_items = list(
                catalog_db.scalars(
                    select(CatalogExhibition).where(
                        CatalogExhibition.title.in_(sorted(missing_names))
                    )
                )
            )
    except Exception:
        logger.warning("enrich artifact exhibition catalog links failed", exc_info=True)
        return items

    by_title: dict[str, list[CatalogExhibition]] = {}
    by_source_id: dict[str, CatalogExhibition] = {}
    for catalog_item in catalog_items:
        by_title.setdefault(catalog_item.title, []).append(catalog_item)
        by_source_id[catalog_item.source_id] = catalog_item

    enriched_items: list[ArtifactRead] = []
    for item in items:
        enriched_exhibitions: list[ExhibitionRead] = []
        for exhibition in item.exhibitions:
            if exhibition.catalog_source_id:
                enriched_exhibitions.append(exhibition)
                continue
            candidates = by_title.get(exhibition.name.strip(), [])
            if not candidates:
                enriched_exhibitions.append(exhibition)
                continue

            def candidate_score(candidate: CatalogExhibition) -> tuple[int, int]:
                score = 0
                museum_name = exhibition.museum_name.casefold()
                if candidate.museum_name and (
                    museum_name in candidate.museum_name.casefold()
                    or candidate.museum_name.casefold() in museum_name
                ):
                    score += 40
                if candidate.venue and (
                    museum_name in candidate.venue.casefold()
                    or candidate.venue.casefold() in museum_name
                ):
                    score += 20
                if exhibition.start_at and candidate.start_date:
                    score += max(
                        0,
                        10
                        - abs((exhibition.start_at.date() - candidate.start_date).days),
                    )
                return score, -candidate.id

            matched = max(candidates, key=candidate_score)
            enriched_exhibitions.append(
                exhibition.model_copy(
                    update={
                        "catalog_source_id": matched.source_id,
                        "catalog_exhibition_id": matched.id,
                    }
                )
            )

        deduped_exhibitions: dict[str, ExhibitionRead] = {}
        for exhibition in enriched_exhibitions:
            identity = (
                f"catalog:{exhibition.catalog_source_id}"
                if exhibition.catalog_source_id
                else "manual:"
                f"{normalize_museum_directory_key(exhibition.museum_name)}:"
                f"{normalize_museum_directory_key(exhibition.name)}"
            )
            existing = deduped_exhibitions.get(identity)
            if existing is None:
                deduped_exhibitions[identity] = exhibition
                continue
            catalog_item = (
                by_source_id.get(exhibition.catalog_source_id)
                if exhibition.catalog_source_id
                else None
            )
            if catalog_item and catalog_item.museum_name:
                canonical_museum = normalize_museum_directory_key(catalog_item.museum_name)
                existing_matches = (
                    normalize_museum_directory_key(existing.museum_name)
                    == canonical_museum
                )
                current_matches = (
                    normalize_museum_directory_key(exhibition.museum_name)
                    == canonical_museum
                )
                if current_matches and not existing_matches:
                    deduped_exhibitions[identity] = exhibition

        enriched_items.append(item.model_copy(update={
            "exhibitions": list(deduped_exhibitions.values()),
        }))
    return enriched_items


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

    # Auto-reuse changes an existing collection record, so it requires an
    # exact normalized name in addition to the exact museum and era above.
    # Near-name candidates may still be surfaced for a human to inspect, but
    # must never be selected automatically for ingestion.
    return None


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
        suffix = Path(file.filename or "").suffix.lower()
        generated_name = f"{uuid4().hex}{suffix}"
        target_path = UPLOADS_DIR / generated_name
        image_hash, exif, preview_bytes = await run_in_threadpool(
            persist_upload_and_build_preview,
            file.file,
            target_path,
        )
        if target_path.stat().st_size == 0:
            target_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="图片内容为空。")
        duplicate_image = await find_duplicate_artifact_image(db, image_hash)
        if duplicate_image is not None:
            target_path.unlink(missing_ok=True)
            raise HTTPException(status_code=409, detail=build_duplicate_image_detail(duplicate_image))

        uploaded_images.append(
            UploadedImageRead(
                filename=file.filename or generated_name,
                url=build_uploaded_file_url(generated_name),
                preview_data_url=(
                    f"data:image/jpeg;base64,{base64.b64encode(preview_bytes).decode('ascii')}"
                    if preview_bytes else None
                ),
                uploaded_at=datetime.now(timezone.utc),
                capture_museum_name=None,
                exhibition_name=None,
                camera_model=exif.camera_model,
                lens_model=exif.lens_model,
                latitude=exif.latitude,
                longitude=exif.longitude,
                captured_at=exif.captured_at,
                shutter_speed=exif.shutter_speed,
                aperture=exif.aperture,
                iso=exif.iso,
                edit_method=None,
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
    return await generate_artifact_description_payload(
        image_urls=[],
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
    async def event_generator():
        event_queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()

        async def emit(event: dict[str, object]) -> None:
            await event_queue.put(event)

        yield f"data: {json.dumps({'type': 'progress', 'message': '已读取名称、年代、博物馆与出土地点'}, ensure_ascii=False)}\n\n"
        task = asyncio.create_task(generate_artifact_description_payload(
            image_urls=[],
            museum_name=museum_name,
            name=name,
            era=era,
            Place_of_Excavation=Place_of_Excavation,
            event_callback=emit,
        ))
        while not task.done() or not event_queue.empty():
            try:
                event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'heartbeat'}, ensure_ascii=False)}\n\n"
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
    display_location_name: str | None = Form(None),
    latitude: float | None = Form(None),
    longitude: float | None = Form(None),
    camera_model: str | None = Form(None),
    lens_model: str | None = Form(None),
    captured_at: datetime | None = Form(None),
    shutter_speed: str | None = Form(None),
    aperture: str | None = Form(None),
    iso: int | None = Form(None),
    clean_exif: bool = Form(False),
) -> Response:
    """Return edited bytes for a user-authorised local overwrite."""
    started_at = time_module.perf_counter()
    original_bytes = await file.read()
    if not original_bytes:
        raise HTTPException(status_code=400, detail="图片内容为空。")
    source_hash = await run_in_threadpool(hash_bytes, original_bytes)
    description_text = description or build_fallback_description(
        museum_name=museum_name,
        name=name,
        era=era,
        Place_of_Excavation=Place_of_Excavation,
    )
    try:
        image_bytes = await run_in_threadpool(
            update_image_exif_metadata,
            original_bytes,
            artifact_name=name,
            description=description_text,
            latitude=latitude,
            longitude=longitude,
            museum_name=museum_name,
            era=era,
            place_of_excavation=Place_of_Excavation,
            display_location_name=display_location_name,
            camera_model=camera_model,
            lens_model=lens_model,
            captured_at=captured_at,
            shutter_speed=shutter_speed,
            aperture=aperture,
            iso=iso,
            reset_existing_exif=clean_exif,
            raise_on_error=True,
        )
    except ImageExifWriteError as exc:
        logger.warning(
            "EXIF prepare failed for %s (clean=%s): %s",
            file.filename,
            clean_exif,
            exc,
        )
        raise HTTPException(
            status_code=422,
            detail=(
                "兼容模式仍无法重写这张图片，请重新导出为标准 JPEG 后再试。"
                if clean_exif
                else "原始 EXIF 结构无法直接重写，正在等待兼容模式重试。"
            ),
        ) from exc
    await run_in_threadpool(verify_written_gps, image_bytes, latitude, longitude)
    content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "image/jpeg"
    elapsed_ms = (time_module.perf_counter() - started_at) * 1000
    logger.info("prepared EXIF for %s in %.0fms", file.filename, elapsed_ms)
    return Response(
        content=image_bytes,
        media_type=content_type,
        headers={
            "X-Source-Hash": source_hash,
            "X-Exif-Rewrite-Mode": "clean" if clean_exif else "preserve",
            "Server-Timing": f'exif;dur={elapsed_ms:.1f};desc="EXIF prepare"',
        },
    )


@app.post(f"{settings.api_prefix}/artifacts/extract-exif-file")
async def extract_artifact_exif_file(file: UploadFile = File(...)) -> dict[str, object | None]:
    """Read capture metadata and a compact preview from the spooled upload."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="图片内容为空。")
    metadata, preview_bytes = await run_in_threadpool(extract_exif_and_preview_from_file, file.file)
    return {
        **metadata.as_dict(),
        "captured_at": metadata.captured_at.isoformat() if metadata.captured_at else None,
        "preview_data_url": (
            f"data:image/jpeg;base64,{base64.b64encode(preview_bytes).decode('ascii')}"
            if preview_bytes else None
        ),
    }


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
        display_location_name=payload.display_location_name,
    )
    verify_written_gps(image_bytes, payload.latitude, payload.longitude)
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
    catalog_exhibition_source_id: str | None = Form(None),
    catalog_exhibition_id: int | None = Form(None),
    latitude: float | None = Form(None),
    longitude: float | None = Form(None),
    camera_model: str | None = Form(None),
    lens_model: str | None = Form(None),
    captured_at: datetime | None = Form(None),
    shutter_speed: str | None = Form(None),
    aperture: str | None = Form(None),
    iso: int | None = Form(None),
    existing_artifact_id: int | None = Form(None),
    skip_existing_match: bool = Form(False),
    exif_prepared: bool = Form(False),
    source_hash: str | None = Form(None),
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
            "exif_prepared": exif_prepared,
        },
    )
    # #endregion
    original_bytes = await file.read()
    if not original_bytes:
        raise HTTPException(status_code=400, detail="图片内容为空。")
    normalized_source_hash = (source_hash or "").strip().lower() or None
    if normalized_source_hash is not None and not SHA256_PATTERN.fullmatch(normalized_source_hash):
        raise HTTPException(status_code=400, detail="原图哈希格式不正确。")
    if normalized_source_hash is None:
        normalized_source_hash = await run_in_threadpool(hash_bytes, original_bytes)

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
    if exif_prepared:
        # The local-overwrite endpoint already encoded and verified these exact
        # bytes. Re-encoding a large JPEG here used to duplicate the slowest
        # CPU step and could introduce another lossy generation.
        image_bytes = original_bytes
    else:
        image_bytes = await run_in_threadpool(
            update_image_exif_metadata,
            original_bytes,
            artifact_name=name,
            description=description_text,
            latitude=latitude,
            longitude=longitude,
            museum_name=museum_name,
            era=era,
            place_of_excavation=Place_of_Excavation,
            display_location_name=display_location_name,
            camera_model=camera_model,
            lens_model=lens_model,
            captured_at=captured_at,
            shutter_speed=shutter_speed,
            aperture=aperture,
            iso=iso,
        )
    await run_in_threadpool(verify_written_gps, image_bytes, latitude, longitude)
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
            camera_model=camera_model,
            lens_model=lens_model,
            capture_museum_name=display_location_name,
            exhibition_name=exhibition_name,
            capture_location=display_location_name,
            latitude=latitude,
            longitude=longitude,
            captured_at=captured_at,
            shutter_speed=shutter_speed,
            aperture=aperture,
            iso=iso,
            edit_method=None,
            source_hash=normalized_source_hash,
            catalog_exhibition_source_id=catalog_exhibition_source_id,
            catalog_exhibition_id=catalog_exhibition_id,
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
def ingest_artifact(
    background_tasks: BackgroundTasks,
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
    catalog_exhibition_source_id: str | None = Form(None),
    catalog_exhibition_id: int | None = Form(None),
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
) -> Artifact | ArtifactRead:
    """Store the image in OSS and the metadata in the cloud DB. Bearer-token protected."""
    started_at = time_module.perf_counter()
    require_ingest_token(authorization)

    contents = image.file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="图片内容为空。")
    image_hash = hash_bytes(contents)
    byte_duplicate = (
        find_artifact_image_by_source_hash_local(db, source_hash)
        or find_artifact_image_by_hash_local(db, image_hash)
    )
    content_hash = image_content_fingerprint(contents)
    # Exact hashes use indexed lookups. Only genuinely new bytes need the
    # perceptual-hash scan used to catch EXIF/re-encode variants.
    duplicate_images = (
        [byte_duplicate]
        if byte_duplicate is not None
        else find_artifact_images_by_content(db, content_hash)
    )
    duplicate_image = duplicate_images[0] if duplicate_images else None

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
    capture_museum, exhibition = resolve_capture_context(
        db,
        capture_museum_name,
        exhibition_name,
        catalog_exhibition_source_id,
        catalog_exhibition_id,
    )
    merged_tags = merge_unique_tags(
        parse_tags(tags),
        build_capture_tags(
            image_metadata.get("camera_model"),
            image_metadata.get("lens_model"),
        ),
    )
    excavation_value = normalize_place_of_excavation(Place_of_Excavation)

    artifact: Artifact | None = duplicate_image.artifact if duplicate_image is not None else None
    if artifact is None and existing_artifact_id is not None:
        artifact = db.scalar(artifact_detail_query().where(Artifact.id == existing_artifact_id))
        if artifact is None:
            raise HTTPException(status_code=404, detail="要更新的文物不存在。")
    elif artifact is None and not skip_existing_match:
        existing_match = find_existing_artifact_match(
            db,
            name=name,
            museum_name=museum_name,
            era=era,
        )
        artifact = existing_match.artifact if existing_match is not None else None

    upload_started_at = time_module.perf_counter()
    image_url = upload_image(
        contents, image.filename or "image.jpg", image.content_type
    )
    upload_elapsed_ms = (time_module.perf_counter() - upload_started_at) * 1000

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

    replaced_urls: list[str] = []
    if duplicate_image is not None:
        replaced_urls = [item.url for item in duplicate_images if item.url and item.url != image_url]
        for extra_image in duplicate_images[1:]:
            extra_image.image_hash = None
            extra_image.source_hash = None
            db.delete(extra_image)
        db.flush()

        duplicate_image.url = image_url
        duplicate_image.image_hash = image_hash
        duplicate_image.source_hash = source_hash or image_hash
        duplicate_image.content_hash = content_hash
        duplicate_image.capture_museum_id = capture_museum.id if capture_museum is not None else None
        duplicate_image.exhibition_id = exhibition.id if exhibition is not None else None
        duplicate_image.capture_location = optional_text(capture_location)
        for field, value in image_metadata.items():
            setattr(duplicate_image, field, value)
    else:
        artifact.images.append(
            ArtifactImage(
                url=image_url,
                image_hash=image_hash,
                source_hash=source_hash or image_hash,
                content_hash=content_hash,
                capture_museum_id=capture_museum.id if capture_museum is not None else None,
                exhibition_id=exhibition.id if exhibition is not None else None,
                capture_location=optional_text(capture_location),
                **image_metadata,
            )
        )
    db.commit()
    db.expire_all()
    refreshed = db.scalar(artifact_detail_query().where(Artifact.id == artifact.id))
    if duplicate_image is None:
        logger.info(
            "cloud ingest completed for %s in %.0fms (OSS %.0fms)",
            image.filename,
            (time_module.perf_counter() - started_at) * 1000,
            upload_elapsed_ms,
        )
        return refreshed

    old_urls = set(replaced_urls)
    if old_urls:
        background_tasks.add_task(delete_images_best_effort, old_urls)
    removed_count = max(0, len(duplicate_images) - 1)
    detail = "已用本次校正覆盖已有图片"
    if removed_count:
        detail += f"，并清理 {removed_count} 条历史重复图片记录"
    logger.info(
        "cloud ingest replacement completed for %s in %.0fms (OSS %.0fms; %d old objects queued)",
        image.filename,
        (time_module.perf_counter() - started_at) * 1000,
        upload_elapsed_ms,
        len(old_urls),
    )
    return ArtifactRead.model_validate(refreshed).model_copy(
        update={
            "duplicate_image_replaced": True,
            "duplicate_image_detail": f"{detail}。",
        }
    )


def delete_images_best_effort(urls: set[str]) -> None:
    """Delete superseded OSS objects after the ingest response is sent."""
    for old_url in urls:
        try:
            delete_image(old_url)
        except Exception as exc:  # noqa: BLE001 - DB replacement must remain committed
            logger.warning("delete replaced OSS image failed for %s: %s", old_url, exc)


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
        catalog_exhibition_source_id=payload.catalog_exhibition_source_id,
        catalog_exhibition_id=payload.catalog_exhibition_id,
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
    catalog_exhibition_source_id: str | None = Form(None),
    catalog_exhibition_id: int | None = Form(None),
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
        catalog_exhibition_source_id=catalog_exhibition_source_id,
        catalog_exhibition_id=catalog_exhibition_id,
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
        duplicate_image_replaced=bool(created.get("duplicate_image_replaced")),
        duplicate_image_detail=created.get("duplicate_image_detail"),
    )


def normalize_catalog_match_text(value: str | None) -> str:
    return re.sub(r"[\W_]+", "", (value or "").casefold(), flags=re.UNICODE)


def looks_like_catalog_institution(value: str) -> bool:
    return bool(
        re.search(
            r"(博物馆|博物院|美术馆|艺术馆|纪念馆|科技馆|展览馆|陈列馆|文化馆|图书馆)$",
            value,
        )
    )


def is_long_running_catalog_exhibition(
    item: CatalogExhibition | ExhibitionRecommendationRead,
) -> bool:
    if item.is_permanent:
        return True
    if item.start_date is None and item.end_date is None:
        return False
    if item.start_date is None or item.end_date is None:
        return True
    return (item.end_date - item.start_date).days >= 365


def haversine_distance_km(
    latitude_a: float,
    longitude_a: float,
    latitude_b: float,
    longitude_b: float,
) -> float:
    radius_km = 6371.0088
    lat_a = math.radians(latitude_a)
    lat_b = math.radians(latitude_b)
    lat_delta = math.radians(latitude_b - latitude_a)
    lon_delta = math.radians(longitude_b - longitude_a)
    value = (
        math.sin(lat_delta / 2) ** 2
        + math.cos(lat_a) * math.cos(lat_b) * math.sin(lon_delta / 2) ** 2
    )
    return radius_km * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def artifact_summary(item: ArtifactRead) -> ExhibitionArtifactSummaryRead:
    images = sorted(
        item.images,
        key=lambda image: (image.uploaded_at, image.id),
        reverse=True,
    )
    captured_at = next(
        (image.captured_at for image in images if image.captured_at is not None),
        None,
    )
    return ExhibitionArtifactSummaryRead(
        id=item.id,
        name=item.name,
        museum_name=item.museum_name,
        era=item.era,
        cover_url=images[0].url if images else None,
        captured_at=captured_at,
    )


@app.get(
    f"{settings.api_prefix}/exhibition-history",
    response_model=HistoricalExhibitionDetailRead,
)
def get_historical_exhibition_detail(
    name: str = Query(..., min_length=1),
    museum_name: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> HistoricalExhibitionDetailRead:
    normalized_name = name.strip()
    normalized_museum = optional_text(museum_name)
    if should_proxy_artifact_queries_to_cloud():
        try:
            artifacts = enrich_artifact_catalog_links(
                merge_duplicate_artifact_reads(fetch_cloud_artifact_payload())
            )
        except Exception as exc:  # noqa: BLE001 - surface cloud query failure
            raise HTTPException(status_code=502, detail=f"查询云端历史展览失败：{exc}") from exc
    else:
        query = artifact_detail_query().order_by(Artifact.created_at.desc())
        artifacts = enrich_artifact_catalog_links(
            merge_duplicate_artifact_reads(list(db.scalars(query)))
        )

    matched_artifacts: list[ArtifactRead] = []
    matched_exhibitions: list[ExhibitionRead] = []
    for artifact in artifacts:
        exhibitions = [
            exhibition
            for exhibition in artifact.exhibitions
            if exhibition.name.strip() == normalized_name
            and (
                normalized_museum is None
                or exhibition.museum_name.strip() == normalized_museum
            )
        ]
        if exhibitions:
            matched_artifacts.append(artifact)
            matched_exhibitions.extend(exhibitions)
    if not matched_exhibitions:
        raise HTTPException(status_code=404, detail="Historical exhibition not found")

    start_at = min(
        (
            exhibition.start_at
            for exhibition in matched_exhibitions
            if exhibition.start_at is not None
        ),
        default=None,
    )
    end_at = max(
        (
            exhibition.end_at
            for exhibition in matched_exhibitions
            if exhibition.end_at is not None
        ),
        default=None,
    )
    return HistoricalExhibitionDetailRead(
        name=normalized_name,
        museum_name=normalized_museum or matched_exhibitions[0].museum_name,
        start_at=start_at,
        end_at=end_at,
        artifacts=[artifact_summary(item) for item in matched_artifacts],
    )


@app.get(
    f"{settings.api_prefix}/exhibition-catalog/recommendations",
    response_model=list[ExhibitionRecommendationRead],
)
def recommend_exhibition_catalog(
    captured_at: datetime | None = Query(default=None),
    latitude: float | None = Query(default=None, ge=-90, le=90),
    longitude: float | None = Query(default=None, ge=-180, le=180),
    location: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=8, ge=1, le=30),
    catalog_db: Session = Depends(get_exhibition_db),
    artifact_db: Session = Depends(get_db),
) -> list[ExhibitionRecommendationRead]:
    normalized_location = optional_text(location)
    normalized_query = optional_text(q)
    if (
        captured_at is None
        and latitude is None
        and longitude is None
        and normalized_location is None
        and normalized_query is None
    ):
        return []

    capture_date = captured_at.date() if captured_at is not None else None
    base_query = select(CatalogExhibition)
    if normalized_query:
        like = f"%{normalized_query}%"
        base_query = base_query.where(
            or_(
                CatalogExhibition.title.ilike(like),
                CatalogExhibition.museum_name.ilike(like),
                CatalogExhibition.venue.ilike(like),
                CatalogExhibition.address.ilike(like),
                CatalogExhibition.city.ilike(like),
            )
        )

    dated_query = base_query.where(CatalogExhibition.is_permanent.is_(False))
    if capture_date is not None:
        dated_query = dated_query.where(
            and_(
                or_(
                    CatalogExhibition.start_date.is_(None),
                    CatalogExhibition.start_date <= capture_date,
                ),
                or_(
                    CatalogExhibition.end_date.is_(None),
                    CatalogExhibition.end_date >= capture_date,
                ),
            )
        )
    dated_candidates = list(
        catalog_db.scalars(
            dated_query.order_by(
                CatalogExhibition.start_date.desc().nulls_last(),
                CatalogExhibition.synced_at.desc(),
            ).limit(2000)
        )
    )
    permanent_candidates = list(
        catalog_db.scalars(
            base_query.where(CatalogExhibition.is_permanent.is_(True))
            .order_by(CatalogExhibition.synced_at.desc())
            .limit(1000)
        )
    )
    candidates = [*dated_candidates, *permanent_candidates]

    location_hints: list[tuple[str, str, float | None]] = []
    if normalized_location:
        location_hints.append((normalized_location, "EXIF 地点一致", None))
    nearest_museum: Museum | None = None
    nearest_distance: float | None = None
    if latitude is not None and longitude is not None:
        museums = list(
            artifact_db.scalars(
                select(Museum).where(
                    Museum.latitude.is_not(None),
                    Museum.longitude.is_not(None),
                )
            )
        )
        for museum in museums:
            distance = haversine_distance_km(
                latitude,
                longitude,
                float(museum.latitude),
                float(museum.longitude),
            )
            if nearest_distance is None or distance < nearest_distance:
                nearest_museum = museum
                nearest_distance = distance
        if nearest_museum is not None and nearest_distance is not None and nearest_distance <= 80:
            location_hints.append(
                (nearest_museum.name, f"距拍摄地点约 {nearest_distance:.1f} km", nearest_distance)
            )
            if nearest_museum.location:
                location_hints.append(
                    (nearest_museum.location, "邻近已收录场馆", nearest_distance)
                )

    scored: list[tuple[int, ExhibitionRecommendationRead]] = []
    for candidate in candidates:
        score = 0
        reasons: list[str] = []
        matched_distance: float | None = None
        matched_location = False
        if capture_date is not None:
            score += 70
            if candidate.is_permanent:
                reasons.append("常设展，长期有效")
            elif is_long_running_catalog_exhibition(candidate):
                reasons.append("拍摄日期在长期展期内")
            else:
                reasons.append("拍摄日期在展期内")
        if normalized_query:
            score += 50
            reasons.append("名称或地点符合搜索")

        field_values = {
            "展馆": normalize_catalog_match_text(candidate.museum_name),
            "展厅": normalize_catalog_match_text(candidate.venue),
            "地址": normalize_catalog_match_text(candidate.address),
            "城市": normalize_catalog_match_text(candidate.city),
            "地区": normalize_catalog_match_text(candidate.region),
        }
        for hint, hint_reason, distance in location_hints:
            normalized_hint = normalize_catalog_match_text(hint)
            if len(normalized_hint) < 2:
                continue
            institution_hint = looks_like_catalog_institution(normalized_hint)
            matched_label = next(
                (
                    label
                    for label, field_value in field_values.items()
                    if field_value
                    and (not institution_hint or label not in {"城市", "地区"})
                    and (
                        normalized_hint in field_value
                        or field_value in normalized_hint
                    )
                ),
                None,
            )
            if matched_label is None:
                continue
            matched_location = True
            score += {
                "展馆": 140,
                "展厅": 110,
                "地址": 90,
                "城市": 70,
                "地区": 50,
            }[matched_label]
            reason = f"{matched_label}与{hint_reason}"
            if reason not in reasons:
                reasons.append(reason)
            if distance is not None:
                matched_distance = distance

        if location_hints and not matched_location:
            continue
        scored.append(
            (
                score,
                ExhibitionRecommendationRead(
                    **ExhibitionCatalogItemRead.model_validate(candidate).model_dump(),
                    match_score=score,
                    match_reasons=reasons,
                    distance_km=matched_distance,
                ),
            )
        )

    scored.sort(
        key=lambda entry: (
            entry[0],
            (
                entry[1].start_date
                if not entry[1].is_permanent and entry[1].start_date
                else date.min
            ),
            entry[1].id,
        ),
        reverse=True,
    )
    selected = scored[:limit]
    if capture_date is not None and limit >= 2:
        permanent = [entry for entry in scored if entry[1].is_permanent]
        if permanent and not any(entry[1].is_permanent for entry in selected):
            selected[-1] = permanent[0]
            selected.sort(key=scored.index)
    return [entry[1] for entry in selected]


@app.get(
    f"{settings.api_prefix}/exhibition-catalog",
    response_model=ExhibitionCatalogListRead,
)
def list_exhibition_catalog(
    q: str | None = Query(default=None),
    year: int | None = Query(default=None, ge=1800, le=2200),
    region: str | None = Query(default=None),
    city: str | None = Query(default=None),
    museum_name: str | None = Query(default=None),
    address: str | None = Query(default=None),
    venue: str | None = Query(default=None),
    status: str | None = Query(default=None, pattern="^(ongoing|upcoming|ended|permanent)$"),
    include_facets: bool = Query(default=True),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=36, ge=1, le=200),
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionCatalogListRead:
    today = datetime.now().date()
    # Hide legacy malformed dates as well as rejecting them during source
    # parsing. Undated and permanent exhibitions remain visible.
    displayable_year = or_(
        CatalogExhibition.start_year.is_(None),
        CatalogExhibition.is_permanent.is_(True),
        (
            (CatalogExhibition.start_year >= 1900)
            & (CatalogExhibition.start_year <= today.year + 1)
        ),
    )
    filters = [displayable_year]
    if q and q.strip():
        like = f"%{q.strip()}%"
        filters.append(
            or_(
                CatalogExhibition.title.ilike(like),
                CatalogExhibition.museum_name.ilike(like),
                CatalogExhibition.venue.ilike(like),
                CatalogExhibition.address.ilike(like),
                CatalogExhibition.city.ilike(like),
            )
        )
    if year is not None:
        filters.append(
            CatalogExhibition.start_year.is_not(None)
            & (CatalogExhibition.start_year <= year)
            & (
                (CatalogExhibition.end_year >= year)
                | CatalogExhibition.end_year.is_(None)
            )
        )
    if region and region.strip():
        filters.append(CatalogExhibition.region == region.strip())
    if city and city.strip():
        filters.append(CatalogExhibition.city == city.strip())
    if museum_name and museum_name.strip():
        filters.append(CatalogExhibition.museum_name == museum_name.strip())
    if address and address.strip():
        filters.append(CatalogExhibition.address == address.strip())
    if venue and venue.strip():
        filters.append(CatalogExhibition.venue == venue.strip())
    if status == "permanent":
        filters.append(CatalogExhibition.is_permanent.is_(True))
    elif status == "upcoming":
        filters.extend(
            [
                CatalogExhibition.is_permanent.is_(False),
                CatalogExhibition.start_date > today,
            ]
        )
    elif status == "ended":
        filters.extend(
            [
                CatalogExhibition.is_permanent.is_(False),
                CatalogExhibition.end_date < today,
            ]
        )
    elif status == "ongoing":
        filters.extend(
            [
                CatalogExhibition.is_permanent.is_(False),
                or_(
                    CatalogExhibition.start_date.is_(None),
                    CatalogExhibition.start_date <= today,
                ),
                or_(
                    CatalogExhibition.end_date.is_(None),
                    CatalogExhibition.end_date >= today,
                ),
            ]
        )

    filtered = select(CatalogExhibition)
    count_query = select(func.count()).select_from(CatalogExhibition)
    for condition in filters:
        filtered = filtered.where(condition)
        count_query = count_query.where(condition)
    filtered = filtered.order_by(
        CatalogExhibition.start_date.desc().nulls_last(),
        CatalogExhibition.synced_at.desc(),
        CatalogExhibition.id.desc(),
    )
    items = list(
        db.scalars(
            filtered.offset((page - 1) * page_size).limit(page_size)
        )
    )
    total = int(db.scalar(count_query) or 0)

    years: list[ExhibitionYearFacetRead] = []
    regions: list[ExhibitionFacetRead] = []
    cities: list[ExhibitionFacetRead] = []
    if include_facets:
        year_rows = db.execute(
            select(CatalogExhibition.start_year, func.count())
            .where(
                CatalogExhibition.start_year.is_not(None),
                CatalogExhibition.start_year >= 1900,
                CatalogExhibition.start_year <= today.year + 1,
            )
            .group_by(CatalogExhibition.start_year)
            .order_by(CatalogExhibition.start_year.desc())
        )
        region_rows = db.execute(
            select(CatalogExhibition.region, func.count())
            .group_by(CatalogExhibition.region)
            .order_by(func.count().desc(), CatalogExhibition.region.asc())
        )
        city_query = select(CatalogExhibition.city, func.count()).group_by(
            CatalogExhibition.city
        )
        if region and region.strip():
            city_query = city_query.where(CatalogExhibition.region == region.strip())
        city_rows = db.execute(
            city_query.order_by(func.count().desc(), CatalogExhibition.city.asc())
        )
        years = [
            ExhibitionYearFacetRead(year=int(row[0]), count=int(row[1]))
            for row in year_rows
            if row[0] is not None
        ]
        regions = [
            ExhibitionFacetRead(value=str(row[0]), count=int(row[1]))
            for row in region_rows
        ]
        cities = [
            ExhibitionFacetRead(value=str(row[0]), count=int(row[1]))
            for row in city_rows
        ]
    last_synced_at = db.scalar(select(func.max(CatalogExhibition.synced_at)))
    latest_run = latest_sync_run(db)
    remaining = None
    if latest_run and latest_run.discovered:
        remaining = exhibition_backfill_remaining(db, latest_run.discovered)

    return ExhibitionCatalogListRead(
        items=[ExhibitionCatalogItemRead.model_validate(item) for item in items],
        total=total,
        page=page,
        page_size=page_size,
        years=years,
        regions=regions,
        cities=cities,
        last_synced_at=last_synced_at,
        backfill_remaining=remaining,
    )


@app.get(
    f"{settings.api_prefix}/exhibition-catalog/sync",
    response_model=ExhibitionSyncRunRead | None,
)
def get_exhibition_sync_status(
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionSyncRun | None:
    return latest_sync_run(db)


@app.get(
    f"{settings.api_prefix}/exhibition-catalog/sync/status",
    response_model=ExhibitionSyncStatusRead,
)
def get_exhibition_sync_live_status(
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionSyncStatusRead:
    catalog_total = exhibition_catalog_count(db)
    recent_runs = list(
        db.scalars(
            select(ExhibitionSyncRun)
            .order_by(ExhibitionSyncRun.started_at.desc())
            .limit(8)
        )
    )
    run = recent_runs[0] if recent_runs else None
    processed = 0
    backfill_remaining = None
    discovered_total = 0
    rate_per_minute = None
    eta_seconds = None
    if run is not None:
        discovered_total = max(catalog_total, run.discovered)
        processed = min(
            run.attempted,
            run.created + run.updated + run.failed,
        )
        if run.discovered:
            backfill_remaining = exhibition_backfill_remaining(db, run.discovered)

        now = datetime.now(timezone.utc)
        created_total = 0
        duration_seconds = 0.0
        for recent_run in recent_runs:
            if recent_run.created <= 0:
                continue
            started_at = recent_run.started_at
            completed_at = recent_run.completed_at or now
            if started_at.tzinfo is None:
                started_at = started_at.replace(tzinfo=timezone.utc)
            if completed_at.tzinfo is None:
                completed_at = completed_at.replace(tzinfo=timezone.utc)
            created_total += recent_run.created
            duration_seconds += max(
                1,
                (completed_at - started_at).total_seconds(),
            )
        if created_total > 0 and duration_seconds > 0:
            rate_per_minute = created_total / (duration_seconds / 60)
            if backfill_remaining:
                eta_seconds = int(
                    math.ceil(backfill_remaining / rate_per_minute * 60)
                )

    overall_progress = (
        min(100.0, catalog_total / discovered_total * 100)
        if discovered_total
        else 0
    )
    worker_state = db.get(ExhibitionSyncWorkerState, 1)
    worker_read = None
    if worker_state is not None:
        heartbeat_at = worker_state.heartbeat_at
        normalized_heartbeat = (
            heartbeat_at
            if heartbeat_at.tzinfo is not None
            else heartbeat_at.replace(tzinfo=timezone.utc)
        )
        worker_read = ExhibitionSyncWorkerRead(
            status=worker_state.status,
            message=worker_state.message,
            heartbeat_at=heartbeat_at,
            next_run_at=worker_state.next_run_at,
            online=(
                datetime.now(timezone.utc) - normalized_heartbeat
            ).total_seconds() <= 45,
        )
    return ExhibitionSyncStatusRead(
        catalog_total=catalog_total,
        discovered_total=discovered_total,
        backfill_remaining=backfill_remaining,
        processed=processed,
        overall_progress=round(overall_progress, 2),
        rate_per_minute=(
            round(rate_per_minute, 1)
            if rate_per_minute is not None
            else None
        ),
        eta_seconds=eta_seconds,
        run=(
            ExhibitionSyncRunRead.model_validate(run)
            if run is not None
            else None
        ),
        recent_runs=[
            ExhibitionSyncRunRead.model_validate(item)
            for item in recent_runs
        ],
        worker=worker_read,
    )


@app.post(
    f"{settings.api_prefix}/exhibition-catalog/sync",
    response_model=ExhibitionSyncAcceptedRead,
    status_code=202,
)
def start_exhibition_sync(
    mode: str = Query(default="incremental", pattern="^(incremental|full)$"),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionSyncAcceptedRead:
    require_ingest_token(authorization)
    if not settings.exhibition_sync_enabled:
        raise HTTPException(
            status_code=409,
            detail="展览同步由独立 Worker 管理，API 进程未启用同步任务。",
        )
    accepted = exhibition_sync_coordinator.start(
        mode=mode,  # type: ignore[arg-type]
        trigger="manual",
    )
    current_run = latest_sync_run(db)
    return ExhibitionSyncAcceptedRead(
        accepted=accepted,
        detail="同步任务已启动。" if accepted else "已有同步任务正在运行。",
        run=(
            ExhibitionSyncRunRead.model_validate(current_run)
            if current_run is not None
            else None
        ),
    )


@app.get(
    f"{settings.api_prefix}/exhibition-catalog/source/{{source_id}}/artifacts",
    response_model=list[ExhibitionArtifactSummaryRead],
)
def list_exhibition_catalog_artifacts(
    source_id: str,
    catalog_db: Session = Depends(get_exhibition_db),
    artifact_db: Session = Depends(get_db),
) -> list[ExhibitionArtifactSummaryRead]:
    catalog_item = catalog_db.scalar(
        select(CatalogExhibition).where(CatalogExhibition.source_id == source_id)
    )
    if catalog_item is None:
        raise HTTPException(status_code=404, detail="Exhibition not found")

    if should_proxy_artifact_queries_to_cloud():
        try:
            artifacts = enrich_artifact_catalog_links(
                merge_duplicate_artifact_reads(fetch_cloud_artifact_payload())
            )
        except Exception as exc:  # noqa: BLE001 - surface cloud query failure
            raise HTTPException(status_code=502, detail=f"查询云端展览文物失败：{exc}") from exc
    else:
        query = (
            artifact_detail_query()
            .join(Artifact.exhibition_links)
            .join(ArtifactExhibition.exhibition)
            .where(
                or_(
                    Exhibition.catalog_source_id == source_id,
                    Exhibition.name == catalog_item.title,
                )
            )
            .distinct()
            .order_by(Artifact.created_at.desc())
        )
        artifacts = enrich_artifact_catalog_links(
            merge_duplicate_artifact_reads(list(artifact_db.scalars(query)))
        )

    matched = [
        item
        for item in artifacts
        if any(
            exhibition.catalog_source_id == source_id
            or exhibition.name == catalog_item.title
            for exhibition in item.exhibitions
        )
    ]
    return [artifact_summary(item) for item in matched]


@app.get(
    f"{settings.api_prefix}/exhibition-catalog/source/{{source_id}}",
    response_model=ExhibitionCatalogDetailRead,
)
def get_exhibition_catalog_detail_by_source(
    source_id: str,
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionCatalogDetailRead:
    item = db.scalar(
        select(CatalogExhibition).where(CatalogExhibition.source_id == source_id)
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Exhibition not found")
    return ExhibitionCatalogDetailRead.model_validate(item)


@app.get(
    f"{settings.api_prefix}/exhibition-catalog/{{exhibition_id}}",
    response_model=ExhibitionCatalogDetailRead,
)
def get_exhibition_catalog_detail(
    exhibition_id: int,
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionCatalogDetailRead:
    item = db.get(CatalogExhibition, exhibition_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Exhibition not found")
    return ExhibitionCatalogDetailRead.model_validate(item)


@app.get(
    f"{settings.api_prefix}/museum-directory",
    response_model=list[MuseumDirectoryRead],
)
def list_museum_directory(
    q: str | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=5000),
    db: Session = Depends(get_db),
    catalog_db: Session = Depends(get_exhibition_db),
) -> list[MuseumDirectoryRead]:
    museums = list(
        db.scalars(
            select(Museum)
            .options(
                selectinload(Museum.exhibitions),
                selectinload(Museum.artifacts),
            )
            .order_by(Museum.name.asc())
        )
    )
    catalog_rows = list(
        catalog_db.execute(
            select(
                CatalogExhibition.museum_name,
                CatalogExhibition.region,
                CatalogExhibition.city,
                func.max(CatalogExhibition.address),
                func.count(),
                func.min(CatalogExhibition.start_year),
                func.max(
                    func.coalesce(
                        CatalogExhibition.end_year,
                        CatalogExhibition.start_year,
                    )
                ),
                func.max(CatalogExhibition.cover_url),
            )
            .where(
                CatalogExhibition.museum_name.is_not(None),
                func.trim(CatalogExhibition.museum_name) != "",
            )
            .group_by(
                CatalogExhibition.museum_name,
                CatalogExhibition.region,
                CatalogExhibition.city,
            )
        )
    )
    address_rows = list(
        catalog_db.execute(
            select(
                CatalogExhibition.address,
                CatalogExhibition.region,
                CatalogExhibition.city,
                func.count(),
                func.min(CatalogExhibition.start_year),
                func.max(
                    func.coalesce(
                        CatalogExhibition.end_year,
                        CatalogExhibition.start_year,
                    )
                ),
                func.max(CatalogExhibition.cover_url),
            )
            .where(
                CatalogExhibition.address.is_not(None),
                func.trim(CatalogExhibition.address) != "",
            )
            .group_by(
                CatalogExhibition.address,
                CatalogExhibition.region,
                CatalogExhibition.city,
            )
        )
    )
    address_groups = {
        (
            str(row[0]).strip(),
            str(row[1] or "").strip(),
            str(row[2] or "").strip(),
        ): {
            "museum_name": None,
            "region": str(row[1] or "").strip(),
            "city": str(row[2] or "").strip(),
            "address": str(row[0]).strip(),
            "count": int(row[3] or 0),
            "first_year": int(row[4]) if row[4] is not None else None,
            "last_year": int(row[5]) if row[5] is not None else None,
            "cover_url": str(row[6]) if row[6] else None,
            "match_by_address": True,
        }
        for row in address_rows
    }

    groups: list[dict[str, object]] = []
    groups_by_name: dict[str, list[dict[str, object]]] = {}
    for row in catalog_rows:
        museum_name = str(row[0]).strip()
        region = str(row[1] or "").strip()
        city = str(row[2] or "").strip()
        address = str(row[3] or "").strip() or None
        group: dict[str, object] = {
            "museum_name": museum_name,
            "region": region,
            "city": city,
            "address": address,
            "count": int(row[4] or 0),
            "first_year": int(row[5]) if row[5] is not None else None,
            "last_year": int(row[6]) if row[6] is not None else None,
            "cover_url": str(row[7]) if row[7] else None,
            "match_by_address": False,
        }
        groups.append(group)
        groups_by_name.setdefault(
            normalize_museum_directory_key(museum_name),
            [],
        ).append(group)

    directory: list[MuseumDirectoryRead] = []
    matched_group_ids: set[int] = set()
    for museum in museums:
        candidates = groups_by_name.get(
            normalize_museum_directory_key(museum.name),
            [],
        )
        for candidate in candidates:
            matched_group_ids.add(id(candidate))
        matched_group = None
        if len(candidates) == 1:
            matched_group = candidates[0]
        elif candidates and museum.location:
            normalized_location = normalize_museum_directory_key(museum.location)
            city_matches = [
                candidate
                for candidate in candidates
                if normalize_museum_directory_key(str(candidate["city"]))
                in normalized_location
            ]
            if len(city_matches) == 1:
                matched_group = city_matches[0]

        # Rows deployed before the parent venue field existed only contain the
        # room name. Until the throttled worker revisits all historical pages,
        # use the dominant address among titles mentioning this museum. The
        # exact-address query then also finds exhibitions whose title omits it.
        address_candidate = catalog_db.execute(
            select(
                CatalogExhibition.address,
                CatalogExhibition.region,
                CatalogExhibition.city,
                func.count(),
            )
            .where(
                CatalogExhibition.title.ilike(f"%{museum.name.strip()}%"),
                CatalogExhibition.address.is_not(None),
                func.trim(CatalogExhibition.address) != "",
            )
            .group_by(
                CatalogExhibition.address,
                CatalogExhibition.region,
                CatalogExhibition.city,
            )
            .order_by(func.count().desc())
            .limit(1)
        ).first()
        if address_candidate is not None:
            fallback_group = address_groups.get(
                (
                    str(address_candidate[0]).strip(),
                    str(address_candidate[1] or "").strip(),
                    str(address_candidate[2] or "").strip(),
                )
            )
            if fallback_group is not None and (
                matched_group is None
                or int(fallback_group["count"]) > int(matched_group["count"])
            ):
                matched_group = fallback_group

        catalog_count = int(matched_group["count"]) if matched_group else 0
        directory.append(
            MuseumDirectoryRead(
                id=museum.id,
                museum_id=museum.id,
                name=museum.name,
                location=museum.location
                or (
                    str(matched_group["address"])
                    if matched_group and matched_group["address"]
                    else None
                )
                or (
                    " · ".join(
                        part
                        for part in (
                            str(matched_group["city"]),
                            str(matched_group["region"]),
                        )
                        if part
                    )
                    if matched_group
                    else None
                ),
                latitude=museum.latitude,
                longitude=museum.longitude,
                description=museum.description,
                artifact_count=museum.artifact_count,
                exhibition_count=max(museum.exhibition_count, catalog_count),
                catalog_exhibition_count=catalog_count,
                first_year=(
                    matched_group["first_year"] if matched_group else None
                ),
                last_year=(
                    matched_group["last_year"] if matched_group else None
                ),
                cover_url=(
                    str(matched_group["cover_url"])
                    if matched_group and matched_group["cover_url"]
                    else None
                ),
                catalog_museum_name=(
                    str(matched_group["museum_name"])
                    if matched_group
                    and not matched_group["match_by_address"]
                    and matched_group["museum_name"]
                    else None
                ),
                catalog_address=(
                    str(matched_group["address"])
                    if matched_group
                    and matched_group["match_by_address"]
                    and matched_group["address"]
                    else None
                ),
                catalog_venue=(
                    str(matched_group["museum_name"])
                    if matched_group and matched_group["museum_name"]
                    else None
                ),
                catalog_city=(
                    str(matched_group["city"]) if matched_group else None
                ),
                catalog_region=(
                    str(matched_group["region"]) if matched_group else None
                ),
                derived_from_catalog=False,
                exhibitions=[
                    ExhibitionRead.model_validate(item)
                    for item in museum.exhibitions
                ],
            )
        )

    used_ids = {item.id for item in directory}
    for group in groups:
        if id(group) in matched_group_ids:
            continue
        museum_name = str(group["museum_name"])
        city = str(group["city"])
        region = str(group["region"])
        directory_id = catalog_museum_directory_id(museum_name, city, region)
        while directory_id in used_ids:
            directory_id -= 1
        used_ids.add(directory_id)
        count = int(group["count"])
        location = (
            str(group["address"]) if group["address"] else None
        ) or " · ".join(part for part in (city, region) if part)
        directory.append(
            MuseumDirectoryRead(
                id=directory_id,
                name=museum_name,
                location=location or None,
                description=f"根据公开展览目录整理，收录 {count} 场历年展览。",
                artifact_count=0,
                exhibition_count=count,
                catalog_exhibition_count=count,
                first_year=group["first_year"],
                last_year=group["last_year"],
                cover_url=(
                    str(group["cover_url"]) if group["cover_url"] else None
                ),
                catalog_museum_name=museum_name,
                catalog_venue=museum_name,
                catalog_city=city or None,
                catalog_region=region or None,
                derived_from_catalog=True,
            )
        )

    search_text = normalize_museum_directory_key(q)
    if search_text:
        directory = [
            item
            for item in directory
            if search_text
            in normalize_museum_directory_key(
                " ".join(
                    value
                    for value in (
                        item.name,
                        item.location,
                        item.description,
                    )
                    if value
                )
            )
        ]
    directory.sort(
        key=lambda item: (
            normalize_museum_directory_key(item.name),
            item.id,
        )
    )
    return directory[:limit]


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


@app.get(f"{settings.api_prefix}/era-timeline", response_model=EraTimelineRead)
def get_era_timeline(
    era: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> EraTimelineRead:
    """Return chronological era facets and the artifacts in the selected era.

    Artifact.era deliberately retains operator input (for example ``商代`` or
    ``红山文化``).  The timeline groups those variants for browsing only.
    """
    normalized_selected = era.strip() if era and era.strip() else None
    timeline = list(WENWU_ERA_TIMELINE)
    selected = next((item for item in timeline if item[0] == normalized_selected), None)
    if normalized_selected and selected is None:
        raise HTTPException(status_code=404, detail="未找到该时代")

    # The local gallery intentionally proxies to the cloud in normal local
    # operator mode.  This page must use that same collection rather than the
    # usually-empty local cache.  It also cannot use exact SQL equality: old
    # records commonly say "商代晚期" while the rail says "商".
    if should_proxy_artifact_queries_to_cloud():
        try:
            all_artifacts = enrich_artifact_catalog_links(
                merge_duplicate_artifact_reads(fetch_cloud_artifact_payload())
            )
        except Exception as exc:  # noqa: BLE001 - make the data-source error visible
            raise HTTPException(status_code=502, detail=f"查询图库失败：{exc}") from exc
    else:
        all_artifacts = enrich_artifact_catalog_links(
            merge_duplicate_artifact_reads(
                list(db.scalars(artifact_detail_query().order_by(Artifact.created_at.desc())))
            )
        )

    def matches_era(value: str | None, aliases: tuple[str, ...]) -> bool:
        if not value:
            return False
        normalized = re.sub(r"[\s（()）]", "", value)
        return any(
            normalized == alias
            or normalized.startswith(alias)
            or alias in normalized
            for alias in aliases
        )

    facets = [
        EraTimelineItemRead(
            name=name,
            aliases=list(aliases),
            count=sum(1 for artifact in all_artifacts if matches_era(artifact.era, aliases)),
        )
        for name, aliases in timeline
    ]

    artifacts: list[ArtifactRead] = []
    if selected is not None:
        artifacts = [artifact for artifact in all_artifacts if matches_era(artifact.era, selected[1])]
    return EraTimelineRead(
        eras=facets,
        selected_era=normalized_selected,
        artifacts=artifacts,
    )


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
    museum_name: str | None = Query(default=None),
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
    if museum_name and museum_name.strip():
        museum_like = f"%{museum_name.strip()}%"
        query = query.where(Exhibition.museum.has(Museum.name.ilike(museum_like)))
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.where(Exhibition.name.ilike(like))
    return list(db.scalars(query.limit(limit)))


@app.post(f"{settings.api_prefix}/exhibitions", response_model=ExhibitionRead, status_code=201)
def create_exhibition(payload: ExhibitionCreate, db: Session = Depends(get_db)) -> Exhibition:
    museum = db.get(Museum, payload.museum_id)
    if museum is None:
        raise HTTPException(status_code=404, detail="Museum not found")
    exhibition = ensure_exhibition(
        db,
        museum,
        payload.name,
        payload.start_at,
        payload.end_at,
        payload.catalog_source_id,
        payload.catalog_exhibition_id,
    )
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
        try:
            payload = fetch_cloud_artifact_payload(filtered_params)
        except Exception as exc:  # noqa: BLE001 - surface cloud query failure to the operator
            raise HTTPException(status_code=502, detail=f"查询云端图库失败：{exc}") from exc
        return enrich_artifact_catalog_links(
            merge_duplicate_artifact_reads(payload)
        )

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
    return enrich_artifact_catalog_links(
        merge_duplicate_artifact_reads(list(db.scalars(query)))
    )


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
            payload.catalog_exhibition_source_id,
            payload.catalog_exhibition_id,
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
            db,
            image.capture_museum_name,
            image.exhibition_name,
            image.catalog_exhibition_source_id,
            image.catalog_exhibition_id,
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


@app.get(f"{settings.api_prefix}/image-variant")
async def get_image_variant(
    url: str = Query(..., min_length=1, max_length=2048),
    size: int = Query(default=160, ge=64, le=IMAGE_VARIANT_MASTER_SIZE),
) -> FileResponse:
    IMAGE_VARIANT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    source_key = hashlib.sha256(url.encode("utf-8")).hexdigest()
    cache_path = IMAGE_VARIANT_CACHE_DIR / f"v2-{source_key}-{size}.webp"
    if not cache_path.exists():
        image_lock = IMAGE_VARIANT_LOCKS.setdefault(source_key, asyncio.Lock())
        async with image_lock:
            if not cache_path.exists():
                # A cold gallery can request dozens of different originals at
                # once. Serialize expensive download/decode work on small cloud
                # instances so normal API and health requests remain responsive.
                async with IMAGE_VARIANT_WORK_SEMAPHORE:
                    if not cache_path.exists():
                        master_path = (
                            IMAGE_VARIANT_CACHE_DIR
                            / f"v2-{source_key}-{IMAGE_VARIANT_MASTER_SIZE}.webp"
                        )
                        try:
                            if not master_path.exists():
                                source_bytes = await load_image_source_bytes(url)
                                await run_in_threadpool(
                                    render_image_variant,
                                    source_bytes,
                                    master_path,
                                    IMAGE_VARIANT_MASTER_SIZE,
                                )
                            if size != IMAGE_VARIANT_MASTER_SIZE:
                                await run_in_threadpool(
                                    render_image_variant,
                                    master_path.read_bytes(),
                                    cache_path,
                                    size,
                                )
                        except HTTPException:
                            raise
                        except Exception as exc:
                            raise HTTPException(
                                status_code=422,
                                detail=f"无法生成图片预览：{exc}",
                            ) from exc

    return FileResponse(
        cache_path,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


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


@app.get(f"{settings.api_prefix}/artifact-images/by-source-hash", response_model=ArtifactImageRead | None)
def get_artifact_image_by_source_hash(
    source_hash: str = Query(..., min_length=64, max_length=64),
    db: Session = Depends(get_db),
) -> ArtifactImageRead | None:
    normalized_source_hash = source_hash.strip().lower()
    if not SHA256_PATTERN.fullmatch(normalized_source_hash):
        raise HTTPException(status_code=400, detail="原图哈希格式不正确。")
    if should_proxy_artifact_queries_to_cloud():
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifact-images/by-source-hash",
                    params={"source_hash": normalized_source_hash},
                )
                response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - surface lookup failure to the caller
            raise HTTPException(status_code=502, detail=f"查询云端入库状态失败：{exc}") from exc
        payload = response.json()
        return ArtifactImageRead.model_validate(payload) if payload else None

    match = find_artifact_image_by_source_hash_local(db, normalized_source_hash)
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
        db,
        payload.capture_museum_name,
        payload.exhibition_name,
        payload.catalog_exhibition_source_id,
        payload.catalog_exhibition_id,
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
