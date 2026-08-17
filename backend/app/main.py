import asyncio
import logging
import threading
import time as time_module
from contextlib import asynccontextmanager
from pathlib import Path
from typing import BinaryIO

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text
from sqlalchemy.orm import selectinload

from app.artifact_research.agent import prompt_sources, run_artifact_research
from app.artifact_research.router import router as artifact_research_router
from app.config import settings
from app.db import Base, SessionLocal, engine
from app.exhibition_db import (
    ExhibitionSessionLocal,
    initialize_exhibition_database,
)
from app.exhibition_service import (
    exhibition_backfill_remaining,
    exhibition_catalog_count,
    exhibition_sync_coordinator,
    latest_sync_run,
)
from app.exif_utils import (
    extract_exif_and_preview_from_file,
    image_content_fingerprint,
    update_image_exif_metadata,
)
from app.models import Artifact, ArtifactExhibition, ArtifactImage, Exhibition
from app.oss import delete_image, oss_configured, upload_image
from app.request_context import (  # noqa: F401 - compatibility export
    add_request_observability,
    current_request_id,
)
from app.routes.artifacts import (  # noqa: F401 - compatibility exports
    ArtifactRouteDependencies,
    configure_artifact_routes,
    create_artifact,
    create_artifact_image,
    create_exhibition,
    create_museum,
    get_artifact,
    get_artifact_image_by_hash,
    get_artifact_image_by_source_hash,
    get_era_timeline,
    get_image_variant,
    list_artifact_images,
    list_artifacts,
    list_era_options,
    list_exhibitions,
    list_museums,
    match_artifact,
    match_artifact_route,
    update_artifact,
    update_museum,
)
from app.routes.artifacts import router as artifact_router
from app.routes.batch import BatchRouteDependencies, create_batch_router
from app.routes.cloud_ingest import CloudIngestDependencies, create_cloud_ingest_router
from app.routes.exhibition_catalog import (  # noqa: F401 - compatibility exports
    ExhibitionCatalogRouteDependencies,
    artifact_summary,
    configure_exhibition_catalog_routes,
    get_exhibition_catalog_detail,
    get_exhibition_catalog_detail_by_source,
    get_exhibition_sync_live_status,
    get_exhibition_sync_status,
    get_historical_exhibition_detail,
    haversine_distance_km,
    is_long_running_catalog_exhibition,
    list_exhibition_catalog,
    list_exhibition_catalog_artifacts,
    list_museum_directory,
    looks_like_catalog_institution,
    normalize_catalog_match_text,
    recommend_exhibition_catalog,
    start_exhibition_sync,
)
from app.routes.exhibition_catalog import router as exhibition_catalog_router
from app.routes.google_photos import (
    GooglePhotosRouteDependencies,
    create_google_photos_router,
)
from app.routes.health import create_health_router
from app.routes.map_tiles import create_map_tile_router
from app.routes.quick_entry import (
    QuickEntryRouteDependencies,
    create_quick_entry_router,
)
from app.routes.uploads import UploadRouteDependencies, create_upload_router
from app.routes.vision import VisionRouteDependencies, create_vision_router
from app.routes.web_bridge import (
    WebBridgeRouteDependencies,
    create_web_bridge_router,
)
from app.services.artifact_metadata import (  # noqa: F401 - compatibility exports
    IMAGE_EXTENSIONS,
    artifact_name_match_score,
    build_capture_tags,
    build_fallback_description,
    canonical_catalog_museum_name,
    catalog_museum_directory_id,
    catalog_museum_names_for_directory_name,
    catalog_museum_query_name,
    compact_artifact_name_for_match,
    ensure_exhibition,
    ensure_museum,
    has_valid_coordinates,
    is_catalog_room_label,
    longest_common_subsequence_length,
    merge_unique_tags,
    museum_map_coordinates,
    museum_name_matches_catalog_museum,
    normalize_artifact_field_warnings,
    normalize_edit_method,
    normalize_era_label,
    normalize_exhibition_name,
    normalize_identity_text,
    normalize_museum_directory_key,
    normalize_museum_name_for_write,
    normalize_museum_segment,
    normalize_place_of_excavation,
    normalize_verified_claims,
    optional_datetime,
    optional_float,
    optional_int,
    optional_text,
    parse_artifact_compound_name,
    parse_tags,
    resolve_museum_branch_from_image_gps,
)
from app.services.catalog import (  # noqa: F401 - compatibility exports
    ArtifactMatchCandidate,
    CatalogServiceDependencies,
    artifact_read_merge_key,
    attach_catalog_metadata_to_uploaded_museum_directory,
    build_artifact_match_read,
    build_uploaded_museum_directory,
    catalog_museum_directory_summaries,
    configure_catalog_service,
    datetime_sort_value,
    enrich_artifact_catalog_links,
    fetch_cloud_artifact_match,
    fetch_cloud_artifact_payload,
    find_existing_artifact_match,
    get_cached_cloud_museum_directory_artifacts,
    get_cloud_museum_directory_artifacts,
    load_persisted_cloud_museum_directory_artifacts,
    merge_duplicate_artifact_reads,
    persist_cloud_museum_directory_artifacts,
    refresh_cloud_museum_directory_artifacts,
    should_proxy_artifact_queries_to_cloud,
)
from app.services.cloud_submission import (
    CloudSubmissionService,
    extract_http_error_detail,
)
from app.services.image_delivery import (  # noqa: F401 - compatibility exports
    ImageDeliveryDependencies,
    build_uploaded_file_url,
    configure_image_delivery,
    is_allowed_remote_image_url,
    load_image_source_bytes,
    render_image_variant,
    resolve_uploaded_file_path,
)
from app.services.ingest_support import (  # noqa: F401 - compatibility exports
    SHA256_PATTERN,
    IngestSupportDependencies,
    build_duplicate_artifact_read,
    build_duplicate_image_detail,
    build_image_metadata,
    cleanup_existing_content_duplicates,
    configure_ingest_support,
    find_artifact_image_by_hash_local,
    find_artifact_image_by_source_hash_local,
    find_artifact_images_by_content,
    hash_bytes,
    hash_file,
    normalize_source_hash,
    persist_upload_and_build_preview,
    resolve_capture_context,
    sync_artifact_links_and_tags,
    verify_written_gps,
)
from app.services.ingest_support import (
    read_bounded_upload as _read_bounded_upload,
)
from app.services.pending_artifacts import (  # noqa: F401 - compatibility exports
    materialize_pending_artifact_image,
    pending_artifact_image_bytes,
    register_pending_artifact,
    scan_pending_items,
    sse,
)
from app.services.vision_workflow import (  # noqa: F401 - compatibility exports
    VisionWorkflowDependencies,
    configure_vision_workflow,
    find_duplicate_artifact_image,
    generate_artifact_description_payload,
    run_vision_analysis,
    write_temp_image_file,
)
from app.startup import run_startup_migrations as _run_startup_migrations
from app.startup import sync_reference_options
from app.vision import (
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
CLOUD_INGEST_WORK_SEMAPHORE = threading.BoundedSemaphore(
    max(1, settings.cloud_ingest_concurrency)
)

cloud_http_client: httpx.AsyncClient | None = None


def run_startup_migrations(connection) -> None:
    _run_startup_migrations(
        connection,
        legacy_batch_imports_dir=LEGACY_BATCH_IMPORTS_DIR,
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
    if settings.exhibition_sync_enabled and exhibition_catalog_ready:
        exhibition_sync_coordinator.start_scheduler()
        with ExhibitionSessionLocal() as exhibition_db:
            catalog_total = exhibition_catalog_count(exhibition_db)
            latest_run = latest_sync_run(exhibition_db)
            discovered_total = latest_run.discovered if latest_run is not None else 0
            backfill_remaining = exhibition_backfill_remaining(
                exhibition_db,
                discovered_total,
            )
            if catalog_total == 0 or backfill_remaining > 0:
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
    expose_headers=[
        "X-Source-Hash",
        "X-Error-Code",
        "X-Request-ID",
        "X-App-Revision",
        "Retry-After",
        "Server-Timing",
    ],
)
app.middleware("http")(add_request_observability)


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


def require_ingest_token(authorization: str | None) -> None:
    expected = settings.ingest_token
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="云端未配置 INGEST_TOKEN，拒绝写入。",
        )
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="无效的鉴权令牌。")


