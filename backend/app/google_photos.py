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
    GooglePhotosConfigRead,
    GooglePhotosConfigUpdate,
    GooglePhotosMediaItemRead,
    GooglePhotosMediaListRead,
    GooglePhotosPickerSessionCreate,
    GooglePhotosPickerSessionRead,
    GooglePhotosStatusRead,
)

GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_PHOTOS_PICKER_API_BASE_URL = "https://photospicker.googleapis.com/v1"
GOOGLE_PHOTOS_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"

_AUTH_STATES: set[str] = set()


def _token_path() -> Path:
    return Path(settings.google_photos_token_path)


def _config_path() -> Path:
    return Path(settings.google_photos_config_path)


def _load_runtime_config() -> dict[str, Any] | None:
    path = _config_path()
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _save_runtime_config(payload: dict[str, Any]) -> None:
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))


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


def _token_has_required_scope(payload: dict[str, Any] | None) -> bool:
    if not isinstance(payload, dict):
        return False
    scope_text = str(payload.get("scope", "")).strip()
    if not scope_text:
        return False
    granted = {item.strip() for item in scope_text.split() if item.strip()}
    return GOOGLE_PHOTOS_SCOPE in granted


def _require_google_photos_config() -> tuple[GooglePhotosConfigRead, str]:
    config = current_google_photos_config()
    runtime = _load_runtime_config() or {}
    client_secret = str(runtime.get("client_secret", "")).strip() or settings.google_photos_client_secret
    if not (config.client_id and client_secret and config.redirect_uri):
        raise HTTPException(status_code=400, detail="未配置 Google Photos OAuth 参数，请先在前端完成配置。")
    return config, client_secret


def current_google_photos_config() -> GooglePhotosConfigRead:
    runtime = _load_runtime_config() or {}
    client_id = str(runtime.get("client_id", "")).strip() or settings.google_photos_client_id
    redirect_uri = str(runtime.get("redirect_uri", "")).strip() or settings.google_photos_redirect_uri
    client_secret = str(runtime.get("client_secret", "")).strip() or settings.google_photos_client_secret
    return GooglePhotosConfigRead(
        client_id=client_id,
        redirect_uri=redirect_uri,
        has_client_secret=bool(client_secret),
    )


def save_google_photos_config(payload: GooglePhotosConfigUpdate) -> GooglePhotosConfigRead:
    normalized = {
        "client_id": payload.client_id.strip(),
        "client_secret": payload.client_secret.strip(),
        "redirect_uri": payload.redirect_uri.strip(),
        "updated_at": datetime.utcnow().isoformat(),
    }
    if not normalized["client_id"] or not normalized["client_secret"] or not normalized["redirect_uri"]:
        raise HTTPException(status_code=400, detail="请完整填写 Client ID、Client Secret 和 Redirect URI。")
    _save_runtime_config(normalized)
    _token_path().unlink(missing_ok=True)
    return current_google_photos_config()


def clear_google_photos_token() -> GooglePhotosStatusRead:
    _token_path().unlink(missing_ok=True)
    _AUTH_STATES.clear()
    return build_google_photos_status()


def google_photos_auth_configured() -> bool:
    config = current_google_photos_config()
    return bool(config.client_id and config.has_client_secret and config.redirect_uri)


def google_photos_enabled() -> bool:
    return settings.app_role == "local"


def google_photos_connected() -> bool:
    payload = _load_token_payload()
    if not _token_has_required_scope(payload):
        return False
    return bool(payload and (payload.get("refresh_token") or payload.get("access_token")))


def build_google_photos_status() -> GooglePhotosStatusRead:
    if not google_photos_enabled():
        return GooglePhotosStatusRead(
            enabled=False,
            auth_configured=False,
            connected=False,
            detail="仅本地模式支持 Google Photos 导入。",
        )
    configured = google_photos_auth_configured()
    payload = _load_token_payload()
    connected = google_photos_connected()
    detail = None
    if not configured:
        detail = "请先在前端填写 Google Photos OAuth 配置。"
    elif payload and not _token_has_required_scope(payload):
        detail = "本地 Google Photos 授权仍是旧权限，请重新连接以启用 Picker。"
    elif not connected:
        detail = "尚未连接 Google Photos。"
    else:
        detail = "已连接 Google Photos，可打开 Picker 选择图片。"
    return GooglePhotosStatusRead(
        enabled=True,
        auth_configured=configured,
        connected=connected,
        detail=detail,
    )


