import unittest
from contextlib import nullcontext
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, call, patch

import httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.exhibition_db import ExhibitionCatalogBase, _repair_legacy_museum_names
from app.exhibition_models import CatalogExhibition
from app.exhibition_service import (
    ExhibitionSyncCoordinator,
    _candidate_urls,
    _fetch_source_document,
)


def exhibition(
    source_id: str,
    *,
    description: str | None,
    end_date: date | None,
    museum_name: str | None = "测试美术馆",
) -> CatalogExhibition:
    return CatalogExhibition(
        source_id=source_id,
        source_url=f"https://art.icity.ly/events/{source_id}",
        title=source_id,
        region="中国大陆",
        city="北京",
        city_slug="beijing",
        museum_name=museum_name,
        description=description,
        end_date=end_date,
        is_permanent=False,
    )


class ExhibitionSyncCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        ExhibitionCatalogBase.metadata.create_all(self.engine)
        self.db = Session(self.engine)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_continuation_skips_existing_refresh_but_keeps_missing_details(self) -> None:
        current = exhibition(
            "current",
            description="已有详情",
            end_date=date.today() + timedelta(days=30),
        )
        missing_detail = exhibition(
            "missing-detail",
            description=None,
            end_date=date.today() - timedelta(days=30),
        )
        missing_museum = exhibition(
            "missing-museum",
            description="已有详情",
            end_date=date.today() - timedelta(days=30),
            museum_name=None,
        )
        room_as_museum = exhibition(
            "room-as-museum",
            description="已有详情",
            end_date=date.today() - timedelta(days=30),
            museum_name="二层临展厅",
        )
        self.db.add_all([current, missing_detail, missing_museum, room_as_museum])
        self.db.commit()
        discovered = [
            current.source_url,
            missing_detail.source_url,
            missing_museum.source_url,
            room_as_museum.source_url,
            "https://art.icity.ly/events/new",
        ]

        candidates, _ = _candidate_urls(
            self.db,
            discovered,
            "incremental",
            refresh_existing=False,
        )

        self.assertNotIn(current.source_url, candidates)
        self.assertIn(missing_detail.source_url, candidates)
        self.assertIn(missing_museum.source_url, candidates)
        self.assertIn(room_as_museum.source_url, candidates)
        self.assertIn("https://art.icity.ly/events/new", candidates)

    def test_first_incremental_run_refreshes_current_exhibitions(self) -> None:
        current = exhibition(
            "current",
            description="已有详情",
            end_date=date.today() + timedelta(days=30),
        )
        self.db.add(current)
        self.db.commit()

        candidates, _ = _candidate_urls(
            self.db,
            [current.source_url],
            "incremental",
        )

        self.assertIn(current.source_url, candidates)

    def test_startup_repair_never_promotes_rooms_to_museums(self) -> None:
        address = "太原市万柏林区广经路13号"
        permanent = exhibition(
            "shanxi-permanent",
            description="已有详情",
            end_date=None,
            museum_name=None,
        )
        permanent.title = "「吉金光华」山西青铜博物馆常设展"
        permanent.address = address
        permanent.city = "太原"
        room = exhibition(
            "shanxi-room",
            description="已有详情",
            end_date=date.today(),
            museum_name="二层临展厅",
        )
        room.venue = "二层临展厅"
        room.address = address
        room.city = "太原"
        composite = exhibition(
            "library-room",
            description="已有详情",
            end_date=date.today(),
            museum_name="上海图书馆第一展厅",
        )
        composite.venue = "上海图书馆第一展厅"
        composite.address = "上海市淮海中路1555号"
        composite.city = "上海"
        self.db.add_all([permanent, room, composite])
        self.db.commit()

        with self.engine.begin() as connection:
            repaired = _repair_legacy_museum_names(connection)
        self.db.expire_all()

        self.assertEqual(repaired, 3)
        self.assertEqual(permanent.museum_name, "山西青铜博物馆")
        self.assertEqual(room.museum_name, "山西青铜博物馆")
        self.assertEqual(composite.museum_name, "上海图书馆")


class ExhibitionSyncCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_discovery_document_retries_transient_tls_failure(self) -> None:
        response = httpx.Response(
            200,
            request=httpx.Request("GET", "https://art.icity.ly"),
        )
        client = SimpleNamespace(
            get=AsyncMock(
                side_effect=[
                    httpx.ConnectError("temporary TLS failure"),
                    response,
                ]
            )
        )

        with patch(
            "app.exhibition_service.asyncio.sleep",
            new=AsyncMock(),
        ) as sleep:
            result = await _fetch_source_document(
                client,
                "https://art.icity.ly",
            )

        self.assertIs(result, response)
        self.assertEqual(client.get.await_count, 2)
        sleep.assert_awaited_once_with(1)

    async def test_continuous_backfill_runs_until_catalog_catches_up(self) -> None:
        runs = [
            SimpleNamespace(
                status="success",
                discovered=2500,
                created=1000,
                updated=0,
            ),
            SimpleNamespace(
                status="success",
                discovered=2500,
                created=1000,
                updated=0,
            ),
            SimpleNamespace(
                status="success",
                discovered=2500,
                created=500,
                updated=0,
            ),
        ]
        coordinator = ExhibitionSyncCoordinator()

        with (
            patch(
                "app.exhibition_service.run_exhibition_sync",
                new=AsyncMock(side_effect=runs),
            ) as run_sync,
            patch(
                "app.exhibition_service.ExhibitionSessionLocal",
                side_effect=lambda: nullcontext(object()),
            ),
            patch(
                "app.exhibition_service.exhibition_backfill_remaining",
                side_effect=[1500, 500, 0],
            ),
            patch(
                "app.exhibition_service.asyncio.sleep",
                new=AsyncMock(),
            ) as sleep,
        ):
            result = await coordinator.run_until_caught_up(
                mode="incremental",
                trigger="bootstrap",
            )

        self.assertIs(result, runs[-1])
        self.assertEqual(run_sync.await_count, 3)
        self.assertEqual(
            run_sync.await_args_list,
            [
                call(mode="incremental", trigger="bootstrap"),
                call(
                    mode="incremental",
                    trigger="backfill",
                    refresh_existing=False,
                ),
                call(
                    mode="incremental",
                    trigger="backfill",
                    refresh_existing=False,
                ),
            ],
        )
        self.assertEqual(sleep.await_count, 2)

    async def test_continuous_backfill_stops_after_no_progress(self) -> None:
        stalled_run = SimpleNamespace(
            status="partial",
            discovered=2500,
            created=0,
            updated=0,
        )
        coordinator = ExhibitionSyncCoordinator()

        with (
            patch(
                "app.exhibition_service.run_exhibition_sync",
                new=AsyncMock(return_value=stalled_run),
            ) as run_sync,
            patch(
                "app.exhibition_service.ExhibitionSessionLocal",
                side_effect=lambda: nullcontext(object()),
            ),
            patch(
                "app.exhibition_service.exhibition_backfill_remaining",
                return_value=500,
            ),
            patch(
                "app.exhibition_service.asyncio.sleep",
                new=AsyncMock(),
            ) as sleep,
        ):
            result = await coordinator.run_until_caught_up(
                mode="incremental",
                trigger="scheduled",
            )

        self.assertIs(result, stalled_run)
        self.assertEqual(run_sync.await_count, 1)
        sleep.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
