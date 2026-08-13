from __future__ import annotations

import json
import logging
import threading
import time as time_module
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.exhibition_models import CatalogExhibition
from app.exhibition_source import (
    institution_name_from_permanent_title,
    museum_name_from_source_fields,
)
from app.models import Artifact, Museum
from app.schemas import (
    ArtifactMatchRead,
    ArtifactRead,
    ExhibitionRead,
    MuseumDirectoryRead,
)
from app.services.artifact_metadata import (
    canonical_catalog_museum_name,
    catalog_museum_directory_id,
    catalog_museum_names_for_directory_name,
    catalog_museum_query_name,
    compact_artifact_name_for_match,
    is_catalog_room_label,
    merge_unique_tags,
    museum_map_coordinates,
    normalize_identity_text,
    normalize_museum_directory_key,
    optional_text,
    resolve_museum_branch_from_image_gps,
)

logger = logging.getLogger("app.vision")
DATA_DIR = Path(".")


@dataclass(slots=True)
class ArtifactMatchCandidate:
    artifact: Artifact
    score: float
    reason: str


@dataclass(slots=True)
class CatalogServiceDependencies:
    data_dir: Path
    artifact_detail_query: Callable[..., Any]
    get_exhibition_session_factory: Callable[..., Any]


def configure_catalog_service(dependencies: CatalogServiceDependencies) -> None:
    global DATA_DIR
    global CLOUD_MUSEUM_DIRECTORY_CACHE_PATH
    global artifact_detail_query
    global ExhibitionSessionLocal

    DATA_DIR = dependencies.data_dir
    CLOUD_MUSEUM_DIRECTORY_CACHE_PATH = DATA_DIR / "museum-directory-cloud-cache.json"
    artifact_detail_query = dependencies.artifact_detail_query
    ExhibitionSessionLocal = lambda: dependencies.get_exhibition_session_factory()()


def should_proxy_artifact_queries_to_cloud() -> bool:
    return settings.app_role == "local" and bool(settings.cloud_api_base_url)


def fetch_cloud_artifact_payload(
    params: dict[str, object] | None = None,
) -> list[dict]:
    base = settings.cloud_api_base_url.rstrip("/")
    last_error: Exception | None = None
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        for attempt in range(2):
            try:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifacts",
                    params=params,
                )
                if response.status_code in {502, 503, 504} and attempt == 0:
                    continue
                response.raise_for_status()
                payload = response.json()
                return payload if isinstance(payload, list) else []
            except (httpx.RequestError, httpx.HTTPStatusError) as exc:
                last_error = exc
                if attempt == 0:
                    continue
                raise
    if last_error is not None:
        raise last_error
    return []


CLOUD_MUSEUM_DIRECTORY_CACHE_TTL_SECONDS = 45
CLOUD_MUSEUM_DIRECTORY_CACHE_STALE_SECONDS = 10 * 60
CLOUD_MUSEUM_DIRECTORY_CACHE_LOCK = threading.Lock()
CLOUD_MUSEUM_DIRECTORY_REFRESH_LOCK = threading.Lock()
CLOUD_MUSEUM_DIRECTORY_CACHE: tuple[float, list[ArtifactRead]] | None = None
CLOUD_MUSEUM_DIRECTORY_CACHE_PATH = DATA_DIR / "museum-directory-cloud-cache.json"


def load_persisted_cloud_museum_directory_artifacts() -> list[ArtifactRead] | None:
    """Load the last successful Gallery response after a local restart.

    The Museum browser is a read-only view of Gallery uploads.  An upstream
    outage must not turn that view into a 502 simply because this local
    container was restarted and its in-memory cache was cleared.
    """
    try:
        payload = json.loads(
            CLOUD_MUSEUM_DIRECTORY_CACHE_PATH.read_text(encoding="utf-8")
        )
        if not isinstance(payload, list):
            raise ValueError("场馆目录缓存不是列表")
        return [ArtifactRead.model_validate(item) for item in payload]
    except FileNotFoundError:
        return None
    except Exception as exc:  # noqa: BLE001 - a bad cache must not break the directory
        logger.warning("忽略无法读取的场馆目录磁盘缓存：%s", exc)
        return None


