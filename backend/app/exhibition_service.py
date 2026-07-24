import asyncio
import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.exhibition_db import ExhibitionSessionLocal
from app.exhibition_models import CatalogExhibition, ExhibitionSyncRun
from app.exhibition_source import (
    SOURCE_BASE_URL,
    SOURCE_SITEMAP_URL,
    ParsedExhibition,
    parse_city_regions,
    parse_exhibition_detail,
    parse_sitemap_event_urls,
)


logger = logging.getLogger("app.exhibition_sync")
SyncMode = Literal["incremental", "full"]
SYNC_ADVISORY_LOCK_ID = 684_209_731


def exhibition_status(item: CatalogExhibition, today: date | None = None) -> str:
    today = today or date.today()
    if item.is_permanent:
        return "permanent"
    if item.start_date and item.start_date > today:
        return "upcoming"
    if item.end_date and item.end_date < today:
        return "ended"
    return "ongoing"


def _lock_sync(db: Session) -> bool:
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return True
    return bool(
        db.scalar(
            text("SELECT pg_try_advisory_lock(:lock_id)"),
            {"lock_id": SYNC_ADVISORY_LOCK_ID},
        )
    )


def _unlock_sync(db: Session) -> None:
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return
    db.execute(
        text("SELECT pg_advisory_unlock(:lock_id)"),
        {"lock_id": SYNC_ADVISORY_LOCK_ID},
    )


def _create_run(db: Session, mode: SyncMode, trigger: str) -> ExhibitionSyncRun:
    run = ExhibitionSyncRun(mode=mode, trigger=trigger, status="running")
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def _candidate_urls(
    db: Session,
    discovered_urls: list[str],
    mode: SyncMode,
    *,
    refresh_existing: bool = True,
) -> tuple[list[str], set[str]]:
    rows = list(
        db.execute(
            select(
                CatalogExhibition.source_url,
                CatalogExhibition.end_date,
                CatalogExhibition.is_permanent,
                CatalogExhibition.description,
            )
        )
    )
    existing_urls = {row.source_url for row in rows}
    if mode == "full":
        return list(dict.fromkeys(discovered_urls)), existing_urls

    today = date.today()
    refresh_urls = (
        [
            row.source_url
            for row in rows
            if row.is_permanent
            or row.end_date is None
            or row.end_date >= today - timedelta(days=7)
        ]
        if refresh_existing
        else []
    )
    missing_detail_urls = [
        row.source_url for row in rows if not (row.description or "").strip()
    ]
    unknown_urls = [url for url in reversed(discovered_urls) if url not in existing_urls]
    backfill_urls = list(dict.fromkeys([*missing_detail_urls, *unknown_urls]))
    backfill_urls = backfill_urls[: settings.exhibition_sync_backfill_batch_size]

    return list(dict.fromkeys([*refresh_urls, *backfill_urls])), existing_urls


def _upsert_exhibition(
    db: Session,
    parsed: ParsedExhibition,
    existing_by_source_id: dict[str, CatalogExhibition],
) -> bool:
    item = existing_by_source_id.get(parsed.source_id)
    created = item is None
    if item is None:
        item = CatalogExhibition(
            source_id=parsed.source_id,
            source_url=parsed.source_url,
            title=parsed.title,
            region=parsed.region,
            city=parsed.city,
            city_slug=parsed.city_slug,
        )
        db.add(item)
        existing_by_source_id[parsed.source_id] = item

    item.source_url = parsed.source_url
    item.title = parsed.title
    item.region = parsed.region
    item.city = parsed.city
    item.city_slug = parsed.city_slug
    item.venue = parsed.venue
    item.address = parsed.address
    item.start_date = parsed.start_date
    item.end_date = parsed.end_date
    item.start_year = parsed.start_date.year if parsed.start_date else (
        parsed.end_date.year if parsed.end_date else None
    )
    item.end_year = parsed.end_date.year if parsed.end_date else item.start_year
    item.is_permanent = parsed.is_permanent
    item.opening_hours = parsed.opening_hours
    item.fee = parsed.fee
    item.summary = parsed.summary
    item.description = parsed.description
    item.image_urls = parsed.image_urls
    item.cover_url = parsed.cover_url
    item.source_time_text = parsed.source_time_text
    item.synced_at = datetime.now(timezone.utc)
    return created


async def _fetch_detail(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    url: str,
    city_regions: dict[str, tuple[str, str]],
) -> tuple[ParsedExhibition | None, str | None]:
    async with semaphore:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = await client.get(url)
                response.raise_for_status()
                return (
                    parse_exhibition_detail(
                        response.text,
                        source_url=url,
                        city_regions=city_regions,
                    ),
                    None,
                )
            except Exception as exc:  # noqa: BLE001 - retry isolated source failures
                last_error = exc
                if attempt < 2:
                    await asyncio.sleep(0.4 * (attempt + 1))
        return None, f"{url}: {last_error!r}"


