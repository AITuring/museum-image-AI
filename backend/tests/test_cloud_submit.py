import asyncio
import unittest
from io import BytesIO
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import HTTPException, Request, Response

from app import main
from app.services.cloud_submission import should_bypass_environment_proxy


class RecordingCloudClient:
    def __init__(self, status_code: int = 422) -> None:
        self.data: dict[str, str] | None = None
        self.headers: dict[str, str] | None = None
        self.post_count = 0
        self.status_code = status_code

    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        self.post_count += 1
        self.data = kwargs["data"]  # type: ignore[assignment]
        self.headers = kwargs["headers"]  # type: ignore[assignment]
        return httpx.Response(
            self.status_code,
            json={"detail": "stop after recording request"},
            request=httpx.Request("POST", url),
        )


def artifact_payload(artifact_id: int = 7) -> dict[str, object]:
    return {
        "id": artifact_id,
        "museum_id": 3,
        "name": "测试文物",
        "era": None,
        "Place_of_Excavation": None,
        "description": None,
        "created_at": "2026-08-13T00:00:00Z",
        "museum_name": "测试博物馆",
        "tags": [],
        "images": [],
        "exhibitions": [],
    }


class TransientThenSuccessClient(RecordingCloudClient):
    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        self.post_count += 1
        self.data = kwargs["data"]  # type: ignore[assignment]
        self.headers = kwargs["headers"]  # type: ignore[assignment]
        status_code = 503 if self.post_count == 1 else 201
        payload = {"detail": "temporarily unavailable"} if status_code == 503 else artifact_payload()
        return httpx.Response(
            status_code,
            json=payload,
            request=httpx.Request("POST", url),
        )


class LostResponseThenReconciledClient(RecordingCloudClient):
    def __init__(self) -> None:
        super().__init__()
        self.get_count = 0

    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        self.post_count += 1
        self.headers = kwargs["headers"]  # type: ignore[assignment]
        raise httpx.ReadTimeout("response was lost", request=httpx.Request("POST", url))

    async def get(self, url: str, **kwargs: object) -> httpx.Response:
        self.get_count += 1
        payload: dict[str, object]
        if url.endswith("/artifact-images/by-source-hash"):
            payload = {"artifact_id": 7}
        else:
            payload = artifact_payload()
        return httpx.Response(200, json=payload, request=httpx.Request("GET", url))


class ConcurrentCloudClient(RecordingCloudClient):
    def __init__(self) -> None:
        super().__init__(status_code=201)
        self.active_requests = 0
        self.max_active_requests = 0

    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        self.active_requests += 1
        self.max_active_requests = max(
            self.max_active_requests,
            self.active_requests,
        )
        try:
            await asyncio.sleep(0.01)
            return httpx.Response(
                201,
                json=artifact_payload(),
                request=httpx.Request("POST", url),
            )
        finally:
            self.active_requests -= 1


