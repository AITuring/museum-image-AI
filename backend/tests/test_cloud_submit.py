import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from app import main


class RecordingCloudClient:
    def __init__(self) -> None:
        self.data: dict[str, str] | None = None

    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        self.data = kwargs["data"]  # type: ignore[assignment]
        return httpx.Response(
            422,
            json={"detail": "stop after recording request"},
            request=httpx.Request("POST", url),
        )


class CloudSubmitFormTests(unittest.IsolatedAsyncioTestCase):
    async def submit_with_catalog_exhibition_id(
        self,
        catalog_exhibition_id: int | None,
    ) -> dict[str, str]:
        client = RecordingCloudClient()
        with (
            patch.object(main.settings, "cloud_api_base_url", "https://cloud.example"),
            patch.object(main.settings, "ingest_token", "test-token"),
            patch.object(main, "cloud_http_client", client),
        ):
            with self.assertRaises(HTTPException):
                await main.submit_artifact_to_cloud(
                    image_bytes=b"image",
                    image_name="test.jpg",
                    content_type="image/jpeg",
                    museum_name="测试博物馆",
                    name="测试文物",
                    era=None,
                    Place_of_Excavation=None,
                    description=None,
                    existing_artifact_id=None,
                    skip_existing_match=False,
                    tags=[],
                    camera_model=None,
                    lens_model=None,
                    capture_museum_name=None,
                    exhibition_name=None,
                    capture_location=None,
                    latitude=None,
                    longitude=None,
                    captured_at=None,
                    shutter_speed=None,
                    aperture=None,
                    iso=None,
                    edit_method=None,
                    catalog_exhibition_id=catalog_exhibition_id,
                )
        self.assertIsNotNone(client.data)
        return client.data or {}

    async def test_omits_empty_catalog_exhibition_id(self) -> None:
        data = await self.submit_with_catalog_exhibition_id(None)
        self.assertNotIn("catalog_exhibition_id", data)

    async def test_serializes_selected_catalog_exhibition_id(self) -> None:
        data = await self.submit_with_catalog_exhibition_id(42)
        self.assertEqual(data["catalog_exhibition_id"], "42")


if __name__ == "__main__":
    unittest.main()
