import unittest
from datetime import date, datetime, timedelta
from unittest.mock import patch

from fastapi import BackgroundTasks
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.exhibition_db import ExhibitionCatalogBase
from app.exhibition_models import CatalogExhibition
from app.main import (
    attach_catalog_metadata_to_uploaded_museum_directory,
    build_uploaded_museum_directory,
    is_allowed_remote_image_url,
    list_exhibition_catalog,
    list_museum_directory,
    museum_name_matches_catalog_museum,
)
from app.models import Artifact, ArtifactImage, Museum
from app.schemas import ArtifactImageRead, ArtifactRead


def catalog_exhibition(
    source_id: str,
    *,
    venue: str,
    city: str,
    title: str,
    start_date: date,
    museum_name: str | None = None,
    address: str | None = None,
) -> CatalogExhibition:
    return CatalogExhibition(
        source_id=source_id,
        source_url=f"https://art.icity.ly/events/{source_id}",
        title=title,
        region="中国大陆",
        city=city,
        city_slug=city,
        museum_name=venue if museum_name is None else museum_name,
        venue=venue,
        address=address or f"{city}{venue}",
        start_date=start_date,
        end_date=start_date + timedelta(days=90),
        start_year=start_date.year,
        end_year=start_date.year,
        is_permanent=False,
        image_urls=[],
    )


class MuseumDirectoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cloud_proxy = patch(
            "app.main.should_proxy_artifact_queries_to_cloud",
            return_value=False,
        )
        self.cloud_proxy.start()
        self.main_engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        self.catalog_engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.main_engine)
        ExhibitionCatalogBase.metadata.create_all(self.catalog_engine)
        self.main_db = Session(self.main_engine)
        self.catalog_db = Session(self.catalog_engine)

    def tearDown(self) -> None:
        self.main_db.close()
        self.catalog_db.close()
        self.main_engine.dispose()
        self.catalog_engine.dispose()
        self.cloud_proxy.stop()

    def add_uploaded_museum(self, name: str, *, location: str | None = None) -> Museum:
        museum = Museum(name=name, location=location)
        artifact = Artifact(name=f"{name}藏品", museum=museum)
        artifact.images.append(ArtifactImage(url=f"/files/uploads/{name}.jpg"))
        self.main_db.add(museum)
        self.main_db.commit()
        return museum

    def test_directory_merges_uploaded_and_catalog_only_museums(self) -> None:
        self.add_uploaded_museum("山东博物馆", location="济南")
        self.catalog_db.add_all(
            [
                catalog_exhibition(
                    "sd-2025",
                    venue="山东博物馆",
                    city="济南",
                    title="海岱日新",
                    start_date=date(2025, 1, 1),
                ),
                catalog_exhibition(
                    "sd-2026",
                    venue="山东博物馆",
                    city="济南",
                    title="礼乐文明",
                    start_date=date(2026, 2, 1),
                ),
                catalog_exhibition(
                    "confucius-2026",
                    venue="孔子博物馆",
                    city="曲阜",
                    title="大哉孔子",
                    start_date=date(2026, 3, 1),
                ),
            ]
        )
        self.catalog_db.commit()

        directory = list_museum_directory(
            background_tasks=BackgroundTasks(),
            q=None,
            limit=100,
            db=self.main_db,
            catalog_db=self.catalog_db,
        )

        self.assertEqual(len(directory), 2)
        shandong = next(item for item in directory if item.name == "山东博物馆")
        self.assertGreater(shandong.id, 0)
        self.assertEqual(shandong.catalog_exhibition_count, 2)
        self.assertEqual(shandong.first_year, 2025)
        self.assertEqual(shandong.last_year, 2026)
        self.assertFalse(shandong.derived_from_catalog)

        confucius = next(item for item in directory if item.name == "孔子博物馆")
        self.assertLess(confucius.id, 0)
        self.assertIsNone(confucius.museum_id)
        self.assertEqual(confucius.museum_ids, [])
        self.assertEqual(confucius.catalog_exhibition_count, 1)
        self.assertTrue(confucius.derived_from_catalog)

    def test_catalog_can_filter_an_exact_museum_venue(self) -> None:
        self.catalog_db.add_all(
            [
                catalog_exhibition(
                    "sd",
                    venue="山东博物馆",
                    city="济南",
                    title="山东展览",
                    start_date=date(2026, 1, 1),
                ),
                catalog_exhibition(
                    "other",
                    venue="孔子博物馆",
                    city="曲阜",
                    title="曲阜展览",
                    start_date=date(2026, 1, 1),
                ),
            ]
        )
        self.catalog_db.commit()

        result = list_exhibition_catalog(
            q=None,
            year=None,
            region=None,
            city="济南",
            museum_name="山东博物馆",
            address=None,
            venue="山东博物馆",
            status=None,
            include_facets=False,
            page=1,
            page_size=36,
            db=self.catalog_db,
        )

        self.assertEqual(result.total, 1)
        self.assertEqual(result.items[0].title, "山东展览")

    def test_directory_does_not_promote_rooms_or_floors_to_museums(self) -> None:
        self.add_uploaded_museum("上海博物馆")
        self.catalog_db.add_all(
            [
                catalog_exhibition(
                    "museum",
                    venue="第一展览厅",
                    museum_name="上海博物馆",
                    city="上海",
                    title="馆藏书画展",
                    start_date=date(2026, 1, 1),
                ),
                catalog_exhibition(
                    "room",
                    venue="1、2号展厅",
                    city="天津",
                    title="展厅活动",
                    start_date=date(2026, 1, 1),
                ),
                catalog_exhibition(
                    "complex",
                    venue="1933老场坊1号楼3楼",
                    city="上海",
                    title="空间活动",
                    start_date=date(2026, 1, 1),
                ),
            ]
        )
        self.catalog_db.commit()

        directory = list_museum_directory(
            background_tasks=BackgroundTasks(),
            q=None,
            limit=100,
            db=self.main_db,
            catalog_db=self.catalog_db,
        )

        self.assertEqual([item.name for item in directory], ["上海博物馆"])

    def test_catalog_only_imuseum_museum_is_searchable(self) -> None:
        address = "太原市万柏林区广经路13号"
        permanent = catalog_exhibition(
            "shanxi-bronze-permanent",
            venue="山西青铜博物馆",
            city="太原",
            title="「吉金光华」山西青铜博物馆常设展",
            start_date=date(2019, 7, 27),
            address=address,
        )
        # This mirrors the production rows created before the source parser
        # had a separate parent-museum field: the permanent display has no
        # museum and temporary exhibitions contain only their room.
        permanent.museum_name = None
        permanent.is_permanent = True
        self.catalog_db.add_all(
            [
                permanent,
                catalog_exhibition(
                    "vv6ay6t",
                    venue="二层临展厅",
                    museum_name="二层临展厅",
                    city="太原",
                    title="致和：春秋时期的晋与吴",
                    start_date=date(2026, 6, 5),
                    address=address,
                ),
                catalog_exhibition(
                    "shanxi-bronze-room",
                    venue="一层临展厅",
                    museum_name="一层临展厅",
                    city="太原",
                    title="晋国霸业",
                    start_date=date(2024, 10, 1),
                    address=address,
                ),
            ]
        )
        self.catalog_db.commit()

        directory = list_museum_directory(
            background_tasks=BackgroundTasks(),
            q="山西青铜",
            limit=8,
            db=self.main_db,
            catalog_db=self.catalog_db,
        )

        self.assertEqual(len(directory), 1)
        museum = directory[0]
        self.assertEqual(museum.name, "山西青铜博物馆")
        self.assertEqual(museum.location, address)
        self.assertEqual(museum.latitude, 37.805219)
        self.assertEqual(museum.longitude, 112.533475)
        self.assertEqual(museum.catalog_museum_name, "山西青铜博物馆")
        self.assertEqual(museum.catalog_address, address)
        self.assertEqual(museum.catalog_exhibition_count, 3)
        self.assertTrue(museum.derived_from_catalog)

        history = list_exhibition_catalog(
            q=None,
            year=None,
            region=None,
            city="太原",
            museum_name=None,
            address=museum.catalog_address,
            venue=None,
            status=None,
            include_facets=False,
            page=1,
            page_size=100,
            db=self.catalog_db,
        )
        self.assertEqual(history.total, 3)
        self.assertIn(
            "致和：春秋时期的晋与吴",
            [item.title for item in history.items],
        )

    def test_catalog_keeps_same_named_museums_in_different_cities_separate(self) -> None:
        self.add_uploaded_museum("龙美术馆", location="上海")
        self.catalog_db.add_all(
            [
                catalog_exhibition(
                    "dragon-shanghai",
                    venue="龙美术馆",
                    museum_name="龙美术馆",
                    city="上海",
                    title="上海展览",
                    start_date=date(2026, 1, 1),
                    address="上海市徐汇区龙腾大道3399号",
                ),
                catalog_exhibition(
                    "dragon-chongqing",
                    venue="龙美术馆",
                    museum_name="龙美术馆",
                    city="重庆",
                    title="重庆展览",
                    start_date=date(2026, 2, 1),
                    address="重庆市江北区北滨一路",
                ),
            ]
        )
        self.catalog_db.commit()

        directory = list_museum_directory(
            background_tasks=BackgroundTasks(),
            q=None,
            limit=100,
            db=self.main_db,
            catalog_db=self.catalog_db,
        )

        dragon_museums = [item for item in directory if item.name == "龙美术馆"]
        self.assertEqual(len(dragon_museums), 2)
        self.assertEqual(
            {item.catalog_city for item in dragon_museums},
            {"上海", "重庆"},
        )
        self.assertEqual(len({item.id for item in dragon_museums}), 2)
        shanghai = next(item for item in dragon_museums if item.catalog_city == "上海")
        chongqing = next(item for item in dragon_museums if item.catalog_city == "重庆")
        self.assertGreater(shanghai.id, 0)
        self.assertLess(chongqing.id, 0)

        chongqing_search = list_museum_directory(
            background_tasks=BackgroundTasks(),
            q="重庆",
            limit=100,
            db=self.main_db,
            catalog_db=self.catalog_db,
        )
        self.assertEqual(
            [(item.name, item.catalog_city) for item in chongqing_search],
            [("龙美术馆", "重庆")],
        )

    def test_cloud_proxy_responds_from_cache_and_schedules_refresh(self) -> None:
        self.catalog_db.add(
            catalog_exhibition(
                "vv6ay6t",
                venue="二层临展厅",
                museum_name="山西青铜博物馆",
                city="太原",
                title="致和：春秋时期的晋与吴",
                start_date=date(2026, 6, 5),
            )
        )
        self.catalog_db.commit()
        background_tasks = BackgroundTasks()

        with (
            patch(
                "app.main.should_proxy_artifact_queries_to_cloud",
                return_value=True,
            ),
            patch(
                "app.main.get_cached_cloud_museum_directory_artifacts",
                return_value=[],
            ) as cached,
            patch("app.main.get_cloud_museum_directory_artifacts") as refresh,
        ):
            directory = list_museum_directory(
                background_tasks=background_tasks,
                q="山西青铜",
                limit=8,
                db=self.main_db,
                catalog_db=self.catalog_db,
            )

        self.assertEqual([item.name for item in directory], ["山西青铜博物馆"])
        cached.assert_called_once_with()
        refresh.assert_not_called()
        self.assertEqual(len(background_tasks.tasks), 1)

    def test_uploaded_directory_merges_trailing_cang_museum_names(self) -> None:
        now = datetime.now()

        def artifact(artifact_id: int, museum_id: int, museum_name: str) -> ArtifactRead:
            return ArtifactRead(
                id=artifact_id,
                museum_id=museum_id,
                name=f"{museum_name}文物",
                created_at=now,
                museum_name=museum_name,
                images=[
                    ArtifactImageRead(
                        id=artifact_id,
                        artifact_id=artifact_id,
                        artifact_name=f"{museum_name}文物",
                        museum_name=museum_name,
                        url=f"/files/uploads/{artifact_id}.jpg",
                        created_at=now,
                        uploaded_at=now,
                    )
                ],
            )

        directory = build_uploaded_museum_directory(
            [artifact(1, 8, "河北博物院"), artifact(2, 23, "河北博物院藏")],
            q=None,
            limit=100,
        )

        self.assertEqual(len(directory), 1)
        self.assertEqual(directory[0].name, "河北博物院")
        self.assertEqual(directory[0].museum_id, 8)
        self.assertEqual(directory[0].artifact_count, 2)
        self.assertEqual(directory[0].museum_ids, [8, 23])

    def test_uploaded_directory_connects_matching_catalog_museum(self) -> None:
        now = datetime.now()
        directory = build_uploaded_museum_directory(
            [
                ArtifactRead(
                    id=1,
                    museum_id=8,
                    name="测试文物",
                    created_at=now,
                    museum_name="上海博物馆",
                    images=[
                        ArtifactImageRead(
                            id=1,
                            artifact_id=1,
                            artifact_name="测试文物",
                            museum_name="上海博物馆",
                            url="/files/uploads/test.jpg",
                            created_at=now,
                            uploaded_at=now,
                        )
                    ],
                )
            ],
            q=None,
            limit=100,
        )
        self.catalog_db.add(
            catalog_exhibition(
                "shanghai-2026",
                venue="第一展览厅",
                museum_name="上海博物馆",
                city="上海",
                title="海上书画展",
                start_date=date(2026, 1, 1),
            )
        )
        self.catalog_db.commit()

        attached = attach_catalog_metadata_to_uploaded_museum_directory(directory, self.catalog_db)

        self.assertEqual(attached[0].catalog_museum_name, "上海博物馆")
        self.assertEqual(attached[0].catalog_exhibition_count, 1)
        self.assertEqual(attached[0].exhibition_count, 1)

    def test_uploaded_directory_keeps_catalog_branches_separate(self) -> None:
        self.assertTrue(museum_name_matches_catalog_museum("上海博物馆东馆", "上海博物馆东馆"))
        self.assertFalse(museum_name_matches_catalog_museum("上海博物馆人民广场馆", "上海博物馆东馆"))
        self.assertTrue(museum_name_matches_catalog_museum("上海博物馆人民广场馆", "上海博物馆"))
        self.assertFalse(museum_name_matches_catalog_museum("上海博物馆", "上海历史博物馆"))

    def test_uploaded_directory_uses_image_gps_to_separate_shanghai_museum_venues(self) -> None:
        now = datetime.now()
        directory = build_uploaded_museum_directory(
            [
                ArtifactRead(
                    id=1,
                    museum_id=1,
                    name="东馆文物",
                    created_at=now,
                    museum_name="上海博物馆",
                    images=[
                        ArtifactImageRead(
                            id=1,
                            artifact_id=1,
                            artifact_name="东馆文物",
                            museum_name="上海博物馆",
                            url="/files/uploads/east.jpg",
                            latitude=31.219913,
                            longitude=121.538745,
                            created_at=now,
                            uploaded_at=now,
                        )
                    ],
                ),
                ArtifactRead(
                    id=2,
                    museum_id=2,
                    name="人民广场文物",
                    created_at=now,
                    museum_name="上海博物馆",
                    images=[
                        ArtifactImageRead(
                            id=2,
                            artifact_id=2,
                            artifact_name="人民广场文物",
                            museum_name="上海博物馆",
                            url="/files/uploads/people-square.jpg",
                            latitude=31.2302,
                            longitude=121.4752,
                            created_at=now,
                            uploaded_at=now,
                        )
                    ],
                ),
            ],
            q=None,
            limit=100,
        )

        self.assertEqual(
            [(item.name, item.latitude, item.longitude) for item in directory],
            [
                ("上海博物馆东馆", 31.219913, 121.538745),
                ("上海博物馆人民广场馆", 31.2302, 121.4752),
            ],
        )

    def test_image_variant_allows_imuseum_cdn_covers(self) -> None:
        self.assertTrue(
            is_allowed_remote_image_url(
                "https://icity-static.icitycdn.com/images/uploads/cover.jpg"
            )
        )
        self.assertFalse(is_allowed_remote_image_url("https://example.com/cover.jpg"))

    def test_directory_uses_dominant_address_while_parent_museum_is_backfilled(self) -> None:
        address = "上海市黄浦区人民大道201号"
        self.add_uploaded_museum("上海博物馆")
        first = catalog_exhibition(
            "sh-title",
            venue="第一展览厅",
            city="上海",
            title="上海博物馆藏历代扇面书画展",
            start_date=date(2025, 1, 1),
            museum_name="",
            address=address,
        )
        second = catalog_exhibition(
            "sh-room",
            venue="3楼",
            city="上海",
            title="中国历代绘画馆",
            start_date=date(2024, 1, 1),
            museum_name="",
            address=address,
        )
        self.catalog_db.add_all([first, second])
        self.catalog_db.commit()

        directory = list_museum_directory(
            background_tasks=BackgroundTasks(),
            q=None,
            limit=100,
            db=self.main_db,
            catalog_db=self.catalog_db,
        )

        shanghai = next(item for item in directory if item.name == "上海博物馆")
        self.assertEqual(shanghai.catalog_address, address)
        self.assertEqual(shanghai.catalog_exhibition_count, 2)
        self.assertIsNone(shanghai.catalog_museum_name)

        history = list_exhibition_catalog(
            q=None,
            year=None,
            region=None,
            city="上海",
            museum_name=None,
            address=address,
            venue=None,
            status=None,
            include_facets=False,
            page=1,
            page_size=100,
            db=self.catalog_db,
        )
        self.assertEqual(history.total, 2)


if __name__ == "__main__":
    unittest.main()
