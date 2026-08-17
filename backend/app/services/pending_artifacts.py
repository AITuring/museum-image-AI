import json
import mimetypes
import tempfile
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PendingArtifact


def scan_pending_items(db: Session) -> list[PendingArtifact]:
    return list(
        db.scalars(select(PendingArtifact).order_by(PendingArtifact.created_at.desc()))
    )


def register_pending_artifact(
    db: Session,
    *,
    file_hash: str,
    source_path: str,
    file_name: str,
    image_blob: bytes | None = None,
    image_mime_type: str | None = None,
    metadata: dict[str, object | None] | None = None,
) -> PendingArtifact | None:
    existing = db.scalar(
        select(PendingArtifact).where(PendingArtifact.file_hash == file_hash)
    )
    if existing is not None:
        return None
    row = PendingArtifact(
        source_path=source_path,
        file_hash=file_hash,
        file_name=file_name,
        image_blob=image_blob,
        image_mime_type=image_mime_type,
        status="pending",
        tags=[],
        **(metadata or {}),
    )
    db.add(row)
    db.flush()
    return row


def materialize_pending_artifact_image(
    row: PendingArtifact,
) -> tuple[Path, Path | None]:
    if row.image_blob:
        suffix = Path(row.file_name).suffix.lower() or ".jpg"
        temporary_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        temporary_file.write(row.image_blob)
        temporary_file.close()
        temporary_path = Path(temporary_file.name)
        return temporary_path, temporary_path
    path = Path(row.source_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="原图文件已不存在。")
    return path, None


def pending_artifact_image_bytes(row: PendingArtifact) -> tuple[bytes, str]:
    if row.image_blob:
        content_type = (
            row.image_mime_type
            or mimetypes.guess_type(row.file_name)[0]
            or "image/jpeg"
        )
        return row.image_blob, content_type
    path = Path(row.source_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="原图文件已不存在。")
    content_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    return path.read_bytes(), content_type


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