def persist_cloud_museum_directory_artifacts(artifacts: list[ArtifactRead]) -> None:
    try:
        CLOUD_MUSEUM_DIRECTORY_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = CLOUD_MUSEUM_DIRECTORY_CACHE_PATH.with_suffix(
            f".{uuid4().hex}.tmp"
        )
        temporary_path.write_text(
            json.dumps(
                [item.model_dump(mode="json") for item in artifacts], ensure_ascii=False
            ),
            encoding="utf-8",
        )
        temporary_path.replace(CLOUD_MUSEUM_DIRECTORY_CACHE_PATH)
    except Exception as exc:  # noqa: BLE001 - a memory cache is still usable
        logger.warning("无法写入场馆目录磁盘缓存：%s", exc)


def get_cloud_museum_directory_artifacts() -> list[ArtifactRead]:
    """Read Gallery once for the directory, with a stale-success fallback.

    The local frontend can request the directory concurrently while it mounts
    or follows a detail route.  Re-fetching the entire cloud Gallery for each
    request both overloads the cloud API and turns a transient failure into a
    blank local museum page.
    """
    global CLOUD_MUSEUM_DIRECTORY_CACHE
    now = time_module.monotonic()
    with CLOUD_MUSEUM_DIRECTORY_CACHE_LOCK:
        cached = CLOUD_MUSEUM_DIRECTORY_CACHE
        if (
            cached is not None
            and now - cached[0] < CLOUD_MUSEUM_DIRECTORY_CACHE_TTL_SECONDS
        ):
            return cached[1]

    if not CLOUD_MUSEUM_DIRECTORY_REFRESH_LOCK.acquire(blocking=False):
        return (
            cached[1]
            if cached is not None
            else (load_persisted_cloud_museum_directory_artifacts() or [])
        )
    try:
        try:
            artifacts = enrich_artifact_catalog_links(
                merge_duplicate_artifact_reads(fetch_cloud_artifact_payload())
            )
        except Exception:
            if (
                cached is not None
                and now - cached[0] < CLOUD_MUSEUM_DIRECTORY_CACHE_STALE_SECONDS
            ):
                logger.warning("云端图库刷新失败，继续使用最近一次成功的场馆目录缓存")
                return cached[1]
            persisted = load_persisted_cloud_museum_directory_artifacts()
            if persisted is not None:
                logger.warning("云端图库刷新失败，继续使用磁盘中的场馆目录缓存")
                with CLOUD_MUSEUM_DIRECTORY_CACHE_LOCK:
                    CLOUD_MUSEUM_DIRECTORY_CACHE = (now, persisted)
                return persisted
            raise
        with CLOUD_MUSEUM_DIRECTORY_CACHE_LOCK:
            CLOUD_MUSEUM_DIRECTORY_CACHE = (now, artifacts)
        persist_cloud_museum_directory_artifacts(artifacts)
        return artifacts
    finally:
        CLOUD_MUSEUM_DIRECTORY_REFRESH_LOCK.release()


def get_cached_cloud_museum_directory_artifacts() -> list[ArtifactRead]:
    """Return the last known Gallery snapshot without blocking autocomplete."""
    global CLOUD_MUSEUM_DIRECTORY_CACHE
    with CLOUD_MUSEUM_DIRECTORY_CACHE_LOCK:
        cached = CLOUD_MUSEUM_DIRECTORY_CACHE
        if cached is not None:
            return cached[1]
        persisted = load_persisted_cloud_museum_directory_artifacts()
        if persisted is None:
            return []
        # Keep the disk snapshot available to keyword searches, but mark it as
        # stale so the next full directory request still refreshes from cloud.
        CLOUD_MUSEUM_DIRECTORY_CACHE = (
            time_module.monotonic() - CLOUD_MUSEUM_DIRECTORY_CACHE_TTL_SECONDS,
            persisted,
        )
        return persisted


def refresh_cloud_museum_directory_artifacts() -> None:
    """Refresh Gallery cache without surfacing post-response failures."""
    try:
        get_cloud_museum_directory_artifacts()
    except Exception:  # noqa: BLE001 - the catalog-only response already succeeded
        logger.warning("云端图库后台刷新失败，继续使用本地场馆目录", exc_info=True)


