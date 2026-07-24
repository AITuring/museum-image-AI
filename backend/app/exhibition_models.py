from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.exhibition_db import ExhibitionCatalogBase


class CatalogExhibition(ExhibitionCatalogBase):
    __tablename__ = "catalog_exhibitions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    source_id: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    source_url: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    source_name: Mapped[str] = mapped_column(String(64), default="iMuseum", nullable=False)

    title: Mapped[str] = mapped_column(String(500), nullable=False, index=True)
    region: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    city: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    city_slug: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    venue: Mapped[str | None] = mapped_column(String(500), nullable=True, index=True)
    address: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    start_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    start_year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    end_year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    is_permanent: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    opening_hours: Mapped[str | None] = mapped_column(String(255), nullable=True)
    fee: Mapped[str | None] = mapped_column(String(255), nullable=True)

    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_urls: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    cover_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    source_time_text: Mapped[str | None] = mapped_column(String(500), nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    @property
    def status(self) -> str:
        today = date.today()
        if self.is_permanent:
            return "permanent"
        if self.start_date and self.start_date > today:
            return "upcoming"
        if self.end_date and self.end_date < today:
            return "ended"
        return "ongoing"


class ExhibitionSyncRun(ExhibitionCatalogBase):
    __tablename__ = "exhibition_sync_runs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    trigger: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    discovered: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    attempted: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    updated: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ExhibitionSyncWorkerState(ExhibitionCatalogBase):
    __tablename__ = "exhibition_sync_worker_state"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="starting")
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    heartbeat_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
