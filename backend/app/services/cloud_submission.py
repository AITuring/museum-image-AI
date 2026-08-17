import asyncio
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import uuid4

import httpx
from fastapi import HTTPException

from app.config import settings
from app.request_context import current_request_id
from app.schemas import ArtifactRead

logger = logging.getLogger("app.vision")
TRANSIENT_CLOUD_STATUSES = {408, 425, 429, 500, 502, 503, 504}


def extract_http_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception:
        payload = None
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
    text_body = response.text.strip()
    if text_body:
        return text_body[:1000]
    return f"HTTP {response.status_code}"


def cloud_retry_delay_seconds(response: httpx.Response | None, attempt: int) -> float:
    fallback = 0.8 * (2**attempt)
    if response is None:
        return fallback
    retry_after = response.headers.get("Retry-After", "").strip()
    try:
        requested_delay = float(retry_after)
    except ValueError:
        return fallback
    return min(10.0, max(fallback, requested_delay))


async def reconcile_cloud_submission(
    client: httpx.AsyncClient,
    *,
    base: str,
    source_hash: str | None,
    request_id: str,
) -> ArtifactRead | None:
    """Confirm a possibly committed upload before sending the image again."""
    if not source_hash:
        return None
    request_headers = {"X-Request-ID": request_id}
    lookup_timeout = httpx.Timeout(8, connect=3)
    try:
        image_response = await client.get(
            f"{base}{settings.api_prefix}/artifact-images/by-source-hash",
            params={"source_hash": source_hash},
            headers=request_headers,
            timeout=lookup_timeout,
        )
        if image_response.status_code == 404:
            return None
        image_response.raise_for_status()
        image_payload = image_response.json()
        if not isinstance(image_payload, dict):
            return None
        artifact_id = image_payload.get("artifact_id")
        if not isinstance(artifact_id, int) or artifact_id <= 0:
            return None

        artifact_response = await client.get(
            f"{base}{settings.api_prefix}/artifacts/{artifact_id}",
            headers=request_headers,
            timeout=lookup_timeout,
        )
        if artifact_response.status_code == 404:
            return None
        artifact_response.raise_for_status()
        artifact = ArtifactRead.model_validate(artifact_response.json())
        logger.info(
            "cloud ingest reconciled request_id=%s source_hash=%s artifact_id=%d",
            request_id,
            source_hash[:12],
            artifact.id,
        )
        return artifact
    except Exception as exc:  # noqa: BLE001 - reconciliation is best effort
        logger.warning(
            "cloud ingest reconciliation failed request_id=%s source_hash=%s: %s",
            request_id,
            source_hash[:12],
            exc,
        )
        return None


