import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.db import get_db
from app.exhibition_db import get_exhibition_db
from app.exhibition_models import (
    CatalogExhibition,
    ExhibitionSyncRun,
    ExhibitionSyncWorkerState,
)
from app.exhibition_schemas import (
    ExhibitionArtifactSummaryRead,
    ExhibitionCatalogDetailRead,
    ExhibitionCatalogItemRead,
    ExhibitionCatalogListRead,
    ExhibitionFacetRead,
    ExhibitionRecommendationRead,
    ExhibitionSyncAcceptedRead,
    ExhibitionSyncRunRead,
    ExhibitionSyncStatusRead,
    ExhibitionSyncWorkerRead,
    ExhibitionYearFacetRead,
    HistoricalExhibitionDetailRead,
)
from app.exhibition_service import (
    exhibition_backfill_remaining,
    exhibition_catalog_count,
    exhibition_sync_coordinator,
    latest_sync_run,
)
from app.exhibition_source import is_probable_room_label
from app.models import Artifact, ArtifactExhibition, Exhibition, Museum
from app.schemas import ArtifactRead, ExhibitionRead, MuseumDirectoryRead

router = APIRouter()


@dataclass(slots=True)
class ExhibitionCatalogRouteDependencies:
    optional_text: Callable[..., Any]
    should_proxy_artifact_queries_to_cloud: Callable[..., Any]
    enrich_artifact_catalog_links: Callable[..., Any]
    merge_duplicate_artifact_reads: Callable[..., Any]
    fetch_cloud_artifact_payload: Callable[..., Any]
    artifact_detail_query: Callable[..., Any]
    get_cached_cloud_museum_directory_artifacts: Callable[..., Any]
    refresh_cloud_museum_directory_artifacts: Callable[..., Any]
    build_uploaded_museum_directory: Callable[..., Any]
    attach_catalog_metadata_to_uploaded_museum_directory: Callable[..., Any]
    normalize_museum_directory_key: Callable[..., Any]
    museum_map_coordinates: Callable[..., Any]
    require_ingest_token: Callable[..., Any]


def configure_exhibition_catalog_routes(
    dependencies: ExhibitionCatalogRouteDependencies,
) -> None:
    """Bind application services without importing the main assembly module."""
    global optional_text
    global should_proxy_artifact_queries_to_cloud
    global enrich_artifact_catalog_links
    global merge_duplicate_artifact_reads
    global fetch_cloud_artifact_payload
    global artifact_detail_query
    global get_cached_cloud_museum_directory_artifacts
    global refresh_cloud_museum_directory_artifacts
    global build_uploaded_museum_directory
    global attach_catalog_metadata_to_uploaded_museum_directory
    global normalize_museum_directory_key
    global museum_map_coordinates
    global require_ingest_token

    optional_text = dependencies.optional_text
    should_proxy_artifact_queries_to_cloud = (
        dependencies.should_proxy_artifact_queries_to_cloud
    )
    enrich_artifact_catalog_links = dependencies.enrich_artifact_catalog_links
    merge_duplicate_artifact_reads = dependencies.merge_duplicate_artifact_reads
    fetch_cloud_artifact_payload = dependencies.fetch_cloud_artifact_payload
    artifact_detail_query = dependencies.artifact_detail_query
    get_cached_cloud_museum_directory_artifacts = (
        dependencies.get_cached_cloud_museum_directory_artifacts
    )
    refresh_cloud_museum_directory_artifacts = (
        dependencies.refresh_cloud_museum_directory_artifacts
    )
    build_uploaded_museum_directory = dependencies.build_uploaded_museum_directory
    attach_catalog_metadata_to_uploaded_museum_directory = (
        dependencies.attach_catalog_metadata_to_uploaded_museum_directory
    )
    normalize_museum_directory_key = dependencies.normalize_museum_directory_key
    museum_map_coordinates = dependencies.museum_map_coordinates
    require_ingest_token = dependencies.require_ingest_token


def normalize_catalog_match_text(value: str | None) -> str:
    return re.sub(r"[\W_]+", "", (value or "").casefold(), flags=re.UNICODE)


def looks_like_catalog_institution(value: str) -> bool:
    return bool(
        re.search(
            r"(博物馆|博物院|美术馆|艺术馆|纪念馆|科技馆|展览馆|陈列馆|文化馆|图书馆)$",
            value,
        )
    )


