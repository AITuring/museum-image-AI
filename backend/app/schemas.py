from datetime import datetime

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class MuseumCreate(BaseModel):
    name: str
    location: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    description: str | None = None


class MuseumUpdate(BaseModel):
    name: str
    location: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    description: str | None = None


class ExhibitionCreate(BaseModel):
    museum_id: int
    name: str
    start_at: datetime | None = None
    end_at: datetime | None = None


class ExhibitionRead(ExhibitionCreate):
    id: int
    museum_name: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MuseumRead(MuseumCreate):
    id: int
    created_at: datetime
    artifact_count: int = 0
    exhibition_count: int = 0
    exhibitions: list[ExhibitionRead] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class EraOptionRead(BaseModel):
    id: int
    name: str
    sort_order: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ArtifactImageCreate(BaseModel):
    url: str
    camera_model: str | None = None
    lens_model: str | None = None
    capture_museum_name: str | None = None
    exhibition_name: str | None = None
    capture_location: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    captured_at: datetime | None = None
    shutter_speed: str | None = None
    aperture: str | None = None
    iso: int | None = None
    edit_method: str | None = None


class ArtifactImageRead(ArtifactImageCreate):
    id: int
    artifact_id: int
    artifact_name: str
    museum_name: str
    era: str | None = None
    created_at: datetime
    uploaded_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ArtifactCreate(BaseModel):
    museum_id: int
    name: str
    era: str | None = None
    Place_of_Excavation: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    images: list[ArtifactImageCreate] = Field(default_factory=list)


class ArtifactUpdate(BaseModel):
    museum_name: str
    name: str
    era: str | None = None
    Place_of_Excavation: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    image_id: int | None = None
    camera_model: str | None = None
    lens_model: str | None = None
    capture_museum_name: str | None = None
    exhibition_name: str | None = "常设"
    capture_location: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    captured_at: datetime | None = None
    shutter_speed: str | None = None
    aperture: str | None = None
    iso: int | None = None
    edit_method: str | None = None


class CloudArtifactSubmitRequest(BaseModel):
    image_url: str
    museum_name: str
    name: str
    era: str | None = None
    Place_of_Excavation: str | None = None
    description: str | None = None
    existing_artifact_id: int | None = None
    skip_existing_match: bool = False
    tags: list[str] = Field(default_factory=list)
    camera_model: str | None = None
    lens_model: str | None = None
    capture_museum_name: str | None = None
    exhibition_name: str | None = "常设"
    capture_location: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    captured_at: datetime | None = None
    shutter_speed: str | None = None
    aperture: str | None = None
    iso: int | None = None
    edit_method: str | None = None


class ArtifactRead(BaseModel):
    id: int
    museum_id: int
    name: str
    era: str | None = None
    Place_of_Excavation: str | None = None
    description: str | None = None
    created_at: datetime
    museum_name: str
    tags: list[str] = Field(
        default_factory=list, validation_alias=AliasChoices("tag_names", "tags")
    )
    images: list[ArtifactImageRead] = Field(default_factory=list)
    exhibitions: list[ExhibitionRead] = Field(
        default_factory=list,
        validation_alias=AliasChoices("exhibition_records", "exhibitions"),
    )

    model_config = ConfigDict(from_attributes=True)


class ArtifactMatchRead(BaseModel):
    artifact: ArtifactRead
    match_score: float
    match_reason: str


class ArtifactImageAttach(ArtifactImageCreate):
    artifact_id: int


class UploadedImageRead(BaseModel):
    filename: str
    url: str
    uploaded_at: datetime
    camera_model: str | None = None
    lens_model: str | None = None
    capture_museum_name: str | None = None
    exhibition_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    captured_at: datetime | None = None
    shutter_speed: str | None = None
    aperture: str | None = None
    iso: int | None = None
    edit_method: str | None = None


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


class WebBridgeStatusRead(BaseModel):
    enabled: bool
    site_key: str | None = None
    site_label: str | None = None
    login_required: bool = False
    auto_login_supported: bool = False
    login_command: str | None = None
    detail: str | None = None


class WebBridgeLoginStartRead(BaseModel):
    started: bool
    detail: str
    login_command: str | None = None


# ── Batch identification (local side) ────────────────────────────────────────────


class BatchScanRequest(BaseModel):
    directory: str
    # Optional override of recognized extensions (lowercase, with dot).
    extensions: list[str] = Field(default_factory=list)


class PendingArtifactRead(BaseModel):
    id: int
    source_path: str
    file_name: str
    status: str
    error: str | None = None
    museum_name: str | None = None
    name: str | None = None
    era: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    camera_model: str | None = None
    lens_model: str | None = None
    capture_museum_name: str | None = None
    exhibition_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    captured_at: datetime | None = None
    shutter_speed: str | None = None
    aperture: str | None = None
    iso: int | None = None
    edit_method: str | None = None
    confidence: float | None = None
    provider: str | None = None
    analysis: str | None = None
    existing_artifact_id: int | None = None
    cloud_artifact_id: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BatchScanResponse(BaseModel):
    scanned: int
    added: int
    skipped: int
    items: list[PendingArtifactRead] = Field(default_factory=list)


class PendingArtifactUpdate(BaseModel):
    museum_name: str | None = None
    name: str | None = None
    era: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    camera_model: str | None = None
    lens_model: str | None = None
    capture_museum_name: str | None = None
    exhibition_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    captured_at: datetime | None = None
    shutter_speed: str | None = None
    aperture: str | None = None
    iso: int | None = None
    edit_method: str | None = None
    existing_artifact_id: int | None = None


class BatchIdentifyRequest(BaseModel):
    # Specific pending ids to (re)identify; empty = all rows in pending/failed state.
    ids: list[int] = Field(default_factory=list)


class PendingArtifactSubmitRequest(BaseModel):
    skip_existing_match: bool = False
