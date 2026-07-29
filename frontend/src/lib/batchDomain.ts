import { normalizeTags } from "./batchHelpers"

export type PendingArtifact = {
  id: number
  source_path: string
  image_url: string
  file_name: string
  status: string
  error: string | null
  museum_name: string | null
  name: string | null
  era: string | null
  description: string | null
  tags: string[]
  camera_model: string | null
  lens_model: string | null
  capture_museum_name: string | null
  exhibition_name: string | null
  latitude: number | null
  longitude: number | null
  captured_at: string | null
  shutter_speed: string | null
  aperture: string | null
  iso: number | null
  edit_method: string | null
  confidence: number | null
  provider: string | null
  analysis: string | null
  existing_artifact_id: number | null
  cloud_artifact_id: number | null
  created_at: string
  updated_at: string
}

export type RawPendingArtifact = Omit<PendingArtifact, "image_url">

export type VisionCandidate = {
  provider: string
  model: string
  artifact_name: string
  era: string | null
  museum_name: string | null
  tags: string[]
  description: string
  confidence: number | null
  analysis: string | null
  reasoning: string | null
}

export type VisionAnalyzeResponse = {
  candidates: VisionCandidate[]
  unavailable_providers: string[]
  failed_providers: string[]
}

export const STATUS_LABEL: Record<string, string> = {
  pending: "待识别",
  identifying: "识别中…",
  identified: "已识别",
  submitting: "提交中…",
  submitted: "已入库",
  failed: "失败",
}



export type MuseumOption = {
  id: number
  name: string
}

export type EraOption = {
  id: number
  name: string
  sort_order: number
}

export type ExhibitionOption = {
  id: number
  museum_id: number
  museum_name: string
  name: string
  start_at: string | null
  end_at: string | null
}

export type ExistingArtifactImage = {
  id: number
  url: string
}

export type ExistingArtifactMatch = {
  artifact: {
    id: number
    name: string
    era: string | null
    description: string | null
    museum_name: string
    tags: string[]
    images: ExistingArtifactImage[]
  }
  match_score: number
  match_reason: string
}

export type SubmitNotice = {
  type: "success" | "error"
  text: string
}

export type FileWithRelativePath = File & {
  webkitRelativePath?: string
}

export type GooglePhotosStatus = {
  enabled: boolean
  auth_configured: boolean
  connected: boolean
  detail: string | null
}

export type GooglePhotosConfig = {
  client_id: string
  redirect_uri: string
  has_client_secret: boolean
}

export type GooglePhotosPickerSession = {
  id: string
  picker_uri: string
  media_items_set: boolean
  poll_interval_ms: number | null
  timeout_in_ms: number | null
  expire_time: string | null
}

export type GooglePhotosMediaItem = {
  id: string
  filename: string
  base_url: string
  product_url: string | null
  mime_type: string | null
  width: number | null
  height: number | null
  creation_time: string | null
  thumbnail_url: string | null
}

export type GooglePhotosMediaList = {
  items: GooglePhotosMediaItem[]
  next_page_token: string | null
}

export type GooglePhotosImportResult = {
  imported: number
  skipped: number
  warnings: string[]
  items: RawPendingArtifact[]
}

export type BatchScanResponse = {
  scanned: number
  added: number
  skipped: number
  items: RawPendingArtifact[]
}

export type PendingArtifactSubmitResult = {
  item: RawPendingArtifact
  duplicate_image_skipped: boolean
  duplicate_image_replaced: boolean
  duplicate_image_detail: string | null
}
export function buildPendingPreviewUrl(apiBaseUrl: string, id: number) {
  return `${apiBaseUrl}/api/batch/pending/${id}/image`
}
export function normalizePersistedPendingItem(apiBaseUrl: string, item: RawPendingArtifact): PendingArtifact {
  return {
    ...item,
    image_url: buildPendingPreviewUrl(apiBaseUrl, item.id),
  }
}
export function deriveTagsFromAnalysis(
  analysis: string | null | undefined,
  options?: { artifactName?: string | null; era?: string | null; museumName?: string | null },
) {
  const text = (analysis ?? "").trim()
  if (!text) {
    return []
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim())
  const marker = /^(?:适合入库的|可(?:入库|检索)的?)?(?:(?:入库|推荐|建议)\s*)?(?:标签|关键词)(?:建议|如下)?\s*[:：]?\s*(.*)$/
  const stopMarker = /^(?:说明|备注|理由|依据|补充|器型与材质|纹饰与工艺|用途与历史背景|出土与墓葬信息|详细描述|描述|名称|时代|馆藏|博物馆)[:：]?$/
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(marker)
    if (!match) {
      continue
    }
    const tagLines = [match[1]?.trim() ?? ""].filter(Boolean)
    for (const remainder of lines.slice(index + 1)) {
      if (!remainder) break
      if (stopMarker.test(remainder)) break
      tagLines.push(remainder)
    }
    const tags = normalizeTags(
      tagLines
        .join("\n")
        .split(/[,\n，、；;|/]+/)
        .map((tag) => tag.replace(/^\d+[.)、]\s*/, "").trim().replace(/[【】[\]<>《》"'']/g, "")),
    )
    if (tags.length > 0) {
      const blocked = new Set(
        [options?.artifactName, options?.era, options?.museumName]
          .map((value) => (value ?? "").trim().toLowerCase())
          .filter(Boolean),
      )
      return tags.filter((tag) => !blocked.has(tag.toLowerCase()))
    }
  }

  const keywordCandidates = [
    "青铜器",
    "金器",
    "银器",
    "玉器",
    "陶器",
    "瓷器",
    "石器",
    "佛像",
    "礼器",
    "摆件",
    "铭文",
    "龙纹",
    "凤纹",
    "兽面纹",
    "鎏金",
    "彩绘",
    "秘色瓷",
    "越窑",
    "红山文化",
    "墓葬",
    "出土文物",
  ]
  const derived = keywordCandidates.filter((keyword) => text.includes(keyword)).slice(0, 8)
  return normalizeTags(derived)
}
export function enrichPendingItemTags(item: PendingArtifact): PendingArtifact {
  if ((item.tags ?? []).length > 0) {
    return item
  }
  const derivedTags = deriveTagsFromAnalysis(item.analysis, {
    artifactName: item.name,
    era: item.era,
    museumName: item.museum_name,
  })
  if (derivedTags.length === 0) {
    return item
  }
  return { ...item, tags: derivedTags }
}
