from datetime import datetime

from pydantic import BaseModel, Field


class ArtifactResearchQuery(BaseModel):
    artifact_name: str = Field(min_length=1, max_length=512)
    era: str | None = Field(default=None, max_length=255)
    museum_name: str | None = Field(default=None, max_length=255)
    place_of_excavation: str | None = Field(default=None, max_length=512)


class ArtifactResearchRequest(ArtifactResearchQuery):
    force_refresh: bool = False
    knowledge_top_k: int = Field(default=8, ge=1, le=20)


class ArtifactResearchSourceRead(BaseModel):
    title: str
    url: str
    snippet: str = ""
    source: str | None = None
    source_type: str = "web"
    document_id: str | None = None
    page_start: int | None = None
    page_end: int | None = None
    score: float | None = None


class ArtifactResearchRead(BaseModel):
    research_id: str
    agent_version: str
    query: ArtifactResearchQuery
    search_queries: list[str] = Field(default_factory=list)
    web_sources: list[ArtifactResearchSourceRead] = Field(default_factory=list)
    knowledge_sources: list[ArtifactResearchSourceRead] = Field(default_factory=list)
    research_summary: str
    cached: bool = False
    created_at: datetime
