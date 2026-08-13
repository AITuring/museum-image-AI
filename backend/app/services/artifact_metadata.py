import hashlib
import json
import logging
import math
import re
import unicodedata
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.exhibition_source import (
    institution_name_from_room_label,
    is_probable_room_label,
    museum_name_from_source_fields,
)
from app.models import Exhibition, Museum
from app.schemas import (
    ArtifactFieldWarningRead,
    ArtifactImageRead,
    ArtifactVerifiedClaimRead,
    ParsedArtifactNameRead,
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


def ensure_museum(db: Session, museum_name: str) -> Museum:
    # ``故宫博物院藏`` means an artifact is held by the Palace Museum; “藏”
    # is not part of the institution name. Normalize at the write boundary so
    # quick entry cannot create a second Museum row that the directory later
    # has to merge back together.
    name = normalize_museum_name_for_write(museum_name, "馆藏单位")
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
                    input_value=optional_text(str(item.get("input_value", "")))
                    or default_value,
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
                    ]
                    if isinstance(refs, list)
                    else [],
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
            source_refs = (
                [
                    str(ref).strip()
                    for ref in refs
                    if isinstance(ref, (str, int)) and str(ref).strip()
                ]
                if isinstance(refs, list)
                else []
            )
            if clean_text and not any(
                existing.text == clean_text for existing in claims
            ):
                claims.append(
                    ArtifactVerifiedClaimRead(text=clean_text, source_refs=source_refs)
                )

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


def artifact_name_match_score(
    source_name: str | None, candidate_name: str | None
) -> float:
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
        raise HTTPException(
            status_code=400, detail=f"{field_name} 格式不正确。"
        ) from exc


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
        raise HTTPException(
            status_code=400, detail=f"{field_name} 格式不正确。"
        ) from exc


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
        raise HTTPException(
            status_code=400, detail="修图方式仅支持：简单调整、堆栈合成。"
        )
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
    if segment.endswith("藏") and segment[:-1].endswith(
        ("博物馆", "博物院", "纪念馆", "美术馆")
    ):
        return segment[:-1]
    return segment


def normalize_museum_name_for_write(value: str, field_label: str = "博物馆") -> str:
    """Normalize a museum write and reject room/floor identities.

    Composite legacy labels retain useful context, so
    ``上海图书馆第一展厅`` becomes ``上海图书馆``. A bare room such as
    ``二层临展厅`` has no defensible parent institution and must be corrected by
    the caller or recovered from a selected catalog exhibition.
    """
    name = normalize_museum_segment(value)
    recovered = institution_name_from_room_label(name)
    if recovered:
        name = normalize_museum_segment(recovered)
    if not name:
        raise HTTPException(status_code=400, detail=f"{field_label}不能为空。")
    if is_probable_room_label(name):
        raise HTTPException(
            status_code=422,
            detail=f"“{name}”是展厅、展区或楼层，不是博物馆；请选择真实场馆。",
        )
    return name


def normalize_museum_directory_key(value: str | None) -> str:
    if not value:
        return ""
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\s·•・,，。．()（）\[\]【】<>《》\-—–_/]+", "", normalized)


def is_catalog_room_label(value: str | None) -> bool:
    """Reject legacy room/floor values that were once stored as museums."""
    return is_probable_room_label(value)


def catalog_museum_directory_id(name: str, city: str | None) -> int:
    """Return a stable negative route id without colliding with database ids."""
    identity = f"{normalize_museum_directory_key(name)}\0{normalize_museum_directory_key(city)}"
    digest = hashlib.blake2b(identity.encode("utf-8"), digest_size=8).digest()
    return -(int.from_bytes(digest, "big") % 2_000_000_000 + 1)


_MUSEUM_BRANCH_GPS_RULES = {
    normalize_museum_directory_key("上海博物馆"): (
        # The two Shanghai Museum venues have distinct collections, exhibition
        # calendars, and coordinates.  A generic historic “上海博物馆” label
        # is only made specific when the uploaded image GPS proves the venue.
        ("上海博物馆人民广场馆", 31.2302, 121.4752),
        ("上海博物馆东馆", 31.219913, 121.538745),
    ),
}

# Verified physical venue pins used when catalog-only museums do not yet have
# uploaded-image GPS. Keep this deliberately small and source-backed; live
# geocoding remains the general fallback in the map UI.
_MUSEUM_MAP_COORDINATES = {
    # AMap POI B0FFKY2TQI, verified 2026-08-13.
    normalize_museum_directory_key("山西青铜博物馆"): (37.805219, 112.533475),
}


def has_valid_coordinates(latitude: float | None, longitude: float | None) -> bool:
    return (
        latitude is not None
        and longitude is not None
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
    )


