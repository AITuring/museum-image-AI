import asyncio
import hashlib
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.db import get_db
from app.exhibition_source import is_probable_room_label
from app.services.cloud_query import (
    CLOUD_QUERY_TIMEOUT_SECONDS,
    CLOUD_SOURCE_HASH_TIMEOUT_SECONDS,
    mark_cloud_query_failure,
    mark_cloud_query_success,
)
from app.models import (
    Artifact,
    ArtifactExhibition,
    ArtifactImage,
    ArtifactTag,
    EraOption,
    Exhibition,
    Museum,
)
from app.reference_data import WENWU_ERA_TIMELINE
from app.schemas import (
    ArtifactCreate,
    ArtifactImageAttach,
    ArtifactImageRead,
    ArtifactMatchRead,
    ArtifactRead,
    ArtifactUpdate,
    EraOptionRead,
    EraTimelineItemRead,
    EraTimelineRead,
    ExhibitionCreate,
    ExhibitionRead,
    MuseumCreate,
    MuseumRead,
    MuseumUpdate,
)

router = APIRouter()
IMAGE_VARIANT_MASTER_SIZE = 1280


@dataclass(slots=True)
class ArtifactRouteDependencies:
    normalize_museum_name_for_write: Callable[..., Any]
    optional_text: Callable[..., Any]
    ensure_exhibition: Callable[..., Any]
    should_proxy_artifact_queries_to_cloud: Callable[..., Any]
    enrich_artifact_catalog_links: Callable[..., Any]
    merge_duplicate_artifact_reads: Callable[..., Any]
    fetch_cloud_artifact_payload: Callable[..., Any]
    artifact_detail_query: Callable[..., Any]
    normalize_place_of_excavation: Callable[..., Any]
    ensure_museum: Callable[..., Any]
    resolve_capture_context: Callable[..., Any]
    sync_artifact_links_and_tags: Callable[..., Any]
    find_existing_artifact_match: Callable[..., Any]
    build_artifact_match_read: Callable[..., Any]
    merge_unique_tags: Callable[..., Any]
    build_capture_tags: Callable[..., Any]
    normalize_edit_method: Callable[..., Any]
    artifact_image_query: Callable[..., Any]
    load_image_source_bytes: Callable[..., Any]
    render_image_variant: Callable[..., Any]
    find_artifact_image_by_hash_local: Callable[..., Any]
    find_artifact_image_by_source_hash_local: Callable[..., Any]
    image_variant_cache_dir: Path
    image_variant_locks: dict[str, asyncio.Lock]
    image_variant_work_semaphore: asyncio.Semaphore
    image_variant_master_size: int
    sha256_pattern: re.Pattern[str]


def configure_artifact_routes(dependencies: ArtifactRouteDependencies) -> None:
    """Bind artifact services and caches without importing the app assembly module."""
    global normalize_museum_name_for_write
    global optional_text
    global ensure_exhibition
    global should_proxy_artifact_queries_to_cloud
    global enrich_artifact_catalog_links
    global merge_duplicate_artifact_reads
    global fetch_cloud_artifact_payload
    global artifact_detail_query
    global normalize_place_of_excavation
    global ensure_museum
    global resolve_capture_context
    global sync_artifact_links_and_tags
    global find_existing_artifact_match
    global build_artifact_match_read
    global merge_unique_tags
    global build_capture_tags
    global normalize_edit_method
    global artifact_image_query
    global load_image_source_bytes
    global render_image_variant
    global find_artifact_image_by_hash_local
    global find_artifact_image_by_source_hash_local
    global IMAGE_VARIANT_CACHE_DIR
    global IMAGE_VARIANT_LOCKS
    global IMAGE_VARIANT_WORK_SEMAPHORE
    global IMAGE_VARIANT_MASTER_SIZE
    global SHA256_PATTERN

    normalize_museum_name_for_write = dependencies.normalize_museum_name_for_write
    optional_text = dependencies.optional_text
    ensure_exhibition = dependencies.ensure_exhibition
    should_proxy_artifact_queries_to_cloud = (
        dependencies.should_proxy_artifact_queries_to_cloud
    )
    enrich_artifact_catalog_links = dependencies.enrich_artifact_catalog_links
    merge_duplicate_artifact_reads = dependencies.merge_duplicate_artifact_reads
    fetch_cloud_artifact_payload = dependencies.fetch_cloud_artifact_payload
    artifact_detail_query = dependencies.artifact_detail_query
    normalize_place_of_excavation = dependencies.normalize_place_of_excavation
    ensure_museum = dependencies.ensure_museum
    resolve_capture_context = dependencies.resolve_capture_context
    sync_artifact_links_and_tags = dependencies.sync_artifact_links_and_tags
    find_existing_artifact_match = dependencies.find_existing_artifact_match
    build_artifact_match_read = dependencies.build_artifact_match_read
    merge_unique_tags = dependencies.merge_unique_tags
    build_capture_tags = dependencies.build_capture_tags
    normalize_edit_method = dependencies.normalize_edit_method
    artifact_image_query = dependencies.artifact_image_query
    load_image_source_bytes = dependencies.load_image_source_bytes
    render_image_variant = dependencies.render_image_variant
    find_artifact_image_by_hash_local = dependencies.find_artifact_image_by_hash_local
    find_artifact_image_by_source_hash_local = (
        dependencies.find_artifact_image_by_source_hash_local
    )
    IMAGE_VARIANT_CACHE_DIR = dependencies.image_variant_cache_dir
    IMAGE_VARIANT_LOCKS = dependencies.image_variant_locks
    IMAGE_VARIANT_WORK_SEMAPHORE = dependencies.image_variant_work_semaphore
    IMAGE_VARIANT_MASTER_SIZE = dependencies.image_variant_master_size
    SHA256_PATTERN = dependencies.sha256_pattern


