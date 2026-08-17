import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.google_photos import (
    build_google_photos_auth_url,
    build_google_photos_status,
    clear_google_photos_token,
    create_google_photos_picker_session,
    current_google_photos_config,
    delete_google_photos_picker_session,
    download_google_photos_image,
    exchange_google_photos_code,
    get_google_photos_media_items_by_ids,
    get_google_photos_picker_session,
    google_photos_enabled,
    list_google_photos_media_items,
    save_google_photos_config,
)
from app.models import PendingArtifact
from app.schemas import (
    GooglePhotosAuthStartRead,
    GooglePhotosConfigRead,
    GooglePhotosConfigUpdate,
    GooglePhotosImportRead,
    GooglePhotosImportRequest,
    GooglePhotosMediaListRead,
    GooglePhotosPickerSessionCreate,
    GooglePhotosPickerSessionRead,
    GooglePhotosStatusRead,
    PendingArtifactRead,
)


def build_google_photos_callback_html(success: bool, message: str) -> str:
    payload = json.dumps(
        {
            "source": "google-photos-oauth",
            "success": success,
            "message": message,
        },
        ensure_ascii=False,
    )
    title = "Google Photos 已连接" if success else "Google Photos 连接失败"
    return f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <style>
      body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #f8f7f2; color: #2c241c; }}
      .card {{ max-width: 520px; margin: 40px auto; padding: 24px; background: #fff; border-radius: 16px; box-shadow: 0 12px 32px rgba(54, 39, 19, 0.08); }}
      h1 {{ margin: 0 0 12px; font-size: 22px; }}
      p {{ margin: 0; line-height: 1.6; }}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>{title}</h1>
      <p>{message}</p>
    </div>
    <script>
      const payload = {payload};
      try {{
        if (window.opener && !window.opener.closed) {{
          window.opener.postMessage(payload, "*");
        }}
      }} catch (_error) {{
        // Ignore postMessage cross-window failures and still try to close the popup.
      }}
      setTimeout(() => window.close(), 800);
    </script>
  </body>
</html>"""


@dataclass(slots=True)
class GooglePhotosRouteDependencies:
    hash_bytes: Callable[..., Any]
    build_image_metadata: Callable[..., Any]
    register_pending_artifact: Callable[..., Any]
    optional_text: Callable[..., Any]


@dataclass(slots=True)
class GooglePhotosRouteHandlers:
    status: Callable[..., Any]
    config: Callable[..., Any]
    update_config: Callable[..., Any]
    delete_token: Callable[..., Any]
    auth_start: Callable[..., Any]
    auth_callback: Callable[..., Any]
    picker_session_create: Callable[..., Any]
    picker_session_get: Callable[..., Any]
    picker_session_delete: Callable[..., Any]
    picker_media_items: Callable[..., Any]
    import_photos: Callable[..., Any]


def create_google_photos_router(
    dependencies: GooglePhotosRouteDependencies,
) -> tuple[APIRouter, GooglePhotosRouteHandlers]:
    router = APIRouter()

    @router.get("/google-photos/status", response_model=GooglePhotosStatusRead)
    def google_photos_status() -> GooglePhotosStatusRead:
        return build_google_photos_status()

    @router.get("/google-photos/config", response_model=GooglePhotosConfigRead)
    def google_photos_config() -> GooglePhotosConfigRead:
        return current_google_photos_config()

    @router.put("/google-photos/config", response_model=GooglePhotosConfigRead)
    def update_google_photos_config(
        payload: GooglePhotosConfigUpdate,
    ) -> GooglePhotosConfigRead:
        return save_google_photos_config(payload)

    @router.delete(
        "/google-photos/token",
        response_model=GooglePhotosStatusRead,
    )
    def delete_google_photos_token() -> GooglePhotosStatusRead:
        return clear_google_photos_token()

    @router.get(
        "/google-photos/auth/start",
        response_model=GooglePhotosAuthStartRead,
    )
    def google_photos_auth_start() -> GooglePhotosAuthStartRead:
        return GooglePhotosAuthStartRead(auth_url=build_google_photos_auth_url())

    @router.get("/google-photos/callback", response_class=HTMLResponse)
    def google_photos_auth_callback(
        code: str | None = Query(default=None),
        state: str | None = Query(default=None),
        error: str | None = Query(default=None),
    ) -> HTMLResponse:
        if error:
            return HTMLResponse(
                build_google_photos_callback_html(
                    False,
                    f"Google 授权被取消或失败：{error}",
                ),
                status_code=400,
            )
        if not code:
            return HTMLResponse(
                build_google_photos_callback_html(
                    False,
                    "Google 授权回调缺少 code。",
                ),
                status_code=400,
            )
        try:
            exchange_google_photos_code(code, state)
        except HTTPException as exc:
            return HTMLResponse(
                build_google_photos_callback_html(False, str(exc.detail)),
                status_code=exc.status_code,
            )
        return HTMLResponse(
            build_google_photos_callback_html(
                True,
                "Google Photos 已连接，可以回到批量入库页继续导入图片。",
            )
        )

    @router.post(
        "/google-photos/picker/sessions",
        response_model=GooglePhotosPickerSessionRead,
    )
    def google_photos_picker_session_create(
        payload: GooglePhotosPickerSessionCreate,
    ) -> GooglePhotosPickerSessionRead:
        return create_google_photos_picker_session(payload)

    @router.get(
        "/google-photos/picker/sessions/{session_id}",
        response_model=GooglePhotosPickerSessionRead,
    )
    def google_photos_picker_session_get(
        session_id: str,
    ) -> GooglePhotosPickerSessionRead:
        normalized = session_id.strip()
        if not normalized:
            raise HTTPException(
                status_code=400,
                detail="Google Photos Picker session_id 不能为空。",
            )
        return get_google_photos_picker_session(normalized)

    @router.delete(
        "/google-photos/picker/sessions/{session_id}",
        status_code=204,
    )
    def google_photos_picker_session_delete(session_id: str) -> None:
        normalized = session_id.strip()
        if not normalized:
            raise HTTPException(
                status_code=400,
                detail="Google Photos Picker session_id 不能为空。",
            )
        delete_google_photos_picker_session(normalized)

    @router.get(
        "/google-photos/picker/media-items",
        response_model=GooglePhotosMediaListRead,
    )
    def google_photos_picker_media_items(
        session_id: str = Query(..., min_length=1),
        page_size: int = Query(default=100, ge=1, le=100),
        page_token: str | None = Query(default=None),
    ) -> GooglePhotosMediaListRead:
        return list_google_photos_media_items(
            session_id=session_id.strip(),
            page_size=page_size,
            page_token=dependencies.optional_text(page_token),
        )

    @router.post(
        "/google-photos/import",
        response_model=GooglePhotosImportRead,
    )
    def google_photos_import(
        payload: GooglePhotosImportRequest,
        db: Session = Depends(get_db),
    ) -> GooglePhotosImportRead:
        if not google_photos_enabled():
            raise HTTPException(
                status_code=400,
                detail="当前环境不支持 Google Photos 导入。",
            )
        session_id = payload.session_id.strip()
        if not session_id:
            raise HTTPException(
                status_code=400,
                detail="Google Photos Picker session_id 不能为空。",
            )
        media_item_ids = [
            item.strip() for item in payload.media_item_ids if item.strip()
        ]
        if not media_item_ids:
            raise HTTPException(
                status_code=400,
                detail="请至少选择一张 Google Photos 图片。",
            )

        imported = 0
        skipped = 0
        warnings: list[str] = []
        imported_ids: list[int] = []
        media_items = get_google_photos_media_items_by_ids(
            session_id=session_id,
            media_item_ids=media_item_ids,
        )

        for media_item in media_items:
            mime_type = (media_item.mime_type or "").lower()
            if not mime_type.startswith("image/"):
                skipped += 1
                warnings.append(f"{media_item.filename} 不是图片，已跳过。")
                continue
            contents = download_google_photos_image(media_item)
            if not contents:
                skipped += 1
                warnings.append(f"{media_item.filename} 下载为空，已跳过。")
                continue
            file_hash = dependencies.hash_bytes(contents)
            metadata = dependencies.build_image_metadata(
                image_bytes=contents,
                captured_at=(
                    media_item.creation_time.isoformat()
                    if media_item.creation_time
                    else None
                ),
            )
            created = dependencies.register_pending_artifact(
                db,
                file_hash=file_hash,
                source_path=f"google_photos:{media_item.id}",
                file_name=media_item.filename,
                image_blob=contents,
                image_mime_type=media_item.mime_type or "image/jpeg",
                metadata=metadata,
            )
            if not created:
                skipped += 1
                warnings.append(f"{media_item.filename} 已在待处理列表中，已跳过。")
                continue
            imported += 1
            imported_ids.append(created.id)

        db.commit()
        try:
            delete_google_photos_picker_session(session_id)
        except HTTPException:
            pass
        imported_rows = []
        if imported_ids:
            imported_rows = list(
                db.scalars(
                    select(PendingArtifact)
                    .where(PendingArtifact.id.in_(imported_ids))
                    .order_by(PendingArtifact.created_at.desc())
                )
            )
        return GooglePhotosImportRead(
            imported=imported,
            skipped=skipped,
            warnings=warnings,
            items=[PendingArtifactRead.model_validate(row) for row in imported_rows],
        )

    return router, GooglePhotosRouteHandlers(
        status=google_photos_status,
        config=google_photos_config,
        update_config=update_google_photos_config,
        delete_token=delete_google_photos_token,
        auth_start=google_photos_auth_start,
        auth_callback=google_photos_auth_callback,
        picker_session_create=google_photos_picker_session_create,
        picker_session_get=google_photos_picker_session_get,
        picker_session_delete=google_photos_picker_session_delete,
        picker_media_items=google_photos_picker_media_items,
        import_photos=google_photos_import,
    )
