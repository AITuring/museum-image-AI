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