def cloud_ingest_configuration_error() -> str | None:
    missing: list[str] = []
    if not settings.ingest_token:
        missing.append("INGEST_TOKEN")
    if not oss_configured():
        missing.append(
            "OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_ENDPOINT / OSS_BUCKET"
        )
    if not missing:
        return None
    return f"云端入库配置不完整：缺少 {'；'.join(missing)}。"


def reserve_cloud_ingest_slot():
    if not CLOUD_INGEST_WORK_SEMAPHORE.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail="云端正在处理另一张图片，请稍候自动重试。",
            headers={"Retry-After": "2"},
        )
    try:
        yield
    finally:
        CLOUD_INGEST_WORK_SEMAPHORE.release()


def read_bounded_upload(source: BinaryIO) -> bytes:
    """Compatibility wrapper that keeps MAX_IMAGE_SOURCE_BYTES patchable."""
    return _read_bounded_upload(source, max_bytes=MAX_IMAGE_SOURCE_BYTES)


# Service composition. Lambdas intentionally resolve main-module globals at
# call time so legacy imports and test patches keep working after the split.
configure_catalog_service(
    CatalogServiceDependencies(
        data_dir=DATA_DIR,
        artifact_detail_query=lambda: artifact_detail_query(),
        get_exhibition_session_factory=lambda: ExhibitionSessionLocal,
    )
)
configure_image_delivery(
    ImageDeliveryDependencies(
        data_dir=DATA_DIR,
        max_image_source_bytes=MAX_IMAGE_SOURCE_BYTES,
        should_proxy_artifact_queries_to_cloud=lambda: (
            should_proxy_artifact_queries_to_cloud()
        ),
    )
)
configure_ingest_support(
    IngestSupportDependencies(
        open_exhibition_session=lambda: ExhibitionSessionLocal(),
        catalog_museum_directory_summaries=lambda *args, **kwargs: (
            catalog_museum_directory_summaries(*args, **kwargs)
        ),
        artifact_image_query=lambda: artifact_image_query(),
        open_primary_session=lambda: SessionLocal(),
        delete_image=lambda *args, **kwargs: delete_image(*args, **kwargs),
    )
)
configure_vision_workflow(
    VisionWorkflowDependencies(
        data_dir=DATA_DIR,
        get_enabled_providers=lambda: get_enabled_providers(),
        enabled_sites=lambda: enabled_sites(),
        request_provider_analysis=lambda *args, **kwargs: request_provider_analysis(
            *args, **kwargs
        ),
        request_web_candidate=lambda *args, **kwargs: request_web_candidate(
            *args, **kwargs
        ),
        run_artifact_research=lambda *args, **kwargs: run_artifact_research(
            *args, **kwargs
        ),
        generate_artifact_descriptions_parallel=lambda *args, **kwargs: (
            generate_artifact_descriptions_parallel(*args, **kwargs)
        ),
        prompt_sources=lambda *args, **kwargs: prompt_sources(*args, **kwargs),
        build_fallback_description=lambda *args, **kwargs: build_fallback_description(
            *args, **kwargs
        ),
        normalize_verified_claims=lambda *args, **kwargs: normalize_verified_claims(
            *args, **kwargs
        ),
        normalize_artifact_field_warnings=lambda *args, **kwargs: (
            normalize_artifact_field_warnings(*args, **kwargs)
        ),
        optional_text=lambda *args, **kwargs: optional_text(*args, **kwargs),
        sanitize_generated_tags=lambda *args, **kwargs: sanitize_generated_tags(
            *args, **kwargs
        ),
        should_proxy_artifact_queries_to_cloud=lambda: (
            should_proxy_artifact_queries_to_cloud()
        ),
        find_artifact_image_by_hash_local=lambda *args, **kwargs: (
            find_artifact_image_by_hash_local(*args, **kwargs)
        ),
        hash_bytes=lambda contents: hash_bytes(contents),
    )
)

