from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class ExhibitionCatalogItemRead(BaseModel):
    id: int
    source_id: str
    source_url: str
    source_name: str
    title: str
    region: str
    city: str
    venue: str | None = None
    address: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    start_year: int | None = None
    end_year: int | None = None
    is_permanent: bool
    opening_hours: str | None = None
    fee: str | None = None
    summary: str | None = None
    cover_url: str | None = None
    source_time_text: str | None = None
    synced_at: datetime
    status: str

    model_config = ConfigDict(from_attributes=True)


class ExhibitionFacetRead(BaseModel):
    value: str
    count: int


class ExhibitionYearFacetRead(BaseModel):
    year: int
    count: int


class ExhibitionCatalogListRead(BaseModel):
    items: list[ExhibitionCatalogItemRead] = Field(default_factory=list)
    total: int
    page: int
    page_size: int
    years: list[ExhibitionYearFacetRead] = Field(default_factory=list)
    regions: list[ExhibitionFacetRead] = Field(default_factory=list)
    cities: list[ExhibitionFacetRead] = Field(default_factory=list)
    last_synced_at: datetime | None = None
    backfill_remaining: int | None = None


class ExhibitionCatalogDetailRead(ExhibitionCatalogItemRead):
    description: str | None = None
    image_urls: list[str] = Field(default_factory=list)


class ExhibitionRecommendationRead(ExhibitionCatalogItemRead):
    match_score: int
    match_reasons: list[str] = Field(default_factory=list)
    distance_km: float | None = None


class ExhibitionArtifactSummaryRead(BaseModel):
    id: int
    name: str
    museum_name: str
    era: str | None = None
    cover_url: str | None = None
    captured_at: datetime | None = None


class HistoricalExhibitionDetailRead(BaseModel):
    name: str
    museum_name: str
    start_at: datetime | None = None
    end_at: datetime | None = None
    artifacts: list[ExhibitionArtifactSummaryRead] = Field(default_factory=list)


class ExhibitionSyncRunRead(BaseModel):
    id: int
    mode: str
    trigger: str
    status: str
    discovered: int
    attempted: int
    created: int
    updated: int
    failed: int
    error: str | None = None
    started_at: datetime
    completed_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class ExhibitionSyncStatusRead(BaseModel):
    catalog_total: int
    backfill_remaining: int | None = None
    processed: int = 0
    run: ExhibitionSyncRunRead | None = None


class ExhibitionSyncAcceptedRead(BaseModel):
    accepted: bool
    detail: str
    run: ExhibitionSyncRunRead | None = None
