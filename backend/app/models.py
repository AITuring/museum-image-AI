from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Museum(Base):
    __tablename__ = "museums"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    artifacts: Mapped[list["Artifact"]] = relationship(
        back_populates="museum", cascade="all, delete-orphan"
    )
    exhibitions: Mapped[list["Exhibition"]] = relationship(
        back_populates="museum", cascade="all, delete-orphan"
    )
    captured_images: Mapped[list["ArtifactImage"]] = relationship(
        back_populates="capture_museum"
    )

    @property
    def artifact_count(self) -> int:
        return len(self.artifacts)

    @property
    def exhibition_count(self) -> int:
        return len(self.exhibitions)


class EraOption(Base):
    __tablename__ = "era_options"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    museum_id: Mapped[int] = mapped_column(ForeignKey("museums.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    era: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    Place_of_Excavation: Mapped[str | None] = mapped_column("Place_of_Excavation", String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    museum: Mapped[Museum] = relationship(back_populates="artifacts")
    tags: Mapped[list["ArtifactTag"]] = relationship(
        back_populates="artifact", cascade="all, delete-orphan"
    )
    images: Mapped[list["ArtifactImage"]] = relationship(
        back_populates="artifact", cascade="all, delete-orphan"
    )
    exhibition_links: Mapped[list["ArtifactExhibition"]] = relationship(
        back_populates="artifact", cascade="all, delete-orphan"
    )

    @property
    def museum_name(self) -> str:
        return self.museum.name

    @property
    def tag_names(self) -> list[str]:
        return [tag.name for tag in self.tags]

    @property
    def exhibition_records(self) -> list["Exhibition"]:
        return [link.exhibition for link in self.exhibition_links]


class ArtifactTag(Base):
    __tablename__ = "artifact_tags"
    __table_args__ = (UniqueConstraint("artifact_id", "name", name="uq_artifact_tag_name"),)

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    artifact_id: Mapped[int] = mapped_column(
        ForeignKey("artifacts.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)

    artifact: Mapped[Artifact] = relationship(back_populates="tags")


class Exhibition(Base):
    __tablename__ = "exhibitions"
    __table_args__ = (UniqueConstraint("museum_id", "name", name="uq_exhibition_museum_name"),)

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    museum_id: Mapped[int] = mapped_column(ForeignKey("museums.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    museum: Mapped[Museum] = relationship(back_populates="exhibitions")
    artifact_links: Mapped[list["ArtifactExhibition"]] = relationship(
        back_populates="exhibition", cascade="all, delete-orphan"
    )
    images: Mapped[list["ArtifactImage"]] = relationship(back_populates="exhibition")

    @property
    def museum_name(self) -> str:
        return self.museum.name


class ArtifactExhibition(Base):
    __tablename__ = "artifact_exhibitions"
    __table_args__ = (
        UniqueConstraint("artifact_id", "exhibition_id", name="uq_artifact_exhibition"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    artifact_id: Mapped[int] = mapped_column(
        ForeignKey("artifacts.id"), nullable=False, index=True
    )
    exhibition_id: Mapped[int] = mapped_column(
        ForeignKey("exhibitions.id"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    artifact: Mapped[Artifact] = relationship(back_populates="exhibition_links")
    exhibition: Mapped[Exhibition] = relationship(back_populates="artifact_links")


class PendingArtifact(Base):
    """Local-only staging table for the batch identification workflow.

    One row per scanned image. The qwen bridge fills the identification fields; the
    operator edits them and submits each row to the cloud. Deduplicated by file hash so
    re-scanning a directory is idempotent and runs can resume.
    """

    __tablename__ = "pending_artifacts"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    source_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    file_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    file_name: Mapped[str] = mapped_column(String(512), nullable=False)
    image_blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    image_mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # pending -> identifying -> identified -> submitting -> submitted ; or failed
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False, index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Editable identification fields (seeded by the qwen bridge).
    museum_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    era: Mapped[str | None] = mapped_column(String(255), nullable=True)
    Place_of_Excavation: Mapped[str | None] = mapped_column("Place_of_Excavation", String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    camera_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lens_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    capture_museum_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    exhibition_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    capture_location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    shutter_speed: Mapped[str | None] = mapped_column(String(64), nullable=True)
    aperture: Mapped[str | None] = mapped_column(String(64), nullable=True)
    iso: Mapped[int | None] = mapped_column(Integer, nullable=True)
    edit_method: Mapped[str | None] = mapped_column(String(32), nullable=True)

    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    analysis: Mapped[str | None] = mapped_column(Text, nullable=True)

    existing_artifact_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cloud_artifact_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ArtifactImage(Base):
    __tablename__ = "artifact_images"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    artifact_id: Mapped[int] = mapped_column(
        ForeignKey("artifacts.id"), nullable=False, index=True
    )
    url: Mapped[str] = mapped_column(String(512), nullable=False)
    image_hash: Mapped[str | None] = mapped_column(String(64), unique=True, index=True, nullable=True)
    # Perceptual image-content fingerprint, stable across JPEG/EXIF rewrites.
    content_hash: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    # Hash of the bytes before the current Museum EXIF write.
    source_hash: Mapped[str | None] = mapped_column(String(64), unique=True, index=True, nullable=True)
    camera_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lens_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    capture_museum_id: Mapped[int | None] = mapped_column(
        ForeignKey("museums.id"), nullable=True, index=True
    )
    exhibition_id: Mapped[int | None] = mapped_column(
        ForeignKey("exhibitions.id"), nullable=True, index=True
    )
    capture_location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    shutter_speed: Mapped[str | None] = mapped_column(String(64), nullable=True)
    aperture: Mapped[str | None] = mapped_column(String(64), nullable=True)
    iso: Mapped[int | None] = mapped_column(Integer, nullable=True)
    edit_method: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    artifact: Mapped[Artifact] = relationship(back_populates="images")
    capture_museum: Mapped[Museum | None] = relationship(back_populates="captured_images")
    exhibition: Mapped[Exhibition | None] = relationship(back_populates="images")

    @property
    def artifact_name(self) -> str:
        return self.artifact.name

    @property
    def museum_name(self) -> str:
        return self.artifact.museum.name

    @property
    def era(self) -> str | None:
        return self.artifact.era

    @property
    def uploaded_at(self) -> datetime:
        return self.created_at

    @property
    def capture_museum_name(self) -> str | None:
        return self.capture_museum.name if self.capture_museum is not None else None

    @property
    def exhibition_name(self) -> str | None:
        return self.exhibition.name if self.exhibition is not None else None
