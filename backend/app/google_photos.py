import json
import secrets
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException

from app.config import settings
from app.schemas import (
    GooglePhotosAlbumRead,
    GooglePhotosMediaItemRead,
    GooglePhotosMediaListRead,
    GooglePhotosStatusRead,
)

GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_PHOTOS_API_BASE_URL = "https://photoslibrary.googleapis.com/v1"
GOOGLE_PHOTOS_SCOPE = "https://www.googleapis.com/auth/photoslibrary.readonly"

_AUTH_STATES: set[str] = set()


def _token_path() -> Path:
    return Path(settings.google_photos_token_path)


def google_photos_auth_configured() -> bool:
    return bool(
        settings.google_photos_client_id
        and settings.google_photos_client_secret
        and settings.google_photos_redirect_uri
    )


def google_photos_enabled() -> bool:
    return settings.app_role == "local"


def _load_token_payload() -> dict[str, Any] | None:
    path = _token_path()
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _save_token_payload(payload: dict[str, Any]) -> None:
    path = _token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))


def google_photos_connected() -> bool:
    payload = _load_token_payload()
    return isinstance(payload, dict) and bool(payload.get("refresh_token") or payload.get("access_token"))


def build_google_photos_status() -> GooglePhotosStatusRead:
    if not google_photos_enabled():
        return GooglePhotosStatusRead(
            enabled=False,
            auth_configured=False,
            connected=False,
            detail="仅本地模式支持 Google Photos 导入。",
        )
    configured = google_photos_auth_configured()
    connected = google_photos_connected()
    detail = None
    if not configured:
        detail = "未配置 GOOGLE_PHOTOS_CLIENT_ID / SECRET / REDIRECT_URI。"
    elif not connected:
        detail = "尚未连接 Google Photos。"
    return GooglePhotosStatusRead(
        enabled=True,
        auth_configured=configured,
        connected=connected,
        detail=detail,
    )