@router.get("/museums", response_model=list[MuseumRead])
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
    museums = list(db.scalars(query.limit(min(1000, limit * 2))))
    return [museum for museum in museums if not is_probable_room_label(museum.name)][
        :limit
    ]


@router.get("/era-options", response_model=list[EraOptionRead])
def list_era_options(db: Session = Depends(get_db)) -> list[EraOption]:
    query = select(EraOption).order_by(EraOption.sort_order.asc(), EraOption.name.asc())
    return list(db.scalars(query))


@router.get("/era-timeline", response_model=EraTimelineRead)
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
                list(
                    db.scalars(
                        artifact_detail_query().order_by(Artifact.created_at.desc())
                    )
                )
            )
        )

    def matches_era(value: str | None, aliases: tuple[str, ...]) -> bool:
        if not value:
            return False
        normalized = re.sub(r"[\s（()）]", "", value)
        return any(
            normalized == alias or normalized.startswith(alias) or alias in normalized
            for alias in aliases
        )

    facets = [
        EraTimelineItemRead(
            name=name,
            aliases=list(aliases),
            parent=parent,
            count=sum(
                1 for artifact in all_artifacts if matches_era(artifact.era, aliases)
            ),
        )
        for name, aliases, parent in timeline
    ]

    artifacts: list[ArtifactRead] = []
    if selected is not None:
        artifacts = [
            artifact
            for artifact in all_artifacts
            if matches_era(artifact.era, selected[1])
        ]
        if selected[0] == "五代十国":
            artifacts = [
                artifact.model_copy(update={"era": "五代十国"})
                if artifact.era == "五代"
                else artifact
                for artifact in artifacts
            ]
    return EraTimelineRead(
        eras=facets,
        selected_era=normalized_selected,
        total_artifacts=sum(
            1
            for artifact in all_artifacts
            if any(
                matches_era(artifact.era, aliases)
                for _, aliases, parent in timeline
                if parent is None
            )
        ),
        artifacts=artifacts,
    )


@router.post("/museums", response_model=MuseumRead, status_code=201)
def create_museum(payload: MuseumCreate, db: Session = Depends(get_db)) -> Museum:
    name = normalize_museum_name_for_write(payload.name)
    existing = db.scalar(select(Museum).where(Museum.name == name))
    if existing is not None:
        raise HTTPException(status_code=400, detail="Museum already exists")

    museum = Museum(
        **payload.model_dump(exclude={"name"}),
        name=name,
    )
    db.add(museum)
    db.commit()
    db.refresh(museum)
    return museum


@router.patch("/museums/{museum_id}", response_model=MuseumRead)
def update_museum(
    museum_id: int,
    payload: MuseumUpdate,
    db: Session = Depends(get_db),
) -> Museum:
    museum = db.get(Museum, museum_id)
    if museum is None:
        raise HTTPException(status_code=404, detail="Museum not found")

    name = normalize_museum_name_for_write(payload.name)

    existing = db.scalar(
        select(Museum).where(Museum.name == name, Museum.id != museum_id)
    )
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


@router.get("/exhibitions", response_model=list[ExhibitionRead])
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


@router.post("/exhibitions", response_model=ExhibitionRead, status_code=201)
def create_exhibition(
    payload: ExhibitionCreate, db: Session = Depends(get_db)
) -> Exhibition:
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


