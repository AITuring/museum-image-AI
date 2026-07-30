export type GalleryEditFormState = {
  museumName: string
  name: string
  era: string
  Place_of_Excavation: string
  description: string
  tags: string[]
  imageId: number | null
  cameraModel: string
  lensModel: string
  captureMuseumName: string
  exhibitionName: string
  catalogExhibitionSourceId: string
  catalogExhibitionId: number | null
  captureLocation: string
  latitude: string
  longitude: string
  capturedAt: string
  shutterSpeed: string
  aperture: string
  iso: string
  editMethod: string
}

export type HistoricalExhibitionDraft = {
  imageId: number
  artifactId: number
  captureMuseumName: string
  exhibitionName: string
  catalogSourceId: string
  catalogExhibitionId: number | null
  startAt: string | null
  endAt: string | null
}

export type HistoricalExhibitionGroup = HistoricalExhibitionDraft & { imageIds: number[] }

export type MuseumOption = {
  id: number
  name: string
}

export type EraOption = {
  id: number
  name: string
  sort_order: number
}

export type CatalogExhibitionOption = {
  id: number
  source_id: string
  title: string
  city: string
  museum_name: string | null
  venue: string | null
  address: string | null
  start_date: string | null
  end_date: string | null
  is_permanent: boolean
}

export type LocalExhibitionOption = {
  id: number
  museum_name: string
  name: string
  start_at: string | null
  end_at: string | null
  catalog_source_id: string | null
  catalog_exhibition_id: number | null
}

export type HistoricalExhibitionChoice = {
  key: string
  name: string
  museumName: string
  venue: string
  catalogSourceId: string
  catalogExhibitionId: number | null
  startAt: string | null
  endAt: string | null
  isPermanent: boolean
}
