"""Alibaba Cloud OSS upload helper (used by the cloud side).

Images submitted from the local operator machine are stored in OSS; only their public
URL is persisted in the database.
"""

import logging
from uuid import uuid4

from app.config import settings

logger = logging.getLogger("app.oss")


def oss_configured() -> bool:
    return bool(
        settings.oss_access_key_id
        and settings.oss_access_key_secret
        and settings.oss_endpoint
        and settings.oss_bucket
    )


def _public_url(object_key: str) -> str:
    if settings.oss_public_base_url:
        base = settings.oss_public_base_url.rstrip("/")
        return f"{base}/{object_key}"
    # Derive the default virtual-hosted style URL from endpoint + bucket.
    endpoint = settings.oss_endpoint.rstrip("/")
    scheme, _, host = endpoint.partition("://")
    if not host:
        scheme, host = "https", endpoint
    return f"{scheme}://{settings.oss_bucket}.{host}/{object_key}"


def _build_object_key(filename: str) -> str:
    suffix = ""
    if "." in filename:
        suffix = "." + filename.rsplit(".", 1)[-1].lower()
    prefix = settings.oss_key_prefix.strip("/")
    name = f"{uuid4().hex}{suffix}"
    return f"{prefix}/{name}" if prefix else name


def upload_image(data: bytes, filename: str, content_type: str | None = None) -> str:
    """Upload image bytes to OSS and return the public URL.

    Raises RuntimeError if OSS is not configured.
    """
    if not oss_configured():
        raise RuntimeError(
            "OSS 未配置：请设置 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / "
            "OSS_ENDPOINT / OSS_BUCKET。"
        )

    import oss2  # imported lazily so the local side need not install/configure it

    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)

    object_key = _build_object_key(filename)
    headers = {"Content-Type": content_type} if content_type else None
    bucket.put_object(object_key, data, headers=headers)
    url = _public_url(object_key)
    logger.info("OSS uploaded %s (%d bytes) -> %s", object_key, len(data), url)
    return url
