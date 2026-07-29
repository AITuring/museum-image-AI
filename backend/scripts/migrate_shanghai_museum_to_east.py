#!/usr/bin/env python3
"""Move legacy Shanghai Museum artifacts to the East Hall without data loss.

Run inside the backend container so the local API can proxy its Gallery edits
to cloud when APP_ROLE=local:

    docker compose exec -T backend python scripts/migrate_shanghai_museum_to_east.py
"""

from __future__ import annotations

import os

import httpx


API_BASE_URL = os.environ.get("MUSEUM_API_BASE_URL", "http://localhost:8000/api").rstrip("/")
SOURCE_MUSEUM_NAME = "上海博物馆"
TARGET_MUSEUM_NAME = "上海博物馆东馆"


def image_for_artifact(artifact: dict) -> dict:
    images = artifact.get("images") or []
    if not images:
        raise ValueError(f"文物 {artifact['id']} 没有图片，已停止迁移。")
    return next(
        (image for image in images if image.get("artifact_id") == artifact["id"]),
        images[0],
    )


def update_payload(artifact: dict, image: dict) -> dict:
    return {
        "museum_name": TARGET_MUSEUM_NAME,
        "name": artifact["name"],
        "era": artifact.get("era"),
        "Place_of_Excavation": artifact.get("Place_of_Excavation"),
        "description": artifact.get("description"),
        "tags": artifact.get("tags") or [],
        "image_id": image["id"],
        "camera_model": image.get("camera_model"),
        "lens_model": image.get("lens_model"),
        "capture_museum_name": TARGET_MUSEUM_NAME,
        "exhibition_name": image.get("exhibition_name") or "常设",
        "catalog_exhibition_source_id": image.get("catalog_exhibition_source_id"),
        "catalog_exhibition_id": image.get("catalog_exhibition_id"),
        "capture_location": image.get("capture_location"),
        "latitude": image.get("latitude"),
        "longitude": image.get("longitude"),
        "captured_at": image.get("captured_at"),
        "shutter_speed": image.get("shutter_speed"),
        "aperture": image.get("aperture"),
        "iso": image.get("iso"),
        "edit_method": image.get("edit_method"),
    }


def main() -> None:
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        response = client.get(
            f"{API_BASE_URL}/artifacts",
            params={"q": SOURCE_MUSEUM_NAME},
        )
        response.raise_for_status()
        targets = [
            artifact
            for artifact in response.json()
            if artifact.get("museum_name") == SOURCE_MUSEUM_NAME
        ]
        if not targets:
            print("没有需要迁移的“上海博物馆”文物。")
            return

        for artifact in targets:
            updated = client.patch(
                f"{API_BASE_URL}/artifacts/{artifact['id']}",
                json=update_payload(artifact, image_for_artifact(artifact)),
            )
            updated.raise_for_status()
            payload = updated.json()
            print(f"{payload['id']}\t{payload['name']}\t{payload['museum_name']}")


if __name__ == "__main__":
    main()