_cloud_submission_service = CloudSubmissionService(
    get_http_client=lambda: cloud_http_client,
    normalize_place_of_excavation=lambda value: normalize_place_of_excavation(value),
    normalize_exhibition_name=lambda value: normalize_exhibition_name(value),
)
submit_artifact_to_cloud = _cloud_submission_service.submit_artifact_to_cloud


# Small infrastructure routes.
health_router, healthcheck = create_health_router(
    get_engine=lambda: engine,
    get_ingest_configuration_error=cloud_ingest_configuration_error,
)
app.include_router(health_router, prefix=settings.api_prefix)

map_tile_router, map_tile, MAP_TILE_CACHE = create_map_tile_router(
    get_http_client=lambda: cloud_http_client,
)
app.include_router(map_tile_router, prefix=settings.api_prefix)

web_bridge_router, _web_bridge_handlers = create_web_bridge_router(
    WebBridgeRouteDependencies(
        enabled_sites=lambda: enabled_sites(),
        build_web_bridge_status=lambda *args, **kwargs: build_web_bridge_status(
            *args, **kwargs
        ),
        start_web_bridge_login=lambda: start_web_bridge_login(),
    )
)
app.include_router(web_bridge_router, prefix=settings.api_prefix)
web_bridge_status = _web_bridge_handlers.status
start_web_bridge_login_helper = _web_bridge_handlers.start_login