@router.get("/artifacts", response_model=list[ArtifactRead])
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
            key: value
            for key, value in params.items()
            if value is not None and value != ""
        }
        try:
            payload = fetch_cloud_artifact_payload(filtered_params)
        except Exception as exc:  # noqa: BLE001 - surface cloud query failure to the operator
            raise HTTPException(
                status_code=502, detail=f"查询云端图库失败：{exc}"
            ) from exc
        return enrich_artifact_catalog_links(merge_duplicate_artifact_reads(payload))

    query = artifact_detail_query().order_by(Artifact.created_at.desc())
    if museum_id is not None:
        query = query.where(Artifact.museum_id == museum_id)
    if era is not None:
        query = query.where(Artifact.era == era)
    if tag is not None:
        query = query.join(Artifact.tags).where(ArtifactTag.name == tag).distinct()
    if captured_after is not None:
        query = (
            query.join(Artifact.images)
            .where(ArtifactImage.captured_at >= captured_after)
            .distinct()
        )
    if captured_before is not None:
        query = (
            query.join(Artifact.images)
            .where(ArtifactImage.captured_at <= captured_before)
            .distinct()
        )
    if uploaded_after is not None:
        query = (
            query.join(Artifact.images)
            .where(ArtifactImage.created_at >= uploaded_after)
            .distinct()
        )
    if uploaded_before is not None:
        query = (
            query.join(Artifact.images)
            .where(ArtifactImage.created_at <= uploaded_before)
            .distinct()
        )
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


@router.get("/artifacts/match", response_model=ArtifactMatchRead | None)
def match_artifact_route(
    name: str = Query(..., min_length=1),
    museum_name: str | None = Query(default=None),
    era: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> ArtifactMatchRead | None:
    # Keep this static path ahead of /artifacts/{artifact_id}; FastAPI matches
    # routes in declaration order, and the detail route must not shadow it.
    return match_artifact(name=name, museum_name=museum_name, era=era, db=db)


@router.get("/artifacts/{artifact_id}", response_model=ArtifactRead)
def get_artifact(artifact_id: int, db: Session = Depends(get_db)) -> ArtifactRead:
    if should_proxy_artifact_queries_to_cloud():
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            with httpx.Client(timeout=30, follow_redirects=True) as client:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifacts/{artifact_id}"
                )
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in {404, 405}:
                try:
                    payload = fetch_cloud_artifact_payload()
                except Exception as fallback_exc:  # noqa: BLE001 - retain the upstream failure context
                    raise HTTPException(
                        status_code=502, detail=f"查询云端文物失败：{fallback_exc}"
                    ) from fallback_exc
                matched = next(
                    (item for item in payload if int(item.get("id", 0)) == artifact_id),
                    None,
                )
                if matched is None:
                    raise HTTPException(status_code=404, detail="文物不存在。") from exc
                return ArtifactRead.model_validate(matched)
            raise HTTPException(
                status_code=502, detail=f"查询云端文物失败：{exc}"
            ) from exc
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=502, detail=f"查询云端文物失败：{exc}"
            ) from exc
        return ArtifactRead.model_validate(response.json())

    artifact = db.scalar(artifact_detail_query().where(Artifact.id == artifact_id))
    if artifact is None:
        raise HTTPException(status_code=404, detail="文物不存在。")
    return ArtifactRead.model_validate(enrich_artifact_catalog_links([artifact])[0])


@router.patch("/artifacts/{artifact_id}", response_model=ArtifactRead)
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
            raise HTTPException(
                status_code=502, detail=f"更新云端文物失败：{exc}"
            ) from exc
        return ArtifactRead.model_validate(response.json())

    artifact = db.scalar(artifact_detail_query().where(Artifact.id == artifact_id))
    if artifact is None:
        raise HTTPException(status_code=404, detail="文物不存在。")

    museum = ensure_museum(db, payload.museum_name)
    artifact.museum_id = museum.id
    artifact.name = payload.name.strip()
    artifact.era = optional_text(payload.era)
    artifact.Place_of_Excavation = normalize_place_of_excavation(
        payload.Place_of_Excavation
    )
    artifact.description = optional_text(payload.description)

    target_image = None
    if payload.image_id is not None:
        target_image = next(
            (image for image in artifact.images if image.id == payload.image_id), None
        )
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
        target_image.capture_museum_id = (
            capture_museum.id if capture_museum is not None else None
        )
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


