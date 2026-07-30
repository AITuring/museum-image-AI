import { compactArtifactNameForMatch, normalizeIdentityText } from "./galleryArtifactIdentity"
import { isFloorLabel } from "./galleryEditorHelpers"
import type { GalleryEditFormState } from "./galleryEditorTypes"
import type { GalleryArtifact, GalleryImage } from "./galleryTypes"

export type RawGalleryArtifact = Omit<GalleryArtifact, "tags" | "images" | "exhibitions"> & {
  tags?: string[]
  images?: GalleryImage[]
  exhibitions?: GalleryArtifact["exhibitions"]
}

export function getGalleryImageFilename(url: string, index: number) {
  const cleanUrl = url.split(/[?#]/, 1)[0]
  const encodedName = cleanUrl.split("/").filter(Boolean).at(-1)
  if (!encodedName) return `image-${index + 1}`
  try {
    return decodeURIComponent(encodedName)
  } catch {
    return encodedName
  }
}

function galleryArtifactMergeKey(artifact: GalleryArtifact) {
  const museumKey = normalizeIdentityText(artifact.museum_name)
  const eraKey = normalizeIdentityText(artifact.era)
  const nameKey = compactArtifactNameForMatch(artifact.name)
  return museumKey && eraKey && nameKey ? `${museumKey}\u0000${eraKey}\u0000${nameKey}` : null
}

export function normalizeTags(tags: string[]) {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const rawTag of tags) {
    const tag = rawTag.trim()
    if (!tag || seen.has(tag)) {
      continue
    }
    seen.add(tag)
    normalized.push(tag)
  }
  return normalized
}

export function getSubjectTags(tags: string[]) {
  return tags.filter((tag) => !/^(机型|镜头)[:：]/.test(tag))
}

export function mergeGalleryArtifacts(items: GalleryArtifact[]) {
  const merged: GalleryArtifact[] = []
  const keyedIndexes = new Map<string, number>()

  for (const item of items) {
    const key = galleryArtifactMergeKey(item)
    if (!key) {
      merged.push(item)
      continue
    }

    const existingIndex = keyedIndexes.get(key)
    if (existingIndex === undefined) {
      keyedIndexes.set(key, merged.length)
      merged.push(item)
      continue
    }

    const existing = merged[existingIndex]
    const imagesById = new Map(existing.images.map((image) => [image.id, image]))
    item.images.forEach((image) => {
      if (!imagesById.has(image.id)) imagesById.set(image.id, image)
    })

    const exhibitionsById = new Map(existing.exhibitions.map((exhibition) => [exhibition.id, exhibition]))
    item.exhibitions.forEach((exhibition) => {
      if (!exhibitionsById.has(exhibition.id)) exhibitionsById.set(exhibition.id, exhibition)
    })

    merged[existingIndex] = {
      ...existing,
      description: existing.description || item.description,
      Place_of_Excavation: existing.Place_of_Excavation || item.Place_of_Excavation,
      tags: normalizeTags([...existing.tags, ...item.tags]),
      images: Array.from(imagesById.values()).sort((left, right) => {
        const leftTime = left.uploaded_at ? Date.parse(left.uploaded_at) : 0
        const rightTime = right.uploaded_at ? Date.parse(right.uploaded_at) : 0
        return rightTime - leftTime || right.id - left.id
      }),
      exhibitions: Array.from(exhibitionsById.values()).sort((left, right) => {
        const leftTime = left.start_at ? Date.parse(left.start_at) : 0
        const rightTime = right.start_at ? Date.parse(right.start_at) : 0
        return rightTime - leftTime || right.id - left.id
      }),
    }
  }

  return merged
}

export function normalizeArtifact(item: RawGalleryArtifact): GalleryArtifact {
  return {
    ...item,
    tags: Array.isArray(item.tags) ? item.tags : [],
    images: Array.isArray(item.images) ? item.images : [],
    exhibitions: Array.isArray(item.exhibitions) ? item.exhibitions : [],
  }
}

export function getGalleryArtifactIdFromLocation() {
  const routeMatch = window.location.pathname.match(/^\/gallery\/(\d+)$/)
  const routeId = routeMatch ? Number(routeMatch[1]) : Number.NaN
  if (Number.isInteger(routeId) && routeId > 0) return routeId

  const legacyValue = new URLSearchParams(window.location.search).get("artifact")
  const legacyId = legacyValue ? Number(legacyValue) : Number.NaN
  return Number.isInteger(legacyId) && legacyId > 0 ? legacyId : null
}

export function getGalleryReturnTarget() {
  const params = new URLSearchParams(window.location.search)
  if (params.get("from") !== "eras") return { path: "/gallery", label: "图库" }
  const era = params.get("era")?.trim()
  const eraQuery = era ? `?${new URLSearchParams({ era }).toString()}` : ""
  return { path: `/eras${eraQuery}`, label: "时代" }
}

export function formatMetaDate(value?: string | null) {
  if (!value) return ""
  const normalized = value.replace("T", " ")
  return normalized.length >= 19 ? normalized.slice(0, 19) : normalized
}

export function formatMetaValue(value?: string | number | null) {
  if (value === null || value === undefined) return ""
  return String(value)
}

export function buildEditForm(artifact: GalleryArtifact, image?: GalleryImage | null): GalleryEditFormState {
  const storedCaptureMuseum = image?.capture_museum_name ?? ""
  // A floor is a venue detail, not a museum. Repair legacy catalog-derived
  // values in the editable form so saving corrects the persisted record.
  const captureMuseumName = isFloorLabel(storedCaptureMuseum) ? artifact.museum_name : storedCaptureMuseum

  return {
    museumName: artifact.museum_name ?? "",
    name: artifact.name ?? "",
    era: artifact.era ?? "",
    Place_of_Excavation: artifact.Place_of_Excavation ?? "",
    description: artifact.description ?? "",
    tags: getSubjectTags(artifact.tags),
    imageId: image?.id ?? null,
    cameraModel: image?.camera_model ?? "",
    lensModel: image?.lens_model ?? "",
    captureMuseumName,
    exhibitionName: image?.exhibition_name ?? "常设",
    catalogExhibitionSourceId: image?.catalog_exhibition_source_id ?? "",
    catalogExhibitionId: image?.catalog_exhibition_id ?? null,
    captureLocation: image?.capture_location ?? image?.capture_museum_name ?? artifact.museum_name ?? "",
    latitude: image?.latitude?.toString() ?? "",
    longitude: image?.longitude?.toString() ?? "",
    capturedAt: image?.captured_at ?? "",
    shutterSpeed: image?.shutter_speed ?? "",
    aperture: image?.aperture ?? "",
    iso: image?.iso?.toString() ?? "",
    editMethod: image?.edit_method ?? "",
  }
}

export function parseOptionalNumber(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label}格式不正确`)
  }
  return parsed
}
