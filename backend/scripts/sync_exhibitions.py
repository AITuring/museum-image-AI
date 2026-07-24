import argparse
import asyncio
import sys
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


# `python scripts/sync_exhibitions.py` makes /app/scripts the first import root.
# Add the backend root so the sibling `app` package is importable both from the
# Docker command above and from local direct execution.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.config import settings
from app.exhibition_db import initialize_exhibition_database
from app.exhibition_db import ExhibitionSessionLocal
from app.exhibition_models import ExhibitionSyncWorkerState
from app.exhibition_service import (
    ExhibitionSyncCoordinator,
    exhibition_backfill_remaining,
    run_exhibition_sync,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="同步 iMuseum 公开展览目录")
    parser.add_argument(
        "--mode",
        choices=("incremental", "full"),
        default="incremental",
        help="incremental 刷新有效记录并分批回填；full 一次性回填 sitemap 全部展览",
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="启动独立 Worker：先持续补齐历史数据，追平后按每日计划同步",
    )
    return parser.parse_args()


def seconds_until_daily_sync() -> float:
    zone = ZoneInfo(settings.exhibition_sync_timezone)
    now = datetime.now(zone)
    target = datetime.combine(
        now.date(),
        time(settings.exhibition_sync_hour, settings.exhibition_sync_minute),
        tzinfo=zone,
    )
    if target <= now:
        target += timedelta(days=1)
    return max(1, (target - now).total_seconds())


def remaining_after(run) -> int:
    if run is None:
        return 0
    with ExhibitionSessionLocal() as db:
        return exhibition_backfill_remaining(db, run.discovered)


class WorkerHeartbeat:
    def __init__(self) -> None:
        self.status = "starting"
        self.message: str | None = "同步 Worker 正在启动"
        self.next_run_at: datetime | None = None

    def set(
        self,
        status: str,
        *,
        message: str | None = None,
        next_run_at: datetime | None = None,
    ) -> None:
        self.status = status
        self.message = message
        self.next_run_at = next_run_at

    def persist(self) -> None:
        with ExhibitionSessionLocal() as db:
            state = db.get(ExhibitionSyncWorkerState, 1)
            if state is None:
                state = ExhibitionSyncWorkerState(id=1)
                db.add(state)
            state.status = self.status
            state.message = self.message
            state.heartbeat_at = datetime.now(timezone.utc)
            state.next_run_at = self.next_run_at
            db.commit()

    async def run(self) -> None:
        while True:
            try:
                self.persist()
            except Exception as exc:  # noqa: BLE001 - heartbeat must not stop sync
                print(f"sync worker heartbeat failed: {exc}", flush=True)
            await asyncio.sleep(15)


async def run_daemon() -> None:
    coordinator = ExhibitionSyncCoordinator()
    heartbeat = WorkerHeartbeat()
    heartbeat_task = asyncio.create_task(
        heartbeat.run(),
        name="exhibition-sync-worker-heartbeat",
    )
    trigger = "worker-bootstrap"
    try:
        while True:
            heartbeat.set(
                "syncing",
                message="正在补齐历史展览" if trigger != "worker-scheduled" else "正在同步最新展览",
            )
            heartbeat.persist()
            run = await coordinator.run_until_caught_up(
                mode="incremental",
                trigger=trigger,
            )
            remaining = remaining_after(run)
            if run is None or run.status == "failed" or remaining > 0:
                delay = max(60, settings.exhibition_sync_retry_seconds)
                next_run_at = datetime.now(timezone.utc) + timedelta(seconds=delay)
                heartbeat.set(
                    "retry_wait",
                    message=f"仍有 {remaining} 条待补，等待重试",
                    next_run_at=next_run_at,
                )
                heartbeat.persist()
                print(
                    f"sync worker retrying in {delay}s "
                    f"status={run.status if run is not None else 'locked'} "
                    f"remaining={remaining}",
                    flush=True,
                )
                await asyncio.sleep(delay)
                trigger = "worker-retry"
                continue

            delay = seconds_until_daily_sync()
            next_run_at = datetime.now(timezone.utc) + timedelta(seconds=delay)
            heartbeat.set(
                "waiting_daily",
                message="历史数据已追平，等待每日增量同步",
                next_run_at=next_run_at,
            )
            heartbeat.persist()
            print(
                f"sync worker caught up; next incremental sync in {int(delay)}s",
                flush=True,
            )
            await asyncio.sleep(delay)
            trigger = "worker-scheduled"
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass


async def main() -> int:
    args = parse_args()
    initialize_exhibition_database()
    if args.daemon:
        await run_daemon()
        return 0

    run = await run_exhibition_sync(mode=args.mode, trigger="cli")
    if run is None:
        print("另一个同步任务正在运行。")
        return 2
    print(
        f"status={run.status} discovered={run.discovered} attempted={run.attempted} "
        f"created={run.created} updated={run.updated} failed={run.failed}"
    )
    return 0 if run.status in {"success", "partial"} else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
