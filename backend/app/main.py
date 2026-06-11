import asyncio
import hashlib
import json
import logging
import mimetypes
from pathlib import Path
from uuid import uuid4
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, or_, select, text
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.db import Base, SessionLocal, engine, get_db
from app.models import Artifact, ArtifactImage, ArtifactTag, Museum, PendingArtifact
from app.oss import upload_image
from app.schemas import (
    ArtifactCreate,
    ArtifactImageAttach,
    ArtifactImageRead,
    ArtifactRead,
    BatchIdentifyRequest,
    BatchScanRequest,
    BatchScanResponse,
    CloudArtifactSubmitRequest,
    HealthRead,
    MuseumCreate,
    MuseumRead,
    PendingArtifactRead,
    PendingArtifactUpdate,
    UploadedImageRead,
    VisionAnalyzeRequest,
    VisionAnalyzeResponse,
)
from app.vision import (
    get_enabled_providers,
    request_provider_analysis,
    stream_provider_analysis,
)
from app.web_bridge import enabled_sites, request_web_candidate

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff"}

logger = logging.getLogger("app.vision")

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path("/data") if Path("/data").exists() else BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"


def run_startup_migrations(connection) -> None:
    inspector = inspect(connection)
    table_names = set(inspector.get_table_names())

    if "artifacts" not in table_names:
        return

    artifact_columns = {column["name"] for column in inspector.get_columns("artifacts")}

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
    )


def artifact_image_query():
    return select(ArtifactImage).options(
        selectinload(ArtifactImage.artifact).selectinload(Artifact.museum)
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


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@app.get(f"{settings.api_prefix}/health", response_model=HealthRead)
def healthcheck() -> HealthRead:
    return HealthRead(status="ok", environment=settings.app_env, database="connected")


@app.post(
    f"{settings.api_prefix}/vision/analyze",
    response_model=VisionAnalyzeResponse,
)
async def analyze_artifact_images(payload: VisionAnalyzeRequest) -> VisionAnalyzeResponse:
    if not payload.image_urls:
        raise HTTPException(status_code=400, detail="No image urls provided")

    providers, unavailable_providers = get_enabled_providers()
    web_sites = enabled_sites()
    if not providers and not web_sites:
        raise HTTPException(
            status_code=400,
            detail="No vision provider configured. Please set DASHSCOPE_API_KEY or VOLCENGINE_API_KEY.",
        )

    tasks = [
        request_provider_analysis(provider, payload.image_urls, DATA_DIR, payload.image_name)
        for provider in providers
    ]
    task_names = [provider.name for provider in providers]
    for site in web_sites:
        tasks.append(
            request_web_candidate(site, payload.image_urls, DATA_DIR, payload.image_name)
        )
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
async def upload_images(files: list[UploadFile] = File(...)) -> list[UploadedImageRead]:
    uploaded_images: list[UploadedImageRead] = []

    for file in files:
        suffix = Path(file.filename or "").suffix.lower()
        generated_name = f"{uuid4().hex}{suffix}"
        target_path = UPLOADS_DIR / generated_name

        contents = await file.read()
        target_path.write_bytes(contents)

        uploaded_images.append(
            UploadedImageRead(
                filename=file.filename or generated_name,
                url=build_uploaded_file_url(generated_name),
            )
        )

    return uploaded_images


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
    description: str | None = Form(None),
    tags: str = Form(""),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> Artifact:
    """Store the image in OSS and the metadata in the cloud DB. Bearer-token protected."""
    require_ingest_token(authorization)

    contents = await image.read()
    if not contents:
        raise HTTPException(status_code=400, detail="图片内容为空。")

    image_url = upload_image(
        contents, image.filename or "image.jpg", image.content_type
    )

    museum = ensure_museum(db, museum_name)
    artifact = Artifact(
        museum_id=museum.id,
        name=name.strip(),
        era=(era or None),
        description=(description or None),
        ai_status="reviewed",
    )
    artifact.tags = [
        ArtifactTag(name=tag) for tag in dict.fromkeys(parse_tags(tags))
    ]
    artifact.images = [ArtifactImage(url=image_url)]
    db.add(artifact)
    db.commit()
    return db.scalar(artifact_detail_query().where(Artifact.id == artifact.id))


@app.post(
    f"{settings.api_prefix}/artifacts/submit-cloud",
    response_model=ArtifactRead,
    status_code=201,
)
async def submit_single_artifact_to_cloud(payload: CloudArtifactSubmitRequest) -> Artifact:
    if not settings.cloud_api_base_url:
        raise HTTPException(status_code=400, detail="未配置 CLOUD_API_BASE_URL。")
    if not settings.ingest_token:
        raise HTTPException(status_code=400, detail="未配置 INGEST_TOKEN。")
    if not payload.museum_name.strip():
        raise HTTPException(status_code=400, detail="请填写或确认博物馆名称。")
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="请填写或确认文物名称。")

    image_path = resolve_uploaded_file_path(payload.image_url)
    content_type = mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
    base = settings.cloud_api_base_url.rstrip("/")

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{base}{settings.api_prefix}/ingest/artifacts",
                files={"image": (image_path.name, image_path.read_bytes(), content_type)},
                data={
                    "museum_name": payload.museum_name.strip(),
                    "name": payload.name.strip(),
                    "era": payload.era or "",
                    "description": payload.description or "",
                    "tags": json.dumps(payload.tags, ensure_ascii=False),
                },
                headers={"Authorization": f"Bearer {settings.ingest_token}"},
            )
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001 - surface submit failure to the operator
        raise HTTPException(status_code=502, detail=f"提交云端失败：{exc}") from exc

    return ArtifactRead.model_validate(response.json())


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
        file_hash = hash_file(path)
        existing = db.scalar(
            select(PendingArtifact).where(PendingArtifact.file_hash == file_hash)
        )
        if existing is not None:
            skipped += 1
            continue
        db.add(
            PendingArtifact(
                source_path=str(path),
                file_hash=file_hash,
                file_name=path.name,
                status="pending",
                tags=[],
            )
        )
        added += 1
    db.commit()

    items = list(
        db.scalars(select(PendingArtifact).order_by(PendingArtifact.created_at.desc()))
    )
    return BatchScanResponse(scanned=scanned, added=added, skipped=skipped, items=items)


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
def pending_image(pending_id: int, db: Session = Depends(get_db)) -> FileResponse:
    row = db.get(PendingArtifact, pending_id)
    if row is None:
        raise HTTPException(status_code=404, detail="记录不存在。")
    path = Path(row.source_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="原图文件已不存在。")
    return FileResponse(str(path))


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
                try:
                    candidate = await request_web_candidate(
                        site, [row.source_path], DATA_DIR, row.file_name
                    )
                    row.museum_name = candidate.museum_name
                    row.name = candidate.artifact_name
                    row.era = candidate.era
                    row.description = candidate.description
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
    response_model=PendingArtifactRead,
)
async def submit_pending(
    pending_id: int, db: Session = Depends(get_db)
) -> PendingArtifact:
    if not settings.cloud_api_base_url:
        raise HTTPException(status_code=400, detail="未配置 CLOUD_API_BASE_URL。")

    row = db.get(PendingArtifact, pending_id)
    if row is None:
        raise HTTPException(status_code=404, detail="记录不存在。")
    if not (row.name and row.name.strip()) or not (row.museum_name and row.museum_name.strip()):
        raise HTTPException(status_code=400, detail="请先填写文物名称和博物馆名称。")

    path = Path(row.source_path)
    if not path.exists():
        raise HTTPException(status_code=400, detail="原图文件已不存在，无法提交。")

    row.status = "submitting"
    row.error = None
    db.commit()

    content_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    base = settings.cloud_api_base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{base}{settings.api_prefix}/ingest/artifacts",
                files={"image": (row.file_name, path.read_bytes(), content_type)},
                data={
                    "museum_name": row.museum_name,
                    "name": row.name,
                    "era": row.era or "",
                    "description": row.description or "",
                    "tags": json.dumps(row.tags or [], ensure_ascii=False),
                },
                headers={"Authorization": f"Bearer {settings.ingest_token}"},
            )
            response.raise_for_status()
            created = response.json()
    except Exception as exc:  # noqa: BLE001 - surface submit failure to the operator
        logger.warning("submit pending %s failed: %s", pending_id, exc, exc_info=exc)
        row.status = "failed"
        row.error = f"提交云端失败：{exc}"
        db.commit()
        raise HTTPException(status_code=502, detail=row.error) from exc

    row.cloud_artifact_id = created.get("id")
    row.status = "submitted"
    db.commit()
    db.refresh(row)
    return row


