import type { GalleryArtifact } from "../Gallery"

export function toAbsoluteUrl(apiBaseUrl: string, url: string) {
  if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return url
  return `${apiBaseUrl}${url.startsWith("/") ? url : `/${url}`}`
}

export function getBackendImageVariantUrl(apiBaseUrl: string, url: string, size: number) {
  return `${apiBaseUrl}/api/image-variant?url=${encodeURIComponent(toAbsoluteUrl(apiBaseUrl, url))}&size=${size}`
}

export function normalizeIdentityText(value: string | null | undefined) {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/[《》“”'"·、，,。！？!？()（）\[\]【】]/g, "").toLowerCase()
}

export function compactArtifactNameForMatch(value: string | null | undefined) {
  return normalizeIdentityText(value).replace(/^(?:文物|藏品|器物)/, "")
}

export function galleryArtifactMergeKey(artifact: GalleryArtifact) {
  const name = compactArtifactNameForMatch(artifact.name)
  const museum = normalizeIdentityText(artifact.museum_name)
  const era = normalizeIdentityText(artifact.era)
  return name && museum ? `${name}\u0000${museum}\u0000${era}` : `id:${artifact.id}`
}