@router.get("/artifacts/match", response_model=ArtifactMatchRead | None)
def match_artifact(
    name: str = Query(..., min_length=1),
    museum_name: str | None = Query(default=None),
    era: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> ArtifactMatchRead | None:
    normalized_name = optional_text(name)
    normalized_museum_name = optional_text(museum_name)
    normalized_era = optional_text(era)
    if (
        normalized_name is None
        or normalized_museum_name is None
        or normalized_era is None
    ):
        return None

    if should_proxy_artifact_queries_to_cloud():
        params = {
            "name": normalized_name,
            "museum_name": normalized_museum_name,
            "era": normalized_era,
        }
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            with httpx.Client(
                timeout=CLOUD_QUERY_TIMEOUT_SECONDS,
                follow_redirects=True,
            ) as client:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifacts/match",
                    params=params,
                )
                response.raise_for_status()
        except Exception:  # noqa: BLE001 - matching is best-effort
            mark_cloud_query_failure("同名文物查询")
        else:
            mark_cloud_query_success()
            payload = response.json()
            return ArtifactMatchRead.model_validate(payload) if payload else None

    match = find_existing_artifact_match(
        db,
        name=normalized_name,
        museum_name=normalized_museum_name,
        era=normalized_era,
    )
    return build_artifact_match_read(match) if match is not None else None


@router.post("/artifacts", response_model=ArtifactRead, status_code=201)
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
            db.add(
                ArtifactExhibition(artifact_id=artifact.id, exhibition_id=exhibition.id)
            )
            linked_exhibition_ids.add(exhibition.id)
        prepared_images.append(
            ArtifactImage(
                url=image.url,
                camera_model=image.camera_model,
                lens_model=image.lens_model,
                capture_museum_id=capture_museum.id
                if capture_museum is not None
                else None,
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


@router.get("/artifact-images", response_model=list[ArtifactImageRead])
def list_artifact_images(
    artifact_id: int | None = Query(default=None),
    museum_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
) -> list[ArtifactImage]:
    query = artifact_image_query().order_by(ArtifactImage.created_at.desc())
    if artifact_id is not None:
        query = query.where(ArtifactImage.artifact_id == artifact_id)
    if museum_id is not None:
        query = query.join(ArtifactImage.artifact).where(
            Artifact.museum_id == museum_id
        )
    return list(db.scalars(query))


@router.get("/image-variant")
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


@router.get(
    "/artifact-images/by-hash",
    response_model=ArtifactImageRead | None,
)
def get_artifact_image_by_hash(
    image_hash: str = Query(..., min_length=64, max_length=64),
    db: Session = Depends(get_db),
) -> ArtifactImageRead | None:
    if should_proxy_artifact_queries_to_cloud():
        base = settings.cloud_api_base_url.rstrip("/")
        try:
            with httpx.Client(
                timeout=CLOUD_QUERY_TIMEOUT_SECONDS,
                follow_redirects=True,
            ) as client:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifact-images/by-hash",
                    params={"image_hash": image_hash},
                )
                response.raise_for_status()
        except Exception:  # noqa: BLE001 - duplicate lookup is best-effort
            mark_cloud_query_failure("重复图片查询")
        else:
            mark_cloud_query_success()
            payload = response.json()
            return ArtifactImageRead.model_validate(payload) if payload else None

    match = find_artifact_image_by_hash_local(db, image_hash)
    return ArtifactImageRead.model_validate(match) if match is not None else None


@router.get(
    "/artifact-images/by-source-hash",
    response_model=ArtifactImageRead | None,
)
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
            with httpx.Client(
                timeout=CLOUD_SOURCE_HASH_TIMEOUT_SECONDS,
                follow_redirects=True,
            ) as client:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifact-images/by-source-hash",
                    params={"source_hash": normalized_source_hash},
                )
                response.raise_for_status()
        except Exception:  # noqa: BLE001 - confirmation is best-effort
            mark_cloud_query_failure("原图哈希确认")
        else:
            mark_cloud_query_success()
            payload = response.json()
            return ArtifactImageRead.model_validate(payload) if payload else None

    match = find_artifact_image_by_source_hash_local(db, normalized_source_hash)
    return ArtifactImageRead.model_validate(match) if match is not None else None


@router.post(
    "/artifact-images",
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
        db.add(
            ArtifactExhibition(
                artifact_id=artifact.id, exhibition_id=image.exhibition_id
            )
        )
    for tag in build_capture_tags(payload.camera_model, payload.lens_model):
        if not any(existing.name == tag for existing in artifact.tags):
            artifact.tags.append(ArtifactTag(name=tag))
    db.add(image)
    db.commit()
    return db.scalar(artifact_image_query().where(ArtifactImage.id == image.id))