def build_uploaded_museum_directory(
    artifacts: list[ArtifactRead | dict],
    q: str | None,
    limit: int,
) -> list[MuseumDirectoryRead]:
    """Build the museum browser from the same uploaded images as Gallery.

    A local desktop instance reads Gallery from the cloud API.  Its own
    database may only hold a staging record, so deriving the directory from
    local ``Museum`` rows makes nearly every uploaded photo disappear.
    """
    groups: dict[str, dict[str, object]] = {}
    for raw_artifact in artifacts:
        artifact = ArtifactRead.model_validate(raw_artifact)
        if not artifact.images:
            continue
        # ``馆藏`` / ``藏`` describes the artifact provenance, not another
        # museum. Cloud imports may have created a separate Museum row before
        # filename parsing was fixed, so group by the canonical display name
        # instead of the database row id.
        source_museum_name = museum_name_from_source_fields(
            artifact.museum_name,
            None,
        )
        if source_museum_name is None:
            continue
        museum_name = resolve_museum_branch_from_image_gps(
            source_museum_name,
            artifact.images,
        )
        if not museum_name:
            continue
        key = normalize_museum_directory_key(museum_name)
        group = groups.setdefault(
            key,
            {
                "id": artifact.museum_id,
                "museum_ids": set(),
                "name": museum_name,
                "artifact_ids": set(),
                "image_count": 0,
                "location": None,
                "coordinate_clusters": {},
                "cover_url": None,
                "exhibitions": {},
            },
        )
        # The card needs one stable route id, while the grouped artifacts can
        # originate from duplicate historical Museum records.
        group["id"] = min(int(group["id"]), artifact.museum_id)
        cast_museum_ids = group["museum_ids"]
        assert isinstance(cast_museum_ids, set)
        cast_museum_ids.add(artifact.museum_id)
        cast_artifact_ids = group["artifact_ids"]
        assert isinstance(cast_artifact_ids, set)
        cast_artifact_ids.add(artifact.id)
        cast_exhibitions = group["exhibitions"]
        assert isinstance(cast_exhibitions, dict)
        for exhibition in artifact.exhibitions:
            cast_exhibitions.setdefault(exhibition.id, exhibition)
        for image in artifact.images:
            group["image_count"] = int(group["image_count"]) + 1
            if not group["cover_url"]:
                group["cover_url"] = image.url
            if not group["location"] and image.capture_location:
                group["location"] = image.capture_location
            if (
                image.latitude is not None
                and image.longitude is not None
                and -90 <= image.latitude <= 90
                and -180 <= image.longitude <= 180
            ):
                # One artifact can be photographed at several exhibitions.  A
                # top-level museum pin must follow the most consistently
                # recorded coordinate cluster, not whichever image happens to
                # be returned first.
                coordinate_key = (round(image.latitude, 4), round(image.longitude, 4))
                coordinate_clusters = group["coordinate_clusters"]
                assert isinstance(coordinate_clusters, dict)
                count, latitude_total, longitude_total = coordinate_clusters.get(
                    coordinate_key, (0, 0.0, 0.0)
                )
                coordinate_clusters[coordinate_key] = (
                    count + 1,
                    latitude_total + image.latitude,
                    longitude_total + image.longitude,
                )

    directory: list[MuseumDirectoryRead] = []
    for group in groups.values():
        artifact_ids = group["artifact_ids"]
        museum_ids = group["museum_ids"]
        exhibitions = group["exhibitions"]
        assert isinstance(artifact_ids, set)
        assert isinstance(museum_ids, set)
        assert isinstance(exhibitions, dict)
        image_count = int(group["image_count"])
        coordinate_clusters = group["coordinate_clusters"]
        assert isinstance(coordinate_clusters, dict)
        dominant_coordinate = max(
            coordinate_clusters.values(),
            key=lambda cluster: cluster[0],
            default=None,
        )
        latitude = (
            dominant_coordinate[1] / dominant_coordinate[0]
            if dominant_coordinate
            else None
        )
        longitude = (
            dominant_coordinate[2] / dominant_coordinate[0]
            if dominant_coordinate
            else None
        )
        latitude, longitude = museum_map_coordinates(
            str(group["name"]),
            latitude,
            longitude,
        )
        directory.append(
            MuseumDirectoryRead(
                id=int(group["id"]),
                museum_id=int(group["id"]),
                museum_ids=sorted(int(museum_id) for museum_id in museum_ids),
                name=str(group["name"]),
                location=str(group["location"]) if group["location"] else None,
                latitude=latitude,
                longitude=longitude,
                description=f"图库已上传 {image_count} 张图片，覆盖 {len(artifact_ids)} 件文物。",
                artifact_count=len(artifact_ids),
                exhibition_count=len(exhibitions),
                cover_url=str(group["cover_url"]) if group["cover_url"] else None,
                exhibitions=list(exhibitions.values()),
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
                    for value in (item.name, item.location, item.description)
                    if value
                )
            )
        ]
    directory.sort(
        key=lambda item: (normalize_museum_directory_key(item.name), item.id)
    )
    return directory[:limit]


