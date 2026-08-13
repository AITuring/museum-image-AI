import asyncio
import logging
from collections import OrderedDict
from collections.abc import Callable

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

logger = logging.getLogger("app.vision")

MAP_TILE_CACHE_MAX_ITEMS = 512


def create_map_tile_router(
    *,
    get_http_client: Callable[[], httpx.AsyncClient | None],
) -> tuple[
    APIRouter,
    Callable[[int, int, int], object],
    OrderedDict[tuple[int, int, int], bytes],
]:
    """Build the bounded AMap proxy and expose its handler/cache for compatibility."""
    router = APIRouter()
    cache: OrderedDict[tuple[int, int, int], bytes] = OrderedDict()
    fetch_semaphore = asyncio.Semaphore(8)

    @router.get("/map-tiles/{zoom}/{x}/{y}.png", include_in_schema=False)
    async def map_tile(zoom: int, x: int, y: int) -> Response:
        """Proxy a bounded official AMap raster tile when direct tile hosts fail."""
        if zoom < 3 or zoom > 20:
            raise HTTPException(status_code=404, detail="Map tile not found")
        tile_count = 1 << zoom
        if y < 0 or y >= tile_count:
            raise HTTPException(status_code=404, detail="Map tile not found")
        normalized_x = x % tile_count
        cache_key = (zoom, normalized_x, y)
        cached = cache.get(cache_key)
        if cached is not None:
            cache.move_to_end(cache_key)
            return Response(
                content=cached,
                media_type="image/png",
                headers={"Cache-Control": "public, max-age=604800, immutable"},
            )

        params = {
            "x": normalized_x,
            "y": y,
            "z": zoom,
            "size": 1,
            "scl": 1,
            "style": 7,
        }
        first_host_number = (normalized_x + y + zoom) % 4 + 1
        content: bytes | None = None
        last_error: Exception | None = None
        for host_offset in range(4):
            host_number = (first_host_number + host_offset - 1) % 4 + 1
            upstream_url = f"https://wprd0{host_number}.is.autonavi.com/appmaptile"
            try:
                async with fetch_semaphore:
                    client = get_http_client()
                    if client is not None:
                        upstream = await client.get(
                            upstream_url,
                            params=params,
                            timeout=6,
                        )
                    else:
                        async with httpx.AsyncClient(timeout=6) as fallback_client:
                            upstream = await fallback_client.get(
                                upstream_url,
                                params=params,
                            )
                upstream.raise_for_status()
            except (httpx.RequestError, httpx.HTTPStatusError) as exc:
                last_error = exc
                continue

            candidate = upstream.content
            if len(candidate) > 512 * 1024 or not candidate.startswith(
                b"\x89PNG\r\n\x1a\n"
            ):
                last_error = ValueError("invalid map tile response")
                continue
            content = candidate
            break

        if content is None:
            logger.warning(
                "map tile fetch failed across all hosts for %s/%s/%s: %s",
                zoom,
                normalized_x,
                y,
                last_error,
            )
            raise HTTPException(
                status_code=502,
                detail="Map tile is temporarily unavailable",
            ) from last_error

        cache[cache_key] = content
        cache.move_to_end(cache_key)
        while len(cache) > MAP_TILE_CACHE_MAX_ITEMS:
            cache.popitem(last=False)
        return Response(
            content=content,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=604800, immutable"},
        )

    return router, map_tile, cache
