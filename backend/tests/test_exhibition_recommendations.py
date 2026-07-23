import unittest
from datetime import date, datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.exhibition_db import ExhibitionCatalogBase
from app.exhibition_models import CatalogExhibition
from app.main import recommend_exhibition_catalog
from app.models import Museum


def exhibition(
    source_id: str,
    title: str,
    *,
    start_date: date | None,
    end_date: date | None,
    is_permanent: bool = False,
) -> CatalogExhibition:
    return CatalogExhibition(
        source_id=source_id,
        source_url=f"https://example.com/events/{source_id}",
        title=title,
        region="中国大陆",
        city="济南",
        city_slug="jinan",
        venue="山东博物馆",
        start_date=start_date,
        end_date=end_date,
        start_year=start_date.year if start_date else None,
        end_year=end_date.year if end_date else None,
        is_permanent=is_permanent,
    )


class ExhibitionRecommendationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog_engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        self.artifact_engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        ExhibitionCatalogBase.metadata.create_all(self.catalog_engine)
        Museum.__table__.create(self.artifact_engine)
        self.catalog_db = Session(self.catalog_engine)
        self.artifact_db = Session(self.artifact_engine)

    def tearDown(self) -> None:
        self.catalog_db.close()
        self.artifact_db.close()
        self.catalog_engine.dispose()
        self.artifact_engine.dispose()

    def recommend(self, *, limit: int = 10):
        return recommend_exhibition_catalog(
            captured_at=datetime(2026, 6, 1, 12, 0, 0),
            latitude=None,
            longitude=None,
            location=None,
            q=None,
            limit=limit,
            catalog_db=self.catalog_db,
            artifact_db=self.artifact_db,
        )

    def test_permanent_exhibition_survives_large_dated_candidate_pool(self) -> None:
        self.catalog_db.add_all(
            [
                exhibition(
                    f"special-{index}",
                    f"特展 {index}",
                    start_date=date(2026, 1, 1),
                    end_date=date(2026, 12, 31),
                )
                for index in range(501)
            ]
        )
        self.catalog_db.add(
            exhibition(
                "permanent",
                "常设陈列",
                start_date=None,
                end_date=None,
                is_permanent=True,
            )
        )
        self.catalog_db.commit()

        recommendations = self.recommend()

        permanent = next(
            item for item in recommendations if item.source_id == "permanent"
        )
        self.assertIn("常设展，长期有效", permanent.match_reasons)
        self.assertEqual(recommendations[-1].source_id, "permanent")

    def test_long_running_exhibition_is_kept_with_capture_date(self) -> None:
        self.catalog_db.add_all(
            [
                exhibition(
                    "short",
                    "短期特展",
                    start_date=date(2026, 5, 1),
                    end_date=date(2026, 7, 1),
                ),
                exhibition(
                    "long-running",
                    "长期陈列",
                    start_date=date(2020, 1, 1),
                    end_date=date(2030, 12, 31),
                ),
            ]
        )
        self.catalog_db.commit()

        recommendations = self.recommend(limit=2)

        long_running = next(
            item for item in recommendations if item.source_id == "long-running"
        )
        self.assertIn("拍摄日期在长期展期内", long_running.match_reasons)


if __name__ == "__main__":
    unittest.main()