@dataclass(frozen=True)
class CatalogMuseumDirectorySummary:
    name: str
    raw_names: frozenset[str]
    region: str | None
    city: str | None
    address: str | None
    exhibition_count: int
    first_year: int | None
    last_year: int | None
    cover_url: str | None
    uses_address_fallback: bool


def catalog_museum_directory_summaries(
    catalog_db: Session,
    q: str | None = None,
) -> list[CatalogMuseumDirectorySummary]:
    """Aggregate exhibition rows into real institutions, excluding rooms."""
    query = select(
        CatalogExhibition.museum_name,
        CatalogExhibition.title,
        CatalogExhibition.region,
        CatalogExhibition.city,
        CatalogExhibition.address,
        CatalogExhibition.start_year,
        CatalogExhibition.end_year,
        CatalogExhibition.cover_url,
    )
    keyword = optional_text(q)
    if keyword:
        like = f"%{keyword}%"
        keyword_match = or_(
            CatalogExhibition.title.ilike(like),
            CatalogExhibition.museum_name.ilike(like),
            CatalogExhibition.address.ilike(like),
            CatalogExhibition.city.ilike(like),
            CatalogExhibition.region.ilike(like),
        )
        matching_addresses = select(CatalogExhibition.address).where(
            CatalogExhibition.address.is_not(None),
            func.trim(CatalogExhibition.address) != "",
            keyword_match,
        )
        query = query.where(
            or_(keyword_match, CatalogExhibition.address.in_(matching_addresses))
        )

    rows = list(catalog_db.execute(query))
    address_candidates: dict[tuple[str, str, str], set[str]] = {}
    for row in rows:
        raw_name = optional_text(row[0])
        title = optional_text(row[1])
        address = optional_text(row[4])
        if not address:
            continue
        candidates: list[str] = []
        explicit_name = canonical_catalog_museum_name(raw_name, address)
        if explicit_name is not None and not is_catalog_room_label(explicit_name):
            candidates.append(explicit_name)
        title_name = institution_name_from_permanent_title(title)
        title_name = canonical_catalog_museum_name(title_name, address)
        if title_name is not None and not is_catalog_room_label(title_name):
            candidates.append(title_name)
        if candidates:
            address_candidates.setdefault(
                (
                    normalize_museum_directory_key(address),
                    normalize_museum_directory_key(row[3]),
                    normalize_museum_directory_key(row[2]),
                ),
                set(),
            ).update(candidates)
    address_institutions = {
        address_key: next(iter(candidates))
        for address_key, candidates in address_candidates.items()
        if len(candidates) == 1
    }

    groups: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        raw_name = optional_text(row[0])
        title = optional_text(row[1])
        address = optional_text(row[4])
        museum_name = canonical_catalog_museum_name(raw_name, address)
        uses_address_fallback = False
        if museum_name is None or is_catalog_room_label(museum_name):
            museum_name = address_institutions.get(
                (
                    normalize_museum_directory_key(address),
                    normalize_museum_directory_key(row[3]),
                    normalize_museum_directory_key(row[2]),
                )
            )
            uses_address_fallback = museum_name is not None
            if museum_name is None:
                museum_name = institution_name_from_permanent_title(title)
        if museum_name is None or is_catalog_room_label(museum_name):
            continue
        region = optional_text(row[2])
        city = optional_text(row[3])
        key = (
            normalize_museum_directory_key(museum_name),
            normalize_museum_directory_key(city),
        )
        group = groups.setdefault(
            key,
            {
                "name": museum_name,
                "raw_names": set(),
                "region": region,
                "city": city,
                "address_counts": {},
                "exhibition_count": 0,
                "first_year": None,
                "last_year": None,
                "cover_url": None,
                "uses_address_fallback": False,
            },
        )
        raw_names = group["raw_names"]
        address_counts = group["address_counts"]
        assert isinstance(raw_names, set)
        assert isinstance(address_counts, dict)
        if raw_name:
            raw_names.add(raw_name)
        if address:
            address_counts[address] = int(address_counts.get(address, 0)) + 1
        group["uses_address_fallback"] = bool(
            group["uses_address_fallback"] or uses_address_fallback
        )
        group["exhibition_count"] = int(group["exhibition_count"]) + 1
        for year in (row[5], row[6] or row[5]):
            if year is None:
                continue
            group["first_year"] = (
                year
                if group["first_year"] is None
                else min(int(group["first_year"]), year)
            )
            group["last_year"] = (
                year
                if group["last_year"] is None
                else max(int(group["last_year"]), year)
            )
        if group["cover_url"] is None and row[7]:
            group["cover_url"] = str(row[7])

    summaries: list[CatalogMuseumDirectorySummary] = []
    for group in groups.values():
        raw_names = group["raw_names"]
        address_counts = group["address_counts"]
        assert isinstance(raw_names, set)
        assert isinstance(address_counts, dict)
        dominant_address = (
            min(
                address_counts,
                key=lambda address: (-int(address_counts[address]), address),
            )
            if address_counts
            else None
        )
        summaries.append(
            CatalogMuseumDirectorySummary(
                name=str(group["name"]),
                raw_names=frozenset(str(name) for name in raw_names),
                region=optional_text(str(group["region"])) if group["region"] else None,
                city=optional_text(str(group["city"])) if group["city"] else None,
                address=dominant_address,
                exhibition_count=int(group["exhibition_count"]),
                first_year=(
                    int(group["first_year"])
                    if group["first_year"] is not None
                    else None
                ),
                last_year=(
                    int(group["last_year"]) if group["last_year"] is not None else None
                ),
                cover_url=(str(group["cover_url"]) if group["cover_url"] else None),
                uses_address_fallback=bool(group["uses_address_fallback"]),
            )
        )
    return summaries


