import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from app import main


class _MapTileClient:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.calls = 0

    async def get(self, url: str, *, params: dict[str, int], timeout: int) -> httpx.Response:
        self.calls += 1
        request = httpx.Request("GET", url, params=params)
        return httpx.Response(200, content=self.payload, request=request)


class _TransientMapTileClient(_MapTileClient):
    def __init__(self, payload: bytes) -> None:
        super().__init__(payload)
        self.urls: list[str] = []

    async def get(self, url: str, *, params: dict[str, int], timeout: int) -> httpx.Response:
        self.calls += 1
        self.urls.append(url)
        request = httpx.Request("GET", url, params=params)
        if self.calls == 1:
            raise httpx.ConnectError("transient tile host failure", request=request)
        return httpx.Response(200, content=self.payload, request=request)


class MapTileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        main.MAP_TILE_CACHE.clear()

    async def test_proxy_validates_and_caches_official_png_tile(self) -> None:
        client = _MapTileClient(b"\x89PNG\r\n\x1a\nmap-tile")
        with patch.object(main, "cloud_http_client", client):
            first = await main.map_tile(13, 6656, 3165)
            second = await main.map_tile(13, 6656, 3165)

        self.assertEqual(first.body, client.payload)
        self.assertEqual(second.body, client.payload)
        self.assertEqual(client.calls, 1)
        self.assertEqual(first.media_type, "image/png")
        self.assertIn("immutable", first.headers["cache-control"])

    async def test_proxy_rejects_out_of_range_tile_without_network(self) -> None:
        client = _MapTileClient(b"\x89PNG\r\n\x1a\nmap-tile")
        with (
            patch.object(main, "cloud_http_client", client),
            self.assertRaises(HTTPException) as raised,
        ):
            await main.map_tile(2, 0, 0)

        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(client.calls, 0)

    async def test_proxy_rejects_non_png_upstream_payload(self) -> None:
        client = _MapTileClient(b"not-an-image")
        with (
            patch.object(main, "cloud_http_client", client),
            self.assertRaises(HTTPException) as raised,
        ):
            await main.map_tile(13, 6656, 3165)

        self.assertEqual(raised.exception.status_code, 502)

    async def test_proxy_retries_another_official_host_after_transient_failure(self) -> None:
        client = _TransientMapTileClient(b"\x89PNG\r\n\x1a\nmap-tile")
        with patch.object(main, "cloud_http_client", client):
            response = await main.map_tile(13, 6656, 3165)

        self.assertEqual(response.body, client.payload)
        self.assertEqual(client.calls, 2)
        self.assertNotEqual(client.urls[0], client.urls[1])


if __name__ == "__main__":
    unittest.main()
