import type { ArtifactFieldWarning } from "../components/ReviewIndicators"
import type {
  DescriptionCandidate,
  ExifWorkbenchItem,
  FormState,
  ImageExifMetadata,
  VerifiedClaim,
} from "../components/types"
import { formatCapturedAt } from "./exifDisplay"

export function hasMeaningfulFormValue(form: FormState) {
  return Boolean(
    form.museumName.trim() ||
      form.name.trim() ||
      form.era.trim() ||
      form.placeOfExcavation.trim() ||
      form.displayLocationName.trim() ||
      form.exhibitionName.trim() ||
      form.latitude.trim() ||
      form.longitude.trim() ||
      form.cameraModel.trim() ||
      form.lensModel.trim() ||
      form.capturedAt.trim() ||
      form.shutterSpeed.trim() ||
      form.aperture.trim() ||
      form.iso.trim() ||
      form.description.trim() ||
      form.tags.length > 0,
  )
}

export function applySharedForm(current: FormState, shared: FormState): FormState {
  return {
    ...current,
    museumName: shared.museumName,
    name: shared.name,
    era: shared.era,
    placeOfExcavation: shared.placeOfExcavation,
    displayLocationName: shared.displayLocationName,
    exhibitionName: shared.exhibitionName,
    catalogExhibitionId: shared.catalogExhibitionId,
    catalogExhibitionSourceId: shared.catalogExhibitionSourceId,
    latitude: shared.latitude,
    longitude: shared.longitude,
    description: shared.description,
    tags: [...shared.tags],
  }
}

export function buildItemId(file: File, index: number) {
  return `${file.name}-${file.lastModified}-${index}`
}

export function uniqueTags(tags: string[]) {
  return Array.from(new Set(tags.map((item) => item.trim()).filter(Boolean)))
}

export function ensureCandidates(value: DescriptionCandidate[] | undefined | null): DescriptionCandidate[] {
  return Array.isArray(value)
    ? value.map((candidate) => {
        const normalized = normalizeVerifiedClaims(candidate.description, candidate.verified_claims)
        return {
          ...candidate,
          description: normalized.description,
          field_warnings: ensureFieldWarnings(candidate.field_warnings),
          verified_claims: normalized.claims,
          search_hits: Array.isArray(candidate.search_hits) ? candidate.search_hits : [],
        }
      })
    : []
}

export function normalizeVerifiedClaims(description: string, value: unknown) {
  const claims: VerifiedClaim[] = Array.isArray(value)
    ? value.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const claim = item as Partial<VerifiedClaim>
        const text = String(claim.text || "").replace(/\[(?:联网核验|来源\d+)\]/g, "").trim()
        if (!text) return []
        return [{
          text: /[。！？]$/.test(text) ? text : `${text}。`,
          source_refs: ensureStringList(claim.source_refs),
        }]
      })
    : []
  const legacyPattern = /([^。！？\n]+?)\[联网核验\]([。！？]?)/g
  const cleanDescription = description.replace(legacyPattern, (_match, rawClaim: string, punctuation: string) => {
    const text = rawClaim.trim().replace(/^[，,；;\s]+/, "")
    if (text) {
      const normalizedText = `${text}${punctuation || "。"}`
      if (!claims.some((claim) => claim.text === normalizedText)) {
        claims.push({ text: normalizedText, source_refs: ["联网核验"] })
      }
    }
    return ""
  }).replace(/\[联网核验\]/g, "").replace(/\n{3,}/g, "\n\n").trim()
  return { description: cleanDescription, claims }
}

export function ensureFieldWarnings(value: unknown): ArtifactFieldWarning[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const warning = item as Partial<ArtifactFieldWarning>
    if (!warning.field || !warning.reason) return []
    return [{
      field: String(warning.field),
      label: String(warning.label || warning.field),
      input_value: String(warning.input_value || ""),
      suggested_value: warning.suggested_value ? String(warning.suggested_value) : null,
      reason: String(warning.reason),
      source_refs: ensureStringList(warning.source_refs),
    }]
  })
}

export function ensureStringList(value: string[] | undefined | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function researchSourceUrl(apiBaseUrl: string, url: string) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url
  return `${apiBaseUrl}${url.startsWith("/") ? url : `/${url}`}`
}