def attach_catalog_metadata_to_uploaded_museum_directory(
    directory: list[MuseumDirectoryRead],
    catalog_db: Session,
    *,
    q: str | None = None,
    limit: int = 5000,
    attach_existing: bool = True,
) -> list[MuseumDirectoryRead]:
    """Merge iMuseum institutions into Gallery-derived museum cards."""
    summaries = catalog_museum_directory_summaries(catalog_db, q)
    summary_name_counts: dict[str, int] = {}
    for summary in summaries:
        key = normalize_museum_directory_key(summary.name)
        summary_name_counts[key] = summary_name_counts.get(key, 0) + 1

    directory_by_name: dict[str, list[MuseumDirectoryRead]] = {}
    directory_by_catalog_label: dict[str, list[MuseumDirectoryRead]] = {}

    def register_directory_item(item: MuseumDirectoryRead) -> None:
        name_key = normalize_museum_directory_key(item.name)
        directory_by_name.setdefault(name_key, []).append(item)
        for label in catalog_museum_names_for_directory_name(item.name):
            directory_by_catalog_label.setdefault(label.strip(), []).append(item)

    def matches_summary_city(
        item: MuseumDirectoryRead,
        summary: CatalogMuseumDirectorySummary,
    ) -> bool:
        name_key = normalize_museum_directory_key(summary.name)
        city_key = normalize_museum_directory_key(summary.city)
        item_city_key = normalize_museum_directory_key(item.catalog_city)
        if item_city_key:
            return item_city_key == city_key
        location_key = normalize_museum_directory_key(item.location)
        if city_key and location_key:
            if city_key in location_key:
                return True
            generic_locations = {
                normalize_museum_directory_key(item.name),
                normalize_museum_directory_key("上海博物馆"),
            }
            if location_key not in generic_locations:
                return False
        return summary_name_counts.get(name_key, 0) <= 1

    def first_matching_candidate(
        candidates: list[MuseumDirectoryRead],
        summary: CatalogMuseumDirectorySummary,
    ) -> MuseumDirectoryRead | None:
        return next(
            (item for item in candidates if matches_summary_city(item, summary)),
            None,
        )

    for item in directory:
        register_directory_item(item)

    for summary in summaries:
        matched_item = first_matching_candidate(
            directory_by_name.get(
                normalize_museum_directory_key(summary.name),
                [],
            ),
            summary,
        )
        if matched_item is None:
            matched_item = next(
                (
                    candidate
                    for raw_name in summary.raw_names
                    for candidate in directory_by_catalog_label.get(
                        raw_name.strip(),
                        [],
                    )
                    if matches_summary_city(candidate, summary)
                ),
                None,
            )

        if matched_item is None:
            latitude, longitude = museum_map_coordinates(
                summary.name,
                None,
                None,
            )
            matched_item = MuseumDirectoryRead(
                id=catalog_museum_directory_id(summary.name, summary.city),
                museum_id=None,
                museum_ids=[],
                name=summary.name,
                location=summary.address
                or " · ".join(
                    value for value in (summary.city, summary.region) if value
                )
                or None,
                latitude=latitude,
                longitude=longitude,
                description=None,
                artifact_count=0,
                exhibition_count=summary.exhibition_count,
                catalog_exhibition_count=summary.exhibition_count,
                first_year=summary.first_year,
                last_year=summary.last_year,
                cover_url=summary.cover_url,
                catalog_museum_name=catalog_museum_query_name(summary.name),
                catalog_address=(
                    summary.address if summary.uses_address_fallback else None
                ),
                catalog_venue=summary.name,
                catalog_city=summary.city,
                catalog_region=summary.region,
                derived_from_catalog=True,
                exhibitions=[],
            )
            directory.append(matched_item)
            register_directory_item(matched_item)
            continue

        if not attach_existing:
            continue
        matched_item.catalog_exhibition_count = summary.exhibition_count
        matched_item.exhibition_count = max(
            matched_item.exhibition_count,
            summary.exhibition_count,
        )
        matched_item.first_year = summary.first_year
        matched_item.last_year = summary.last_year
        matched_item.cover_url = matched_item.cover_url or summary.cover_url
        matched_item.catalog_museum_name = catalog_museum_query_name(summary.name)
        matched_item.catalog_address = (
            summary.address if summary.uses_address_fallback else None
        )
        matched_item.catalog_venue = summary.name
        matched_item.catalog_city = summary.city
        matched_item.catalog_region = summary.region
        matched_item.latitude, matched_item.longitude = museum_map_coordinates(
            summary.name,
            matched_item.latitude,
            matched_item.longitude,
        )
        has_only_parent_location = (
            matched_item.name != "上海博物馆"
            and normalize_museum_directory_key(matched_item.location)
            == normalize_museum_directory_key("上海博物馆")
        )
        if not matched_item.location or has_only_parent_location:
            matched_item.location = summary.address

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
                        item.catalog_city,
                        item.catalog_region,
                    )
                    if value
                )
            )
        ]
    directory.sort(
        key=lambda item: (
            normalize_museum_directory_key(item.name),
            normalize_museum_directory_key(item.catalog_city),
            item.id,
        )
    )
    return directory[:limit]