def build_google_photos_auth_url() -> str:
    if not google_photos_enabled():
        raise HTTPException(status_code=400, detail="当前环境不支持 Google Photos 导入。")
    config, _client_secret = _require_google_photos_config()
    state = secrets.token_urlsafe(24)
    _AUTH_STATES.add(state)
    params = {
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "response_type": "code",
        "scope": GOOGLE_PHOTOS_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{GOOGLE_OAUTH_AUTHORIZE_URL}?{urlencode(params)}"


def exchange_google_photos_code(code: str, state: str | None) -> None:
    config, client_secret = _require_google_photos_config()
    if not state or state not in _AUTH_STATES:
        raise HTTPException(status_code=400, detail="Google Photos OAuth state 无效或已过期。")
    _AUTH_STATES.discard(state)
    response = httpx.post(
        GOOGLE_OAUTH_TOKEN_URL,
        data={
            "code": code,
            "client_id": config.client_id,
            "client_secret": client_secret,
            "redirect_uri": config.redirect_uri,
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
    if not stored_payload["refresh_token"] and previous.get("refresh_token") and _token_has_required_scope(previous):
        stored_payload["refresh_token"] = previous["refresh_token"]
    _save_token_payload(stored_payload)


def _refresh_google_photos_token(refresh_token: str) -> dict[str, Any]:
    config, client_secret = _require_google_photos_config()
    response = httpx.post(
        GOOGLE_OAUTH_TOKEN_URL,
        data={
            "client_id": config.client_id,
            "client_secret": client_secret,
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
    if not _token_has_required_scope(payload):
        raise HTTPException(status_code=401, detail="Google Photos 授权范围已切换到 Picker，请重新连接。")
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


def _duration_to_ms(value: str | None) -> int | None:
    if not value:
        return None
    text = str(value).strip()
    if not text.endswith("s"):
        return None
    try:
        return max(0, int(float(text[:-1]) * 1000))
    except ValueError:
        return None


def _session_from_payload(payload: dict[str, Any]) -> GooglePhotosPickerSessionRead:
    picker_uri = str(payload.get("pickerUri", "")).strip()
    if picker_uri and not picker_uri.endswith("/autoclose"):
        picker_uri = f"{picker_uri}/autoclose"
    polling = payload.get("pollingConfig", {}) if isinstance(payload.get("pollingConfig"), dict) else {}
    return GooglePhotosPickerSessionRead(
        id=str(payload.get("id", "")).strip(),
        picker_uri=picker_uri,
        media_items_set=bool(payload.get("mediaItemsSet")),
        poll_interval_ms=_duration_to_ms(str(polling.get("pollInterval", "")).strip() or None),
        timeout_in_ms=_duration_to_ms(str(polling.get("timeoutIn", "")).strip() or None),
        expire_time=_normalize_datetime(str(payload.get("expireTime", "")).strip() or None),
    )


def create_google_photos_picker_session(
    payload: GooglePhotosPickerSessionCreate,
) -> GooglePhotosPickerSessionRead:
    response = httpx.post(
        f"{GOOGLE_PHOTOS_PICKER_API_BASE_URL}/sessions",
        headers=_authorized_headers(),
        json={"pickingConfig": {"maxItemCount": str(max(1, min(payload.max_item_count, 2000)))}},
        timeout=30,
    )
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"创建 Google Photos Picker 会话失败：{response.text}") from exc
    data = response.json()
    if not isinstance(data, dict) or not str(data.get("id", "")).strip():
        raise HTTPException(status_code=502, detail="Google Photos Picker 会话返回异常。")
    return _session_from_payload(data)


def get_google_photos_picker_session(session_id: str) -> GooglePhotosPickerSessionRead:
    response = httpx.get(
        f"{GOOGLE_PHOTOS_PICKER_API_BASE_URL}/sessions/{session_id}",
        headers=_authorized_headers(),
        timeout=30,
    )
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"读取 Google Photos Picker 会话失败：{response.text}") from exc
    data = response.json()
    if not isinstance(data, dict) or not str(data.get("id", "")).strip():
        raise HTTPException(status_code=404, detail="Google Photos Picker 会话不存在。")
    return _session_from_payload(data)


def delete_google_photos_picker_session(session_id: str) -> None:
    response = httpx.delete(
        f"{GOOGLE_PHOTOS_PICKER_API_BASE_URL}/sessions/{session_id}",
        headers=_authorized_headers(),
        timeout=30,
    )
    if response.status_code in {200, 204, 404}:
        return
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"清理 Google Photos Picker 会话失败：{response.text}") from exc


def _media_item_from_payload(payload: dict[str, Any]) -> GooglePhotosMediaItemRead:
    media_file = payload.get("mediaFile", {}) if isinstance(payload.get("mediaFile"), dict) else {}
    media_metadata = (
        media_file.get("mediaFileMetadata", {})
        if isinstance(media_file.get("mediaFileMetadata"), dict)
        else {}
    )
    base_url = str(media_file.get("baseUrl", "")).strip()
    mime_type = str(media_file.get("mimeType", "")).strip() or None
    filename = str(media_file.get("filename", "")).strip() or f"{payload.get('id', 'image')}.jpg"
    width_value = media_metadata.get("width")
    height_value = media_metadata.get("height")
    return GooglePhotosMediaItemRead(
        id=str(payload.get("id", "")).strip(),
        filename=filename,
        base_url=base_url,
        product_url=None,
        mime_type=mime_type,
        width=int(width_value) if str(width_value).strip() else None,
        height=int(height_value) if str(height_value).strip() else None,
        creation_time=_normalize_datetime(str(payload.get("createTime", "")).strip() or None),
        thumbnail_url=f"{base_url}=w512-h512" if base_url else None,
    )


def list_google_photos_media_items(
    *,
    session_id: str,
    page_size: int = 100,
    page_token: str | None = None,
) -> GooglePhotosMediaListRead:
    params = {
        "sessionId": session_id,
        "pageSize": max(1, min(page_size, 100)),
    }
    if page_token:
        params["pageToken"] = page_token
    response = httpx.get(
        f"{GOOGLE_PHOTOS_PICKER_API_BASE_URL}/mediaItems",
        headers=_authorized_headers(),
        params=params,
        timeout=30,
    )
    try:
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"读取 Google Photos 已选图片失败：{response.text}") from exc
    payload = response.json()
    items = [
        _media_item_from_payload(item)
        for item in payload.get("mediaItems", [])
        if isinstance(item, dict)
        and str(item.get("id", "")).strip()
        and str(item.get("type", "")).upper() == "PHOTO"
    ]
    return GooglePhotosMediaListRead(
        items=items,
        next_page_token=str(payload.get("nextPageToken", "")).strip() or None,
    )


def get_google_photos_media_items_by_ids(
    *,
    session_id: str,
    media_item_ids: list[str],
) -> list[GooglePhotosMediaItemRead]:
    wanted = {item.strip() for item in media_item_ids if item.strip()}
    if not wanted:
        return []
    page_token: str | None = None
    found: dict[str, GooglePhotosMediaItemRead] = {}
    while True:
        page = list_google_photos_media_items(session_id=session_id, page_token=page_token, page_size=100)
        for item in page.items:
            if item.id in wanted:
                found[item.id] = item
        if found.keys() >= wanted or not page.next_page_token:
            break
        page_token = page.next_page_token
    missing = [item_id for item_id in media_item_ids if item_id.strip() and item_id.strip() not in found]
    if missing:
        raise HTTPException(status_code=400, detail="部分 Google Photos 已选图片已失效，请重新打开 Picker 选择。")
    return [found[item_id] for item_id in media_item_ids if item_id in found]


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
