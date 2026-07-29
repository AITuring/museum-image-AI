import type { ArtifactFieldWarning } from "./ReviewIndicators"

export type ParsedArtifactName = {
  original_name: string
  normalized_name: string
  era: string | null
  artifact_name: string | null
  museum_name: string | null
  Place_of_Excavation: string | null
  catalog_no: string | null
}

export type VerifiedClaim = { text: string; source_refs: string[] }

export type DescriptionSearchHit = {
  title: string
  url: string
  snippet: string
  source: string | null
}

export type DescriptionCandidate = {
  provider: string
  model: string
  description: string
  tags: string[]
  reasoning: string | null
  research_summary?: string | null
  field_warnings?: ArtifactFieldWarning[]
  verified_claims?: VerifiedClaim[]
  search_hits?: DescriptionSearchHit[]
  status: string
  error: string | null
}

export type LiveProviderState = {
  model: string
  status: "running" | "complete" | "error"
  reasoning: string
  message: string
  descriptionLength: number
  tagCount: number
}

export type GeneratedDescription = {
  provider: string
  model: string
  description: string
  tags: string[]
  reasoning: string | null
  research_id?: string | null
  candidates: DescriptionCandidate[]
  unavailable_providers: string[]
}

export type MuseumOption = {
  id: number
  name: string
  latitude: number | null
  longitude: number | null
}

export type ExhibitionRecommendation = {
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
  match_score: number
  match_reasons: string[]
  distance_km: number | null
}

export type SubmitNotice = { type: "success" | "error"; text: string }
export type UploadActivity = "files" | "directory" | null
export type ArtifactSubmitResult = {
  duplicate_image_skipped?: boolean
  duplicate_image_replaced?: boolean
  duplicate_image_detail?: string | null
  reconciled_after_timeout?: boolean
}

export type ExistingArtifactImage = {
  url: string
  capture_museum_name: string | null
  exhibition_name: string | null
  catalog_exhibition_source_id: string | null
  catalog_exhibition_id: number | null
  capture_location: string | null
  latitude: number | null
  longitude: number | null
}

export type ExistingArtifact = {
  id: number
  museum_name: string
  name: string
  era: string | null
  Place_of_Excavation: string | null
  description: string | null
  tags: string[]
  images: ExistingArtifactImage[]
}

export type ExistingArtifactMatch = {
  artifact: ExistingArtifact
  match_score: number
  match_reason: string
}

export type FormState = {
  museumName: string
  name: string
  era: string
  placeOfExcavation: string
  displayLocationName: string
  exhibitionName: string
  catalogExhibitionId: number | null
  catalogExhibitionSourceId: string
  latitude: string
  longitude: string
  cameraModel: string
  lensModel: string
  capturedAt: string
  shutterSpeed: string
  aperture: string
  iso: string
  description: string
  tags: string[]
}

export type ImageExifMetadata = {
  camera_model: string | null
  lens_model: string | null
  captured_at: string | null
  shutter_speed: string | null
  aperture: string | null
  iso: number | null
  latitude: number | null
  longitude: number | null
  preview_data_url: string | null
}

export type WritableFileStream = {
  write(data: Blob): Promise<void>
  close(): Promise<void>
}

export type WritableFileHandle = {
  kind?: "file"
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<WritableFileStream>
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
}

export type WritableDirectoryHandle = {
  kind?: "directory"
  name: string
  values(): AsyncIterableIterator<WritableFileHandle | WritableDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFileHandle>
  removeEntry(name: string): Promise<void>
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
}

export type FilePickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<WritableDirectoryHandle>
  showOpenFilePicker?: (options: {
    multiple: boolean
    types: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<WritableFileHandle[]>
}

export type ExifWorkbenchItem = {
  id: string
  fileName: string
  originalFileName: string
  previewUrl: string
  localFile: File
  fileHandle: WritableFileHandle | null
  parsedName: ParsedArtifactName | null
  form: FormState
  originalForm: FormState
  candidates: DescriptionCandidate[]
  unavailableProviders: string[]
  descriptionMeta: string | null
  existingArtifactId: number | null
  existingArtifactMatch: string | null
  existingArtifactCandidates: ExistingArtifactMatch[]
  existingArtifactReviewKey: string | null
  verificationDecisions?: Record<string, "accepted" | "rejected">
  submitState: "idle" | "submitting" | "submitted" | "error"
  submitMessage: string | null
  uploadProgress: number
  uploadStage: string | null
  sourceHash: string | null
}

export type PersistedExifDraftItem = Omit<ExifWorkbenchItem, "previewUrl" | "fileHandle"> & {
  previewUrl?: never
  fileHandle?: never
}

export type PersistedExifDraft = {
  version: 1
  items: PersistedExifDraftItem[]
  selectedId: string | null
  sharedForm: FormState
}

export type ReuploadHint = {
  version: 1
  form: FormState
  existingArtifactId: number | null
  updatedAt: string
}
