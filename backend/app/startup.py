import mimetypes
from pathlib import Path

from sqlalchemy import inspect, text

from app.reference_data import (
    WENWU_ERA_OPTIONS,
    WENWU_MUSEUM_COORDINATES,
    WENWU_MUSEUM_OPTIONS,
)


def run_startup_migrations(
    connection,
    *,
    legacy_batch_imports_dir: Path,
) -> None:
    inspector = inspect(connection)
    table_names = set(inspector.get_table_names())

    if "museums" in table_names:
        museum_columns = {column["name"] for column in inspector.get_columns("museums")}
        museum_column_definitions = {
            "latitude": "DOUBLE PRECISION",
            "longitude": "DOUBLE PRECISION",
        }
        for column_name, column_type in museum_column_definitions.items():
            if column_name not in museum_columns:
                connection.execute(
                    text(f"ALTER TABLE museums ADD COLUMN {column_name} {column_type}")
                )

    if "artifacts" not in table_names:
        return

    if "exhibitions" in table_names:
        exhibition_columns = {
            column["name"] for column in inspect(connection).get_columns("exhibitions")
        }
        exhibition_column_definitions = {
            "catalog_source_id": "VARCHAR(32)",
            "catalog_exhibition_id": "INTEGER",
        }
        for column_name, column_type in exhibition_column_definitions.items():
            if column_name not in exhibition_columns:
                connection.execute(
                    text(
                        f"ALTER TABLE exhibitions ADD COLUMN {column_name} {column_type}"
                    )
                )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_exhibitions_catalog_source_id "
                "ON exhibitions (catalog_source_id)"
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_exhibitions_catalog_exhibition_id "
                "ON exhibitions (catalog_exhibition_id)"
            )
        )

    artifact_columns = {column["name"] for column in inspector.get_columns("artifacts")}
    artifact_columns_lower = {column_name.lower() for column_name in artifact_columns}

    if "title" in artifact_columns and "name" not in artifact_columns:
        connection.execute(text("ALTER TABLE artifacts RENAME COLUMN title TO name"))
        artifact_columns.remove("title")
        artifact_columns.add("name")

    if "summary" in artifact_columns and "description" not in artifact_columns:
        connection.execute(
            text("ALTER TABLE artifacts RENAME COLUMN summary TO description")
        )
        artifact_columns.remove("summary")
        artifact_columns.add("description")

    if "name" not in artifact_columns:
        connection.execute(text("ALTER TABLE artifacts ADD COLUMN name VARCHAR(255)"))
        if "title" in artifact_columns:
            connection.execute(
                text("UPDATE artifacts SET name = title WHERE name IS NULL")
            )

    if "era" not in artifact_columns:
        connection.execute(text("ALTER TABLE artifacts ADD COLUMN era VARCHAR(255)"))

    if "description" not in artifact_columns:
        connection.execute(text("ALTER TABLE artifacts ADD COLUMN description TEXT"))
        if "summary" in artifact_columns:
            connection.execute(
                text(
                    "UPDATE artifacts SET description = summary WHERE description IS NULL"
                )
            )

    if (
        "unearthed_place" in artifact_columns_lower
        and "place_of_excavation" not in artifact_columns_lower
    ):
        connection.execute(
            text(
                'ALTER TABLE artifacts RENAME COLUMN unearthed_place TO "Place_of_Excavation"'
            )
        )
        artifact_columns.remove("unearthed_place")
        artifact_columns.add("Place_of_Excavation")
        artifact_columns_lower.remove("unearthed_place")
        artifact_columns_lower.add("place_of_excavation")

    if "place_of_excavation" not in artifact_columns_lower:
        connection.execute(
            text('ALTER TABLE artifacts ADD COLUMN "Place_of_Excavation" VARCHAR(255)')
        )
        artifact_columns.add("Place_of_Excavation")
        artifact_columns_lower.add("place_of_excavation")

    # PostgreSQL folds an unquoted name to lower case.  Older local databases
    # therefore contain ``place_of_excavation``, while the ORM deliberately
    # keeps the public field spelling ``Place_of_Excavation``.  Seeing the
    # column case-insensitively is not enough: the ORM emits a quoted name.
    legacy_place_column = next(
        (
            column_name
            for column_name in artifact_columns
            if column_name.lower() == "place_of_excavation"
            and column_name != "Place_of_Excavation"
        ),
        None,
    )
    if legacy_place_column is not None:
        escaped_column = legacy_place_column.replace('"', '""')
        connection.execute(
            text(
                f'ALTER TABLE artifacts RENAME COLUMN "{escaped_column}" TO "Place_of_Excavation"'
            )
        )
        artifact_columns.remove(legacy_place_column)
        artifact_columns.add("Place_of_Excavation")

    if "unearthed_at" in artifact_columns_lower:
        connection.execute(
            text(
                """
                UPDATE artifacts
                SET "Place_of_Excavation" = unearthed_at
                WHERE "Place_of_Excavation" IS NULL
                  AND unearthed_at IS NOT NULL
                """
            )
        )

    refreshed_columns = {
        column["name"] for column in inspect(connection).get_columns("artifacts")
    }
    if "image_path" in refreshed_columns and "artifact_images" in set(
        inspect(connection).get_table_names()
    ):
        connection.execute(
            text(
                """
                INSERT INTO artifact_images (artifact_id, url)
                SELECT artifacts.id, artifacts.image_path
                FROM artifacts
                WHERE artifacts.image_path IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM artifact_images
                    WHERE artifact_images.artifact_id = artifacts.id
                      AND artifact_images.url = artifacts.image_path
                  )
                """
            )
        )

    if "artifact_images" not in table_names:
        return

    artifact_image_columns = {
        column["name"] for column in inspect(connection).get_columns("artifact_images")
    }
    image_column_definitions = {
        "image_hash": "VARCHAR(64)",
        "source_hash": "VARCHAR(64)",
        "content_hash": "VARCHAR(64)",
        "camera_model": "VARCHAR(255)",
        "lens_model": "VARCHAR(255)",
        "capture_museum_id": "INTEGER",
        "exhibition_id": "INTEGER",
        "capture_location": "VARCHAR(255)",
        "latitude": "DOUBLE PRECISION",
        "longitude": "DOUBLE PRECISION",
        "captured_at": "TIMESTAMP",
        "shutter_speed": "VARCHAR(64)",
        "aperture": "VARCHAR(64)",
        "iso": "INTEGER",
        "edit_method": "VARCHAR(32)",
    }
    for column_name, column_type in image_column_definitions.items():
        if column_name not in artifact_image_columns:
            connection.execute(
                text(
                    f"ALTER TABLE artifact_images ADD COLUMN {column_name} {column_type}"
                )
            )
    connection.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_images_image_hash "
            "ON artifact_images (image_hash)"
        )
    )
    connection.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_images_source_hash "
            "ON artifact_images (source_hash)"
        )
    )
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_artifact_images_content_hash "
            "ON artifact_images (content_hash)"
        )
    )
    # Historical image hashing is intentionally not a startup migration.
    # Downloading and decoding every legacy OSS object here used to hold this
    # transaction open for hours, preventing even /health from becoming ready.
    # New uploads populate all hashes during ingest; legacy backfill belongs in
    # an explicit, resumable maintenance job.

    if "pending_artifacts" not in table_names:
        return

    pending_columns = {
        column["name"]
        for column in inspect(connection).get_columns("pending_artifacts")
    }
    pending_columns_lower = {column_name.lower() for column_name in pending_columns}
    pending_column_definitions = {
        "image_blob": "BYTEA",
        "image_mime_type": "VARCHAR(128)",
        "camera_model": "VARCHAR(255)",
        "lens_model": "VARCHAR(255)",
        "Place_of_Excavation": "VARCHAR(255)",
        "capture_museum_name": "VARCHAR(255)",
        "exhibition_name": "VARCHAR(255)",
        "capture_location": "VARCHAR(255)",
        "latitude": "DOUBLE PRECISION",
        "longitude": "DOUBLE PRECISION",
        "captured_at": "TIMESTAMP",
        "shutter_speed": "VARCHAR(64)",
        "aperture": "VARCHAR(64)",
        "iso": "INTEGER",
        "edit_method": "VARCHAR(32)",
        "existing_artifact_id": "INTEGER",
    }
    for column_name, column_type in pending_column_definitions.items():
        if column_name.lower() not in pending_columns_lower:
            connection.execute(
                text(
                    f'ALTER TABLE pending_artifacts ADD COLUMN "{column_name}" {column_type}'
                )
            )
            pending_columns.add(column_name)
            pending_columns_lower.add(column_name.lower())

    legacy_pending_place_column = next(
        (
            column_name
            for column_name in pending_columns
            if column_name.lower() == "place_of_excavation"
            and column_name != "Place_of_Excavation"
        ),
        None,
    )
    if legacy_pending_place_column is not None:
        escaped_column = legacy_pending_place_column.replace('"', '""')
        connection.execute(
            text(
                f'ALTER TABLE pending_artifacts RENAME COLUMN "{escaped_column}" '
                'TO "Place_of_Excavation"'
            )
        )
        pending_columns.remove(legacy_pending_place_column)
        pending_columns.add("Place_of_Excavation")

    if (
        "unearthed_at" in pending_columns_lower
        and "place_of_excavation" in pending_columns_lower
    ):
        connection.execute(
            text(
                """
                UPDATE pending_artifacts
                SET "Place_of_Excavation" = unearthed_at
                WHERE "Place_of_Excavation" IS NULL
                  AND unearthed_at IS NOT NULL
                """
            )
        )

    legacy_rows = connection.execute(
        text(
            """
            SELECT id, source_path, file_name
            FROM pending_artifacts
            WHERE image_blob IS NULL
              AND source_path LIKE :prefix
            """
        ),
        {"prefix": f"{legacy_batch_imports_dir}%"},
    ).mappings()
    for row in legacy_rows:
        path = Path(row["source_path"])
        if not path.exists() or not path.is_file():
            continue
        mime_type = mimetypes.guess_type(row["file_name"])[0] or "image/jpeg"
        connection.execute(
            text(
                """
                UPDATE pending_artifacts
                SET image_blob = :image_blob,
                    image_mime_type = :image_mime_type,
                    source_path = :source_path
                WHERE id = :id
                """
            ),
            {
                "id": row["id"],
                "image_blob": path.read_bytes(),
                "image_mime_type": mime_type,
                "source_path": f"upload:{row['file_name']}",
            },
        )
        path.unlink(missing_ok=True)