vision_router, _vision_handlers = create_vision_router(
    VisionRouteDependencies(
        data_dir=DATA_DIR,
        run_vision_analysis=lambda *args, **kwargs: run_vision_analysis(
            *args, **kwargs
        ),
        write_temp_image_file=lambda *args, **kwargs: write_temp_image_file(
            *args, **kwargs
        ),
        get_enabled_providers=lambda: get_enabled_providers(),
        enabled_sites=lambda: enabled_sites(),
        stream_provider_analysis=lambda *args, **kwargs: stream_provider_analysis(
            *args, **kwargs
        ),
        request_web_candidate=lambda *args, **kwargs: request_web_candidate(
            *args, **kwargs
        ),
    )
)
app.include_router(vision_router, prefix=settings.api_prefix)
analyze_artifact_images = _vision_handlers.analyze
analyze_artifact_image_file = _vision_handlers.analyze_file
analyze_artifact_images_stream = _vision_handlers.analyze_stream

upload_router, _upload_handlers = create_upload_router(
    UploadRouteDependencies(
        uploads_dir=UPLOADS_DIR,
        persist_upload_and_build_preview=lambda *args, **kwargs: (
            persist_upload_and_build_preview(*args, **kwargs)
        ),
        find_duplicate_artifact_image=lambda *args, **kwargs: (
            find_duplicate_artifact_image(*args, **kwargs)
        ),
        build_duplicate_image_detail=lambda *args, **kwargs: (
            build_duplicate_image_detail(*args, **kwargs)
        ),
        build_uploaded_file_url=lambda filename: build_uploaded_file_url(filename),
        resolve_uploaded_file_path=lambda url: resolve_uploaded_file_path(url),
    )
)
app.include_router(upload_router, prefix=settings.api_prefix)
upload_images = _upload_handlers.upload_images
delete_uploaded_image = _upload_handlers.delete_uploaded_image


# Local import and quick-entry routes.
_google_photos_dependencies = GooglePhotosRouteDependencies(
    hash_bytes=lambda *args, **kwargs: hash_bytes(*args, **kwargs),
    build_image_metadata=lambda *args, **kwargs: build_image_metadata(*args, **kwargs),
    register_pending_artifact=lambda *args, **kwargs: register_pending_artifact(
        *args, **kwargs
    ),
    optional_text=lambda value: optional_text(value),
)
google_photos_router, _google_photos_handlers = create_google_photos_router(
    _google_photos_dependencies
)
app.include_router(google_photos_router, prefix=settings.api_prefix)
google_photos_status = _google_photos_handlers.status
google_photos_config = _google_photos_handlers.config
update_google_photos_config = _google_photos_handlers.update_config
delete_google_photos_token = _google_photos_handlers.delete_token
google_photos_auth_start = _google_photos_handlers.auth_start
google_photos_auth_callback = _google_photos_handlers.auth_callback
google_photos_picker_session_create = _google_photos_handlers.picker_session_create
google_photos_picker_session_get = _google_photos_handlers.picker_session_get
google_photos_picker_session_delete = _google_photos_handlers.picker_session_delete
google_photos_picker_media_items = _google_photos_handlers.picker_media_items
google_photos_import = _google_photos_handlers.import_photos

