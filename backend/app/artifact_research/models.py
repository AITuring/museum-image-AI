from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, DateTime, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def new_uuid() -> str:
    return str(uuid4())


class ArtifactResearchRecord(Base):
    __tablename__ = "artifact_research_records"
    __table_args__ = (
        UniqueConstraint(
            "query_hash",
            "agent_version",
            name="uq_artifact_research_query_version",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    query_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    agent_version: Mapped[str] = mapped_column(String(64), nullable=False)
    query_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    result_json: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