def museum_map_coordinates(
    museum_name: str,
    latitude: float | None,
    longitude: float | None,
) -> tuple[float | None, float | None]:
    if has_valid_coordinates(latitude, longitude):
        return latitude, longitude
    return _MUSEUM_MAP_COORDINATES.get(
        normalize_museum_directory_key(museum_name),
        (latitude, longitude),
    )


def resolve_museum_branch_from_image_gps(
    museum_name: str,
    images: list[ArtifactImageRead],
) -> str:
    """Keep venue branches distinct when an upload carries reliable GPS."""
    canonical_name = normalize_museum_segment(museum_name)
    rules = _MUSEUM_BRANCH_GPS_RULES.get(normalize_museum_directory_key(canonical_name))
    if not rules:
        return canonical_name

    coordinates = [
        (image.latitude, image.longitude)
        for image in images
        if has_valid_coordinates(image.latitude, image.longitude)
    ]
    if not coordinates:
        return canonical_name
    latitude = sum(point[0] for point in coordinates) / len(coordinates)
    longitude = sum(point[1] for point in coordinates) / len(coordinates)
    nearest_name, nearest_latitude, nearest_longitude = min(
        rules,
        key=lambda rule: (latitude - rule[1]) ** 2 + (longitude - rule[2]) ** 2,
    )
    # A 3 km guard prevents a generic museum name with an unrelated GPS point
    # from being silently assigned to either Shanghai Museum venue.
    latitude_km = (latitude - nearest_latitude) * 111.0
    longitude_km = (
        (longitude - nearest_longitude) * 111.0 * math.cos(math.radians(latitude))
    )
    if math.hypot(latitude_km, longitude_km) <= 3.0:
        return nearest_name
    return canonical_name


def catalog_museum_names_for_directory_name(museum_name: str | None) -> set[str]:
    """Return exact catalog museum labels belonging to one directory card."""
    normalized_name = normalize_museum_directory_key(museum_name)
    if normalized_name == normalize_museum_directory_key("上海博物馆人民广场馆"):
        # The catalog's historic People's Square records are named simply
        # “上海博物馆”; keep them on this venue instead of mixing in East Hall.
        return {"上海博物馆人民广场馆", "上海博物馆"}
    return {museum_name.strip()} if museum_name and museum_name.strip() else set()


def catalog_museum_query_name(museum_name: str) -> str:
    if normalize_museum_directory_key(museum_name) == normalize_museum_directory_key(
        "上海博物馆人民广场馆"
    ):
        return "上海博物馆"
    return museum_name


def canonical_catalog_museum_name(
    museum_name: str | None,
    address: str | None = None,
) -> str | None:
    """Resolve legacy Shanghai Museum catalog labels to a physical venue."""
    raw_name = optional_text(museum_name)
    if re.fullmatch(r"[负-]?\d+楼", raw_name or ""):
        normalized_address = normalize_museum_directory_key(address)
        if normalize_museum_directory_key("世纪大道1952号") in normalized_address:
            return "上海博物馆东馆"
        if normalize_museum_directory_key("人民大道201号") in normalized_address:
            return "上海博物馆人民广场馆"
    safe_name = museum_name_from_source_fields(raw_name, None)
    normalized_name = normalize_museum_directory_key(safe_name)
    if normalized_name == normalize_museum_directory_key("上海博物馆"):
        return "上海博物馆人民广场馆"
    return safe_name


def museum_name_matches_catalog_museum(
    museum_name: str | None,
    catalog_museum_name: str | None,
) -> bool:
    """Match catalog rows only to the same, explicitly named venue."""
    candidate = (catalog_museum_name or "").strip()
    return bool(candidate) and candidate in catalog_museum_names_for_directory_name(
        museum_name
    )


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
            any(
                segment == token or segment.startswith(token)
                for token in ERA_TOKEN_CANDIDATES
            )
            or segment.startswith("五代十国")
        ):
            era = normalized_era
            continue
        if catalog_no is None and CATALOG_NO_PATTERN.match(segment):
            catalog_no = segment
            continue
        if museum_name is None and MUSEUM_SEGMENT_PATTERN.search(segment):
            museum_name = normalize_museum_segment(segment)
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
                if (
                    "年" in segment
                    or "出土" in segment
                    or "墓" in segment
                    or "遗址" in segment
                ):
                    place_of_excavation = segment
                    break

    normalized_parts = [
        part
        for part in [era, artifact_name, place_of_excavation, museum_name, catalog_no]
        if part
    ]
    normalized_name = (
        "-".join(normalized_parts) if normalized_parts else normalized_text
    )

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