def build_artifact_match_read(match: ArtifactMatchCandidate) -> ArtifactMatchRead:
    return ArtifactMatchRead(
        artifact=ArtifactRead.model_validate(match.artifact),
        match_score=match.score,
        match_reason=match.reason,
    )


def artifact_read_merge_key(artifact: ArtifactRead) -> tuple[str, str, str] | None:
    museum_key = normalize_identity_text(artifact.museum_name)
    era_key = normalize_identity_text(artifact.era)
    name_key = compact_artifact_name_for_match(artifact.name)
    if museum_key is None or era_key is None or name_key is None:
        return None
    return museum_key, era_key, name_key


def datetime_sort_value(value: datetime | None) -> float:
    if value is None:
        return 0
    try:
        return value.timestamp()
    except (OSError, ValueError):
        return 0


def merge_duplicate_artifact_reads(
    items: list[Artifact | ArtifactRead | dict],
) -> list[ArtifactRead]:
    merged: list[ArtifactRead] = []
    keyed_indexes: dict[tuple[str, str, str], int] = {}

    for raw_item in items:
        item = ArtifactRead.model_validate(raw_item)
        key = artifact_read_merge_key(item)
        if key is None:
            merged.append(item)
            continue

        existing_index = keyed_indexes.get(key)
        if existing_index is None:
            keyed_indexes[key] = len(merged)
            merged.append(item)
            continue

        existing = merged[existing_index]
        images_by_id = {image.id: image for image in existing.images}
        for image in item.images:
            images_by_id.setdefault(image.id, image)
        images = sorted(
            images_by_id.values(),
            key=lambda image: (image.uploaded_at, image.id),
            reverse=True,
        )

        exhibitions_by_id = {
            exhibition.id: exhibition for exhibition in existing.exhibitions
        }
        for exhibition in item.exhibitions:
            exhibitions_by_id.setdefault(exhibition.id, exhibition)

        merged[existing_index] = existing.model_copy(
            update={
                "tags": merge_unique_tags(existing.tags, item.tags),
                "images": images,
                "exhibitions": sorted(
                    exhibitions_by_id.values(),
                    key=lambda exhibition: (
                        datetime_sort_value(exhibition.start_at),
                        exhibition.id,
                    ),
                    reverse=True,
                ),
                "description": existing.description or item.description,
                "Place_of_Excavation": existing.Place_of_Excavation
                or item.Place_of_Excavation,
            }
        )

    return merged


