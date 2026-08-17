import hashlib
import logging
import re
from dataclasses import dataclass
from datetime import datetime, time
from pathlib import Path
from typing import Any, BinaryIO, Callable

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.exhibition_models import CatalogExhibition
from app.exif_utils import (
    ImageExifData,
    extract_exif_and_preview_from_file,
    extract_exif_metadata,
    fingerprint_distance,
)
from app.models import (
    Artifact,
    ArtifactExhibition,
    ArtifactImage,
    ArtifactTag,
    Exhibition,
    Museum,
)
from app.schemas import ArtifactImageRead, ArtifactRead
from app.services.artifact_metadata import (
    build_capture_tags,
    canonical_catalog_museum_name,
    ensure_exhibition,
    ensure_museum,
    merge_unique_tags,
    normalize_edit_method,
    normalize_museum_directory_key,
    normalize_museum_name_for_write,
    optional_datetime,
    optional_float,
    optional_int,
    optional_text,
)

logger = logging.getLogger("app.vision")

SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


@dataclass(slots=True)
class IngestSupportDependencies:
    open_exhibition_session: Callable[[], Session]
    catalog_museum_directory_summaries: Callable[..., Any]
    artifact_image_query: Callable[[], Any]
    open_primary_session: Callable[[], Session]
    delete_image: Callable[[str], None]


_dependencies: IngestSupportDependencies | None = None


def configure_ingest_support(dependencies: IngestSupportDependencies) -> None:
    global _dependencies
    _dependencies = dependencies


def _configured_dependencies() -> IngestSupportDependencies:
    if _dependencies is None:
        raise RuntimeError("ingest support has not been configured")
    return _dependencies


def resolve_capture_context(
    db: Session,
    capture_museum_name: str | None,
    exhibition_name: str | None,
    catalog_exhibition_source_id: str | None = None,
    catalog_exhibition_id: int | None = None,
) -> tuple[Museum | None, Exhibition | None]:
    dependencies = _configured_dependencies()
    catalog_item: CatalogExhibition | None = None
    catalog_museum_name: str | None = None
    normalized_source_id = optional_text(catalog_exhibition_source_id)
    if normalized_source_id or catalog_exhibition_id is not None:
        try:
            with dependencies.open_exhibition_session() as catalog_db:
                if normalized_source_id:
                    catalog_item = catalog_db.scalar(
                        select(CatalogExhibition).where(
                            CatalogExhibition.source_id == normalized_source_id
                        )
                    )
                elif catalog_exhibition_id is not None:
                    catalog_item = catalog_db.get(
                        CatalogExhibition, catalog_exhibition_id
                    )
                if catalog_item is not None:
                    catalog_museum_name = canonical_catalog_museum_name(
                        catalog_item.museum_name,
                        catalog_item.address,
                    )
                    if catalog_museum_name is None and optional_text(
                        catalog_item.address
                    ):
                        summaries = dependencies.catalog_museum_directory_summaries(
                            catalog_db,
                            catalog_item.address,
                        )
                        exact_address = normalize_museum_directory_key(
                            catalog_item.address
                        )
                        exact_city = normalize_museum_directory_key(catalog_item.city)
                        matches = [
                            summary
                            for summary in summaries
                            if normalize_museum_directory_key(summary.address)
                            == exact_address
                            and (
                                not exact_city
                                or normalize_museum_directory_key(summary.city)
                                == exact_city
                            )
                        ]
                        if len(matches) == 1:
                            catalog_museum_name = matches[0].name
        except Exception:
            logger.warning("resolve catalog exhibition failed", exc_info=True)

    # A valid operator-selected museum remains authoritative. If an older UI
    # submitted a room label together with a catalog exhibition, recover the
    # parent institution from that catalog/address. Never fall back to
    # ``venue`` or ``city``: neither field is a museum identity.
    explicit_capture_name = optional_text(capture_museum_name)
    resolved_capture_museum_name = catalog_museum_name
    if explicit_capture_name is not None:
        try:
            resolved_capture_museum_name = normalize_museum_name_for_write(
                explicit_capture_name,
                "展出地点",
            )
        except HTTPException:
            if catalog_museum_name is None:
                raise
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
                catalog_item.source_id
                if catalog_item is not None
                else normalized_source_id
            ),
            catalog_exhibition_id=(
                catalog_item.id if catalog_item is not None else catalog_exhibition_id
            ),
        )
        if capture_museum is not None and optional_text(resolved_exhibition_name)
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
        link.exhibition_id: link
        for link in artifact.exhibition_links
        if link.exhibition_id is not None
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


def normalize_source_hash(source_hash: str | None) -> str | None:
    normalized = (source_hash or "").strip().lower() or None
    if normalized is not None and not SHA256_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="原图哈希格式不正确。")
    return normalized


def read_bounded_upload(source: BinaryIO, *, max_bytes: int) -> bytes:
    contents = source.read(max_bytes + 1)
    if len(contents) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"图片超过 {max_bytes // (1024 * 1024)} MB，已拒绝入库以保护云端稳定性。",
        )
    return contents


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


def verify_written_gps(
    image_bytes: bytes, latitude: float | None, longitude: float | None
) -> None:
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
        raise HTTPException(
            status_code=500, detail="图片 GPS 写入校验失败，未提交入库。"
        )


def find_artifact_image_by_hash_local(
    db: Session, image_hash: str
) -> ArtifactImage | None:
    query = _configured_dependencies().artifact_image_query()
    return db.scalar(query.where(ArtifactImage.image_hash == image_hash))


def find_artifact_image_by_source_hash_local(
    db: Session, source_hash: str | None
) -> ArtifactImage | None:
    if not source_hash:
        return None
    query = _configured_dependencies().artifact_image_query()
    return db.scalar(query.where(ArtifactImage.source_hash == source_hash))


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
    query = _configured_dependencies().artifact_image_query()
    return list(
        db.scalars(
            query.where(ArtifactImage.id.in_(matched_ids)).order_by(
                ArtifactImage.id.asc()
            )
        ).unique()
    )


def cleanup_existing_content_duplicates() -> int:
    """Keep the latest copy when the same photo already exists on one artifact."""
    dependencies = _configured_dependencies()
    removed_urls: list[str] = []
    removed_count = 0
    with dependencies.open_primary_session() as db:
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
                (
                    distance := fingerprint_distance(
                        image.content_hash, keeper.content_hash
                    )
                )
                is not None
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
            dependencies.delete_image(old_url)
        except Exception as exc:  # noqa: BLE001 - DB cleanup must remain committed
            logger.warning(
                "delete historical duplicate OSS image failed for %s: %s", old_url, exc
            )
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


def build_duplicate_artifact_read(
    image: ArtifactImage | ArtifactImageRead,
) -> ArtifactRead:
    detail = build_duplicate_image_detail(image)
    if isinstance(image, ArtifactImageRead):
        return ArtifactRead(
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
    artifact = ArtifactRead.model_validate(image.artifact)
    return artifact.model_copy(
        update={
            "duplicate_image_skipped": True,
            "duplicate_image_detail": detail,
        }
    )
