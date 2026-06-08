from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Museum(Base):
    __tablename__ = "museums"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    artifacts: Mapped[list["Artifact"]] = relationship(
        back_populates="museum", cascade="all, delete-orphan"
    )


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    museum_id: Mapped[int] = mapped_column(ForeignKey("museums.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    era: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
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

    @property
    def museum_name(self) -> str:
        return self.museum.name

    @property
    def tag_names(self) -> list[str]:
        return [tag.name for tag in self.tags]


class ArtifactTag(Base):
    __tablename__ = "artifact_tags"
    __table_args__ = (UniqueConstraint("artifact_id", "name", name="uq_artifact_tag_name"),)

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    artifact_id: Mapped[int] = mapped_column(
        ForeignKey("artifacts.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)

    artifact: Mapped[Artifact] = relationship(back_populates="tags")


class ArtifactImage(Base):
    __tablename__ = "artifact_images"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    artifact_id: Mapped[int] = mapped_column(
        ForeignKey("artifacts.id"), nullable=False, index=True
    )
    url: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    artifact: Mapped[Artifact] = relationship(back_populates="images")

    @property
    def artifact_name(self) -> str:
        return self.artifact.name

    @property
    def museum_name(self) -> str:
        return self.artifact.museum.name

    @property
    def era(self) -> str | None:
        return self.artifact.era
