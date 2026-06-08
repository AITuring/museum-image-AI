from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class MuseumCreate(BaseModel):
    name: str
    location: str | None = None
    description: str | None = None


class MuseumRead(MuseumCreate):
    id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ArtifactImageCreate(BaseModel):
    url: str


class ArtifactImageRead(ArtifactImageCreate):
    id: int
    artifact_id: int
    artifact_name: str
    museum_name: str
    era: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ArtifactCreate(BaseModel):
    museum_id: int
    name: str
    era: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    images: list[ArtifactImageCreate] = Field(default_factory=list)


class ArtifactRead(BaseModel):
    id: int
    museum_id: int
    name: str
    era: str | None = None
    description: str | None = None
    created_at: datetime
    museum_name: str
    tags: list[str] = Field(default_factory=list, validation_alias="tag_names")
    images: list[ArtifactImageRead] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class ArtifactImageAttach(BaseModel):
    artifact_id: int
    url: str


class UploadedImageRead(BaseModel):
    filename: str
    url: str


class VisionAnalyzeRequest(BaseModel):
    image_urls: list[str] = Field(default_factory=list)
    image_name: str | None = None


class SearchHitRead(BaseModel):
    title: str
    url: str
    snippet: str = ""
    source: str | None = None


class VisionCandidateRead(BaseModel):
    provider: str
    model: str
    artifact_name: str
    era: str | None = None
    museum_name: str | None = None
    tags: list[str] = Field(default_factory=list)
    description: str = ""
    confidence: float | None = None
    analysis: str | None = None
    reasoning: str | None = None
    search_hits: list[SearchHitRead] = Field(default_factory=list)


class VisionAnalyzeResponse(BaseModel):
    candidates: list[VisionCandidateRead] = Field(default_factory=list)
    unavailable_providers: list[str] = Field(default_factory=list)
    failed_providers: list[str] = Field(default_factory=list)


class HealthRead(BaseModel):
    status: str
    environment: str
    database: str
