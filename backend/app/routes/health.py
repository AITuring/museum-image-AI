import logging
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from app.config import settings
from app.schemas import HealthRead

logger = logging.getLogger("app.vision")


def create_health_router(
    *,
    get_engine: Callable[[], Any],
    get_ingest_configuration_error: Callable[[], str | None],
) -> tuple[APIRouter, Callable[[], HealthRead]]:
    """Build the readiness route while keeping infrastructure easy to replace in tests."""
    router = APIRouter()

    @router.get("/health", response_model=HealthRead)
    def healthcheck() -> HealthRead:
        try:
            with get_engine().connect() as connection:
                connection.execute(text("SELECT 1"))
        except Exception as exc:  # noqa: BLE001 - health must convert DB failures into readiness
            logger.error("healthcheck database probe failed: %s", exc)
            raise HTTPException(
                status_code=503,
                detail="主数据库暂不可用。",
                headers={
                    "Retry-After": "2",
                    "X-Error-Code": "database_unavailable",
                },
            ) from exc

        ingest_status = "not-applicable"
        if settings.app_role == "cloud":
            configuration_error = get_ingest_configuration_error()
            if configuration_error:
                raise HTTPException(
                    status_code=503,
                    detail=configuration_error,
                    headers={
                        "Retry-After": "2",
                        "X-Error-Code": "cloud_ingest_not_ready",
                    },
                )
            ingest_status = "ready"

        return HealthRead(
            status="ok",
            environment=settings.app_env,
            database="connected",
            role=settings.app_role,
            revision=settings.app_revision,
            ingest=ingest_status,
        )

    return router, healthcheck
