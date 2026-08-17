from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import HTTPException
from PIL import Image, ImageOps

from app.config import settings


@dataclass(slots=True)
class ImageDeliveryDependencies:
    data_dir: Path
    max_image_source_bytes: int
    should_proxy_artifact_queries_to_cloud: Callable[[], bool]


_dependencies: ImageDeliveryDependencies | None = None


def configure_image_delivery(dependencies: ImageDeliveryDependencies) -> None:
    global _dependencies
    _dependencies = dependencies


def _configured_dependencies() -> ImageDeliveryDependencies:
    if _dependencies is None:
        raise RuntimeError("image delivery has not been configured")
    return _dependencies


def build_uploaded_file_url(filename: str) -> str:
    return f"/files/uploads/{filename}"


def resolve_uploaded_file_path(image_url: str) -> Path:
    if not image_url.startswith("/files/uploads/"):
        raise HTTPException(status_code=400, detail="仅支持提交本地上传后的图片。")
    relative_path = image_url.removeprefix("/files/").lstrip("/")
    file_path = _configured_dependencies().data_dir / relative_path
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(
            status_code=400, detail="上传图片已不存在，请重新上传后再提交。"
        )
    return file_path


def is_allowed_remote_image_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False

    hostname = parsed.hostname.lower()
    if hostname == "aliyuncs.com" or hostname.endswith(".aliyuncs.com"):
        return True
    # iMuseum exhibition covers are served from its own CDN, rather than OSS.
    # Keep this narrowly scoped so the preview endpoint remains protected from
    # arbitrary remote fetches.
    if hostname == "icitycdn.com" or hostname.endswith(".icitycdn.com"):
        return True

    configured_hosts = {
        urlparse(candidate).hostname
        for candidate in (
            settings.cloud_api_base_url,
            settings.oss_endpoint,
            settings.oss_public_base_url,
        )
        if candidate
    }
    return hostname in {host.lower() for host in configured_hosts if host}


async def load_image_source_bytes(image_url: str) -> bytes:
    dependencies = _configured_dependencies()
    normalized_url = image_url.strip()
    if normalized_url.startswith("/files/uploads/"):
        if not dependencies.should_proxy_artifact_queries_to_cloud():
            return resolve_uploaded_file_path(normalized_url).read_bytes()
        normalized_url = f"{settings.cloud_api_base_url.rstrip('/')}{normalized_url}"

    if not is_allowed_remote_image_url(normalized_url):
        raise HTTPException(status_code=400, detail="不支持的图片来源。")

    referer = (
        settings.cors_origins_list[0].rstrip("/") + "/"
        if settings.cors_origins_list
        else ""
    )
    request_headers = {
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 MuseumImageDB/1.0",
    }
    if referer:
        request_headers["Referer"] = referer

    try:
        async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
            response = await client.get(normalized_url, headers=request_headers)
            response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"读取图片失败：{exc}") from exc

    if len(response.content) > dependencies.max_image_source_bytes:
        raise HTTPException(status_code=413, detail="原图过大，无法生成缩略图。")
    return response.content


def render_image_variant(source_bytes: bytes, target_path: Path, size: int) -> None:
    with Image.open(BytesIO(source_bytes)) as source:
        # JPEG draft mode asks the decoder to load a reduced-resolution image.
        # This substantially lowers peak memory and CPU for 40–100 MP originals
        # while preserving more than enough detail for the 1280 px master.
        source.draft("RGB", (size, size))
        image = ImageOps.exif_transpose(source)
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        if image.mode != "RGB":
            image = image.convert("RGB")

        buffer = BytesIO()
        image.save(
            buffer,
            format="WEBP",
            quality=74 if size <= 480 else 82,
            method=4,
        )

    temporary_path = target_path.with_suffix(f".{uuid4().hex}.tmp")
    temporary_path.write_bytes(buffer.getvalue())
    temporary_path.replace(target_path)
