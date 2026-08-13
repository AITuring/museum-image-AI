import asyncio
import base64
import json
import logging
import mimetypes
import time as time_module
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from app.exif_utils import ImageExifWriteError
from app.schemas import (
    ArtifactDescriptionGenerateRead,
    ArtifactDescriptionGenerateRequest,
    ArtifactRead,
    ExifArtifactSubmitRequest,
    ParsedArtifactNameRead,
)

logger = logging.getLogger("app.vision")


@dataclass(slots=True)
class QuickEntryRouteDependencies:
    parse_artifact_compound_name: Callable[..., ParsedArtifactNameRead]
    generate_artifact_description_payload: Callable[..., Any]
    hash_bytes: Callable[[bytes], str]
    build_fallback_description: Callable[..., str]
    update_image_exif_metadata: Callable[..., bytes]
    verify_written_gps: Callable[..., None]
    extract_exif_and_preview_from_file: Callable[..., Any]
    resolve_uploaded_file_path: Callable[[str], Path]
    submit_artifact_to_cloud: Callable[..., Any]
    normalize_source_hash: Callable[[str | None], str | None]


@dataclass(slots=True)
class QuickEntryRouteHandlers:
    parse_artifact_name: Callable[..., Any]
    generate_description: Callable[..., Any]
    generate_description_file: Callable[..., Any]
    generate_description_stream_file: Callable[..., Any]
    prepare_exif_file: Callable[..., Any]
    extract_exif_file: Callable[..., Any]
    submit_with_exif: Callable[..., Any]
    submit_with_exif_file: Callable[..., Any]