quick_entry_router, _quick_entry_handlers = create_quick_entry_router(
    QuickEntryRouteDependencies(
        parse_artifact_compound_name=lambda *args, **kwargs: (
            parse_artifact_compound_name(*args, **kwargs)
        ),
        generate_artifact_description_payload=lambda *args, **kwargs: (
            generate_artifact_description_payload(*args, **kwargs)
        ),
        hash_bytes=lambda contents: hash_bytes(contents),
        build_fallback_description=lambda *args, **kwargs: build_fallback_description(
            *args, **kwargs
        ),
        update_image_exif_metadata=lambda *args, **kwargs: update_image_exif_metadata(
            *args, **kwargs
        ),
        verify_written_gps=lambda *args, **kwargs: verify_written_gps(*args, **kwargs),
        extract_exif_and_preview_from_file=lambda *args, **kwargs: (
            extract_exif_and_preview_from_file(*args, **kwargs)
        ),
        resolve_uploaded_file_path=lambda url: resolve_uploaded_file_path(url),
        submit_artifact_to_cloud=lambda *args, **kwargs: submit_artifact_to_cloud(
            *args, **kwargs
        ),
        normalize_source_hash=lambda value: normalize_source_hash(value),
    )
)
app.include_router(quick_entry_router, prefix=settings.api_prefix)
parse_artifact_name = _quick_entry_handlers.parse_artifact_name
generate_artifact_description_api = _quick_entry_handlers.generate_description
generate_artifact_description_file_api = _quick_entry_handlers.generate_description_file
generate_artifact_description_stream_file_api = (
    _quick_entry_handlers.generate_description_stream_file
)
prepare_artifact_exif_file = _quick_entry_handlers.prepare_exif_file
extract_artifact_exif_file = _quick_entry_handlers.extract_exif_file
submit_artifact_with_exif = _quick_entry_handlers.submit_with_exif
submit_artifact_with_exif_file = _quick_entry_handlers.submit_with_exif_file


# Cloud ingest routes.
_cloud_ingest_dependencies = CloudIngestDependencies(
    reserve_ingest_slot=reserve_cloud_ingest_slot,
    require_ingest_token=lambda *args, **kwargs: require_ingest_token(*args, **kwargs),
    configuration_error=lambda: cloud_ingest_configuration_error(),
    normalize_source_hash=lambda *args, **kwargs: normalize_source_hash(
        *args, **kwargs
    ),
    read_bounded_upload=lambda *args, **kwargs: read_bounded_upload(*args, **kwargs),
    hash_bytes=lambda *args, **kwargs: hash_bytes(*args, **kwargs),
    find_image_by_source_hash=lambda *args, **kwargs: (
        find_artifact_image_by_source_hash_local(*args, **kwargs)
    ),
    find_image_by_hash=lambda *args, **kwargs: find_artifact_image_by_hash_local(
        *args, **kwargs
    ),
    image_content_fingerprint=lambda *args, **kwargs: image_content_fingerprint(
        *args, **kwargs
    ),
    find_images_by_content=lambda *args, **kwargs: find_artifact_images_by_content(
        *args, **kwargs
    ),
    build_image_metadata=lambda *args, **kwargs: build_image_metadata(*args, **kwargs),
    ensure_museum=lambda *args, **kwargs: ensure_museum(*args, **kwargs),
    resolve_capture_context=lambda *args, **kwargs: resolve_capture_context(
        *args, **kwargs
    ),
    merge_unique_tags=lambda *args, **kwargs: merge_unique_tags(*args, **kwargs),
    parse_tags=lambda *args, **kwargs: parse_tags(*args, **kwargs),
    build_capture_tags=lambda *args, **kwargs: build_capture_tags(*args, **kwargs),
    normalize_place_of_excavation=lambda value: normalize_place_of_excavation(value),
    artifact_detail_query=lambda: artifact_detail_query(),
    find_existing_artifact_match=lambda *args, **kwargs: find_existing_artifact_match(
        *args, **kwargs
    ),
    upload_image=lambda *args, **kwargs: upload_image(*args, **kwargs),
    optional_text=lambda value: optional_text(value),
    delete_image=lambda *args, **kwargs: delete_image(*args, **kwargs),
    resolve_uploaded_file_path=lambda value: resolve_uploaded_file_path(value),
    submit_artifact_to_cloud=lambda *args, **kwargs: submit_artifact_to_cloud(
        *args, **kwargs
    ),
)
cloud_ingest_router, _cloud_ingest_handlers = create_cloud_ingest_router(
    _cloud_ingest_dependencies
)
app.include_router(cloud_ingest_router, prefix=settings.api_prefix)
ingest_artifact = _cloud_ingest_handlers.ingest_artifact
delete_images_best_effort = _cloud_ingest_handlers.delete_images_best_effort
submit_single_artifact_to_cloud = _cloud_ingest_handlers.submit_single_artifact_to_cloud
submit_single_artifact_file_to_cloud = (
    _cloud_ingest_handlers.submit_single_artifact_file_to_cloud
)


