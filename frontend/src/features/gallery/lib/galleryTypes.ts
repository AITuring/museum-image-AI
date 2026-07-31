export type GalleryImage = {
  id: number
  artifact_id?: number | null
  exhibition_id?: number | null
  url: string
  camera_model?: string | null
  lens_model?: string | null
  capture_museum_name?: string | null
  exhibition_name?: string | null
  catalog_exhibition_source_id?: string | null
  catalog_exhibition_id?: number | null
  capture_location?: string | null
  latitude?: number | null
  longitude?: number | null
  captured_at?: string | null
  uploaded_at?: string | null
  shutter_speed?: string | null
  aperture?: string | null
  iso?: number | null
  edit_method?: string | null
}

export type GalleryArtifact = {
  id: number
  name: string
  era: string | null
  Place_of_Excavation?: string | null
  description: string | null
  museum_name: string
  tags: string[]
  exhibitions: Array<{
    id: number
    museum_name: string
    name: string
    start_at: string | null
    end_at: string | null
    catalog_source_id?: string | null
    catalog_exhibition_id?: number | null
  }>
  images: GalleryImage[]
}
