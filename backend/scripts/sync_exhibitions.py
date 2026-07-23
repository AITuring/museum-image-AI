import argparse
import asyncio
import sys
from pathlib import Path


# `python scripts/sync_exhibitions.py` makes /app/scripts the first import root.
# Add the backend root so the sibling `app` package is importable both from the
# Docker command above and from local direct execution.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.exhibition_db import initialize_exhibition_database
from app.exhibition_service import run_exhibition_sync


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="同步 iMuseum 公开展览目录")
    parser.add_argument(
        "--mode",
        choices=("incremental", "full"),
        default="incremental",
        help="incremental 刷新有效记录并分批回填；full 一次性回填 sitemap 全部展览",
    )
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    initialize_exhibition_database()
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