def create_quick_entry_router(
    dependencies: QuickEntryRouteDependencies,
) -> tuple[APIRouter, QuickEntryRouteHandlers]:
    router = APIRouter()

    @router.get("/artifacts/parse-name", response_model=ParsedArtifactNameRead)
    def parse_artifact_name(
        name: str = Query(..., min_length=1),
    ) -> ParsedArtifactNameRead:
        return dependencies.parse_artifact_compound_name(name)

    @router.post(
        "/artifacts/generate-description",
        response_model=ArtifactDescriptionGenerateRead,
    )
    async def generate_artifact_description_api(
        payload: ArtifactDescriptionGenerateRequest,
    ) -> ArtifactDescriptionGenerateRead:
        return await dependencies.generate_artifact_description_payload(
            image_urls=[payload.image_url] if payload.image_url else [],
            museum_name=payload.museum_name,
            name=payload.name,
            era=payload.era,
            Place_of_Excavation=payload.Place_of_Excavation,
        )

    @router.post(
        "/artifacts/generate-description-file",
        response_model=ArtifactDescriptionGenerateRead,
    )
    async def generate_artifact_description_file_api(
        file: UploadFile | None = File(None),
        museum_name: str | None = Form(None),
        name: str = Form(...),
        era: str | None = Form(None),
        Place_of_Excavation: str | None = Form(None),
    ) -> ArtifactDescriptionGenerateRead:
        return await dependencies.generate_artifact_description_payload(
            image_urls=[],
            museum_name=museum_name,
            name=name,
            era=era,
            Place_of_Excavation=Place_of_Excavation,
        )

    @router.post("/artifacts/generate-description-stream-file")
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

            yield (
                "data: "
                + json.dumps(
                    {
                        "type": "progress",
                        "message": "已读取名称、年代、博物馆与出土地点",
                    },
                    ensure_ascii=False,
                )
                + "\n\n"
            )
            task = asyncio.create_task(
                dependencies.generate_artifact_description_payload(
                    image_urls=[],
                    museum_name=museum_name,
                    name=name,
                    era=era,
                    Place_of_Excavation=Place_of_Excavation,
                    event_callback=emit,
                )
            )
            while not task.done() or not event_queue.empty():
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield (
                        "data: "
                        + json.dumps({"type": "heartbeat"}, ensure_ascii=False)
                        + "\n\n"
                    )
            result = await task
            yield (
                "data: "
                + json.dumps(
                    {"type": "result", "result": result.model_dump()},
                    ensure_ascii=False,
                )
                + "\n\n"
            )

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.post("/artifacts/prepare-exif-file")
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
        source_hash = await run_in_threadpool(dependencies.hash_bytes, original_bytes)
        description_text = description or dependencies.build_fallback_description(
            museum_name=museum_name,
            name=name,
            era=era,
            Place_of_Excavation=Place_of_Excavation,
        )
        try:
            image_bytes = await run_in_threadpool(
                dependencies.update_image_exif_metadata,
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
        await run_in_threadpool(
            dependencies.verify_written_gps,
            image_bytes,
            latitude,
            longitude,
        )
        content_type = (
            file.content_type
            or mimetypes.guess_type(file.filename or "")[0]
            or "image/jpeg"
        )
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

    @router.post("/artifacts/extract-exif-file")
    async def extract_artifact_exif_file(
        file: UploadFile = File(...),
    ) -> dict[str, object | None]:
        """Read capture metadata and a compact preview from the spooled upload."""
        if not file.filename:
            raise HTTPException(status_code=400, detail="图片内容为空。")
        metadata, preview_bytes = await run_in_threadpool(
            dependencies.extract_exif_and_preview_from_file,
            file.file,
        )
        return {
            **metadata.as_dict(),
            "captured_at": metadata.captured_at.isoformat()
            if metadata.captured_at
            else None,
            "preview_data_url": (
                "data:image/jpeg;base64,"
                + base64.b64encode(preview_bytes).decode("ascii")
                if preview_bytes
                else None
            ),
        }

    @router.post(
        "/artifacts/exif-submit",
        response_model=ArtifactRead,
        status_code=201,
    )
    async def submit_artifact_with_exif(
        payload: ExifArtifactSubmitRequest,
    ) -> ArtifactRead:
        image_path = dependencies.resolve_uploaded_file_path(payload.image_url)
        original_bytes = image_path.read_bytes()
        content_type = mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
        description_text = (
            payload.description
            or dependencies.build_fallback_description(
                museum_name=payload.museum_name,
                name=payload.name,
                era=payload.era,
                Place_of_Excavation=payload.Place_of_Excavation,
            )
        )
        image_bytes = dependencies.update_image_exif_metadata(
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
        dependencies.verify_written_gps(
            image_bytes,
            payload.latitude,
            payload.longitude,
        )
        image_path.write_bytes(image_bytes)
        return await dependencies.submit_artifact_to_cloud(
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

    @router.post(
        "/artifacts/exif-submit-file",
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
        original_bytes = await file.read()
        if not original_bytes:
            raise HTTPException(status_code=400, detail="图片内容为空。")
        normalized_source_hash = dependencies.normalize_source_hash(source_hash)
        if normalized_source_hash is None:
            normalized_source_hash = await run_in_threadpool(
                dependencies.hash_bytes,
                original_bytes,
            )

        try:
            parsed_tags = json.loads(tags or "[]")
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="标签格式不正确。") from exc
        if not isinstance(parsed_tags, list):
            raise HTTPException(status_code=400, detail="标签格式不正确。")
        normalized_tags = [str(tag).strip() for tag in parsed_tags if str(tag).strip()]

        content_type = (
            file.content_type
            or mimetypes.guess_type(file.filename or "")[0]
            or "image/jpeg"
        )
        description_text = description or dependencies.build_fallback_description(
            museum_name=museum_name,
            name=name,
            era=era,
            Place_of_Excavation=Place_of_Excavation,
        )
        if exif_prepared:
            # The local-overwrite endpoint already encoded these exact bytes.
            # They are still verified below before any cloud upload begins.
            image_bytes = original_bytes
        else:
            image_bytes = await run_in_threadpool(
                dependencies.update_image_exif_metadata,
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

        # Critical quick-entry invariant: EXIF verification must finish before
        # the cloud submission callback is invoked.
        await run_in_threadpool(
            dependencies.verify_written_gps,
            image_bytes,
            latitude,
            longitude,
        )
        return await dependencies.submit_artifact_to_cloud(
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

    return router, QuickEntryRouteHandlers(
        parse_artifact_name=parse_artifact_name,
        generate_description=generate_artifact_description_api,
        generate_description_file=generate_artifact_description_file_api,
        generate_description_stream_file=(
            generate_artifact_description_stream_file_api
        ),
        prepare_exif_file=prepare_artifact_exif_file,
        extract_exif_file=extract_artifact_exif_file,
        submit_with_exif=submit_artifact_with_exif,
        submit_with_exif_file=submit_artifact_with_exif_file,
    )
