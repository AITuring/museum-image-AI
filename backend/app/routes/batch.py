import json
import logging
import mimetypes
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import PendingArtifact
from app.schemas import (
    BatchIdentifyRequest,
    BatchScanRequest,
    BatchScanResponse,
    PendingArtifactRead,
    PendingArtifactSubmitRequest,
    PendingArtifactSubmitResult,
    PendingArtifactUpdate,
)

logger = logging.getLogger("app.vision")


@dataclass(slots=True)
class BatchRouteDependencies:
    image_extensions: set[str]
    data_dir: Path
    legacy_batch_imports_dir: Path
    session_factory: Callable[[], Session]
    hash_file: Callable[..., Any]
    hash_bytes: Callable[..., Any]
    build_image_metadata: Callable[..., Any]
    register_pending_artifact: Callable[..., Any]
    scan_pending_items: Callable[..., Any]
    pending_artifact_image_bytes: Callable[..., Any]
    materialize_pending_artifact_image: Callable[..., Any]
    sse: Callable[..., Any]
    enabled_sites: Callable[..., Any]
    request_web_candidate: Callable[..., Any]
    fetch_cloud_artifact_match: Callable[..., Any]
    normalize_exhibition_name: Callable[..., Any]
    extract_http_error_detail: Callable[..., Any]


@dataclass(slots=True)
class BatchRouteHandlers:
    batch_scan: Callable[..., Any]
    batch_scan_files: Callable[..., Any]
    list_pending: Callable[..., Any]
    pending_image: Callable[..., Any]
    update_pending: Callable[..., Any]
    delete_pending: Callable[..., Any]
    batch_identify_stream: Callable[..., Any]
    submit_pending: Callable[..., Any]


