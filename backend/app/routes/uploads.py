import base64
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.db import get_db
from app.schemas import UploadedImageRead


@dataclass(slots=True)
class UploadRouteDependencies:
    uploads_dir: Path
    persist_upload_and_build_preview: Callable[..., Any]
    find_duplicate_artifact_image: Callable[..., Any]
    build_duplicate_image_detail: Callable[..., str]
    build_uploaded_file_url: Callable[[str], str]
    resolve_uploaded_file_path: Callable[[str], Path]


@dataclass(slots=True)
class UploadRouteHandlers:
    upload_images: Callable[..., Any]
    delete_uploaded_image: Callable[..., Any]


def create_upload_router(
    dependencies: UploadRouteDependencies,
) -> tuple[APIRouter, UploadRouteHandlers]:
    router = APIRouter()

    @router.post(
        "/uploads/images",
        response_model=list[UploadedImageRead],
        status_code=201,
    )
    async def upload_images(
        files: list[UploadFile] = File(...),
        db: Session = Depends(get_db),
    ) -> list[UploadedImageRead]:
        uploaded_images: list[UploadedImageRead] = []

        for file in files:
            suffix = Path(file.filename or "").suffix.lower()
            generated_name = f"{uuid4().hex}{suffix}"
            target_path = dependencies.uploads_dir / generated_name
            image_hash, exif, preview_bytes = await run_in_threadpool(
                dependencies.persist_upload_and_build_preview,
                file.file,
                target_path,
            )
            if target_path.stat().st_size == 0:
                target_path.unlink(missing_ok=True)
                raise HTTPException(status_code=400, detail="图片内容为空。")
            duplicate_image = await dependencies.find_duplicate_artifact_image(
                db,
                image_hash,
            )
            if duplicate_image is not None:
                target_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=409,
                    detail=dependencies.build_duplicate_image_detail(duplicate_image),
                )

            uploaded_images.append(
                UploadedImageRead(
                    filename=file.filename or generated_name,
                    url=dependencies.build_uploaded_file_url(generated_name),
                    preview_data_url=(
                        "data:image/jpeg;base64,"
                        + base64.b64encode(preview_bytes).decode("ascii")
                        if preview_bytes
                        else None
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

    @router.delete("/uploads/images", status_code=204)
    def delete_uploaded_image(url: str = Query(..., min_length=1)) -> None:
        path = dependencies.resolve_uploaded_file_path(url)
        path.unlink(missing_ok=True)

    return router, UploadRouteHandlers(
        upload_images=upload_images,
        delete_uploaded_image=delete_uploaded_image,
    )
