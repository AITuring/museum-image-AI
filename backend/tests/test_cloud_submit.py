import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from app import main


class RecordingCloudClient:
    def __init__(self, status_code: int = 422) -> None:
        self.data: dict[str, str] | None = None
        self.status_code = status_code

    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        self.data = kwargs["data"]  # type: ignore[assignment]
        return httpx.Response(
            self.status_code,
            json={"detail": "stop after recording request"},
            request=httpx.Request("POST", url),
        )


class CloudSubmitFormTests(unittest.IsolatedAsyncioTestCase):
    async def submit_with_catalog_exhibition_id(
        self,
        catalog_exhibition_id: int | None,
        client: RecordingCloudClient | None = None,
        expected_status: int | None = None,
    ) -> dict[str, str]:
        client = client or RecordingCloudClient()
        with (
            patch.object(main.settings, "cloud_api_base_url", "https://cloud.example"),
            patch.object(main.settings, "ingest_token", "test-token"),
            patch.object(main, "cloud_http_client", client),
        ):
            with self.assertRaises(HTTPException) as raised:
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
        if expected_status is not None:
            self.assertEqual(raised.exception.status_code, expected_status)
        self.assertIsNotNone(client.data)
        return client.data or {}

    async def test_omits_empty_catalog_exhibition_id(self) -> None:
        data = await self.submit_with_catalog_exhibition_id(None)
        self.assertNotIn("catalog_exhibition_id", data)

    async def test_serializes_selected_catalog_exhibition_id(self) -> None:
        data = await self.submit_with_catalog_exhibition_id(42)
        self.assertEqual(data["catalog_exhibition_id"], "42")

    async def test_missing_cloud_ingest_endpoint_is_explicit_upstream_error(self) -> None:
        client = RecordingCloudClient(status_code=404)
        await self.submit_with_catalog_exhibition_id(None, client=client, expected_status=502)


if __name__ == "__main__":
    unittest.main()