def enrich_artifact_catalog_links(items: list[ArtifactRead]) -> list[ArtifactRead]:
    missing_names = {
        exhibition.name.strip()
        for item in items
        for exhibition in item.exhibitions
        if exhibition.name.strip() and not exhibition.catalog_source_id
    }
    catalog_source_ids = {
        exhibition.catalog_source_id
        for item in items
        for exhibition in item.exhibitions
        if exhibition.catalog_source_id
    }
    if not missing_names and not catalog_source_ids:
        return items

    try:
        catalog_filters = []
        if missing_names:
            catalog_filters.append(CatalogExhibition.title.in_(sorted(missing_names)))
        if catalog_source_ids:
            catalog_filters.append(
                CatalogExhibition.source_id.in_(sorted(catalog_source_ids))
            )
        with ExhibitionSessionLocal() as catalog_db:
            catalog_items = list(
                catalog_db.scalars(
                    select(CatalogExhibition).where(or_(*catalog_filters))
                )
            )
    except Exception:
        logger.warning("enrich artifact exhibition catalog links failed", exc_info=True)
        return items

    by_title: dict[str, list[CatalogExhibition]] = {}
    by_source_id: dict[str, CatalogExhibition] = {}
    for catalog_item in catalog_items:
        by_title.setdefault(catalog_item.title, []).append(catalog_item)
        by_source_id[catalog_item.source_id] = catalog_item

    enriched_items: list[ArtifactRead] = []
    for item in items:
        enriched_exhibitions: list[ExhibitionRead] = []
        for exhibition in item.exhibitions:
            matched = (
                by_source_id.get(exhibition.catalog_source_id)
                if exhibition.catalog_source_id
                else None
            )
            if matched is None:
                candidates = by_title.get(exhibition.name.strip(), [])
                if candidates:

                    def candidate_score(
                        candidate: CatalogExhibition,
                    ) -> tuple[int, int]:
                        score = 0
                        museum_name = exhibition.museum_name.casefold()
                        if candidate.museum_name and (
                            museum_name in candidate.museum_name.casefold()
                            or candidate.museum_name.casefold() in museum_name
                        ):
                            score += 40
                        if candidate.venue and (
                            museum_name in candidate.venue.casefold()
                            or candidate.venue.casefold() in museum_name
                        ):
                            score += 20
                        if exhibition.start_at and candidate.start_date:
                            score += max(
                                0,
                                10
                                - abs(
                                    (
                                        exhibition.start_at.date()
                                        - candidate.start_date
                                    ).days
                                ),
                            )
                        return score, -candidate.id

                    matched = max(candidates, key=candidate_score)

            if matched is None:
                enriched_exhibitions.append(exhibition)
                continue

            explicit_branch_names = {
                normalize_museum_directory_key("上海博物馆东馆"),
                normalize_museum_directory_key("上海博物馆人民广场馆"),
            }
            canonical_museum_name = canonical_catalog_museum_name(
                matched.museum_name,
                matched.address,
            )
            resolved_museum_name = (
                exhibition.museum_name
                if normalize_museum_directory_key(exhibition.museum_name)
                in explicit_branch_names
                else canonical_museum_name or exhibition.museum_name
            )
            enriched_exhibitions.append(
                exhibition.model_copy(
                    update={
                        "museum_name": resolved_museum_name,
                        "catalog_source_id": matched.source_id,
                        "catalog_exhibition_id": matched.id,
                        "start_at": exhibition.start_at
                        or (
                            datetime.combine(
                                matched.start_date, time.min, tzinfo=timezone.utc
                            )
                            if matched.start_date
                            else None
                        ),
                        "end_at": exhibition.end_at
                        or (
                            datetime.combine(
                                matched.end_date, time.max, tzinfo=timezone.utc
                            )
                            if matched.end_date
                            else None
                        ),
                    }
                )
            )

        deduped_exhibitions: dict[str, ExhibitionRead] = {}
        for exhibition in enriched_exhibitions:
            identity = (
                f"catalog:{exhibition.catalog_source_id}"
                if exhibition.catalog_source_id
                else "manual:"
                f"{normalize_museum_directory_key(exhibition.museum_name)}:"
                f"{normalize_museum_directory_key(exhibition.name)}"
            )
            existing = deduped_exhibitions.get(identity)
            if existing is None:
                deduped_exhibitions[identity] = exhibition
                continue
            catalog_item = (
                by_source_id.get(exhibition.catalog_source_id)
                if exhibition.catalog_source_id
                else None
            )
            if catalog_item and catalog_item.museum_name:
                canonical_museum = normalize_museum_directory_key(
                    catalog_item.museum_name
                )
                existing_matches = (
                    normalize_museum_directory_key(existing.museum_name)
                    == canonical_museum
                )
                current_matches = (
                    normalize_museum_directory_key(exhibition.museum_name)
                    == canonical_museum
                )
                if current_matches and not existing_matches:
                    deduped_exhibitions[identity] = exhibition

        enriched_items.append(
            item.model_copy(
                update={
                    "exhibitions": list(deduped_exhibitions.values()),
                }
            )
        )
    return enriched_items