def sync_reference_options(connection) -> None:
    # This is a controlled vocabulary label, not operator-entered artifact
    # metadata.  Keep the chooser on the complete historical term.
    connection.execute(
        text(
            """
            UPDATE era_options
            SET name = '五代十国'
            WHERE name = '五代'
              AND NOT EXISTS (SELECT 1 FROM era_options WHERE name = '五代十国')
            """
        )
    )
    for museum_name in WENWU_MUSEUM_OPTIONS:
        longitude, latitude = WENWU_MUSEUM_COORDINATES.get(museum_name, (None, None))
        connection.execute(
            text(
                """
                INSERT INTO museums (name, description, latitude, longitude)
                VALUES (:name, :description, :latitude, :longitude)
                ON CONFLICT (name) DO UPDATE
                SET latitude = CASE
                        WHEN museums.latitude IS NULL OR museums.longitude IS NULL THEN EXCLUDED.latitude
                        WHEN ABS(museums.latitude - :reversed_latitude) < 0.000001
                         AND ABS(museums.longitude - :reversed_longitude) < 0.000001 THEN EXCLUDED.latitude
                        ELSE museums.latitude
                    END,
                    longitude = CASE
                        WHEN museums.latitude IS NULL OR museums.longitude IS NULL THEN EXCLUDED.longitude
                        WHEN ABS(museums.latitude - :reversed_latitude) < 0.000001
                         AND ABS(museums.longitude - :reversed_longitude) < 0.000001 THEN EXCLUDED.longitude
                        ELSE museums.longitude
                    END
                """
            ),
            {
                "name": museum_name,
                "description": "从 wenwu.tsx 参考数据同步",
                "latitude": latitude,
                "longitude": longitude,
                "reversed_latitude": longitude,
                "reversed_longitude": latitude,
            },
        )

    for sort_order, era_name in enumerate(WENWU_ERA_OPTIONS, start=1):
        connection.execute(
            text(
                """
                INSERT INTO era_options (name, sort_order)
                VALUES (:name, :sort_order)
                ON CONFLICT (name) DO UPDATE
                SET sort_order = EXCLUDED.sort_order
                """
            ),
            {
                "name": era_name,
                "sort_order": sort_order,
            },
        )