def create_batch_router(
    dependencies: BatchRouteDependencies,
) -> tuple[APIRouter, BatchRouteHandlers]:
    """Build local batch-entry routes around explicitly supplied services."""
    router = APIRouter()

    @router.post("/batch/scan", response_model=BatchScanResponse)
    def batch_scan(
        payload: BatchScanRequest,
        db: Session = Depends(get_db),
    ) -> BatchScanResponse:
        root = Path(payload.directory).expanduser()
        if not root.exists() or not root.is_dir():
            raise HTTPException(
                status_code=400, detail=f"目录不存在或不是文件夹：{root}"
            )

        extensions = {
            extension.lower() for extension in payload.extensions
        } or dependencies.image_extensions
        scanned = added = skipped = 0
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in extensions:
                continue
            scanned += 1
            contents = path.read_bytes()
            file_hash = dependencies.hash_file(path)
            metadata = dependencies.build_image_metadata(image_bytes=contents)
            created = dependencies.register_pending_artifact(
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

        items = dependencies.scan_pending_items(db)
        return BatchScanResponse(
            scanned=scanned,
            added=added,
            skipped=skipped,
            items=items,
        )

    @router.post("/batch/scan-files", response_model=BatchScanResponse)
    async def batch_scan_files(
        files: list[UploadFile] = File(...),
        db: Session = Depends(get_db),
    ) -> BatchScanResponse:
        scanned = added = skipped = 0
        for file in files:
            suffix = Path(file.filename or "").suffix.lower()
            if suffix not in dependencies.image_extensions:
                continue
            contents = await file.read()
            if not contents:
                continue
            scanned += 1
            file_hash = dependencies.hash_bytes(contents)
            metadata = dependencies.build_image_metadata(image_bytes=contents)
            file_name = Path(file.filename or f"{file_hash}{suffix}").name
            content_type = (
                file.content_type or mimetypes.guess_type(file_name)[0] or "image/jpeg"
            )
            created = dependencies.register_pending_artifact(
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
            items=dependencies.scan_pending_items(db),
        )

    @router.get("/batch/pending", response_model=list[PendingArtifactRead])
    def list_pending(
        status: str | None = Query(default=None),
        db: Session = Depends(get_db),
    ) -> list[PendingArtifact]:
        query = select(PendingArtifact).order_by(PendingArtifact.created_at.desc())
        if status is not None:
            query = query.where(PendingArtifact.status == status)
        return list(db.scalars(query))

    @router.get("/batch/pending/{pending_id}/image")
    def pending_image(
        pending_id: int,
        db: Session = Depends(get_db),
    ) -> Response:
        row = db.get(PendingArtifact, pending_id)
        if row is None:
            raise HTTPException(status_code=404, detail="记录不存在。")
        image_bytes, content_type = dependencies.pending_artifact_image_bytes(row)
        return Response(content=image_bytes, media_type=content_type)

    @router.patch(
        "/batch/pending/{pending_id}",
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

    @router.delete("/batch/pending/{pending_id}", status_code=204)
    def delete_pending(
        pending_id: int,
        db: Session = Depends(get_db),
    ) -> None:
        row = db.get(PendingArtifact, pending_id)
        if row is not None:
            path = Path(row.source_path)
            if (
                path.is_absolute()
                and path.exists()
                and path.is_file()
                and dependencies.legacy_batch_imports_dir in path.parents
            ):
                path.unlink(missing_ok=True)
            db.delete(row)
            db.commit()

    @router.post("/batch/identify/stream")
    async def batch_identify_stream(
        payload: BatchIdentifyRequest,
    ) -> StreamingResponse:
        sites = dependencies.enabled_sites()
        if not sites:
            raise HTTPException(
                status_code=400,
                detail="未启用网页桥（请设置 QWEN_WEB_ENABLED=true 并完成登录）。",
            )
        site = sites[0]

        async def event_generator():
            db = dependencies.session_factory()
            try:
                query = select(PendingArtifact)
                if payload.ids:
                    query = query.where(PendingArtifact.id.in_(payload.ids))
                else:
                    query = query.where(
                        PendingArtifact.status.in_(["pending", "failed"])
                    )
                rows = list(db.scalars(query.order_by(PendingArtifact.created_at)))

                yield dependencies.sse(
                    {"stage": "meta", "total": len(rows), "provider": site.key}
                )

                for row in rows:
                    yield dependencies.sse(
                        {
                            "stage": "start",
                            "id": row.id,
                            "file_name": row.file_name,
                        }
                    )
                    row.status = "identifying"
                    row.error = None
                    db.commit()
                    temp_path: Path | None = None
                    try:
                        image_path, temp_path = (
                            dependencies.materialize_pending_artifact_image(row)
                        )
                        candidate = await dependencies.request_web_candidate(
                            site,
                            [str(image_path)],
                            dependencies.data_dir,
                            row.file_name,
                        )
                        matched_artifact = (
                            await dependencies.fetch_cloud_artifact_match(
                                name=candidate.artifact_name,
                                museum_name=candidate.museum_name,
                                era=candidate.era,
                            )
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
                        yield dependencies.sse(
                            {
                                "stage": "item",
                                "id": row.id,
                                "item": PendingArtifactRead.model_validate(
                                    row
                                ).model_dump(mode="json"),
                            }
                        )
                    except Exception as exc:  # noqa: BLE001 - surface per-item failure
                        logger.warning(
                            "batch identify %s failed: %s",
                            row.id,
                            exc,
                            exc_info=exc,
                        )
                        row.status = "failed"
                        row.error = str(exc) or "识别失败"
                        db.commit()
                        yield dependencies.sse(
                            {
                                "stage": "item_error",
                                "id": row.id,
                                "message": row.error,
                            }
                        )
                    finally:
                        if temp_path is not None:
                            temp_path.unlink(missing_ok=True)

                yield dependencies.sse({"stage": "done"})
            finally:
                db.close()

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.post(
        "/batch/pending/{pending_id}/submit",
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
            raise HTTPException(
                status_code=409, detail="该记录正在提交中，请稍候刷新。"
            )
        if not (row.name and row.name.strip()) or not (
            row.museum_name and row.museum_name.strip()
        ):
            raise HTTPException(
                status_code=400,
                detail="请先填写文物名称和博物馆名称。",
            )

        row.status = "submitting"
        row.error = None
        db.commit()

        image_bytes, content_type = dependencies.pending_artifact_image_bytes(row)
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
                        "exhibition_name": dependencies.normalize_exhibition_name(
                            row.exhibition_name
                        ),
                        "latitude": "" if row.latitude is None else str(row.latitude),
                        "longitude": (
                            "" if row.longitude is None else str(row.longitude)
                        ),
                        "captured_at": (
                            row.captured_at.isoformat() if row.captured_at else ""
                        ),
                        "shutter_speed": row.shutter_speed or "",
                        "aperture": row.aperture or "",
                        "iso": "" if row.iso is None else str(row.iso),
                        "edit_method": row.edit_method or "",
                        "skip_existing_match": (
                            "true"
                            if payload is not None and payload.skip_existing_match
                            else "false"
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
                        detail=(
                            "提交云端失败："
                            f"{dependencies.extract_http_error_detail(response)}"
                        ),
                    )
                created = response.json()
        except Exception as exc:  # noqa: BLE001 - surface submit failure to the operator
            logger.warning(
                "submit pending %s failed: %s",
                pending_id,
                exc,
                exc_info=exc,
            )
            row.status = "failed"
            row.error = (
                exc.detail if isinstance(exc, HTTPException) else f"提交云端失败：{exc}"
            )
            db.commit()
            if isinstance(exc, HTTPException):
                raise HTTPException(
                    status_code=exc.status_code,
                    detail=row.error,
                ) from exc
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

    return router, BatchRouteHandlers(
        batch_scan=batch_scan,
        batch_scan_files=batch_scan_files,
        list_pending=list_pending,
        pending_image=pending_image,
        update_pending=update_pending,
        delete_pending=delete_pending,
        batch_identify_stream=batch_identify_stream,
        submit_pending=submit_pending,
    )