def is_long_running_catalog_exhibition(
    item: CatalogExhibition | ExhibitionRecommendationRead,
) -> bool:
    if item.is_permanent:
        return True
    if item.start_date is None and item.end_date is None:
        return False
    if item.start_date is None or item.end_date is None:
        return True
    return (item.end_date - item.start_date).days >= 365


def haversine_distance_km(
    latitude_a: float,
    longitude_a: float,
    latitude_b: float,
    longitude_b: float,
) -> float:
    radius_km = 6371.0088
    lat_a = math.radians(latitude_a)
    lat_b = math.radians(latitude_b)
    lat_delta = math.radians(latitude_b - latitude_a)
    lon_delta = math.radians(longitude_b - longitude_a)
    value = (
        math.sin(lat_delta / 2) ** 2
        + math.cos(lat_a) * math.cos(lat_b) * math.sin(lon_delta / 2) ** 2
    )
    return radius_km * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def artifact_summary(item: ArtifactRead) -> ExhibitionArtifactSummaryRead:
    images = sorted(
        item.images,
        key=lambda image: (image.uploaded_at, image.id),
        reverse=True,
    )
    captured_at = next(
        (image.captured_at for image in images if image.captured_at is not None),
        None,
    )
    return ExhibitionArtifactSummaryRead(
        id=item.id,
        name=item.name,
        museum_name=item.museum_name,
        era=item.era,
        cover_url=images[0].url if images else None,
        captured_at=captured_at,
    )