def build_google_photos_auth_url() -> str:
    if not google_photos_enabled():
        raise HTTPException(status_code=400, detail="当前环境不支持 Google Photos 导入。")
    if not google_photos_auth_configured():
        raise HTTPException(
            status_code=400,
            detail="未配置 Google Photos OAuth 参数，请先填写环境变量。",
        )
    state = secrets.token_urlsafe(24)
    _AUTH_STATES.add(state)
    params = {
        "client_id": settings.google_photos_client_id,
        "redirect_uri": settings.google_photos_redirect_uri,
        "response_type": "code",
        "scope": GOOGLE_PHOTOS_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{GOOGLE_OAUTH_AUTHORIZE_URL}?{urlencode(params)}"


def exchange_google_photos_code(code: str, state: str | None) -> None:
    if not google_photos_auth_configured():
        raise HTTPException(status_code=400, detail="未配置 Google Photos OAuth 参数。")
    if not state or state not in _AUTH_STATES:
        raise HTTPException(status_code=400, detail="Google Photos OAuth state 无效或已过期。")
    _AUTH_STATES.discard(state)
    response = httpx.post(
        GOOGLE_OAUTH_TOKEN_URL,
        data={
            "code": code,
            "client_id": settings.google_photos_client_id,
            "client_secret": settings.google_photos_client_secret,
            "redirect_uri": settings.google_photos_redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Google Photos 授权换 token 失败：{response.text}") from exc
    payload = response.json()
    expires_in = int(payload.get("expires_in", 3600))
    stored_payload = {
        "access_token": payload.get("access_token", ""),
        "refresh_token": payload.get("refresh_token", ""),
        "token_type": payload.get("token_type", "Bearer"),
        "scope": payload.get("scope", GOOGLE_PHOTOS_SCOPE),
        "expires_at": int(time.time()) + expires_in - 60,
        "updated_at": datetime.utcnow().isoformat(),
    }
    previous = _load_token_payload() or {}
    if not stored_payload["refresh_token"] and previous.get("refresh_token"):
        stored_payload["refresh_token"] = previous["refresh_token"]
    _save_token_payload(stored_payload)


def _refresh_google_photos_token(refresh_token: str) -> dict[str, Any]:
    response = httpx.post(
        GOOGLE_OAUTH_TOKEN_URL,
        data={
            "client_id": settings.google_photos_client_id,
            "client_secret": settings.google_photos_client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Google Photos 刷新 token 失败：{response.text}") from exc
    payload = response.json()
    expires_in = int(payload.get("expires_in", 3600))
    stored_payload = {
        "access_token": payload.get("access_token", ""),
        "refresh_token": refresh_token,
        "token_type": payload.get("token_type", "Bearer"),
        "scope": payload.get("scope", GOOGLE_PHOTOS_SCOPE),
        "expires_at": int(time.time()) + expires_in - 60,
        "updated_at": datetime.utcnow().isoformat(),
    }
    _save_token_payload(stored_payload)
    return stored_payload


def get_google_photos_access_token() -> str:
    if not google_photos_enabled():
        raise HTTPException(status_code=400, detail="当前环境不支持 Google Photos 导入。")
    payload = _load_token_payload()
    if not payload:
        raise HTTPException(status_code=401, detail="Google Photos 尚未连接，请先完成授权。")
    access_token = str(payload.get("access_token", "")).strip()
    expires_at = int(payload.get("expires_at", 0) or 0)
    if access_token and expires_at > int(time.time()):
        return access_token
    refresh_token = str(payload.get("refresh_token", "")).strip()
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Google Photos 授权已失效，请重新连接。")
    refreshed = _refresh_google_photos_token(refresh_token)
    return str(refreshed.get("access_token", "")).strip()


def _authorized_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {get_google_photos_access_token()}"}


def _normalize_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _album_from_payload(payload: dict[str, Any]) -> GooglePhotosAlbumRead:
    cover_photo_base_url = str(payload.get("coverPhotoBaseUrl", "")).strip() or None
    media_items_count = payload.get("mediaItemsCount")
    return GooglePhotosAlbumRead(
        id=str(payload.get("id", "")).strip(),
        title=str(payload.get("title", "")).strip() or "未命名相册",
        media_items_count=int(media_items_count) if str(media_items_count).strip() else None,
        cover_photo_base_url=cover_photo_base_url,
        cover_photo_url=f"{cover_photo_base_url}=w256-h256-c" if cover_photo_base_url else None,
        is_writeable=payload.get("isWriteable"),
    )


def _media_item_from_payload(payload: dict[str, Any]) -> GooglePhotosMediaItemRead:
    media_metadata = payload.get("mediaMetadata", {}) if isinstance(payload.get("mediaMetadata"), dict) else {}
    width_value = media_metadata.get("width")
    height_value = media_metadata.get("height")
    base_url = str(payload.get("baseUrl", "")).strip()
    return GooglePhotosMediaItemRead(
        id=str(payload.get("id", "")).strip(),
        filename=str(payload.get("filename", "")).strip() or f"{payload.get('id', 'image')}.jpg",
        base_url=base_url,
        product_url=str(payload.get("productUrl", "")).strip() or None,
        mime_type=str(payload.get("mimeType", "")).strip() or None,
        width=int(width_value) if str(width_value).strip() else None,
        height=int(height_value) if str(height_value).strip() else None,
        creation_time=_normalize_datetime(str(media_metadata.get("creationTime", "")).strip() or None),
        thumbnail_url=f"{base_url}=w512-h512" if base_url else None,
    )


def list_google_photos_albums(
    *,
    page_size: int = 50,
    page_token: str | None = None,
) -> tuple[list[GooglePhotosAlbumRead], str | None]:
    params = {"pageSize": max(1, min(page_size, 50))}
    if page_token:
        params["pageToken"] = page_token
    response = httpx.get(
        f"{GOOGLE_PHOTOS_API_BASE_URL}/albums",
        headers=_authorized_headers(),
        params=params,
        timeout=30,
    )
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"读取 Google Photos 相册失败：{response.text}") from exc
    payload = response.json()
    albums = [
        _album_from_payload(item)
        for item in payload.get("albums", [])
        if isinstance(item, dict) and str(item.get("id", "")).strip()
    ]
    return albums, str(payload.get("nextPageToken", "")).strip() or None


def list_google_photos_media_items(
    *,
    album_id: str | None = None,
    page_size: int = 60,
    page_token: str | None = None,
) -> GooglePhotosMediaListRead:
    if album_id:
        response = httpx.post(
            f"{GOOGLE_PHOTOS_API_BASE_URL}/mediaItems:search",
            headers=_authorized_headers(),
            json={
                "albumId": album_id,
                "pageSize": max(1, min(page_size, 100)),
                **({"pageToken": page_token} if page_token else {}),
            },
            timeout=30,
        )
    else:
        params = {"pageSize": max(1, min(page_size, 100))}
        if page_token:
            params["pageToken"] = page_token
        response = httpx.get(
            f"{GOOGLE_PHOTOS_API_BASE_URL}/mediaItems",
            headers=_authorized_headers(),
            params=params,
            timeout=30,
        )
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"读取 Google Photos 图片失败：{response.text}") from exc
    payload = response.json()
    items = [
        _media_item_from_payload(item)
        for item in payload.get("mediaItems", [])
        if isinstance(item, dict)
        and str(item.get("id", "")).strip()
        and str(item.get("mimeType", "")).lower().startswith("image/")
    ]
    return GooglePhotosMediaListRead(
        items=items,
        next_page_token=str(payload.get("nextPageToken", "")).strip() or None,
    )


def get_google_photos_media_item(media_item_id: str) -> GooglePhotosMediaItemRead:
    response = httpx.get(
        f"{GOOGLE_PHOTOS_API_BASE_URL}/mediaItems/{media_item_id}",
        headers=_authorized_headers(),
        timeout=30,
    )
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"读取 Google Photos 单张图片失败：{response.text}") from exc
    payload = response.json()
    if not isinstance(payload, dict) or not str(payload.get("id", "")).strip():
        raise HTTPException(status_code=404, detail="Google Photos 图片不存在。")
    return _media_item_from_payload(payload)


def download_google_photos_image(media_item: GooglePhotosMediaItemRead) -> bytes:
    if not media_item.base_url:
        raise HTTPException(status_code=400, detail=f"Google Photos 图片 {media_item.id} 缺少 baseUrl。")
    response = httpx.get(
        f"{media_item.base_url}=d",
        headers=_authorized_headers(),
        timeout=120,
        follow_redirects=True,
    )
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"下载 Google Photos 图片 {media_item.filename} 失败：{response.text}",
        ) from exc
    return response.content