def find_existing_artifact_match(
    db: Session,
    *,
    name: str | None,
    museum_name: str | None = None,
    era: str | None = None,
) -> ArtifactMatchCandidate | None:
    normalized_name = normalize_identity_text(name)
    compact_name = compact_artifact_name_for_match(name)
    normalized_museum_name = normalize_identity_text(museum_name)
    normalized_era = normalize_identity_text(era)
    if (
        normalized_name is None
        or compact_name is None
        or normalized_museum_name is None
        or normalized_era is None
    ):
        return None

    base_query = (
        artifact_detail_query()
        .join(Artifact.museum)
        .where(
            func.lower(Museum.name) == normalized_museum_name,
            Artifact.era.is_not(None),
            func.lower(Artifact.era) == normalized_era,
        )
    )

    exact_match = db.scalar(
        base_query.where(func.lower(Artifact.name) == normalized_name).order_by(
            Artifact.created_at.asc(),
            Artifact.id.asc(),
        )
    )
    if exact_match is not None:
        return ArtifactMatchCandidate(
            artifact=exact_match,
            score=1.0,
            reason="名称完全一致，且时代、馆藏一致。",
        )

    # Auto-reuse changes an existing collection record, so it requires an
    # exact normalized name in addition to the exact museum and era above.
    # Near-name candidates may still be surfaced for a human to inspect, but
    # must never be selected automatically for ingestion.
    return None


async def fetch_cloud_artifact_match(
    *,
    name: str | None,
    museum_name: str | None = None,
    era: str | None = None,
) -> ArtifactMatchRead | None:
    if not settings.cloud_api_base_url:
        return None

    normalized_name = optional_text(name)
    normalized_museum_name = optional_text(museum_name)
    normalized_era = optional_text(era)
    if (
        normalized_name is None
        or normalized_museum_name is None
        or normalized_era is None
    ):
        return None

    params = {
        "name": normalized_name,
        "museum_name": normalized_museum_name,
        "era": normalized_era,
    }

    base = settings.cloud_api_base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            response = await client.get(
                f"{base}{settings.api_prefix}/artifacts/match",
                params=params,
            )
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001 - do not fail the main workflow on preview lookup
        logger.warning("artifact match lookup failed: %s", exc, exc_info=exc)
        return None

    payload = response.json()
    if not payload:
        return None
    return ArtifactMatchRead.model_validate(payload)
