import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.exhibition_db import ExhibitionCatalogBase
from app.exhibition_models import CatalogExhibition
from app.main import (
    enrich_artifact_catalog_links,
    ensure_exhibition,
    ensure_museum,
    resolve_capture_context,
)
from app.schemas import ArtifactRead, ExhibitionRead


class ExhibitionLinkingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.artifact_engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        self.catalog_engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.artifact_engine)
        ExhibitionCatalogBase.metadata.create_all(self.catalog_engine)
        self.artifact_db = Session(self.artifact_engine)
        self.catalog_session_factory = sessionmaker(bind=self.catalog_engine, class_=Session)

    def tearDown(self) -> None:
        self.artifact_db.close()
        self.artifact_engine.dispose()
        self.catalog_engine.dispose()

    def test_explicit_capture_museum_wins_over_catalog_museum(self) -> None:
        with self.catalog_session_factory() as catalog_db:
            catalog_db.add(
                CatalogExhibition(
                    source_id="shanghai-civilization",
                    source_url="https://example.com/shanghai-civilization",
                    title="文明展",
                    region="中国大陆",
                    city="上海",
                    city_slug="shanghai",
                    museum_name="上海博物馆",
                    venue="第一展览厅",
                    is_permanent=False,
                )
            )
            catalog_db.commit()

        with patch("app.main.ExhibitionSessionLocal", self.catalog_session_factory):
            museum, exhibition = resolve_capture_context(
                self.artifact_db,
                "上海博物馆东馆",
                "文明展",
                "shanghai-civilization",
                None,
            )

        self.assertIsNotNone(museum)
        self.assertIsNotNone(exhibition)
        self.assertEqual(museum.name, "上海博物馆东馆")
        self.assertEqual(exhibition.museum_name, "上海博物馆东馆")

    def test_catalog_selection_reuses_normalized_manual_exhibition(self) -> None:
        museum = ensure_museum(self.artifact_db, "上海博物馆")
        manual = ensure_exhibition(self.artifact_db, museum, "文明 · 展")
        linked = ensure_exhibition(
            self.artifact_db,
            museum,
            "文明展",
            catalog_source_id="shanghai-civilization",
            catalog_exhibition_id=42,
        )

        self.assertEqual(linked.id, manual.id)
        self.assertEqual(linked.catalog_source_id, "shanghai-civilization")
        self.assertEqual(linked.catalog_exhibition_id, 42)

    def test_quick_entry_museum_write_strips_trailing_cang(self) -> None:
        canonical = ensure_museum(self.artifact_db, "河北博物院")
        from_artifact_provenance = ensure_museum(self.artifact_db, "河北博物院藏")

        self.assertEqual(from_artifact_provenance.id, canonical.id)
        self.assertEqual(from_artifact_provenance.name, "河北博物院")

    def test_gallery_read_merges_old_venue_and_museum_duplicates(self) -> None:
        with self.catalog_session_factory() as catalog_db:
            catalog_db.add(
                CatalogExhibition(
                    source_id="shanghai-civilization",
                    source_url="https://example.com/shanghai-civilization",
                    title="文明展",
                    region="中国大陆",
                    city="上海",
                    city_slug="shanghai",
                    museum_name="上海博物馆",
                    venue="第一展览厅",
                    is_permanent=False,
                )
            )
            catalog_db.commit()

        now = datetime.now(timezone.utc)
        artifact = ArtifactRead(
            id=1,
            museum_id=1,
            museum_name="上海博物馆",
            name="测试文物",
            created_at=now,
            exhibitions=[
                ExhibitionRead(
                    id=10,
                    museum_id=10,
                    museum_name="第一展览厅",
                    name="文明展",
                    created_at=now,
                ),
                ExhibitionRead(
                    id=11,
                    museum_id=11,
                    museum_name="上海博物馆",
                    name="文明展",
                    created_at=now,
                ),
            ],
        )

        with patch("app.main.ExhibitionSessionLocal", self.catalog_session_factory):
            enriched = enrich_artifact_catalog_links([artifact])

        self.assertEqual(len(enriched[0].exhibitions), 1)
        self.assertEqual(enriched[0].exhibitions[0].museum_name, "上海博物馆")
        self.assertEqual(
            enriched[0].exhibitions[0].catalog_source_id,
            "shanghai-civilization",
        )


if __name__ == "__main__":
    unittest.main()