export function toNullableNumber(value: string) {
  const text = value.trim()
  if (!text) {
    return null
  }
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

export function hasValidGpsCoordinates(latitude: string, longitude: string) {
  const lat = toNullableNumber(latitude)
  const lng = toNullableNumber(longitude)
  return lat !== null
    && lng !== null
    && Math.abs(lat) <= 90
    && Math.abs(lng) <= 180
}

export function exposureSeconds(value: string | null | undefined) {
  const text = (value ?? "").trim().toLowerCase().replace(/s$/, "")
  if (!text) return null
  if (text.includes("/")) {
    const [numerator, denominator] = text.split("/", 2).map(Number)
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
      ? numerator / denominator
      : null
  }
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

export function apertureNumber(value: string | null | undefined) {
  const numeric = Number((value ?? "").trim().toLowerCase().replace(/^f\//, ""))
  return Number.isFinite(numeric) ? numeric : null
}

export function assertWrittenExif(metadata: ImageExifMetadata, form: FormState) {
  const expectedLatitude = toNullableNumber(form.latitude)
  const expectedLongitude = toNullableNumber(form.longitude)
  if (
    expectedLatitude !== null
    && expectedLongitude !== null
    && (
      metadata.latitude === null
      || metadata.longitude === null
      || Math.abs(metadata.latitude - expectedLatitude) > 0.00001
      || Math.abs(metadata.longitude - expectedLongitude) > 0.00001
    )
  ) {
    throw new Error("本地图片 GPS 写入校验失败")
  }

  if ((metadata.camera_model ?? "").trim() !== form.cameraModel.trim()) {
    throw new Error("本地图片相机型号写入校验失败")
  }
  if ((metadata.lens_model ?? "").trim() !== form.lensModel.trim()) {
    throw new Error("本地图片镜头型号写入校验失败")
  }
  if (
    form.capturedAt.trim()
    && formatCapturedAt(metadata.captured_at) !== formatCapturedAt(form.capturedAt)
  ) {
    throw new Error("本地图片拍摄时间写入校验失败")
  }

  const expectedShutter = exposureSeconds(form.shutterSpeed)
  const writtenShutter = exposureSeconds(metadata.shutter_speed)
  if (
    expectedShutter !== null
    && (writtenShutter === null || Math.abs(writtenShutter - expectedShutter) > 0.000001)
  ) {
    throw new Error("本地图片快门信息写入校验失败")
  }

  const expectedAperture = apertureNumber(form.aperture)
  const writtenAperture = apertureNumber(metadata.aperture)
  if (
    expectedAperture !== null
    && (writtenAperture === null || Math.abs(writtenAperture - expectedAperture) > 0.001)
  ) {
    throw new Error("本地图片光圈信息写入校验失败")
  }

  const expectedIso = toNullableNumber(form.iso)
  if (expectedIso !== null && metadata.iso !== expectedIso) {
    throw new Error("本地图片 ISO 写入校验失败")
  }
}

export function fileExtension(name: string) {
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index) : ""
}

export function fileBaseName(name: string) {
  const extension = fileExtension(name)
  return extension ? name.slice(0, -extension.length) : name
}

export function normalizedFileName(baseName: string, referenceName: string) {
  const normalized = baseName.trim().replace(/[\\/:*?"<>|]/g, "")
  return normalized ? `${normalized}${fileExtension(referenceName)}` : referenceName
}

export function changedParts(item: ExifWorkbenchItem) {
  const changed: string[] = []
  if (item.fileName !== item.originalFileName) changed.push("名称")
  const initial = item.originalForm
  const current = item.form
  if (initial.latitude !== current.latitude || initial.longitude !== current.longitude) changed.push("GPS")
  if (
    initial.displayLocationName !== current.displayLocationName
    || initial.exhibitionName !== current.exhibitionName
    || initial.catalogExhibitionSourceId !== current.catalogExhibitionSourceId
  ) changed.push("展出")
  if (initial.cameraModel !== current.cameraModel || initial.lensModel !== current.lensModel || initial.capturedAt !== current.capturedAt || initial.shutterSpeed !== current.shutterSpeed || initial.aperture !== current.aperture || initial.iso !== current.iso) changed.push("拍摄")
  if (initial.name !== current.name || initial.era !== current.era || initial.museumName !== current.museumName || initial.placeOfExcavation !== current.placeOfExcavation) changed.push("信息")
  if (initial.description !== current.description || initial.tags.join("\u0000") !== current.tags.join("\u0000")) changed.push("内容")
  return changed
}