@app.get(f"{settings.api_prefix}/museums", response_model=list[MuseumRead])
def list_museums(db: Session = Depends(get_db)) -> list[Museum]:
    return list(db.scalars(select(Museum).order_by(Museum.created_at.desc())))


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


@app.get(f"{settings.api_prefix}/artifacts", response_model=list[ArtifactRead])
def list_artifacts(
    museum_id: int | None = Query(default=None),
    era: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    q: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[Artifact]:
    query = artifact_detail_query().order_by(Artifact.created_at.desc())
    if museum_id is not None:
        query = query.where(Artifact.museum_id == museum_id)
    if era is not None:
        query = query.where(Artifact.era == era)
    if tag is not None:
        query = query.join(Artifact.tags).where(ArtifactTag.name == tag).distinct()
    if q is not None and q.strip():
        like = f"%{q.strip()}%"
        query = query.join(Artifact.museum).where(
            or_(
                Artifact.name.ilike(like),
                Artifact.description.ilike(like),
                Artifact.era.ilike(like),
                Museum.name.ilike(like),
            )
        )
    return list(db.scalars(query))


@app.post(f"{settings.api_prefix}/artifacts", response_model=ArtifactRead, status_code=201)
def create_artifact(payload: ArtifactCreate, db: Session = Depends(get_db)) -> Artifact:
    museum = db.get(Museum, payload.museum_id)
    if museum is None:
        raise HTTPException(status_code=404, detail="Museum not found")

    artifact = Artifact(
        museum_id=payload.museum_id,
        name=payload.name,
        era=payload.era,
        description=payload.description,
    )
    artifact.tags = [
        ArtifactTag(name=tag)
        for tag in dict.fromkeys(tag.strip() for tag in payload.tags if tag.strip())
    ]
    artifact.images = [ArtifactImage(url=image.url) for image in payload.images]
    db.add(artifact)
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

    image = ArtifactImage(artifact_id=payload.artifact_id, url=payload.url)
    db.add(image)
    db.commit()
    return db.scalar(artifact_image_query().where(ArtifactImage.id == image.id))