class CloudSubmitFormTests(unittest.IsolatedAsyncioTestCase):
    def test_direct_ip_cloud_endpoint_bypasses_environment_proxy(self) -> None:
        self.assertTrue(should_bypass_environment_proxy("http://123.57.34.90:8000"))
        self.assertTrue(should_bypass_environment_proxy("http://localhost:8000"))
        self.assertFalse(should_bypass_environment_proxy("https://cloud.example"))

    async def submit(self, client: RecordingCloudClient, **overrides: object):
        arguments: dict[str, object] = {
            "image_bytes": b"image",
            "image_name": "test.jpg",
            "content_type": "image/jpeg",
            "museum_name": "测试博物馆",
            "name": "测试文物",
            "era": None,
            "Place_of_Excavation": None,
            "description": None,
            "existing_artifact_id": None,
            "skip_existing_match": False,
            "tags": [],
            "camera_model": None,
            "lens_model": None,
            "capture_museum_name": None,
            "exhibition_name": None,
            "capture_location": None,
            "latitude": None,
            "longitude": None,
            "captured_at": None,
            "shutter_speed": None,
            "aperture": None,
            "iso": None,
            "edit_method": None,
        }
        arguments.update(overrides)
        with (
            patch.object(main.settings, "cloud_api_base_url", "https://cloud.example"),
            patch.object(main.settings, "ingest_token", "test-token"),
            patch.object(main, "cloud_http_client", client),
        ):
            return await main.submit_artifact_to_cloud(**arguments)  # type: ignore[arg-type]

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
                await self.submit(
                    client,
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
        self.assertEqual(client.post_count, 1)

    async def test_retries_transient_status_once_and_propagates_request_id(self) -> None:
        client = TransientThenSuccessClient()
        request_id_token = main.current_request_id.set("request-test-123")
        try:
            with patch.object(main.asyncio, "sleep", new=AsyncMock()) as sleep:
                result = await self.submit(client)
        finally:
            main.current_request_id.reset(request_id_token)

        self.assertEqual(result.id, 7)
        self.assertEqual(client.post_count, 2)
        self.assertEqual(client.headers["X-Request-ID"], "request-test-123")  # type: ignore[index]
        sleep.assert_awaited_once()

    async def test_reconciles_lost_response_before_reuploading(self) -> None:
        client = LostResponseThenReconciledClient()
        result = await self.submit(client, source_hash="a" * 64)

        self.assertEqual(result.id, 7)
        self.assertEqual(client.post_count, 1)
        self.assertEqual(client.get_count, 2)

    async def test_local_cloud_submissions_are_serialized(self) -> None:
        client = ConcurrentCloudClient()
        arguments: dict[str, object] = {
            "image_bytes": b"image",
            "image_name": "test.jpg",
            "content_type": "image/jpeg",
            "museum_name": "测试博物馆",
            "name": "测试文物",
            "era": None,
            "Place_of_Excavation": None,
            "description": None,
            "existing_artifact_id": None,
            "skip_existing_match": False,
            "tags": [],
            "camera_model": None,
            "lens_model": None,
            "capture_museum_name": None,
            "exhibition_name": None,
            "capture_location": None,
            "latitude": None,
            "longitude": None,
            "captured_at": None,
            "shutter_speed": None,
            "aperture": None,
            "iso": None,
            "edit_method": None,
        }
        with (
            patch.object(main.settings, "cloud_api_base_url", "https://cloud.example"),
            patch.object(main.settings, "ingest_token", "test-token"),
            patch.object(main, "cloud_http_client", client),
        ):
            results = await asyncio.gather(
                main.submit_artifact_to_cloud(**arguments),  # type: ignore[arg-type]
                main.submit_artifact_to_cloud(**arguments),  # type: ignore[arg-type]
            )

        self.assertEqual([result.id for result in results], [7, 7])
        self.assertEqual(client.max_active_requests, 1)

    def test_cloud_ingest_guard_rejects_overlapping_work(self) -> None:
        active_slot = main.reserve_cloud_ingest_slot()
        next(active_slot)
        try:
            overlapping_slot = main.reserve_cloud_ingest_slot()
            with self.assertRaises(HTTPException) as raised:
                next(overlapping_slot)
        finally:
            active_slot.close()

        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(raised.exception.headers, {"Retry-After": "2"})

    def test_source_hash_is_normalized_and_invalid_values_are_rejected(self) -> None:
        self.assertEqual(main.normalize_source_hash("  " + "A" * 64 + "  "), "a" * 64)
        self.assertIsNone(main.normalize_source_hash(""))

        with self.assertRaises(HTTPException) as raised:
            main.normalize_source_hash("not-a-sha256")

        self.assertEqual(raised.exception.status_code, 400)

    def test_oversized_ingest_is_rejected_before_cloud_processing(self) -> None:
        with patch.object(main, "MAX_IMAGE_SOURCE_BYTES", 4):
            with self.assertRaises(HTTPException) as raised:
                main.read_bounded_upload(BytesIO(b"12345"))

        self.assertEqual(raised.exception.status_code, 413)

    def test_cloud_health_checks_database_configuration_and_revision(self) -> None:
        connection_context = MagicMock()
        with (
            patch.object(main.engine, "connect", return_value=connection_context),
            patch.object(main.settings, "app_role", "cloud"),
            patch.object(main.settings, "app_revision", "revision-123"),
            patch.object(main.settings, "ingest_token", "test-token"),
            patch.object(main, "oss_configured", return_value=True),
        ):
            result = main.healthcheck()

        connection_context.__enter__.return_value.execute.assert_called_once()
        self.assertEqual(result.revision, "revision-123")
        self.assertEqual(result.ingest, "ready")

    def test_cloud_health_rejects_incomplete_ingest_configuration(self) -> None:
        connection_context = MagicMock()
        with (
            patch.object(main.engine, "connect", return_value=connection_context),
            patch.object(main.settings, "app_role", "cloud"),
            patch.object(main.settings, "ingest_token", ""),
            patch.object(main, "oss_configured", return_value=True),
        ):
            with self.assertRaises(HTTPException) as raised:
                main.healthcheck()

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.headers["X-Error-Code"], "cloud_ingest_not_ready")

    def test_health_rejects_database_failure(self) -> None:
        with patch.object(main.engine, "connect", side_effect=RuntimeError("database down")):
            with self.assertRaises(HTTPException) as raised:
                main.healthcheck()

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.headers["X-Error-Code"], "database_unavailable")

    async def test_request_id_is_available_during_request_and_returned(self) -> None:
        request = Request(
            {
                "type": "http",
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/api/probe",
                "raw_path": b"/api/probe",
                "query_string": b"",
                "headers": [(b"x-request-id", b"request-from-client")],
                "client": ("127.0.0.1", 1234),
                "server": ("testserver", 80),
                "root_path": "",
            }
        )

        async def call_next(_: Request) -> Response:
            self.assertEqual(main.current_request_id.get(), "request-from-client")
            return Response(status_code=502)

        with patch.object(main.settings, "app_revision", "revision-test"):
            response = await main.add_request_observability(request, call_next)
        self.assertEqual(response.headers["X-Request-ID"], "request-from-client")
        self.assertEqual(response.headers["X-App-Revision"], "revision-test")
        self.assertIsNone(main.current_request_id.get())


if __name__ == "__main__":
    unittest.main()