# Batch identification routes.
_batch_dependencies = BatchRouteDependencies(
    image_extensions=IMAGE_EXTENSIONS,
    data_dir=DATA_DIR,
    legacy_batch_imports_dir=LEGACY_BATCH_IMPORTS_DIR,
    session_factory=lambda: SessionLocal(),
    hash_file=lambda *args, **kwargs: hash_file(*args, **kwargs),
    hash_bytes=lambda *args, **kwargs: hash_bytes(*args, **kwargs),
    build_image_metadata=lambda *args, **kwargs: build_image_metadata(*args, **kwargs),
    register_pending_artifact=lambda *args, **kwargs: register_pending_artifact(
        *args, **kwargs
    ),
    scan_pending_items=lambda *args, **kwargs: scan_pending_items(*args, **kwargs),
    pending_artifact_image_bytes=lambda *args, **kwargs: pending_artifact_image_bytes(
        *args, **kwargs
    ),
    materialize_pending_artifact_image=lambda *args, **kwargs: (
        materialize_pending_artifact_image(*args, **kwargs)
    ),
    sse=lambda *args, **kwargs: sse(*args, **kwargs),
    enabled_sites=lambda: enabled_sites(),
    request_web_candidate=lambda *args, **kwargs: request_web_candidate(
        *args, **kwargs
    ),
    fetch_cloud_artifact_match=lambda *args, **kwargs: fetch_cloud_artifact_match(
        *args, **kwargs
    ),
    normalize_exhibition_name=lambda value: normalize_exhibition_name(value),
    extract_http_error_detail=extract_http_error_detail,
)
batch_router, _batch_handlers = create_batch_router(_batch_dependencies)
app.include_router(batch_router, prefix=settings.api_prefix)
batch_scan = _batch_handlers.batch_scan
batch_scan_files = _batch_handlers.batch_scan_files
list_pending = _batch_handlers.list_pending
pending_image = _batch_handlers.pending_image
update_pending = _batch_handlers.update_pending
delete_pending = _batch_handlers.delete_pending
batch_identify_stream = _batch_handlers.batch_identify_stream
submit_pending = _batch_handlers.submit_pending


