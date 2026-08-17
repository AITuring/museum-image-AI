from __future__ import annotations

import logging
import threading
import time as time_module

import httpx

from app.config import settings

logger = logging.getLogger("app.cloud_query")

CLOUD_QUERY_TIMEOUT_SECONDS = 8
CLOUD_SOURCE_HASH_TIMEOUT_SECONDS = 3
CLOUD_QUERY_CIRCUIT_COOLDOWN_SECONDS = 45
CLOUD_QUERY_CIRCUIT_LOCK = threading.Lock()
CLOUD_QUERY_CIRCUIT_OPEN_UNTIL = 0.0


def should_proxy_artifact_queries_to_cloud() -> bool:
    if settings.app_role != "local" or not settings.cloud_api_base_url:
        return False
    with CLOUD_QUERY_CIRCUIT_LOCK:
        return CLOUD_QUERY_CIRCUIT_OPEN_UNTIL <= time_module.monotonic()


def mark_cloud_query_failure(context: str) -> None:
    """Temporarily stop optional cloud reads after an upstream outage."""
    global CLOUD_QUERY_CIRCUIT_OPEN_UNTIL
    now = time_module.monotonic()
    with CLOUD_QUERY_CIRCUIT_LOCK:
        was_open = CLOUD_QUERY_CIRCUIT_OPEN_UNTIL > now
        CLOUD_QUERY_CIRCUIT_OPEN_UNTIL = now + CLOUD_QUERY_CIRCUIT_COOLDOWN_SECONDS
    if not was_open:
        logger.warning(
            "云端图库查询暂不可用（%s），接下来 %ss 使用本地数据",
            context,
            CLOUD_QUERY_CIRCUIT_COOLDOWN_SECONDS,
        )


def mark_cloud_query_success() -> None:
    global CLOUD_QUERY_CIRCUIT_OPEN_UNTIL
    with CLOUD_QUERY_CIRCUIT_LOCK:
        if CLOUD_QUERY_CIRCUIT_OPEN_UNTIL <= time_module.monotonic():
            CLOUD_QUERY_CIRCUIT_OPEN_UNTIL = 0.0


def fetch_cloud_artifact_payload(
    params: dict[str, object] | None = None,
) -> list[dict]:
    base = settings.cloud_api_base_url.rstrip("/")
    last_error: Exception | None = None
    with httpx.Client(
        timeout=CLOUD_QUERY_TIMEOUT_SECONDS,
        follow_redirects=True,
    ) as client:
        for attempt in range(2):
            try:
                response = client.get(
                    f"{base}{settings.api_prefix}/artifacts",
                    params=params,
                )
                if response.status_code in {502, 503, 504} and attempt == 0:
                    continue
                response.raise_for_status()
                payload = response.json()
                mark_cloud_query_success()
                return payload if isinstance(payload, list) else []
            except (httpx.RequestError, httpx.HTTPStatusError) as exc:
                last_error = exc
                if attempt == 0 and (
                    isinstance(exc, httpx.RequestError)
                    or (
                        isinstance(exc, httpx.HTTPStatusError)
                        and exc.response.status_code in {502, 503, 504}
                    )
                ):
                    continue
                mark_cloud_query_failure("图库列表")
                raise
    if last_error is not None:
        raise last_error
    return []
