import json
import logging
import mimetypes
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    UploadFile,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Artifact, ArtifactExhibition, ArtifactImage, ArtifactTag
from app.schemas import ArtifactRead, CloudArtifactSubmitRequest

logger = logging.getLogger("app.vision")


@dataclass(slots=True)
class CloudIngestDependencies:
    reserve_ingest_slot: Callable[..., Any]
    require_ingest_token: Callable[..., Any]
    configuration_error: Callable[..., Any]
    normalize_source_hash: Callable[..., Any]
    read_bounded_upload: Callable[..., Any]
    hash_bytes: Callable[..., Any]
    find_image_by_source_hash: Callable[..., Any]
    find_image_by_hash: Callable[..., Any]
    image_content_fingerprint: Callable[..., Any]
    find_images_by_content: Callable[..., Any]
    build_image_metadata: Callable[..., Any]
    ensure_museum: Callable[..., Any]
    resolve_capture_context: Callable[..., Any]
    merge_unique_tags: Callable[..., Any]
    parse_tags: Callable[..., Any]
    build_capture_tags: Callable[..., Any]
    normalize_place_of_excavation: Callable[..., Any]
    artifact_detail_query: Callable[..., Any]
    find_existing_artifact_match: Callable[..., Any]
    upload_image: Callable[..., Any]
    optional_text: Callable[..., Any]
    delete_image: Callable[..., Any]
    resolve_uploaded_file_path: Callable[..., Any]
    submit_artifact_to_cloud: Callable[..., Any]


@dataclass(slots=True)
class CloudIngestHandlers:
    ingest_artifact: Callable[..., Any]
    delete_images_best_effort: Callable[..., Any]
    submit_single_artifact_to_cloud: Callable[..., Any]
    submit_single_artifact_file_to_cloud: Callable[..., Any]


