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
    catalog_source_id: str | None = None
    catalog_exhibition_id: int | None = None


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


class MuseumDirectoryRead(BaseModel):
    id: int
    museum_id: int | None = None
    name: str
    location: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    description: str | None = None
    artifact_count: int = 0
    exhibition_count: int = 0
    catalog_exhibition_count: int = 0
    first_year: int | None = None
    last_year: int | None = None
    cover_url: str | None = None
    catalog_museum_name: str | None = None
    catalog_address: str | None = None
    catalog_venue: str | None = None
    catalog_city: str | None = None
    catalog_region: str | None = None
    derived_from_catalog: bool = False
    exhibitions: list[ExhibitionRead] = Field(default_factory=list)


class EraOptionRead(BaseModel):
    id: int
    name: str
    sort_order: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class EraTimelineItemRead(BaseModel):
    name: str
    aliases: list[str] = Field(default_factory=list)
    count: int = 0


class EraTimelineRead(BaseModel):
    eras: list[EraTimelineItemRead] = Field(default_factory=list)
    selected_era: str | None = None
    artifacts: list["ArtifactRead"] = Field(default_factory=list)


class ArtifactImageCreate(BaseModel):
    url: str
    camera_model: str | None = None
    lens_model: str | None = None
    capture_museum_name: str | None = None
    exhibition_name: str | None = None
    catalog_exhibition_source_id: str | None = None
    catalog_exhibition_id: int | None = None
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
    catalog_exhibition_source_id: str | None = None
    catalog_exhibition_id: int | None = None
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
    catalog_exhibition_source_id: str | None = None
    catalog_exhibition_id: int | None = None
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
    duplicate_image_skipped: bool = False
    duplicate_image_replaced: bool = False
    duplicate_image_detail: str | None = None

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
    preview_data_url: str | None = None
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


class ParsedArtifactNameRead(BaseModel):
    original_name: str
    normalized_name: str
    era: str | None = None
    artifact_name: str | None = None
    museum_name: str | None = None
    Place_of_Excavation: str | None = None
    catalog_no: str | None = None


class ArtifactDescriptionGenerateRequest(BaseModel):
    image_url: str | None = None
    museum_name: str | None = None
    name: str
    era: str | None = None
    Place_of_Excavation: str | None = None


class SearchHitRead(BaseModel):
    title: str
    url: str
    snippet: str = ""
    source: str | None = None


class ArtifactFieldWarningRead(BaseModel):
    field: str
    label: str
    input_value: str = ""
    suggested_value: str | None = None
    reason: str
    source_refs: list[str] = Field(default_factory=list)


class ArtifactVerifiedClaimRead(BaseModel):
    text: str
    source_refs: list[str] = Field(default_factory=list)


class ArtifactDescriptionCandidateRead(BaseModel):
    provider: str
    model: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    reasoning: str | None = None
    research_summary: str | None = None
    field_warnings: list[ArtifactFieldWarningRead] = Field(default_factory=list)
    verified_claims: list[ArtifactVerifiedClaimRead] = Field(default_factory=list)
    search_hits: list[SearchHitRead] = Field(default_factory=list)
    status: str = "success"
    error: str | None = None


class ArtifactDescriptionGenerateRead(BaseModel):
    provider: str
    model: str
    description: str
    tags: list[str] = Field(default_factory=list)
    reasoning: str | None = None
    research_id: str | None = None
    candidates: list[ArtifactDescriptionCandidateRead] = Field(default_factory=list)
    unavailable_providers: list[str] = Field(default_factory=list)


class ExifArtifactSubmitRequest(BaseModel):
    image_url: str
    museum_name: str
    name: str
    era: str | None = None
    Place_of_Excavation: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    display_location_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    existing_artifact_id: int | None = None
    skip_existing_match: bool = False


class VisionAnalyzeRequest(BaseModel):
    image_urls: list[str] = Field(default_factory=list)
    image_name: str | None = None


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


class GooglePhotosStatusRead(BaseModel):
    enabled: bool
    auth_configured: bool
    connected: bool
    detail: str | None = None


class GooglePhotosConfigRead(BaseModel):
    client_id: str = ""
    redirect_uri: str = ""
    has_client_secret: bool = False


class GooglePhotosConfigUpdate(BaseModel):
    client_id: str
    client_secret: str
    redirect_uri: str


class GooglePhotosAuthStartRead(BaseModel):
    auth_url: str


class GooglePhotosPickerSessionCreate(BaseModel):
    max_item_count: int = Field(default=200, ge=1, le=2000)


class GooglePhotosPickerSessionRead(BaseModel):
    id: str
    picker_uri: str
    media_items_set: bool = False
    poll_interval_ms: int | None = None
    timeout_in_ms: int | None = None
    expire_time: datetime | None = None


class GooglePhotosMediaItemRead(BaseModel):
    id: str
    filename: str
    base_url: str
    product_url: str | None = None
    mime_type: str | None = None
    width: int | None = None
    height: int | None = None
    creation_time: datetime | None = None
    thumbnail_url: str | None = None


class GooglePhotosMediaListRead(BaseModel):
    items: list[GooglePhotosMediaItemRead] = Field(default_factory=list)
    next_page_token: str | None = None


class GooglePhotosImportRequest(BaseModel):
    session_id: str
    media_item_ids: list[str] = Field(default_factory=list)


class GooglePhotosImportRead(BaseModel):
    imported: int
    skipped: int
    warnings: list[str] = Field(default_factory=list)
    items: list["PendingArtifactRead"] = Field(default_factory=list)


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
    Place_of_Excavation: str | None = None
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
    Place_of_Excavation: str | None = None
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


class PendingArtifactSubmitResult(BaseModel):
    item: PendingArtifactRead
    duplicate_image_skipped: bool = False
    duplicate_image_replaced: bool = False
    duplicate_image_detail: str | None = None
