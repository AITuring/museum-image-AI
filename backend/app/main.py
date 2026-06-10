import asyncio
import json
import logging
from pathlib import Path
from uuid import uuid4
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, select, text
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.db import Base, engine, get_db
from app.models import Artifact, ArtifactImage, ArtifactTag, Museum
from app.schemas import (
    ArtifactCreate,
    ArtifactImageAttach,
    ArtifactImageRead,
    ArtifactRead,
    HealthRead,
    MuseumCreate,
    MuseumRead,
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
    db: Session = Depends(get_db),
) -> list[Artifact]:
    query = artifact_detail_query().order_by(Artifact.created_at.desc())
    if museum_id is not None:
        query = query.where(Artifact.museum_id == museum_id)
    if era is not None:
        query = query.where(Artifact.era == era)
    if tag is not None:
        query = query.join(Artifact.tags).where(ArtifactTag.name == tag).distinct()
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