@router.get(
    "/exhibition-history",
    response_model=HistoricalExhibitionDetailRead,
)
def get_historical_exhibition_detail(
    name: str = Query(..., min_length=1),
    museum_name: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> HistoricalExhibitionDetailRead:
    normalized_name = name.strip()
    normalized_museum = optional_text(museum_name)
    if should_proxy_artifact_queries_to_cloud():
        try:
            artifacts = enrich_artifact_catalog_links(
                merge_duplicate_artifact_reads(fetch_cloud_artifact_payload())
            )
        except Exception as exc:  # noqa: BLE001 - surface cloud query failure
            raise HTTPException(
                status_code=502, detail=f"查询云端历史展览失败：{exc}"
            ) from exc
    else:
        query = artifact_detail_query().order_by(Artifact.created_at.desc())
        artifacts = enrich_artifact_catalog_links(
            merge_duplicate_artifact_reads(list(db.scalars(query)))
        )

    matched_artifacts: list[ArtifactRead] = []
    matched_exhibitions: list[ExhibitionRead] = []
    for artifact in artifacts:
        exhibitions = [
            exhibition
            for exhibition in artifact.exhibitions
            if exhibition.name.strip() == normalized_name
            and (
                normalized_museum is None
                or exhibition.museum_name.strip() == normalized_museum
            )
        ]
        if exhibitions:
            matched_artifacts.append(artifact)
            matched_exhibitions.extend(exhibitions)
    if not matched_exhibitions:
        raise HTTPException(status_code=404, detail="Historical exhibition not found")

    start_at = min(
        (
            exhibition.start_at
            for exhibition in matched_exhibitions
            if exhibition.start_at is not None
        ),
        default=None,
    )
    end_at = max(
        (
            exhibition.end_at
            for exhibition in matched_exhibitions
            if exhibition.end_at is not None
        ),
        default=None,
    )
    return HistoricalExhibitionDetailRead(
        name=normalized_name,
        museum_name=normalized_museum or matched_exhibitions[0].museum_name,
        start_at=start_at,
        end_at=end_at,
        artifacts=[artifact_summary(item) for item in matched_artifacts],
    )


@router.get(
    "/exhibition-catalog/recommendations",
    response_model=list[ExhibitionRecommendationRead],
)
def recommend_exhibition_catalog(
    captured_at: datetime | None = Query(default=None),
    latitude: float | None = Query(default=None, ge=-90, le=90),
    longitude: float | None = Query(default=None, ge=-180, le=180),
    location: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=8, ge=1, le=30),
    catalog_db: Session = Depends(get_exhibition_db),
    artifact_db: Session = Depends(get_db),
) -> list[ExhibitionRecommendationRead]:
    normalized_location = optional_text(location)
    normalized_query = optional_text(q)
    if (
        captured_at is None
        and latitude is None
        and longitude is None
        and normalized_location is None
        and normalized_query is None
    ):
        return []

    capture_date = captured_at.date() if captured_at is not None else None
    base_query = select(CatalogExhibition)
    if normalized_query:
        like = f"%{normalized_query}%"
        base_query = base_query.where(
            or_(
                CatalogExhibition.title.ilike(like),
                CatalogExhibition.museum_name.ilike(like),
                CatalogExhibition.venue.ilike(like),
                CatalogExhibition.address.ilike(like),
                CatalogExhibition.city.ilike(like),
            )
        )

    dated_query = base_query.where(CatalogExhibition.is_permanent.is_(False))
    if capture_date is not None:
        dated_query = dated_query.where(
            and_(
                or_(
                    CatalogExhibition.start_date.is_(None),
                    CatalogExhibition.start_date <= capture_date,
                ),
                or_(
                    CatalogExhibition.end_date.is_(None),
                    CatalogExhibition.end_date >= capture_date,
                ),
            )
        )
    dated_candidates = list(
        catalog_db.scalars(
            dated_query.order_by(
                CatalogExhibition.start_date.desc().nulls_last(),
                CatalogExhibition.synced_at.desc(),
            ).limit(2000)
        )
    )
    permanent_candidates = list(
        catalog_db.scalars(
            base_query.where(CatalogExhibition.is_permanent.is_(True))
            .order_by(CatalogExhibition.synced_at.desc())
            .limit(1000)
        )
    )
    candidates = [*dated_candidates, *permanent_candidates]

    location_hints: list[tuple[str, str, float | None]] = []
    if normalized_location:
        location_hints.append((normalized_location, "EXIF 地点一致", None))
    nearest_museum: Museum | None = None
    nearest_distance: float | None = None
    if latitude is not None and longitude is not None:
        museums = list(
            artifact_db.scalars(
                select(Museum).where(
                    Museum.latitude.is_not(None),
                    Museum.longitude.is_not(None),
                )
            )
        )
        for museum in museums:
            distance = haversine_distance_km(
                latitude,
                longitude,
                float(museum.latitude),
                float(museum.longitude),
            )
            if nearest_distance is None or distance < nearest_distance:
                nearest_museum = museum
                nearest_distance = distance
        if (
            nearest_museum is not None
            and nearest_distance is not None
            and nearest_distance <= 80
        ):
            location_hints.append(
                (
                    nearest_museum.name,
                    f"距拍摄地点约 {nearest_distance:.1f} km",
                    nearest_distance,
                )
            )
            if nearest_museum.location:
                location_hints.append(
                    (nearest_museum.location, "邻近已收录场馆", nearest_distance)
                )

    scored: list[tuple[int, ExhibitionRecommendationRead]] = []
    for candidate in candidates:
        score = 0
        reasons: list[str] = []
        matched_distance: float | None = None
        matched_location = False
        if capture_date is not None:
            score += 70
            if candidate.is_permanent:
                reasons.append("常设展，长期有效")
            elif is_long_running_catalog_exhibition(candidate):
                reasons.append("拍摄日期在长期展期内")
            else:
                reasons.append("拍摄日期在展期内")
        if normalized_query:
            score += 50
            reasons.append("名称或地点符合搜索")

        field_values = {
            "展馆": normalize_catalog_match_text(candidate.museum_name),
            "展厅": normalize_catalog_match_text(candidate.venue),
            "地址": normalize_catalog_match_text(candidate.address),
            "城市": normalize_catalog_match_text(candidate.city),
            "地区": normalize_catalog_match_text(candidate.region),
        }
        for hint, hint_reason, distance in location_hints:
            normalized_hint = normalize_catalog_match_text(hint)
            if len(normalized_hint) < 2:
                continue
            institution_hint = looks_like_catalog_institution(normalized_hint)
            matched_label = next(
                (
                    label
                    for label, field_value in field_values.items()
                    if field_value
                    and (not institution_hint or label not in {"城市", "地区"})
                    and (
                        normalized_hint in field_value or field_value in normalized_hint
                    )
                ),
                None,
            )
            if matched_label is None:
                continue
            matched_location = True
            score += {
                "展馆": 140,
                "展厅": 110,
                "地址": 90,
                "城市": 70,
                "地区": 50,
            }[matched_label]
            reason = f"{matched_label}与{hint_reason}"
            if reason not in reasons:
                reasons.append(reason)
            if distance is not None:
                matched_distance = distance

        if location_hints and not matched_location:
            continue
        scored.append(
            (
                score,
                ExhibitionRecommendationRead(
                    **ExhibitionCatalogItemRead.model_validate(candidate).model_dump(),
                    match_score=score,
                    match_reasons=reasons,
                    distance_km=matched_distance,
                ),
            )
        )

    scored.sort(
        key=lambda entry: (
            entry[0],
            (
                entry[1].start_date
                if not entry[1].is_permanent and entry[1].start_date
                else date.min
            ),
            entry[1].id,
        ),
        reverse=True,
    )
    selected = scored[:limit]
    if capture_date is not None and limit >= 2:
        permanent = [entry for entry in scored if entry[1].is_permanent]
        if permanent and not any(entry[1].is_permanent for entry in selected):
            selected[-1] = permanent[0]
            selected.sort(key=scored.index)
    return [entry[1] for entry in selected]


