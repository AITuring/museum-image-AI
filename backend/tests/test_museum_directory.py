import unittest
from datetime import date, timedelta
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.exhibition_db import ExhibitionCatalogBase
from app.exhibition_models import CatalogExhibition
from app.main import is_allowed_remote_image_url, list_exhibition_catalog, list_museum_directory
from app.models import Artifact, ArtifactImage, Museum


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

    def test_directory_merges_known_museum_and_adds_catalog_venues(self) -> None:
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
            q=None,
            limit=100,
            db=self.main_db,
            catalog_db=self.catalog_db,
        )

        self.assertEqual(len(directory), 1)
        shandong = next(item for item in directory if item.name == "山东博物馆")
        self.assertGreater(shandong.id, 0)
        self.assertEqual(shandong.catalog_exhibition_count, 2)
        self.assertEqual(shandong.first_year, 2025)
        self.assertEqual(shandong.last_year, 2026)
        self.assertFalse(shandong.derived_from_catalog)

        self.assertNotIn("孔子博物馆", [item.name for item in directory])

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

    def test_directory_only_contains_museums_with_uploaded_images(self) -> None:
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
            q=None,
            limit=100,
            db=self.main_db,
            catalog_db=self.catalog_db,
        )

        self.assertEqual([item.name for item in directory], ["上海博物馆"])

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