async def run_exhibition_sync(
    *,
    mode: SyncMode = "incremental",
    trigger: str = "manual",
    refresh_existing: bool = True,
) -> ExhibitionSyncRun | None:
    db = ExhibitionSessionLocal()
    locked = False
    run: ExhibitionSyncRun | None = None
    try:
        locked = _lock_sync(db)
        if not locked:
            logger.info("exhibition sync skipped because another worker holds the lock")
            return None

        run = _create_run(db, mode, trigger)
        timeout = httpx.Timeout(settings.exhibition_sync_request_timeout_seconds)
        headers = {
            "User-Agent": settings.exhibition_sync_user_agent,
            "Accept": "text/html,application/xml;q=0.9,*/*;q=0.8",
        }
        async with httpx.AsyncClient(
            timeout=timeout,
            headers=headers,
            follow_redirects=True,
        ) as client:
            root_response, sitemap_response = await asyncio.gather(
                client.get(SOURCE_BASE_URL),
                client.get(SOURCE_SITEMAP_URL),
            )
            root_response.raise_for_status()
            sitemap_response.raise_for_status()
            city_regions = parse_city_regions(root_response.text)
            discovered_urls = parse_sitemap_event_urls(sitemap_response.content)
            candidates, existing_urls = _candidate_urls(
                db,
                discovered_urls,
                mode,
                refresh_existing=refresh_existing,
            )

            run.discovered = len(discovered_urls)
            run.attempted = len(candidates)
            db.commit()

            candidate_ids = [url.rsplit("/", 1)[-1] for url in candidates]
            existing_by_source_id = {
                item.source_id: item
                for item in db.scalars(
                    select(CatalogExhibition).where(CatalogExhibition.source_id.in_(candidate_ids))
                )
            }
            semaphore = asyncio.Semaphore(max(1, settings.exhibition_sync_concurrency))
            batch_size = max(1, settings.exhibition_sync_commit_batch_size)
            errors: list[str] = []

            for start in range(0, len(candidates), batch_size):
                batch = candidates[start : start + batch_size]
                results = await asyncio.gather(
                    *[
                        _fetch_detail(client, semaphore, url, city_regions)
                        for url in batch
                    ]
                )
                for parsed, error in results:
                    if error:
                        errors.append(error)
                        run.failed += 1
                        continue
                    if parsed is None:
                        continue
                    created = _upsert_exhibition(db, parsed, existing_by_source_id)
                    if created and parsed.source_url not in existing_urls:
                        run.created += 1
                    else:
                        run.updated += 1
                db.commit()
                logger.info(
                    "exhibition sync run=%s progress=%s/%s created=%s updated=%s failed=%s",
                    run.id,
                    min(start + batch_size, len(candidates)),
                    len(candidates),
                    run.created,
                    run.updated,
                    run.failed,
                )
                if start + batch_size < len(candidates):
                    await asyncio.sleep(
                        max(0, settings.exhibition_sync_commit_pause_seconds)
                    )

        run.status = "partial" if errors else "success"
        run.error = "\n".join(errors[:20]) if errors else None
        run.completed_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(run)
        return run
    except Exception as exc:
        logger.exception("exhibition sync failed")
        if run is not None:
            run.status = "failed"
            run.error = str(exc)
            run.completed_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(run)
        return run
    finally:
        if locked:
            try:
                _unlock_sync(db)
            except Exception:
                logger.warning("failed to release exhibition sync advisory lock", exc_info=True)
        db.close()


def latest_sync_run(db: Session) -> ExhibitionSyncRun | None:
    return db.scalar(
        select(ExhibitionSyncRun).order_by(ExhibitionSyncRun.started_at.desc()).limit(1)
    )


def exhibition_catalog_count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(CatalogExhibition)) or 0)


class ExhibitionSyncCoordinator:
    def __init__(self) -> None:
        self._task: asyncio.Task[ExhibitionSyncRun | None] | None = None
        self._scheduler_task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self, *, mode: SyncMode, trigger: str) -> bool:
        if self.running:
            return False
        self._task = asyncio.create_task(
            self.run_until_caught_up(mode=mode, trigger=trigger),
            name=f"exhibition-sync-{trigger}-{mode}",
        )
        return True

    async def run_until_caught_up(
        self,
        *,
        mode: SyncMode,
        trigger: str,
    ) -> ExhibitionSyncRun | None:
        run = await run_exhibition_sync(mode=mode, trigger=trigger)
        if mode != "incremental" or not settings.exhibition_sync_continuous_backfill:
            return run

        while run is not None and run.status in {"success", "partial"}:
            with ExhibitionSessionLocal() as db:
                remaining = max(0, run.discovered - exhibition_catalog_count(db))
            if remaining == 0:
                logger.info("exhibition backfill caught up")
                return run

            made_progress = run.created + run.updated > 0
            if not made_progress:
                logger.warning(
                    "exhibition backfill stopped with %s remaining because the last run made no progress",
                    remaining,
                )
                return run

            logger.info(
                "exhibition backfill continuing in %ss with %s remaining",
                settings.exhibition_sync_backfill_pause_seconds,
                remaining,
            )
            await asyncio.sleep(
                max(1, settings.exhibition_sync_backfill_pause_seconds)
            )
            run = await run_exhibition_sync(
                mode="incremental",
                trigger="backfill",
                refresh_existing=False,
            )

        return run

    def start_scheduler(self) -> None:
        if self._scheduler_task is None or self._scheduler_task.done():
            self._scheduler_task = asyncio.create_task(
                self._scheduler_loop(),
                name="exhibition-daily-scheduler",
            )

    async def stop(self) -> None:
        if self._scheduler_task is not None:
            self._scheduler_task.cancel()
            try:
                await self._scheduler_task
            except asyncio.CancelledError:
                pass
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _scheduler_loop(self) -> None:
        zone = ZoneInfo(settings.exhibition_sync_timezone)
        while True:
            now = datetime.now(zone)
            target = datetime.combine(
                now.date(),
                time(settings.exhibition_sync_hour, settings.exhibition_sync_minute),
                tzinfo=zone,
            )
            if target <= now:
                target += timedelta(days=1)
            await asyncio.sleep(max(1, (target - now).total_seconds()))
            self.start(mode="incremental", trigger="scheduled")


exhibition_sync_coordinator = ExhibitionSyncCoordinator()
