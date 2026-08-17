"""Request correlation and slow/error request logging.

This module intentionally owns the request-id ContextVar so services can reuse
the same correlation id without importing the FastAPI application module.
"""

from __future__ import annotations

import logging
import re
import time
from contextvars import ContextVar
from uuid import uuid4

from fastapi import Request

from app.config import settings

logger = logging.getLogger("app.vision")
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
current_request_id: ContextVar[str | None] = ContextVar(
    "current_request_id", default=None
)


async def add_request_observability(request: Request, call_next):
    incoming_request_id = request.headers.get("X-Request-ID", "").strip()
    request_id = (
        incoming_request_id
        if REQUEST_ID_PATTERN.fullmatch(incoming_request_id)
        else uuid4().hex
    )
    request_id_token = current_request_id.set(request_id)
    started_at = time.perf_counter()
    try:
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        response.headers["X-Request-ID"] = request_id
        response.headers["X-App-Revision"] = settings.app_revision
        if response.status_code >= 400 or elapsed_ms >= 1000:
            log_request = logger.warning if response.status_code >= 500 else logger.info
            log_request(
                "request completed request_id=%s method=%s path=%s status=%d duration_ms=%.0f",
                request_id,
                request.method,
                request.url.path,
                response.status_code,
                elapsed_ms,
            )
        return response
    except Exception:
        logger.exception(
            "request failed request_id=%s method=%s path=%s",
            request_id,
            request.method,
            request.url.path,
        )
        raise
    finally:
        current_request_id.reset(request_id_token)