@router.get(
    "/exhibition-catalog",
    response_model=ExhibitionCatalogListRead,
)
def list_exhibition_catalog(
    q: str | None = Query(default=None),
    year: int | None = Query(default=None, ge=1800, le=2200),
    region: str | None = Query(default=None),
    city: str | None = Query(default=None),
    museum_name: str | None = Query(default=None),
    address: str | None = Query(default=None),
    venue: str | None = Query(default=None),
    status: str | None = Query(
        default=None, pattern="^(ongoing|upcoming|ended|permanent)$"
    ),
    include_facets: bool = Query(default=True),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=36, ge=1, le=200),
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionCatalogListRead:
    today = datetime.now().date()
    # Hide legacy malformed dates as well as rejecting them during source
    # parsing. Undated and permanent exhibitions remain visible.
    displayable_year = or_(
        CatalogExhibition.start_year.is_(None),
        CatalogExhibition.is_permanent.is_(True),
        (
            (CatalogExhibition.start_year >= 1900)
            & (CatalogExhibition.start_year <= today.year + 1)
        ),
    )
    filters = [displayable_year]
    if q and q.strip():
        like = f"%{q.strip()}%"
        filters.append(
            or_(
                CatalogExhibition.title.ilike(like),
                CatalogExhibition.museum_name.ilike(like),
                CatalogExhibition.venue.ilike(like),
                CatalogExhibition.address.ilike(like),
                CatalogExhibition.city.ilike(like),
            )
        )
    if year is not None:
        filters.append(
            CatalogExhibition.start_year.is_not(None)
            & (CatalogExhibition.start_year <= year)
            & (
                (CatalogExhibition.end_year >= year)
                | CatalogExhibition.end_year.is_(None)
            )
        )
    if region and region.strip():
        filters.append(CatalogExhibition.region == region.strip())
    if city and city.strip():
        filters.append(CatalogExhibition.city == city.strip())
    if museum_name and museum_name.strip():
        filters.append(CatalogExhibition.museum_name == museum_name.strip())
    if address and address.strip():
        filters.append(CatalogExhibition.address == address.strip())
    if venue and venue.strip():
        filters.append(CatalogExhibition.venue == venue.strip())
    if status == "permanent":
        filters.append(CatalogExhibition.is_permanent.is_(True))
    elif status == "upcoming":
        filters.extend(
            [
                CatalogExhibition.is_permanent.is_(False),
                CatalogExhibition.start_date > today,
            ]
        )
    elif status == "ended":
        filters.extend(
            [
                CatalogExhibition.is_permanent.is_(False),
                CatalogExhibition.end_date < today,
            ]
        )
    elif status == "ongoing":
        filters.extend(
            [
                CatalogExhibition.is_permanent.is_(False),
                or_(
                    CatalogExhibition.start_date.is_(None),
                    CatalogExhibition.start_date <= today,
                ),
                or_(
                    CatalogExhibition.end_date.is_(None),
                    CatalogExhibition.end_date >= today,
                ),
            ]
        )

    filtered = select(CatalogExhibition)
    count_query = select(func.count()).select_from(CatalogExhibition)
    for condition in filters:
        filtered = filtered.where(condition)
        count_query = count_query.where(condition)
    filtered = filtered.order_by(
        CatalogExhibition.start_date.desc().nulls_last(),
        CatalogExhibition.synced_at.desc(),
        CatalogExhibition.id.desc(),
    )
    items = list(db.scalars(filtered.offset((page - 1) * page_size).limit(page_size)))
    total = int(db.scalar(count_query) or 0)

    years: list[ExhibitionYearFacetRead] = []
    regions: list[ExhibitionFacetRead] = []
    cities: list[ExhibitionFacetRead] = []
    if include_facets:
        year_rows = db.execute(
            select(CatalogExhibition.start_year, func.count())
            .where(
                CatalogExhibition.start_year.is_not(None),
                CatalogExhibition.start_year >= 1900,
                CatalogExhibition.start_year <= today.year + 1,
            )
            .group_by(CatalogExhibition.start_year)
            .order_by(CatalogExhibition.start_year.desc())
        )
        region_rows = db.execute(
            select(CatalogExhibition.region, func.count())
            .group_by(CatalogExhibition.region)
            .order_by(func.count().desc(), CatalogExhibition.region.asc())
        )
        city_query = select(CatalogExhibition.city, func.count()).group_by(
            CatalogExhibition.city
        )
        if region and region.strip():
            city_query = city_query.where(CatalogExhibition.region == region.strip())
        city_rows = db.execute(
            city_query.order_by(func.count().desc(), CatalogExhibition.city.asc())
        )
        years = [
            ExhibitionYearFacetRead(year=int(row[0]), count=int(row[1]))
            for row in year_rows
            if row[0] is not None
        ]
        regions = [
            ExhibitionFacetRead(value=str(row[0]), count=int(row[1]))
            for row in region_rows
        ]
        cities = [
            ExhibitionFacetRead(value=str(row[0]), count=int(row[1]))
            for row in city_rows
        ]
    last_synced_at = db.scalar(select(func.max(CatalogExhibition.synced_at)))
    latest_run = latest_sync_run(db)
    remaining = None
    if latest_run and latest_run.discovered:
        remaining = exhibition_backfill_remaining(db, latest_run.discovered)

    return ExhibitionCatalogListRead(
        items=[ExhibitionCatalogItemRead.model_validate(item) for item in items],
        total=total,
        page=page,
        page_size=page_size,
        years=years,
        regions=regions,
        cities=cities,
        last_synced_at=last_synced_at,
        backfill_remaining=remaining,
    )


