import unittest
from datetime import date, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.exhibition_db import ExhibitionCatalogBase
from app.exhibition_models import CatalogExhibition
from app.main import list_exhibition_catalog, list_museum_directory
from app.models import Museum


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

    def test_directory_merges_known_museum_and_adds_catalog_venues(self) -> None:
        self.main_db.add(Museum(name="山东博物馆", location="济南"))
        self.main_db.commit()
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

        self.assertEqual(len(directory), 2)
        shandong = next(item for item in directory if item.name == "山东博物馆")
        self.assertGreater(shandong.id, 0)
        self.assertEqual(shandong.catalog_exhibition_count, 2)
        self.assertEqual(shandong.first_year, 2025)
        self.assertEqual(shandong.last_year, 2026)
        self.assertFalse(shandong.derived_from_catalog)

        confucius = next(item for item in directory if item.name == "孔子博物馆")
        self.assertLess(confucius.id, 0)
        self.assertEqual(confucius.exhibition_count, 1)
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

    def test_directory_uses_dominant_address_while_parent_museum_is_backfilled(self) -> None:
        address = "上海市黄浦区人民大道201号"
        self.main_db.add(Museum(name="上海博物馆"))
        self.main_db.commit()
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