@dataclass(slots=True)
class CloudSubmissionService:
    """Reliable local-to-cloud artifact submission with retry reconciliation."""

    get_http_client: Callable[[], Any]
    normalize_place_of_excavation: Callable[[str | None], str | None]
    normalize_exhibition_name: Callable[[str | None], str]

    async def submit_artifact_to_cloud(
        self,
        *,
        image_bytes: bytes,
        image_name: str,
        content_type: str,
        museum_name: str,
        name: str,
        era: str | None,
        Place_of_Excavation: str | None,
        description: str | None,
        existing_artifact_id: int | None,
        skip_existing_match: bool,
        tags: list[str],
        camera_model: str | None,
        lens_model: str | None,
        capture_museum_name: str | None,
        exhibition_name: str | None,
        capture_location: str | None,
        latitude: float | None,
        longitude: float | None,
        captured_at: datetime | None,
        shutter_speed: str | None,
        aperture: str | None,
        iso: int | None,
        edit_method: str | None,
        source_hash: str | None = None,
        catalog_exhibition_source_id: str | None = None,
        catalog_exhibition_id: int | None = None,
    ) -> ArtifactRead:
        if not settings.cloud_api_base_url:
            raise HTTPException(status_code=400, detail="未配置 CLOUD_API_BASE_URL。")
        if not settings.ingest_token:
            raise HTTPException(status_code=400, detail="未配置 INGEST_TOKEN。")
        if not museum_name.strip():
            raise HTTPException(status_code=400, detail="请填写或确认博物馆名称。")
        if not name.strip():
            raise HTTPException(status_code=400, detail="请填写或确认文物名称。")

        excavation_value = self.normalize_place_of_excavation(Place_of_Excavation)
        base = settings.cloud_api_base_url.rstrip("/")
        submit_data = {
            "museum_name": museum_name.strip(),
            "name": name.strip(),
            "era": era or "",
            "Place_of_Excavation": excavation_value or "",
            "description": description or "",
            "skip_existing_match": "true" if skip_existing_match else "false",
            "tags": json.dumps(tags, ensure_ascii=False),
            "camera_model": camera_model or "",
            "lens_model": lens_model or "",
            "capture_museum_name": capture_museum_name or "",
            "exhibition_name": self.normalize_exhibition_name(exhibition_name),
            "catalog_exhibition_source_id": catalog_exhibition_source_id or "",
            "capture_location": capture_location or "",
            "latitude": "" if latitude is None else str(latitude),
            "longitude": "" if longitude is None else str(longitude),
            "captured_at": captured_at.isoformat() if captured_at else "",
            "shutter_speed": shutter_speed or "",
            "aperture": aperture or "",
            "iso": "" if iso is None else str(iso),
            "edit_method": edit_method or "",
            "source_hash": source_hash or "",
        }
        if existing_artifact_id is not None:
            submit_data["existing_artifact_id"] = str(existing_artifact_id)
        if catalog_exhibition_id is not None:
            submit_data["catalog_exhibition_id"] = str(catalog_exhibition_id)

        cloud_url = f"{base}{settings.api_prefix}/ingest/artifacts"
        client = self.get_http_client()
        owns_client = client is None
        if client is None:
            client = httpx.AsyncClient(
                timeout=httpx.Timeout(120, connect=15),
                limits=httpx.Limits(
                    max_connections=20,
                    max_keepalive_connections=10,
                ),
            )
        started_at = time.perf_counter()
        request_id = current_request_id.get() or uuid4().hex
        request_headers = {
            "Authorization": f"Bearer {settings.ingest_token}",
            "X-Request-ID": request_id,
        }
        try:
            for attempt in range(2):
                try:
                    response = await client.post(
                        cloud_url,
                        files={"image": (image_name, image_bytes, content_type)},
                        data=submit_data,
                        headers=request_headers,
                    )
                except httpx.RequestError as exc:
                    reconciled = await reconcile_cloud_submission(
                        client,
                        base=base,
                        source_hash=source_hash,
                        request_id=request_id,
                    )
                    if reconciled is not None:
                        return reconciled
                    if attempt == 0:
                        retry_delay = cloud_retry_delay_seconds(None, attempt)
                        logger.warning(
                            "cloud ingest connection failed request_id=%s image=%s; "
                            "retrying once in %.1fs: %s",
                            request_id,
                            image_name,
                            retry_delay,
                            exc,
                        )
                        await asyncio.sleep(retry_delay)
                        continue
                    raise HTTPException(
                        status_code=502,
                        detail=f"提交云端失败：{exc}",
                        headers={"Retry-After": "2"},
                    ) from exc

                if response.status_code in TRANSIENT_CLOUD_STATUSES:
                    reconciled = await reconcile_cloud_submission(
                        client,
                        base=base,
                        source_hash=source_hash,
                        request_id=request_id,
                    )
                    if reconciled is not None:
                        return reconciled
                if response.status_code in TRANSIENT_CLOUD_STATUSES and attempt == 0:
                    retry_delay = cloud_retry_delay_seconds(response, attempt)
                    logger.warning(
                        "cloud ingest returned HTTP %s request_id=%s image=%s; "
                        "retrying once in %.1fs. response=%s",
                        response.status_code,
                        request_id,
                        image_name,
                        retry_delay,
                        response.text[:1000],
                    )
                    await asyncio.sleep(retry_delay)
                    continue
                if not response.is_success:
                    detail = extract_http_error_detail(response)
                    logger.error(
                        "cloud ingest failed request_id=%s image=%s HTTP %s: %s",
                        request_id,
                        image_name,
                        response.status_code,
                        detail,
                    )
                    if response.status_code == 404:
                        raise HTTPException(
                            status_code=502,
                            detail=(
                                f"云端入库接口不存在（{settings.api_prefix}/ingest/artifacts）。"
                                "请检查 CLOUD_API_BASE_URL，或重新部署与本地代码匹配的云端后端。"
                            ),
                            headers={"X-Error-Code": "cloud_ingest_endpoint_missing"},
                        )
                    error_headers = None
                    if response.status_code in TRANSIENT_CLOUD_STATUSES:
                        error_headers = {
                            "Retry-After": response.headers.get("Retry-After", "2")
                        }
                    raise HTTPException(
                        status_code=response.status_code,
                        detail=f"提交云端失败：{detail}",
                        headers=error_headers,
                    )
                try:
                    return ArtifactRead.model_validate(response.json())
                except Exception as exc:  # noqa: BLE001 - invalid upstream contract
                    raise HTTPException(
                        status_code=502,
                        detail="云端入库响应格式不正确，请稍后重试。",
                        headers={"Retry-After": "2"},
                    ) from exc
            raise HTTPException(
                status_code=502,
                detail="提交云端失败：重试次数已用尽。",
                headers={"Retry-After": "2"},
            )
        except Exception as exc:  # noqa: BLE001 - surface submit failure to the operator
            if isinstance(exc, HTTPException):
                raise exc
            raise HTTPException(
                status_code=502,
                detail=f"提交云端失败：{exc}",
                headers={"Retry-After": "2"},
            ) from exc
        finally:
            if owns_client:
                await client.aclose()
            logger.info(
                "cloud ingest round trip completed request_id=%s image=%s in %.0fms",
                request_id,
                image_name,
                (time.perf_counter() - started_at) * 1000,
            )