# Catalog and core artifact routes are included last so fixed quick-entry paths
# win over the dynamic /artifacts/{artifact_id} path.
_exhibition_catalog_dependencies = ExhibitionCatalogRouteDependencies(
    optional_text=lambda *args, **kwargs: optional_text(*args, **kwargs),
    should_proxy_artifact_queries_to_cloud=lambda: (
        should_proxy_artifact_queries_to_cloud()
    ),
    enrich_artifact_catalog_links=lambda *args, **kwargs: enrich_artifact_catalog_links(
        *args, **kwargs
    ),
    merge_duplicate_artifact_reads=lambda *args, **kwargs: (
        merge_duplicate_artifact_reads(*args, **kwargs)
    ),
    fetch_cloud_artifact_payload=lambda *args, **kwargs: fetch_cloud_artifact_payload(
        *args, **kwargs
    ),
    artifact_detail_query=lambda: artifact_detail_query(),
    get_cached_cloud_museum_directory_artifacts=lambda: (
        get_cached_cloud_museum_directory_artifacts()
    ),
    refresh_cloud_museum_directory_artifacts=lambda: (
        refresh_cloud_museum_directory_artifacts()
    ),
    build_uploaded_museum_directory=lambda *args, **kwargs: (
        build_uploaded_museum_directory(*args, **kwargs)
    ),
    attach_catalog_metadata_to_uploaded_museum_directory=lambda *args, **kwargs: (
        attach_catalog_metadata_to_uploaded_museum_directory(*args, **kwargs)
    ),
    normalize_museum_directory_key=lambda *args, **kwargs: (
        normalize_museum_directory_key(*args, **kwargs)
    ),
    museum_map_coordinates=lambda *args, **kwargs: museum_map_coordinates(
        *args, **kwargs
    ),
    require_ingest_token=lambda *args, **kwargs: require_ingest_token(*args, **kwargs),
)
configure_exhibition_catalog_routes(_exhibition_catalog_dependencies)
app.include_router(exhibition_catalog_router, prefix=settings.api_prefix)

_artifact_route_dependencies = ArtifactRouteDependencies(
    normalize_museum_name_for_write=lambda *args, **kwargs: (
        normalize_museum_name_for_write(*args, **kwargs)
    ),
    optional_text=lambda *args, **kwargs: optional_text(*args, **kwargs),
    ensure_exhibition=lambda *args, **kwargs: ensure_exhibition(*args, **kwargs),
    should_proxy_artifact_queries_to_cloud=lambda: (
        should_proxy_artifact_queries_to_cloud()
    ),
    enrich_artifact_catalog_links=lambda *args, **kwargs: enrich_artifact_catalog_links(
        *args, **kwargs
    ),
    merge_duplicate_artifact_reads=lambda *args, **kwargs: (
        merge_duplicate_artifact_reads(*args, **kwargs)
    ),
    fetch_cloud_artifact_payload=lambda *args, **kwargs: fetch_cloud_artifact_payload(
        *args, **kwargs
    ),
    artifact_detail_query=lambda: artifact_detail_query(),
    normalize_place_of_excavation=lambda *args, **kwargs: normalize_place_of_excavation(
        *args, **kwargs
    ),
    ensure_museum=lambda *args, **kwargs: ensure_museum(*args, **kwargs),
    resolve_capture_context=lambda *args, **kwargs: resolve_capture_context(
        *args, **kwargs
    ),
    sync_artifact_links_and_tags=lambda *args, **kwargs: sync_artifact_links_and_tags(
        *args, **kwargs
    ),
    find_existing_artifact_match=lambda *args, **kwargs: find_existing_artifact_match(
        *args, **kwargs
    ),
    build_artifact_match_read=lambda *args, **kwargs: build_artifact_match_read(
        *args, **kwargs
    ),
    merge_unique_tags=lambda *args, **kwargs: merge_unique_tags(*args, **kwargs),
    build_capture_tags=lambda *args, **kwargs: build_capture_tags(*args, **kwargs),
    normalize_edit_method=lambda *args, **kwargs: normalize_edit_method(
        *args, **kwargs
    ),
    artifact_image_query=lambda: artifact_image_query(),
    load_image_source_bytes=lambda *args, **kwargs: load_image_source_bytes(
        *args, **kwargs
    ),
    render_image_variant=lambda *args, **kwargs: render_image_variant(*args, **kwargs),
    find_artifact_image_by_hash_local=lambda *args, **kwargs: (
        find_artifact_image_by_hash_local(*args, **kwargs)
    ),
    find_artifact_image_by_source_hash_local=lambda *args, **kwargs: (
        find_artifact_image_by_source_hash_local(*args, **kwargs)
    ),
    image_variant_cache_dir=IMAGE_VARIANT_CACHE_DIR,
    image_variant_locks=IMAGE_VARIANT_LOCKS,
    image_variant_work_semaphore=IMAGE_VARIANT_WORK_SEMAPHORE,
    image_variant_master_size=IMAGE_VARIANT_MASTER_SIZE,
    sha256_pattern=SHA256_PATTERN,
)
configure_artifact_routes(_artifact_route_dependencies)
app.include_router(artifact_router, prefix=settings.api_prefix)
