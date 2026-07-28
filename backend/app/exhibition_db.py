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
        # Earlier imports left `museum_name` empty when iMuseum supplied only
        # `展厅`. On those pages the sole location is the institution itself;
        # preserve `venue` as source detail while filling the canonical museum
        # field used by the catalog, timeline and recommendations.
        venue_as_museum_sql = (
            "TRIM(SPLIT_PART(venue, '（', 1))"
            if connection.dialect.name == "postgresql"
            else "TRIM(CASE WHEN INSTR(venue, '（') > 0 "
            "THEN SUBSTR(venue, 1, INSTR(venue, '（') - 1) ELSE venue END)"
        )
        connection.execute(
            text(
                "UPDATE catalog_exhibitions "
                f"SET museum_name = {venue_as_museum_sql} "
                "WHERE (museum_name IS NULL OR TRIM(museum_name) = '') "
                "AND venue IS NOT NULL AND TRIM(venue) <> ''"
            )
        )
        # Apply the same normalization to records repaired by an earlier
        # version of this migration, where the fallback was copied verbatim.
        connection.execute(
            text(
                "UPDATE catalog_exhibitions "
                f"SET museum_name = {venue_as_museum_sql} "
                "WHERE museum_name = venue AND venue LIKE '%（%'"
            )
        )