def create_cloud_ingest_router(
    dependencies: CloudIngestDependencies,
) -> tuple[APIRouter, CloudIngestHandlers]:
    """Build authenticated cloud ingest and local cloud-forwarding routes."""
    router = APIRouter()

    def delete_images_best_effort(urls: set[str]) -> None:
        """Delete superseded OSS objects after the ingest response is sent."""
        for old_url in urls:
            try:
                dependencies.delete_image(old_url)
            except Exception as exc:  # noqa: BLE001 - DB replacement must remain committed
                logger.warning(
                    "delete replaced OSS image failed for %s: %s",
                    old_url,
                    exc,
                )

    @router.post(
        "/ingest/artifacts",
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
        quick_entry_token: str | None = Header(
            default=None,
            alias="X-Quick-Entry-Token",
        ),
        _ingest_slot: None = Depends(dependencies.reserve_ingest_slot),
        db: Session = Depends(get_db),
    ) -> Artifact | ArtifactRead:
        """Store an image in OSS and its reviewed metadata in the cloud DB."""
        started_at = time.perf_counter()
        dependencies.require_ingest_token(authorization, quick_entry_token)
        configuration_error = dependencies.configuration_error()
        if configuration_error:
            raise HTTPException(
                status_code=503,
                detail=configuration_error,
                headers={
                    "Retry-After": "2",
                    "X-Error-Code": "cloud_ingest_not_ready",
                },
            )

        normalized_source_hash = dependencies.normalize_source_hash(source_hash)
        contents = dependencies.read_bounded_upload(image.file)
        if not contents:
            raise HTTPException(status_code=400, detail="图片内容为空。")
        image_hash = dependencies.hash_bytes(contents)
        byte_duplicate = dependencies.find_image_by_source_hash(
            db, normalized_source_hash
        ) or dependencies.find_image_by_hash(db, image_hash)
        content_hash = dependencies.image_content_fingerprint(contents)
        duplicate_images = (
            [byte_duplicate]
            if byte_duplicate is not None
            else dependencies.find_images_by_content(db, content_hash)
        )
        duplicate_image = duplicate_images[0] if duplicate_images else None

        image_metadata = dependencies.build_image_metadata(
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

        museum = dependencies.ensure_museum(db, museum_name)
        capture_museum, exhibition = dependencies.resolve_capture_context(
            db,
            capture_museum_name,
            exhibition_name,
            catalog_exhibition_source_id,
            catalog_exhibition_id,
        )
        merged_tags = dependencies.merge_unique_tags(
            dependencies.parse_tags(tags),
            dependencies.build_capture_tags(
                image_metadata.get("camera_model"),
                image_metadata.get("lens_model"),
            ),
        )
        excavation_value = dependencies.normalize_place_of_excavation(
            Place_of_Excavation
        )

        artifact: Artifact | None = (
            duplicate_image.artifact if duplicate_image is not None else None
        )
        if artifact is None and existing_artifact_id is not None:
            artifact = db.scalar(
                dependencies.artifact_detail_query().where(
                    Artifact.id == existing_artifact_id
                )
            )
            if artifact is None:
                raise HTTPException(status_code=404, detail="要更新的文物不存在。")
        elif artifact is None and not skip_existing_match:
            existing_match = dependencies.find_existing_artifact_match(
                db,
                name=name,
                museum_name=museum.name,
                era=era,
            )
            artifact = existing_match.artifact if existing_match is not None else None

        upload_started_at = time.perf_counter()
        image_url = dependencies.upload_image(
            contents,
            image.filename or "image.jpg",
            image.content_type,
        )
        upload_elapsed_ms = (time.perf_counter() - upload_started_at) * 1000

        if artifact is not None:
            artifact.ai_status = "reviewed"
            artifact.museum_id = museum.id
            artifact.name = name.strip()
            artifact.era = dependencies.optional_text(era)
            artifact.Place_of_Excavation = excavation_value
            artifact.description = dependencies.optional_text(description)
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
                db.add(
                    ArtifactExhibition(
                        artifact_id=artifact.id,
                        exhibition_id=exhibition.id,
                    )
                )

        replaced_urls: list[str] = []
        if duplicate_image is not None:
            replaced_urls = [
                item.url
                for item in duplicate_images
                if item.url and item.url != image_url
            ]
            for extra_image in duplicate_images[1:]:
                extra_image.image_hash = None
                extra_image.source_hash = None
                db.delete(extra_image)
            db.flush()

            duplicate_image.url = image_url
            duplicate_image.image_hash = image_hash
            duplicate_image.source_hash = normalized_source_hash or image_hash
            duplicate_image.content_hash = content_hash
            duplicate_image.capture_museum_id = (
                capture_museum.id if capture_museum is not None else None
            )
            duplicate_image.exhibition_id = (
                exhibition.id if exhibition is not None else None
            )
            duplicate_image.capture_location = dependencies.optional_text(
                capture_location
            )
            for field, value in image_metadata.items():
                setattr(duplicate_image, field, value)
        else:
            artifact.images.append(
                ArtifactImage(
                    url=image_url,
                    image_hash=image_hash,
                    source_hash=normalized_source_hash or image_hash,
                    content_hash=content_hash,
                    capture_museum_id=(
                        capture_museum.id if capture_museum is not None else None
                    ),
                    exhibition_id=(exhibition.id if exhibition is not None else None),
                    capture_location=dependencies.optional_text(capture_location),
                    **image_metadata,
                )
            )
        db.commit()
        db.expire_all()
        refreshed = db.scalar(
            dependencies.artifact_detail_query().where(Artifact.id == artifact.id)
        )
        if duplicate_image is None:
            logger.info(
                "cloud ingest completed for %s in %.0fms (OSS %.0fms)",
                image.filename,
                (time.perf_counter() - started_at) * 1000,
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
            "cloud ingest replacement completed for %s in %.0fms "
            "(OSS %.0fms; %d old objects queued)",
            image.filename,
            (time.perf_counter() - started_at) * 1000,
            upload_elapsed_ms,
            len(old_urls),
        )
        return ArtifactRead.model_validate(refreshed).model_copy(
            update={
                "duplicate_image_replaced": True,
                "duplicate_image_detail": f"{detail}。",
            }
        )

    @router.post(
        "/artifacts/submit-cloud",
        response_model=ArtifactRead,
        status_code=201,
    )
    async def submit_single_artifact_to_cloud(
        payload: CloudArtifactSubmitRequest,
    ) -> ArtifactRead:
        image_path = dependencies.resolve_uploaded_file_path(payload.image_url)
        content_type = mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
        return await dependencies.submit_artifact_to_cloud(
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

    @router.post(
        "/artifacts/submit-cloud-file",
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
        return await dependencies.submit_artifact_to_cloud(
            image_bytes=contents,
            image_name=file.filename or "batch-upload.jpg",
            content_type=(
                file.content_type
                or mimetypes.guess_type(file.filename or "")[0]
                or "image/jpeg"
            ),
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

    return router, CloudIngestHandlers(
        ingest_artifact=ingest_artifact,
        delete_images_best_effort=delete_images_best_effort,
        submit_single_artifact_to_cloud=submit_single_artifact_to_cloud,
        submit_single_artifact_file_to_cloud=submit_single_artifact_file_to_cloud,
    )
