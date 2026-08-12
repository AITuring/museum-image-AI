import re
import unicodedata
from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class ExhibitionCatalogBase(DeclarativeBase):
    pass


exhibition_engine = create_engine(
    settings.exhibition_database_url,
    pool_pre_ping=True,
)
ExhibitionSessionLocal = sessionmaker(
    bind=exhibition_engine,
    autocommit=False,
    autoflush=False,
    class_=Session,
)


def get_exhibition_db() -> Generator[Session, None, None]:
    db = ExhibitionSessionLocal()
    try:
        yield db
    finally:
        db.close()


def _catalog_identity_key(value: object) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return re.sub(r"[\s·•・,，。．()（）\[\]【】<>《》\-—–_/]+", "", normalized)


def _repair_legacy_museum_names(connection) -> int:
    """Repair unsafe venue-as-museum rows without discarding venue detail.

    An earlier migration copied every non-empty ``venue`` into
    ``museum_name``. This made labels such as ``二层临展厅`` reappear at every
    startup. Recovery is deliberately conservative: use an explicit
    institution, a composite institution-plus-room label, an explicit
    permanent-display title, or one unique institution at the exact same
    address/city/region. Ambiguous room-only rows are reset to NULL for the
    sync worker instead of being presented as museums.
    """
    from app.exhibition_source import (
        institution_name_from_permanent_title,
        museum_name_from_source_fields,
    )

    rows = list(
        connection.execute(
            text(
                "SELECT id, museum_name, venue, title, address, city, region "
                "FROM catalog_exhibitions"
            )
        ).mappings()
    )

    def address_key(row) -> tuple[str, str, str] | None:
        address = _catalog_identity_key(row["address"])
        if not address:
            return None
        return (
            address,
            _catalog_identity_key(row["city"]),
            _catalog_identity_key(row["region"]),
        )

    direct_names: dict[int, str | None] = {}
    address_candidates: dict[tuple[str, str, str], dict[str, str]] = {}
    for row in rows:
        direct_name = museum_name_from_source_fields(
            row["museum_name"],
            row["venue"],
        )
        title_name = institution_name_from_permanent_title(row["title"])
        direct_names[int(row["id"])] = direct_name or title_name
        key = address_key(row)
        if key is None:
            continue
        for candidate in (direct_name, title_name):
            candidate_key = _catalog_identity_key(candidate)
            if candidate and candidate_key:
                address_candidates.setdefault(key, {})[candidate_key] = candidate

    address_institutions = {
        key: next(iter(candidates.values()))
        for key, candidates in address_candidates.items()
        if len(candidates) == 1
    }

    repaired = 0
    update_statement = text(
        "UPDATE catalog_exhibitions SET museum_name = :museum_name WHERE id = :id"
    )
    for row in rows:
        row_id = int(row["id"])
        desired = direct_names[row_id]
        key = address_key(row)
        if desired is None and key is not None:
            desired = address_institutions.get(key)
        current = str(row["museum_name"] or "").strip() or None
        if current == desired:
            continue
        connection.execute(
            update_statement,
            {"id": row_id, "museum_name": desired},
        )
        repaired += 1
    return repaired


def initialize_exhibition_database() -> None:
    # Import registers the catalog tables on the separate metadata.
    from app import exhibition_models  # noqa: F401

    with exhibition_engine.begin() as connection:
        ExhibitionCatalogBase.metadata.create_all(bind=connection)
        columns = {
            column["name"]
            for column in inspect(connection).get_columns("catalog_exhibitions")
        }
        if connection.dialect.name == "postgresql":
            connection.execute(
                text(
                    "ALTER TABLE catalog_exhibitions "
                    "ADD COLUMN IF NOT EXISTS museum_name VARCHAR(500)"
                )
            )
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS "
                    "ix_catalog_exhibitions_museum_name "
                    "ON catalog_exhibitions (museum_name)"
                )
            )
        elif "museum_name" not in columns:
            connection.execute(
                text(
                    "ALTER TABLE catalog_exhibitions "
                    "ADD COLUMN museum_name VARCHAR(500)"
                )
            )
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS "
                    "ix_catalog_exhibitions_museum_name "
                    "ON catalog_exhibitions (museum_name)"
                )
            )
        if "description" not in columns:
            connection.execute(
                text("ALTER TABLE catalog_exhibitions ADD COLUMN description TEXT")
            )
        if "image_urls" not in columns:
            if connection.dialect.name == "postgresql":
                connection.execute(
                    text(
                        "ALTER TABLE catalog_exhibitions "
                        "ADD COLUMN image_urls JSONB NOT NULL DEFAULT '[]'::jsonb"
                    )
                )
            else:
                connection.execute(
                    text(
                        "ALTER TABLE catalog_exhibitions "
                        "ADD COLUMN image_urls JSON NOT NULL DEFAULT '[]'"
                    )
                )
        _repair_legacy_museum_names(connection)