@router.get(
    "/exhibition-catalog/sync",
    response_model=ExhibitionSyncRunRead | None,
)
def get_exhibition_sync_status(
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionSyncRun | None:
    return latest_sync_run(db)


@router.get(
    "/exhibition-catalog/sync/status",
    response_model=ExhibitionSyncStatusRead,
)
def get_exhibition_sync_live_status(
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionSyncStatusRead:
    catalog_total = exhibition_catalog_count(db)
    recent_runs = list(
        db.scalars(
            select(ExhibitionSyncRun)
            .order_by(ExhibitionSyncRun.started_at.desc())
            .limit(8)
        )
    )
    run = recent_runs[0] if recent_runs else None
    processed = 0
    backfill_remaining = None
    discovered_total = 0
    rate_per_minute = None
    eta_seconds = None
    if run is not None:
        discovered_total = max(
            catalog_total,
            *(recent_run.discovered for recent_run in recent_runs),
        )
        processed = min(
            run.attempted,
            run.created + run.updated + run.failed,
        )
        if discovered_total:
            backfill_remaining = exhibition_backfill_remaining(db, discovered_total)

        now = datetime.now(timezone.utc)
        created_total = 0
        duration_seconds = 0.0
        for recent_run in recent_runs:
            if recent_run.created <= 0:
                continue
            started_at = recent_run.started_at
            completed_at = recent_run.completed_at or now
            if started_at.tzinfo is None:
                started_at = started_at.replace(tzinfo=timezone.utc)
            if completed_at.tzinfo is None:
                completed_at = completed_at.replace(tzinfo=timezone.utc)
            created_total += recent_run.created
            duration_seconds += max(
                1,
                (completed_at - started_at).total_seconds(),
            )
        if created_total > 0 and duration_seconds > 0:
            rate_per_minute = created_total / (duration_seconds / 60)
            if backfill_remaining:
                eta_seconds = int(math.ceil(backfill_remaining / rate_per_minute * 60))

    completed_total = max(
        0,
        discovered_total - (backfill_remaining or 0),
    )
    overall_progress = (
        min(100.0, completed_total / discovered_total * 100) if discovered_total else 0
    )
    worker_state = db.get(ExhibitionSyncWorkerState, 1)
    worker_read = None
    if worker_state is not None:
        now = datetime.now(timezone.utc)
        heartbeat_at = worker_state.heartbeat_at
        normalized_heartbeat = (
            heartbeat_at
            if heartbeat_at.tzinfo is not None
            else heartbeat_at.replace(tzinfo=timezone.utc)
        )
        next_run_at = worker_state.next_run_at
        normalized_next_run = (
            next_run_at
            if next_run_at is None or next_run_at.tzinfo is not None
            else next_run_at.replace(tzinfo=timezone.utc)
        )
        scheduled_workflow_healthy = bool(
            worker_state.status == "waiting_schedule"
            and normalized_next_run is not None
            and now <= normalized_next_run + timedelta(hours=2)
        )
        worker_read = ExhibitionSyncWorkerRead(
            status=worker_state.status,
            message=worker_state.message,
            heartbeat_at=heartbeat_at,
            next_run_at=next_run_at,
            online=(now - normalized_heartbeat).total_seconds() <= 45,
            scheduled=scheduled_workflow_healthy,
        )
    return ExhibitionSyncStatusRead(
        catalog_total=catalog_total,
        discovered_total=discovered_total,
        backfill_remaining=backfill_remaining,
        processed=processed,
        overall_progress=round(overall_progress, 2),
        rate_per_minute=(
            round(rate_per_minute, 1) if rate_per_minute is not None else None
        ),
        eta_seconds=eta_seconds,
        run=(ExhibitionSyncRunRead.model_validate(run) if run is not None else None),
        recent_runs=[
            ExhibitionSyncRunRead.model_validate(item) for item in recent_runs
        ],
        worker=worker_read,
    )


@router.post(
    "/exhibition-catalog/sync",
    response_model=ExhibitionSyncAcceptedRead,
    status_code=202,
)
def start_exhibition_sync(
    mode: str = Query(default="incremental", pattern="^(incremental|full)$"),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionSyncAcceptedRead:
    require_ingest_token(authorization)
    if not settings.exhibition_sync_enabled:
        raise HTTPException(
            status_code=409,
            detail="展览同步由独立 Worker 管理，API 进程未启用同步任务。",
        )
    accepted = exhibition_sync_coordinator.start(
        mode=mode,  # type: ignore[arg-type]
        trigger="manual",
    )
    current_run = latest_sync_run(db)
    return ExhibitionSyncAcceptedRead(
        accepted=accepted,
        detail="同步任务已启动。" if accepted else "已有同步任务正在运行。",
        run=(
            ExhibitionSyncRunRead.model_validate(current_run)
            if current_run is not None
            else None
        ),
    )


@router.get(
    "/exhibition-catalog/source/{source_id}/artifacts",
    response_model=list[ExhibitionArtifactSummaryRead],
)
def list_exhibition_catalog_artifacts(
    source_id: str,
    catalog_db: Session = Depends(get_exhibition_db),
    artifact_db: Session = Depends(get_db),
) -> list[ExhibitionArtifactSummaryRead]:
    catalog_item = catalog_db.scalar(
        select(CatalogExhibition).where(CatalogExhibition.source_id == source_id)
    )
    if catalog_item is None:
        raise HTTPException(status_code=404, detail="Exhibition not found")

    if should_proxy_artifact_queries_to_cloud():
        try:
            artifacts = enrich_artifact_catalog_links(
                merge_duplicate_artifact_reads(fetch_cloud_artifact_payload())
            )
        except Exception as exc:  # noqa: BLE001 - surface cloud query failure
            raise HTTPException(
                status_code=502, detail=f"查询云端展览文物失败：{exc}"
            ) from exc
    else:
        query = (
            artifact_detail_query()
            .join(Artifact.exhibition_links)
            .join(ArtifactExhibition.exhibition)
            .where(
                or_(
                    Exhibition.catalog_source_id == source_id,
                    Exhibition.name == catalog_item.title,
                )
            )
            .distinct()
            .order_by(Artifact.created_at.desc())
        )
        artifacts = enrich_artifact_catalog_links(
            merge_duplicate_artifact_reads(list(artifact_db.scalars(query)))
        )

    matched = [
        item
        for item in artifacts
        if any(
            exhibition.catalog_source_id == source_id
            or exhibition.name == catalog_item.title
            for exhibition in item.exhibitions
        )
    ]
    return [artifact_summary(item) for item in matched]


@router.get(
    "/exhibition-catalog/source/{source_id}",
    response_model=ExhibitionCatalogDetailRead,
)
def get_exhibition_catalog_detail_by_source(
    source_id: str,
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionCatalogDetailRead:
    item = db.scalar(
        select(CatalogExhibition).where(CatalogExhibition.source_id == source_id)
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Exhibition not found")
    return ExhibitionCatalogDetailRead.model_validate(item)


@router.get(
    "/exhibition-catalog/{exhibition_id}",
    response_model=ExhibitionCatalogDetailRead,
)
def get_exhibition_catalog_detail(
    exhibition_id: int,
    db: Session = Depends(get_exhibition_db),
) -> ExhibitionCatalogDetailRead:
    item = db.get(CatalogExhibition, exhibition_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Exhibition not found")
    return ExhibitionCatalogDetailRead.model_validate(item)


@router.get(
    "/museum-directory",
    response_model=list[MuseumDirectoryRead],
)
def list_museum_directory(
    background_tasks: BackgroundTasks,
    q: str | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=5000),
    db: Session = Depends(get_db),
    catalog_db: Session = Depends(get_exhibition_db),
) -> list[MuseumDirectoryRead]:
    if should_proxy_artifact_queries_to_cloud():
        # Autocomplete and the full browser both render from the most recent
        # successful Gallery snapshot. Refreshing the cloud Gallery happens
        # after the response, so a slow or unavailable deployment cannot add
        # 10+ seconds to museum search. The refresh lock collapses concurrent
        # keystrokes into one upstream request.
        cloud_artifacts = get_cached_cloud_museum_directory_artifacts()
        background_tasks.add_task(refresh_cloud_museum_directory_artifacts)
        directory = build_uploaded_museum_directory(
            cloud_artifacts,
            q=None,
            limit=5000,
        )
        return attach_catalog_metadata_to_uploaded_museum_directory(
            directory,
            catalog_db,
            q=q,
            limit=limit,
        )

    museums = list(
        db.scalars(
            select(Museum)
            .join(Museum.artifacts)
            .join(Artifact.images)
            .options(
                selectinload(Museum.exhibitions),
                selectinload(Museum.artifacts),
            )
            .distinct()
            .order_by(Museum.name.asc())
        )
    )
    museums = [museum for museum in museums if not is_probable_room_label(museum.name)]
    catalog_rows = list(
        catalog_db.execute(
            select(
                CatalogExhibition.museum_name,
                CatalogExhibition.region,
                CatalogExhibition.city,
                func.max(CatalogExhibition.address),
                func.count(),
                func.min(CatalogExhibition.start_year),
                func.max(
                    func.coalesce(
                        CatalogExhibition.end_year,
                        CatalogExhibition.start_year,
                    )
                ),
                func.max(CatalogExhibition.cover_url),
            )
            .where(
                CatalogExhibition.museum_name.is_not(None),
                func.trim(CatalogExhibition.museum_name) != "",
            )
            .group_by(
                CatalogExhibition.museum_name,
                CatalogExhibition.region,
                CatalogExhibition.city,
            )
        )
    )
    address_rows = list(
        catalog_db.execute(
            select(
                CatalogExhibition.address,
                CatalogExhibition.region,
                CatalogExhibition.city,
                func.count(),
                func.min(CatalogExhibition.start_year),
                func.max(
                    func.coalesce(
                        CatalogExhibition.end_year,
                        CatalogExhibition.start_year,
                    )
                ),
                func.max(CatalogExhibition.cover_url),
            )
            .where(
                CatalogExhibition.address.is_not(None),
                func.trim(CatalogExhibition.address) != "",
            )
            .group_by(
                CatalogExhibition.address,
                CatalogExhibition.region,
                CatalogExhibition.city,
            )
        )
    )
    address_groups = {
        (
            str(row[0]).strip(),
            str(row[1] or "").strip(),
            str(row[2] or "").strip(),
        ): {
            "museum_name": None,
            "region": str(row[1] or "").strip(),
            "city": str(row[2] or "").strip(),
            "address": str(row[0]).strip(),
            "count": int(row[3] or 0),
            "first_year": int(row[4]) if row[4] is not None else None,
            "last_year": int(row[5]) if row[5] is not None else None,
            "cover_url": str(row[6]) if row[6] else None,
            "match_by_address": True,
        }
        for row in address_rows
    }

    groups_by_name: dict[str, list[dict[str, object]]] = {}
    for row in catalog_rows:
        museum_name = str(row[0]).strip()
        region = str(row[1] or "").strip()
        city = str(row[2] or "").strip()
        address = str(row[3] or "").strip() or None
        group: dict[str, object] = {
            "museum_name": museum_name,
            "region": region,
            "city": city,
            "address": address,
            "count": int(row[4] or 0),
            "first_year": int(row[5]) if row[5] is not None else None,
            "last_year": int(row[6]) if row[6] is not None else None,
            "cover_url": str(row[7]) if row[7] else None,
            "match_by_address": False,
        }
        groups_by_name.setdefault(
            normalize_museum_directory_key(museum_name),
            [],
        ).append(group)

    directory: list[MuseumDirectoryRead] = []
    for museum in museums:
        candidates = groups_by_name.get(
            normalize_museum_directory_key(museum.name),
            [],
        )
        matched_group = None
        if len(candidates) == 1:
            matched_group = candidates[0]
        elif candidates and museum.location:
            normalized_location = normalize_museum_directory_key(museum.location)
            city_matches = [
                candidate
                for candidate in candidates
                if normalize_museum_directory_key(str(candidate["city"]))
                in normalized_location
            ]
            if len(city_matches) == 1:
                matched_group = city_matches[0]

        # Rows deployed before the parent venue field existed only contain the
        # room name. Until the throttled worker revisits all historical pages,
        # use the dominant address among titles mentioning this museum. The
        # exact-address query then also finds exhibitions whose title omits it.
        address_candidate = catalog_db.execute(
            select(
                CatalogExhibition.address,
                CatalogExhibition.region,
                CatalogExhibition.city,
                func.count(),
            )
            .where(
                CatalogExhibition.title.ilike(f"%{museum.name.strip()}%"),
                CatalogExhibition.address.is_not(None),
                func.trim(CatalogExhibition.address) != "",
            )
            .group_by(
                CatalogExhibition.address,
                CatalogExhibition.region,
                CatalogExhibition.city,
            )
            .order_by(func.count().desc())
            .limit(1)
        ).first()
        if address_candidate is not None:
            fallback_group = address_groups.get(
                (
                    str(address_candidate[0]).strip(),
                    str(address_candidate[1] or "").strip(),
                    str(address_candidate[2] or "").strip(),
                )
            )
            if fallback_group is not None and (
                matched_group is None
                or int(fallback_group["count"]) > int(matched_group["count"])
            ):
                matched_group = fallback_group

        catalog_count = int(matched_group["count"]) if matched_group else 0
        latitude, longitude = museum_map_coordinates(
            museum.name,
            museum.latitude,
            museum.longitude,
        )
        directory.append(
            MuseumDirectoryRead(
                id=museum.id,
                museum_id=museum.id,
                name=museum.name,
                location=museum.location
                or (
                    str(matched_group["address"])
                    if matched_group and matched_group["address"]
                    else None
                )
                or (
                    " · ".join(
                        part
                        for part in (
                            str(matched_group["city"]),
                            str(matched_group["region"]),
                        )
                        if part
                    )
                    if matched_group
                    else None
                ),
                latitude=latitude,
                longitude=longitude,
                description=museum.description,
                artifact_count=museum.artifact_count,
                exhibition_count=max(museum.exhibition_count, catalog_count),
                catalog_exhibition_count=catalog_count,
                first_year=(matched_group["first_year"] if matched_group else None),
                last_year=(matched_group["last_year"] if matched_group else None),
                cover_url=(
                    str(matched_group["cover_url"])
                    if matched_group and matched_group["cover_url"]
                    else None
                ),
                catalog_museum_name=(
                    str(matched_group["museum_name"])
                    if matched_group
                    and not matched_group["match_by_address"]
                    and matched_group["museum_name"]
                    else None
                ),
                catalog_address=(
                    str(matched_group["address"])
                    if matched_group
                    and matched_group["match_by_address"]
                    and matched_group["address"]
                    else None
                ),
                catalog_venue=(
                    str(matched_group["museum_name"])
                    if matched_group and matched_group["museum_name"]
                    else None
                ),
                catalog_city=(str(matched_group["city"]) if matched_group else None),
                catalog_region=(
                    str(matched_group["region"]) if matched_group else None
                ),
                derived_from_catalog=False,
                exhibitions=[
                    ExhibitionRead.model_validate(item) for item in museum.exhibitions
                ],
            )
        )

    search_text = normalize_museum_directory_key(q)
    if search_text:
        directory = [
            item
            for item in directory
            if search_text
            in normalize_museum_directory_key(
                " ".join(
                    value
                    for value in (
                        item.name,
                        item.location,
                        item.description,
                    )
                    if value
                )
            )
        ]
    return attach_catalog_metadata_to_uploaded_museum_directory(
        directory,
        catalog_db,
        q=q,
        limit=limit,
        attach_existing=False,
    )
