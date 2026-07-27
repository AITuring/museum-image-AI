import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import AMapLoader from "@amap/amap-jsapi-loader"
import { AutoComplete, Button, Card, Checkbox, Input, Modal, Segmented, Select, Space, Tag, Tooltip } from "antd"
import {
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  CloudUpload,
  FileCheck2,
  FolderOpen,
  ImagePlus,
  Landmark,
  Loader2,
  MapPin,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react"

const Textarea = Input.TextArea

type ParsedArtifactName = {
  original_name: string
  normalized_name: string
  era: string | null
  artifact_name: string | null
  museum_name: string | null
  Place_of_Excavation: string | null
  catalog_no: string | null
}

type DescriptionCandidate = {
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

type VerifiedClaim = {
  text: string
  source_refs: string[]
}

type ArtifactFieldWarning = {
  field: "artifact_name" | "era" | "museum_name" | "place_of_excavation" | string
  label: string
  input_value: string
  suggested_value: string | null
  reason: string
  source_refs: string[]
}

type LiveProviderState = {
  model: string
  status: "running" | "complete" | "error"
  reasoning: string
  message: string
  descriptionLength: number
  tagCount: number
}

type DescriptionSearchHit = {
  title: string
  url: string
  snippet: string
  source: string | null
}

type GeneratedDescription = {
  provider: string
  model: string
  description: string
  tags: string[]
  reasoning: string | null
  research_id?: string | null
  candidates: DescriptionCandidate[]
  unavailable_providers: string[]
}

type MuseumOption = {
  id: number
  name: string
  latitude: number | null
  longitude: number | null
}

type ExhibitionRecommendation = {
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

type SubmitNotice = {
  type: "success" | "error"
  text: string
}

type UploadActivity = "files" | "directory" | null

type ArtifactSubmitResult = {
  duplicate_image_skipped?: boolean
  duplicate_image_replaced?: boolean
  duplicate_image_detail?: string | null
}

type ExistingArtifactImage = {
  url: string
  capture_museum_name: string | null
  exhibition_name: string | null
  catalog_exhibition_source_id: string | null
  catalog_exhibition_id: number | null
  capture_location: string | null
  latitude: number | null
  longitude: number | null
}

type ExistingArtifact = {
  id: number
  museum_name: string
  name: string
  era: string | null
  Place_of_Excavation: string | null
  description: string | null
  tags: string[]
  images: ExistingArtifactImage[]
}

type ExistingArtifactMatch = {
  artifact: ExistingArtifact
  match_score: number
  match_reason: string
}

type ExifConsoleProps = {
  apiBaseUrl: string
}

type FormState = {
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

type MetadataSyncFieldKey =
  | "displayLocation"
  | "exhibition"
  | "gps"
  | "cameraModel"
  | "lensModel"
  | "shutterSpeed"
  | "aperture"
  | "iso"
  | "capturedAt"
  | "description"
  | "tags"
type MetadataSyncTargetMode = "current" | "selected" | "others"
type MetadataSyncSelection = Record<MetadataSyncFieldKey, boolean>
type MetadataSyncDiffRow = {
  label: string
  targetValue: string
  sourceValue: string
  changed: boolean
  willClearTarget: boolean
}

const METADATA_SYNC_GROUPS: Array<{
  key: string
  title: string
  description: string
  fields: Array<{
    key: MetadataSyncFieldKey
    label: string
  }>
}> = [
  {
    key: "location",
    title: "地点与展览",
    description: "同一批照片通常可以复用",
    fields: [
      { key: "displayLocation", label: "展出地点" },
      { key: "exhibition", label: "对应展览" },
      { key: "gps", label: "经纬度" },
    ],
  },
  {
    key: "camera",
    title: "相机与拍摄参数",
    description: "默认不同步，保留每张照片的原始 EXIF",
    fields: [
      { key: "cameraModel", label: "相机型号" },
      { key: "lensModel", label: "镜头型号" },
      { key: "shutterSpeed", label: "快门" },
      { key: "aperture", label: "光圈" },
      { key: "iso", label: "ISO" },
    ],
  },
  {
    key: "content",
    title: "时间与内容",
    description: "需要完全一致时再开启",
    fields: [
      { key: "capturedAt", label: "拍摄时间" },
      { key: "description", label: "描述" },
      { key: "tags", label: "标签" },
    ],
  },
]

const DEFAULT_METADATA_SYNC_SELECTION: MetadataSyncSelection = {
  displayLocation: true,
  exhibition: true,
  gps: true,
  cameraModel: false,
  lensModel: false,
  shutterSpeed: false,
  aperture: false,
  iso: false,
  capturedAt: false,
  description: false,
  tags: false,
}

const METADATA_SYNC_FIELD_COUNT = METADATA_SYNC_GROUPS.reduce(
  (count, group) => count + group.fields.length,
  0,
)

function metadataSyncSelectionFor(fields: MetadataSyncFieldKey[]): MetadataSyncSelection {
  const enabled = new Set(fields)
  return Object.fromEntries(
    METADATA_SYNC_GROUPS
      .flatMap((group) => group.fields)
      .map((field) => [field.key, enabled.has(field.key)]),
  ) as MetadataSyncSelection
}

function MetadataSyncFieldControls({
  selection,
  onChange,
  context,
}: {
  selection: MetadataSyncSelection
  onChange: (field: MetadataSyncFieldKey, checked: boolean) => void
  context: "sidebar" | "preview"
}) {
  return (
    <div className={`metadata-sync-field-groups is-${context}`}>
      {METADATA_SYNC_GROUPS.map((group) => (
        <section key={group.key} className="metadata-sync-field-group">
          <header>
            <strong>{group.title}</strong>
            <span>{group.description}</span>
          </header>
          <div className="metadata-sync-field-list">
            {group.fields.map((field) => (
              <Checkbox
                key={field.key}
                className="metadata-sync-field"
                checked={selection[field.key]}
                onChange={(event) => onChange(field.key, event.target.checked)}
              >
                {field.label}
              </Checkbox>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

type ImageExifMetadata = {
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

type ExifWorkbenchItem = {
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
}

type PersistedExifDraftItem = Omit<ExifWorkbenchItem, "previewUrl" | "fileHandle"> & {
  previewUrl?: never
  fileHandle?: never
}

type PersistedExifDraft = {
  version: 1
  items: PersistedExifDraftItem[]
  selectedId: string | null
  sharedForm: FormState
}

type ReuploadHint = {
  version: 1
  form: FormState
  existingArtifactId: number | null
  updatedAt: string
}

type WritableFileStream = { write(data: Blob): Promise<void>; close(): Promise<void> }
type WritableFileHandle = {
  kind?: "file"
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<WritableFileStream>
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<"granted" | "denied" | "prompt">
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<"granted" | "denied" | "prompt">
}
type WritableDirectoryHandle = {
  kind?: "directory"
  name: string
  values(): AsyncIterableIterator<WritableFileHandle | WritableDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFileHandle>
  removeEntry(name: string): Promise<void>
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<"granted" | "denied" | "prompt">
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<"granted" | "denied" | "prompt">
}
type FilePickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<WritableDirectoryHandle>
  showOpenFilePicker?: (options: {
    multiple: boolean
    types: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<WritableFileHandle[]>
}

const IMAGE_FILE_PATTERN = /\.(?:jpe?g|png|webp|tiff?)$/i
const CLIENT_PREVIEW_FILE_LIMIT = 24 * 1024 * 1024
const TIFF_BROWSER_FALLBACK_MAX_PIXELS = 24_000_000
const EXIF_DRAFT_DB_NAME = "museum-exif-drafts"
const EXIF_DRAFT_STORE_NAME = "workbench"
const EXIF_DRAFT_RECORD_KEY = "active"
const EXIF_REUPLOAD_HINT_STORE_NAME = "reupload-hints"

function yieldToMainThread() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

function formatCapturedAt(value: string | null | undefined) {
  const normalized = (value ?? "").trim().replace("T", " ").replace(/Z$/, "")
  if (!normalized) return ""
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2})(?::(\d{2}))?/)
  return match ? `${match[1]} ${match[2]}:${match[3] ?? "00"}` : normalized.slice(0, 19)
}

function compactFileName(value: string, maxLength = 38) {
  const characters = Array.from(value)
  if (characters.length <= maxLength) return value
  const tailLength = Math.max(14, Math.floor(maxLength * 0.46))
  const headLength = Math.max(10, maxLength - tailLength - 1)
  return `${characters.slice(0, headLength).join("")}…${characters.slice(-tailLength).join("")}`
}

function indexedFileName(value: string, index: number) {
  return `${String(Math.max(index, 0) + 1).padStart(2, "0")} · ${compactFileName(value)}`
}

function isTiffFile(file: File) {
  return /\.(?:tif|tiff)$/i.test(file.name) || ["image/tif", "image/tiff", "application/tiff", "application/x-tiff"].includes(file.type.toLowerCase())
}

function tiffDimension(value: unknown) {
  if (typeof value === "number") return value
  if (Array.isArray(value) && typeof value[0] === "number") return value[0]
  return 0
}

async function createTiffPreviewUrl(file: File) {
  if (file.size > CLIENT_PREVIEW_FILE_LIMIT) throw new Error("TIFF 文件过大，使用轻量占位预览")
  const UTIF = await import("utif")
  const buffer = await file.arrayBuffer()
  const ifds = UTIF.decode(buffer)
  const mainIfd = ifds
    .filter((ifd) => tiffDimension(ifd.width ?? ifd.t256) > 0 && tiffDimension(ifd.height ?? ifd.t257) > 0)
    .reduce((best, current) => {
      if (!best) return current
      const bestPixels = tiffDimension(best.width ?? best.t256) * tiffDimension(best.height ?? best.t257)
      const currentPixels = tiffDimension(current.width ?? current.t256) * tiffDimension(current.height ?? current.t257)
      return currentPixels > bestPixels ? current : best
    }, undefined as (typeof ifds)[number] | undefined)
  if (!mainIfd) throw new Error("TIFF 中没有可预览的图像页")
  UTIF.decodeImage(buffer, mainIfd, ifds)
  const sourceWidth = tiffDimension(mainIfd.width ?? mainIfd.t256)
  const sourceHeight = tiffDimension(mainIfd.height ?? mainIfd.t257)
  if (sourceWidth * sourceHeight > TIFF_BROWSER_FALLBACK_MAX_PIXELS) {
    throw new Error("TIFF 解码尺寸过大，使用轻量占位预览")
  }
  const rgba = UTIF.toRGBA8(mainIfd)
  const scale = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight))
  const sourceCanvas = document.createElement("canvas")
  sourceCanvas.width = sourceWidth
  sourceCanvas.height = sourceHeight
  const sourceContext = sourceCanvas.getContext("2d")
  if (!sourceContext) throw new Error("浏览器无法生成 TIFF 预览")
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), sourceWidth, sourceHeight), 0, 0)
  const previewCanvas = document.createElement("canvas")
  previewCanvas.width = Math.max(1, Math.round(sourceWidth * scale))
  previewCanvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const previewContext = previewCanvas.getContext("2d")
  if (!previewContext) throw new Error("浏览器无法缩放 TIFF 预览")
  previewContext.drawImage(sourceCanvas, 0, 0, previewCanvas.width, previewCanvas.height)
  const previewBlob = await new Promise<Blob | null>((resolve) => previewCanvas.toBlob(resolve, "image/jpeg", 0.82))
  if (!previewBlob) throw new Error("TIFF 预览生成失败")
  return URL.createObjectURL(previewBlob)
}

function formatFileSize(size: number) {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

async function canvasToPreviewUrl(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8))
  if (!blob) throw new Error("缩略图生成失败")
  return URL.createObjectURL(blob)
}

async function createRasterPreviewUrl(file: File) {
  if (file.size > CLIENT_PREVIEW_FILE_LIMIT || !("createImageBitmap" in window)) {
    // Large JPEG files are still directly previewable by the browser. Avoid
    // decoding the full image into a canvas, but do not replace it with a file
    // placeholder merely because it exceeds the thumbnail-generation limit.
    return URL.createObjectURL(file)
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { resizeWidth: 640, resizeQuality: "high" })
  } catch {
    return URL.createObjectURL(file)
  }
  try {
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext("2d")
    if (!context) throw new Error("浏览器无法生成缩略图")
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await canvasToPreviewUrl(canvas)
  } finally {
    bitmap.close()
  }
}

async function createFilePlaceholderUrl(file: File) {
  const canvas = document.createElement("canvas")
  canvas.width = 640
  canvas.height = 400
  const context = canvas.getContext("2d")
  if (!context) throw new Error("浏览器无法生成文件占位图")
  context.fillStyle = "#f5f5f4"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "#d6d3d1"
  context.fillRect(48, 48, 104, 128)
  context.fillStyle = "#44403c"
  context.font = "600 34px system-ui, sans-serif"
  context.fillText((file.name.split(".").pop() || "IMG").toUpperCase(), 48, 232)
  context.font = "500 24px system-ui, sans-serif"
  context.fillText(file.name.length > 34 ? `${file.name.slice(0, 31)}...` : file.name, 48, 286)
  context.fillStyle = "#78716c"
  context.font = "22px system-ui, sans-serif"
  context.fillText(formatFileSize(file.size), 48, 326)
  return canvasToPreviewUrl(canvas)
}

async function createFallbackPreviewUrl(file: File) {
  try {
    return isTiffFile(file) ? await createTiffPreviewUrl(file) : await createRasterPreviewUrl(file)
  } catch {
    return createFilePlaceholderUrl(file)
  }
}

async function createRestoredPreviewUrl(file: File, apiBaseUrl: string) {
  if (file.size <= CLIENT_PREVIEW_FILE_LIMIT || isTiffFile(file)) {
    return createFallbackPreviewUrl(file)
  }
  try {
    const formData = new FormData()
    formData.append("file", file)
    const metadata = await fetchJson<ImageExifMetadata>(
      `${apiBaseUrl}/api/artifacts/extract-exif-file`,
      { method: "POST", body: formData },
    )
    if (metadata.preview_data_url) return metadata.preview_data_url
  } catch {
    // The browser's direct object URL remains the last-resort preview path.
  }
  return createFallbackPreviewUrl(file)
}

function revokePreviewUrl(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url)
}

const EMPTY_FORM: FormState = {
  museumName: "",
  name: "",
  era: "",
  placeOfExcavation: "",
  displayLocationName: "",
  exhibitionName: "常设",
  catalogExhibitionId: null,
  catalogExhibitionSourceId: "",
  latitude: "",
  longitude: "",
  cameraModel: "",
  lensModel: "",
  capturedAt: "",
  shutterSpeed: "",
  aperture: "",
  iso: "",
  description: "",
  tags: [],
}

const EXIF_FILE_INPUT_ID = "exif-workbench-file-input"

function FormSectionHeader({ icon: Icon, title, description }: {
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <Tooltip title={description} placement="topLeft" trigger={["hover", "focus"]}>
      <span className="exif-section-title" tabIndex={0}>
        <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
        <span>{title}</span>
      </span>
    </Tooltip>
  )
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response))
  }
  return (await response.json()) as T
}

async function responseErrorMessage(response: Response, prefix?: string) {
  let detail = `HTTP ${response.status}`
  try {
    const payload = (await response.json()) as { detail?: string }
    if (payload.detail) detail = payload.detail
  } catch {
    // Keep the HTTP fallback for non-JSON proxy/server errors.
  }
  return prefix ? `${prefix}：${detail}` : detail
}

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs)
  })
}

function formatRecommendationDate(item: ExhibitionRecommendation) {
  if (item.is_permanent) return "常设展"
  if (item.start_date && item.end_date) return `${item.start_date} — ${item.end_date}`
  if (item.start_date) return `${item.start_date} 起`
  if (item.end_date) return `至 ${item.end_date}`
  return "日期待确认"
}

function ExhibitionRecommendationPicker({
  apiBaseUrl,
  capturedAt,
  latitude,
  longitude,
  location,
  selectedSourceId,
  selectedName,
  onSelect,
  onManualChange,
}: {
  apiBaseUrl: string
  capturedAt: string
  latitude: string
  longitude: string
  location: string
  selectedSourceId: string
  selectedName: string
  onSelect: (item: ExhibitionRecommendation | null) => void
  onManualChange: (value: string) => void
}) {
  const [recommendations, setRecommendations] = useState<ExhibitionRecommendation[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const hasContext = Boolean(
      capturedAt.trim()
      || location.trim()
      || (latitude.trim() && longitude.trim())
      || query.trim(),
    )
    if (!hasContext) {
      const resetTimer = window.setTimeout(() => {
        setRecommendations([])
        setError(null)
      }, 0)
      return () => window.clearTimeout(resetTimer)
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "10" })
      if (capturedAt.trim()) params.set("captured_at", capturedAt.trim())
      if (location.trim()) params.set("location", location.trim())
      if (latitude.trim()) params.set("latitude", latitude.trim())
      if (longitude.trim()) params.set("longitude", longitude.trim())
      if (query.trim()) params.set("q", query.trim())
      setLoading(true)
      setError(null)
      void fetchJson<ExhibitionRecommendation[]>(
        `${apiBaseUrl}/api/exhibition-catalog/recommendations?${params.toString()}`,
        { signal: controller.signal },
      )
        .then((items) => setRecommendations(items))
        .catch((nextError) => {
          if (!controller.signal.aborted) {
            setError(nextError instanceof Error ? nextError.message : "展览推荐加载失败")
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 320)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [apiBaseUrl, capturedAt, latitude, longitude, location, query])

  const options = recommendations.map((item) => ({
    value: item.source_id,
    label: (
      <div className="exhibition-option">
        <strong>{item.title}</strong>
        <span>
          {Array.from(
            new Set(
              [item.city, item.museum_name, item.venue, formatRecommendationDate(item)]
                .filter((value): value is string => Boolean(value)),
            ),
          ).join(" · ")}
        </span>
        {item.match_reasons.length ? <small>{item.match_reasons.join("；")}</small> : null}
      </div>
    ),
  }))
  if (
    selectedSourceId
    && !options.some((option) => option.value === selectedSourceId)
  ) {
    options.unshift({
      value: selectedSourceId,
      label: (
        <div className="exhibition-option">
          <strong>{selectedName || "已关联展览"}</strong>
          <span>已保存的展览关联</span>
        </div>
      ),
    })
  }

  return (
    <div className="exhibition-picker">
      <Select
        allowClear
        showSearch
        filterOption={false}
        loading={loading}
        value={selectedSourceId || undefined}
        placeholder={
          capturedAt || latitude || longitude || location
            ? "按 EXIF 时间与地点推荐展览"
            : "照片含时间或定位后自动推荐"
        }
        options={options}
        popupMatchSelectWidth={420}
        notFoundContent={loading ? "正在检索…" : "没有符合条件的展览"}
        onSearch={setQuery}
        onClear={() => onSelect(null)}
        onSelect={(sourceId) => {
          const item = recommendations.find((candidate) => candidate.source_id === sourceId)
          if (item) onSelect(item)
        }}
      />
      <Input
        value={selectedName}
        placeholder="找不到时可手动填写展览名称"
        onChange={(event) => onManualChange(event.target.value)}
      />
      {error ? <span className="field-help error">{error}</span> : null}
      {!error && recommendations.length > 0 ? (
        <span className="field-help">
          已按展出地点筛选，并结合拍摄日期排序；匹配地点的常设展也会持续参与推荐。
        </span>
      ) : null}
    </div>
  )
}

function postFormDataWithProgress<T>(url: string, formData: FormData, onProgress: (progress: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open("POST", url)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(95, 45 + Math.round((event.loaded / event.total) * 50)))
    }
    request.onerror = () => reject(new Error("图片上传连接失败"))
    request.onload = () => {
      let payload: { detail?: string } | T | null = null
      try { payload = JSON.parse(request.responseText) as { detail?: string } | T } catch { /* non-json error */ }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error((payload as { detail?: string } | null)?.detail || `HTTP ${request.status}`))
        return
      }
      resolve(payload as T)
    }
    request.send(formData)
  })
}

async function loadMuseumSuggestions(
  apiBaseUrl: string,
  keyword: string,
  setter: (items: MuseumOption[]) => void,
) {
  try {
    const params = new URLSearchParams({ limit: "8" })
    if (keyword) {
      params.set("q", keyword)
    }
    const items = await fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?${params.toString()}`)
    setter(items)
  } catch {
    setter([])
  }
}

async function verifyWritablePermission(handle: WritableFileHandle | WritableDirectoryHandle) {
  const descriptor = { mode: "readwrite" as const }
  try {
    if (await handle.queryPermission?.(descriptor) === "granted") return true
    if (await handle.requestPermission?.(descriptor) === "granted") return true
    return !handle.queryPermission && !handle.requestPermission
  } catch {
    return false
  }
}

async function listDirectoryImageEntries(handle: WritableDirectoryHandle) {
  const entries: Array<{ handle: WritableFileHandle; file: File }> = []
  for await (const entry of handle.values()) {
    if (entry.kind === "directory" || !IMAGE_FILE_PATTERN.test(entry.name)) continue
    const fileHandle = entry as WritableFileHandle
    entries.push({ handle: fileHandle, file: await fileHandle.getFile() })
  }
  return entries.sort((left, right) => left.file.name.localeCompare(right.file.name, "zh-CN"))
}

async function resolveMuseum(apiBaseUrl: string, name: string): Promise<MuseumOption | null> {
  const items = await fetchJson<MuseumOption[]>(
    `${apiBaseUrl}/api/museums?${new URLSearchParams({ q: name, limit: "8" }).toString()}`,
  )
  const exact = items.find((item) => item.name === name)
  return exact ?? items[0] ?? null
}

async function lookupExistingArtifact(
  apiBaseUrl: string,
  form: FormState,
): Promise<ExistingArtifactMatch | null> {
  if (!form.name.trim() || !form.museumName.trim() || !form.era.trim()) return null
  const params = new URLSearchParams({
    name: form.name.trim(),
    museum_name: form.museumName.trim(),
    era: form.era.trim(),
  })
  try {
    return await fetchJson<ExistingArtifactMatch | null>(
      `${apiBaseUrl}/api/artifacts/match?${params.toString()}`,
    )
  } catch {
    return null
  }
}

function compactArtifactIdentity(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}_]+/gu, "")
}

function artifactReviewIdentityKey(form: FormState) {
  if (!form.name.trim() || !form.museumName.trim() || !form.era.trim()) return ""
  return [
    compactArtifactIdentity(form.name),
    compactArtifactIdentity(form.museumName),
    compactArtifactIdentity(form.era),
  ].join("|")
}

async function lookupExistingArtifactCandidates(
  apiBaseUrl: string,
  form: FormState,
): Promise<ExistingArtifactMatch[]> {
  if (!form.name.trim() || !form.museumName.trim() || !form.era.trim()) return []
  const params = new URLSearchParams({
    q: form.name.trim(),
    era: form.era.trim(),
  })
  const [bestMatch, searchResults] = await Promise.all([
    lookupExistingArtifact(apiBaseUrl, form),
    fetchJson<ExistingArtifact[]>(`${apiBaseUrl}/api/artifacts?${params.toString()}`)
      .catch(() => []),
  ])
  const normalizedMuseum = compactArtifactIdentity(form.museumName)
  const normalizedEra = compactArtifactIdentity(form.era)
  const normalizedName = compactArtifactIdentity(form.name)
  const candidates = new Map<string, ExistingArtifactMatch>()
  const candidateIdentity = (artifact: ExistingArtifact) => [
    compactArtifactIdentity(artifact.name),
    compactArtifactIdentity(artifact.museum_name),
    compactArtifactIdentity(artifact.era),
  ].join("|")
  if (bestMatch) candidates.set(candidateIdentity(bestMatch.artifact), bestMatch)
  searchResults.forEach((artifact) => {
    if (
      compactArtifactIdentity(artifact.museum_name) !== normalizedMuseum
      || compactArtifactIdentity(artifact.era) !== normalizedEra
    ) return
    const candidateName = compactArtifactIdentity(artifact.name)
    const exact = candidateName === normalizedName
    const related = candidateName.includes(normalizedName) || normalizedName.includes(candidateName)
    if (!exact && !related) return
    const identity = candidateIdentity(artifact)
    const nextMatch: ExistingArtifactMatch = {
      artifact,
      match_score: exact ? 1 : 0.8,
      match_reason: exact
        ? "名称完全一致，且时代、馆藏一致。"
        : "名称相近，且时代、馆藏一致。",
    }
    const current = candidates.get(identity)
    if (!current || nextMatch.match_score > current.match_score) {
      candidates.set(identity, nextMatch)
    }
  })
  return Array.from(candidates.values())
    .sort((left, right) => right.match_score - left.match_score)
    .slice(0, 6)
}

function buildBaseForm(): FormState {
  return {
    ...EMPTY_FORM,
  }
}

function cloneFormState(form: FormState): FormState {
  return {
    ...form,
    catalogExhibitionId: form.catalogExhibitionId ?? null,
    catalogExhibitionSourceId: form.catalogExhibitionSourceId ?? "",
    tags: [...form.tags],
  }
}

function normalizedReuploadHintKeys(fileName: string) {
  const normalized = fileName.trim().toLocaleLowerCase("zh-CN")
  const base = fileBaseName(normalized)
  return Array.from(new Set([normalized, base].filter(Boolean)))
}

function applyExistingArtifactToForm(form: FormState, artifact: ExistingArtifact): FormState {
  const capture = artifact.images.find((image) => (
    image.capture_location
    || image.capture_museum_name
    || image.exhibition_name
    || image.latitude !== null
    || image.longitude !== null
  ))
  return {
    ...form,
    museumName: artifact.museum_name || form.museumName,
    name: artifact.name || form.name,
    era: artifact.era ?? form.era,
    placeOfExcavation: artifact.Place_of_Excavation ?? form.placeOfExcavation,
    displayLocationName: form.displayLocationName
      || capture?.capture_location
      || capture?.capture_museum_name
      || artifact.museum_name,
    exhibitionName: capture?.exhibition_name || form.exhibitionName,
    catalogExhibitionId: capture?.catalog_exhibition_id ?? form.catalogExhibitionId,
    catalogExhibitionSourceId: capture?.catalog_exhibition_source_id || form.catalogExhibitionSourceId,
    latitude: form.latitude || capture?.latitude?.toString() || "",
    longitude: form.longitude || capture?.longitude?.toString() || "",
    description: artifact.description ?? form.description,
    // Camera and lens tags describe individual source photos, so do not copy
    // them onto a newly uploaded image. Its own EXIF fields remain authoritative.
    tags: uniqueTags(artifact.tags.filter((tag) => !/^(机型|镜头)\s*[:：]/.test(tag))),
  }
}

function applyReuploadHintToForm(form: FormState, hint: ReuploadHint): FormState {
  return {
    ...form,
    museumName: hint.form.museumName || form.museumName,
    name: hint.form.name || form.name,
    era: hint.form.era || form.era,
    placeOfExcavation: hint.form.placeOfExcavation || form.placeOfExcavation,
    displayLocationName: hint.form.displayLocationName || form.displayLocationName,
    exhibitionName: hint.form.exhibitionName || form.exhibitionName,
    catalogExhibitionId: hint.form.catalogExhibitionId ?? form.catalogExhibitionId,
    catalogExhibitionSourceId: hint.form.catalogExhibitionSourceId || form.catalogExhibitionSourceId,
    latitude: hint.form.latitude || form.latitude,
    longitude: hint.form.longitude || form.longitude,
    description: hint.form.description || form.description,
    tags: hint.form.tags.length > 0 ? [...hint.form.tags] : form.tags,
  }
}

function openExifDraftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(EXIF_DRAFT_DB_NAME, 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(EXIF_DRAFT_STORE_NAME)) {
        request.result.createObjectStore(EXIF_DRAFT_STORE_NAME)
      }
      if (!request.result.objectStoreNames.contains(EXIF_REUPLOAD_HINT_STORE_NAME)) {
        request.result.createObjectStore(EXIF_REUPLOAD_HINT_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("无法打开本地草稿存储"))
  })
}

async function readReuploadHint(fileName: string) {
  const database = await openExifDraftDatabase()
  try {
    for (const key of normalizedReuploadHintKeys(fileName)) {
      const hint = await new Promise<ReuploadHint | null>((resolve, reject) => {
        const request = database.transaction(EXIF_REUPLOAD_HINT_STORE_NAME, "readonly")
          .objectStore(EXIF_REUPLOAD_HINT_STORE_NAME)
          .get(key)
        request.onsuccess = () => resolve((request.result as ReuploadHint | undefined) ?? null)
        request.onerror = () => reject(request.error ?? new Error("读取重新上传线索失败"))
      })
      if (hint?.version === 1) return hint
    }
    return null
  } finally {
    database.close()
  }
}

async function writeReuploadHints(items: ExifWorkbenchItem[]) {
  const candidates = items.filter((item) => (
    item.form.name.trim()
    && item.form.museumName.trim()
    && (item.form.description.trim() || item.form.tags.length > 0)
  ))
  if (candidates.length === 0) return
  const database = await openExifDraftDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(EXIF_REUPLOAD_HINT_STORE_NAME, "readwrite")
      const store = transaction.objectStore(EXIF_REUPLOAD_HINT_STORE_NAME)
      candidates.forEach((item) => {
        const hint: ReuploadHint = {
          version: 1,
          form: cloneFormState(item.form),
          existingArtifactId: item.existingArtifactId ?? null,
          updatedAt: new Date().toISOString(),
        }
        const keys = new Set([
          ...normalizedReuploadHintKeys(item.originalFileName),
          ...normalizedReuploadHintKeys(item.fileName),
        ])
        keys.forEach((key) => store.put(hint, key))
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("保存重新上传线索失败"))
      transaction.onabort = () => reject(transaction.error ?? new Error("保存重新上传线索失败"))
    })
  } finally {
    database.close()
  }
}

async function readExifDraft() {
  const database = await openExifDraftDatabase()
  try {
    return await new Promise<PersistedExifDraft | null>((resolve, reject) => {
      const request = database.transaction(EXIF_DRAFT_STORE_NAME, "readonly")
        .objectStore(EXIF_DRAFT_STORE_NAME)
        .get(EXIF_DRAFT_RECORD_KEY)
      request.onsuccess = () => resolve((request.result as PersistedExifDraft | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error("读取本地草稿失败"))
    })
  } finally {
    database.close()
  }
}

async function writeExifDraft(draft: PersistedExifDraft) {
  const database = await openExifDraftDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(EXIF_DRAFT_STORE_NAME, "readwrite")
        .objectStore(EXIF_DRAFT_STORE_NAME)
        .put(draft, EXIF_DRAFT_RECORD_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error("保存本地草稿失败"))
    })
  } finally {
    database.close()
  }
}

async function clearExifDraft() {
  const database = await openExifDraftDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(EXIF_DRAFT_STORE_NAME, "readwrite")
        .objectStore(EXIF_DRAFT_STORE_NAME)
        .delete(EXIF_DRAFT_RECORD_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error("清理本地草稿失败"))
    })
  } finally {
    database.close()
  }
}

function serializeExifDraftItem(item: ExifWorkbenchItem): PersistedExifDraftItem {
  const { previewUrl: _previewUrl, fileHandle: _fileHandle, ...persistedItem } = item
  return {
    ...persistedItem,
    form: cloneFormState(item.form),
    originalForm: cloneFormState(item.originalForm),
    candidates: ensureCandidates(item.candidates),
    unavailableProviders: ensureStringList(item.unavailableProviders),
    // A directory permission cannot be silently restored after reload. The
    // photo and its edits are retained; the operator can re-authorize later.
    submitState: item.submitState === "submitting" ? "error" : item.submitState,
    submitMessage: item.submitState === "submitting" ? "页面刷新前提交未完成，请确认后重试" : item.submitMessage,
    uploadProgress: item.submitState === "submitting" ? 0 : item.uploadProgress,
    uploadStage: item.submitState === "submitting" ? "等待重试" : item.uploadStage,
  }
}

async function restoreExifDraftItems(draft: PersistedExifDraftItem[], apiBaseUrl: string) {
  return Promise.all(draft.map(async (item) => ({
    ...item,
    form: cloneFormState(item.form),
    originalForm: cloneFormState(item.originalForm),
    candidates: ensureCandidates(item.candidates),
    unavailableProviders: ensureStringList(item.unavailableProviders),
    existingArtifactId: item.existingArtifactId ?? null,
    existingArtifactMatch: item.existingArtifactMatch ?? null,
    existingArtifactCandidates: item.existingArtifactCandidates ?? [],
    existingArtifactReviewKey: item.existingArtifactReviewKey ?? null,
    fileHandle: null,
    previewUrl: await createRestoredPreviewUrl(item.localFile, apiBaseUrl),
  })))
}

function metadataSyncValue(value: string | string[]) {
  if (Array.isArray(value)) return value.length > 0 ? value.join("、") : "未填写"
  return value.trim() || "未填写"
}

function buildMetadataSyncDiffRows(
  target: FormState,
  source: FormState,
  field: MetadataSyncFieldKey,
): MetadataSyncDiffRow[] {
  const fields: Array<{ label: string; target: string | string[]; source: string | string[] }> = field === "displayLocation"
    ? [{ label: "展出地点", target: target.displayLocationName, source: source.displayLocationName }]
    : field === "exhibition"
      ? [
          { label: "对应展览", target: target.exhibitionName, source: source.exhibitionName },
          {
            label: "展览目录关联",
            target: target.catalogExhibitionSourceId,
            source: source.catalogExhibitionSourceId,
          },
        ]
      : field === "gps"
        ? [
            { label: "纬度", target: target.latitude, source: source.latitude },
            { label: "经度", target: target.longitude, source: source.longitude },
          ]
        : field === "cameraModel"
          ? [{ label: "相机型号", target: target.cameraModel, source: source.cameraModel }]
          : field === "lensModel"
            ? [{ label: "镜头型号", target: target.lensModel, source: source.lensModel }]
            : field === "shutterSpeed"
              ? [{ label: "快门", target: target.shutterSpeed, source: source.shutterSpeed }]
              : field === "aperture"
                ? [{ label: "光圈", target: target.aperture, source: source.aperture }]
                : field === "iso"
                  ? [{ label: "ISO", target: target.iso, source: source.iso }]
                  : field === "capturedAt"
                    ? [{ label: "拍摄时间", target: formatCapturedAt(target.capturedAt), source: formatCapturedAt(source.capturedAt) }]
                    : field === "description"
                      ? [{ label: "描述", target: target.description, source: source.description }]
                      : [{ label: "标签", target: target.tags, source: source.tags }]

  return fields.map((field) => {
    const targetValue = metadataSyncValue(field.target)
    const sourceValue = metadataSyncValue(field.source)
    const sourceIsEmpty = sourceValue === "未填写"
    return {
      label: field.label,
      targetValue,
      sourceValue,
      changed: targetValue !== sourceValue,
      willClearTarget: sourceIsEmpty && targetValue !== "未填写",
    }
  })
}

function applySourceMetadata(
  target: FormState,
  source: FormState,
  selection: MetadataSyncSelection,
): FormState {
  return {
    ...target,
    ...(selection.displayLocation ? {
      displayLocationName: source.displayLocationName,
    } : {}),
    ...(selection.exhibition ? {
      exhibitionName: source.exhibitionName,
      catalogExhibitionId: source.catalogExhibitionId,
      catalogExhibitionSourceId: source.catalogExhibitionSourceId,
    } : {}),
    ...(selection.gps ? {
      latitude: source.latitude,
      longitude: source.longitude,
    } : {}),
    ...(selection.cameraModel ? { cameraModel: source.cameraModel } : {}),
    ...(selection.lensModel ? { lensModel: source.lensModel } : {}),
    ...(selection.shutterSpeed ? { shutterSpeed: source.shutterSpeed } : {}),
    ...(selection.aperture ? { aperture: source.aperture } : {}),
    ...(selection.iso ? { iso: source.iso } : {}),
    ...(selection.capturedAt ? { capturedAt: source.capturedAt } : {}),
    ...(selection.description ? { description: source.description } : {}),
    ...(selection.tags ? { tags: [...source.tags] } : {}),
  }
}

function hasMeaningfulFormValue(form: FormState) {
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

function applySharedForm(current: FormState, shared: FormState): FormState {
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

function buildItemId(file: File, index: number) {
  return `${file.name}-${file.lastModified}-${index}`
}

function uniqueTags(tags: string[]) {
  return Array.from(new Set(tags.map((item) => item.trim()).filter(Boolean)))
}

function ensureCandidates(value: DescriptionCandidate[] | undefined | null): DescriptionCandidate[] {
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

function normalizeVerifiedClaims(description: string, value: unknown) {
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

function ensureFieldWarnings(value: unknown): ArtifactFieldWarning[] {
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

function ensureStringList(value: string[] | undefined | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function warningDetail(warning: ArtifactFieldWarning) {
  const suggestion = warning.suggested_value
    ? `建议值：${warning.suggested_value}。`
    : ""
  const sources = warning.source_refs.length > 0
    ? `依据：${warning.source_refs.join("、")}。`
    : ""
  return `${warning.reason}${suggestion}${sources}`
}

function FieldReviewBadge({ warning }: { warning?: ArtifactFieldWarning }) {
  if (!warning) return null
  return (
    <Tooltip title={warningDetail(warning)}>
      <span className="field-review-badge">需要复核</span>
    </Tooltip>
  )
}

function AnnotatedDescription({
  description,
  warnings,
}: {
  description: string
  warnings: ArtifactFieldWarning[]
}) {
  const markers = warnings.flatMap((warning) => {
    const values = [warning.suggested_value, warning.input_value]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
    const value = values.find((candidate) => description.includes(candidate))
    return value ? [{ warning, value, index: description.indexOf(value) }] : []
  }).sort((left, right) => left.index - right.index)

  if (markers.length === 0) return <p className="result-desc">{description || "暂无描述"}</p>

  const parts: ReactNode[] = []
  let cursor = 0
  markers.forEach(({ warning, value, index }, markerIndex) => {
    if (index < cursor) return
    parts.push(description.slice(cursor, index + value.length))
    parts.push(
      <Tooltip key={`${warning.field}-${markerIndex}`} title={warningDetail(warning)}>
        <span className="inline-review-badge">需要复核</span>
      </Tooltip>,
    )
    cursor = index + value.length
  })
  parts.push(description.slice(cursor))
  return <p className="result-desc annotated-description">{parts}</p>
}

function researchSourceUrl(apiBaseUrl: string, url: string) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url
  return `${apiBaseUrl}${url.startsWith("/") ? url : `/${url}`}`
}

function toNullableNumber(value: string) {
  const text = value.trim()
  if (!text) {
    return null
  }
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

function exposureSeconds(value: string | null | undefined) {
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

function apertureNumber(value: string | null | undefined) {
  const numeric = Number((value ?? "").trim().toLowerCase().replace(/^f\//, ""))
  return Number.isFinite(numeric) ? numeric : null
}

function assertWrittenExif(metadata: ImageExifMetadata, form: FormState) {
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

function fileExtension(name: string) {
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index) : ""
}

function fileBaseName(name: string) {
  const extension = fileExtension(name)
  return extension ? name.slice(0, -extension.length) : name
}

function normalizedFileName(baseName: string, referenceName: string) {
  const normalized = baseName.trim().replace(/[\\/:*?"<>|]/g, "")
  return normalized ? `${normalized}${fileExtension(referenceName)}` : referenceName
}

function changedParts(item: ExifWorkbenchItem) {
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

type AMapEvent = { lnglat?: { getLng: () => number; getLat: () => number } }
type AMapGeocodeLocation = {
  getLng?: () => number
  getLat?: () => number
  lng?: number
  lat?: number
}
type AMapInstance = {
  on: (event: string, handler: (event: AMapEvent) => void) => void
  clearMap: () => void
  setZoomAndCenter: (zoom: number, center: [number, number]) => void
  add: (marker: unknown) => void
}
type AMapSdk = {
  Map: new (element: HTMLDivElement, options: Record<string, unknown>) => AMapInstance
  Marker: new (options: Record<string, unknown>) => { on: (event: string, handler: (event: AMapEvent) => void) => void }
  Geocoder: new (options: Record<string, unknown>) => {
    getAddress: (position: [number, number], callback: (status: string, result: { regeocode?: { formattedAddress?: string } }) => void) => void
    getLocation: (
      address: string,
      callback: (status: string, result: { geocodes?: Array<{ location?: AMapGeocodeLocation }> }) => void,
    ) => void
  }
}

declare global {
  interface Window {
    AMap?: AMapSdk
    _AMapSecurityConfig?: Record<string, string>
  }
}

const AMAP_SECURITY_CODE = import.meta.env.VITE_AMAP_SECURITY_CODE as string | undefined
const AMAP_SCRIPT_SRC = import.meta.env.VITE_AMAP_SCRIPT_SRC as string | undefined

function loadAmap(): Promise<AMapSdk> {
  if (window.AMap) return Promise.resolve(window.AMap)
  if (!AMAP_SCRIPT_SRC) return Promise.reject(new Error("未配置高德地图脚本"))
  const key = new URL(AMAP_SCRIPT_SRC).searchParams.get("key")
  if (!key) return Promise.reject(new Error("高德地图 Key 不完整"))
  if (AMAP_SECURITY_CODE) window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE }
  return AMapLoader.load({
    key,
    version: "2.0",
    plugins: ["AMap.Geocoder", "AMap.PlaceSearch"],
  }) as Promise<AMapSdk>
}

async function geocodeLocationName(name: string): Promise<{ latitude: number; longitude: number } | null> {
  const AMap = await loadAmap()
  return new Promise((resolve) => {
    new AMap.Geocoder({ city: "全国" }).getLocation(name, (status, result) => {
      const location = status === "complete" ? result.geocodes?.[0]?.location : undefined
      const longitude = location?.getLng?.() ?? location?.lng
      const latitude = location?.getLat?.() ?? location?.lat
      resolve(
        Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { latitude: Number(latitude), longitude: Number(longitude) }
          : null,
      )
    })
  })
}

async function reverseGeocodeCoordinates(latitude: number, longitude: number): Promise<string> {
  const AMap = await loadAmap()
  return new Promise((resolve) => {
    new AMap.Geocoder({}).getAddress([longitude, latitude], (status, result) => {
      resolve(status === "complete" ? result.regeocode?.formattedAddress?.trim() ?? "" : "")
    })
  })
}

function GpsMapPicker({ latitude, longitude, onPick }: {
  latitude: string
  longitude: string
  onPick: (latitude: string, longitude: string, locationName?: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<AMapInstance | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading")

  async function applyPoint(event: AMapEvent) {
    if (!event.lnglat) return
    const nextLatitude = event.lnglat.getLat().toFixed(6)
    const nextLongitude = event.lnglat.getLng().toFixed(6)
    let locationName = ""
    try {
      locationName = await reverseGeocodeCoordinates(
        Number(nextLatitude),
        Number(nextLongitude),
      )
    } catch {
      // Coordinates remain usable even if reverse geocoding is unavailable.
    }
    onPick(nextLatitude, nextLongitude, locationName || undefined)
  }

  useEffect(() => {
    if (!containerRef.current || !AMAP_SCRIPT_SRC) { setState("missing"); return }
    let disposed = false
    const mount = async () => {
      try {
      const AMap = await loadAmap()
      if (disposed || !containerRef.current) return
      const latitudeValue = Number(latitude) || 39.90923
      const longitudeValue = Number(longitude) || 116.397428
      const map = new AMap.Map(containerRef.current, { zoom: 15, center: [longitudeValue, latitudeValue] })
      map.on("click", (event) => {
        void applyPoint(event)
      })
      if (Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
        const marker = new AMap.Marker({ position: [longitudeValue, latitudeValue], draggable: true })
        marker.on("dragend", (event) => { void applyPoint(event) })
        map.add(marker)
      }
      mapRef.current = map
      setState("ready")
      } catch {
        if (!disposed) setState("error")
      }
    }
    void mount()
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    const latitudeValue = Number(latitude)
    const longitudeValue = Number(longitude)
    const map = mapRef.current
    if (!map || !window.AMap || !Number.isFinite(latitudeValue) || !Number.isFinite(longitudeValue)) return
    map.clearMap()
    map.setZoomAndCenter(15, [longitudeValue, latitudeValue])
    const marker = new window.AMap.Marker({ position: [longitudeValue, latitudeValue], draggable: true })
    marker.on("dragend", (event) => {
      void applyPoint(event)
    })
    map.add(marker)
  }, [latitude, longitude, onPick])

  if (state === "missing") return <p className="muted gps-map-hint">高德地图配置未载入，请检查前端重启后是否读取项目 .env。</p>
  if (state === "error") return <p className="error-text">地图加载失败，请直接填写坐标。</p>
  return <div className="gps-map-wrap"><div ref={containerRef} className="gps-map" />{state === "loading" ? <span>正在加载地图…</span> : null}</div>
}

function ExifConsole({ apiBaseUrl }: ExifConsoleProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const itemsRef = useRef<ExifWorkbenchItem[]>([])
  const locatingDisplayLocationRef = useRef(false)
  const draftWriteTimerRef = useRef<number | null>(null)
  const draftStorageFailureRef = useRef(false)
  const artifactMatchLookupRef = useRef(new Set<string>())
  const [items, setItems] = useState<ExifWorkbenchItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [directoryHandle, setDirectoryHandle] = useState<WritableDirectoryHandle | null>(null)
  const [tagInput, setTagInput] = useState("")
  const [sharedForm, setSharedForm] = useState<FormState>(buildBaseForm())
  const [museumSuggestions, setMuseumSuggestions] = useState<MuseumOption[]>([])
  const [locationSuggestions, setLocationSuggestions] = useState<MuseumOption[]>([])
  const [showMuseumSuggestions, setShowMuseumSuggestions] = useState(false)
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadActivity, setUploadActivity] = useState<UploadActivity>(null)
  const [bindingDirectory, setBindingDirectory] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [descriptionGeneratingItemIds, setDescriptionGeneratingItemIds] = useState<string[]>([])
  const [descriptionProgress, setDescriptionProgress] = useState<string[]>([])
  const [liveResearchSummary, setLiveResearchSummary] = useState("")
  const [liveProviders, setLiveProviders] = useState<Record<string, LiveProviderState>>({})
  const [batchPrefix, setBatchPrefix] = useState("")
  const [batchSuffix, setBatchSuffix] = useState("")
  const [batchRemove, setBatchRemove] = useState("")
  const [batchLocationName, setBatchLocationName] = useState("")
  const [batchExhibitionName, setBatchExhibitionName] = useState("常设")
  const [batchCatalogExhibitionId, setBatchCatalogExhibitionId] = useState<number | null>(null)
  const [batchCatalogExhibitionSourceId, setBatchCatalogExhibitionSourceId] = useState("")
  const [batchLatitude, setBatchLatitude] = useState("")
  const [batchLongitude, setBatchLongitude] = useState("")
  const [metadataSyncSourceId, setMetadataSyncSourceId] = useState("")
  const [metadataSyncTargetMode, setMetadataSyncTargetMode] = useState<MetadataSyncTargetMode>("others")
  const [metadataSyncTargetIds, setMetadataSyncTargetIds] = useState<string[]>([])
  const [metadataSyncSelection, setMetadataSyncSelection] = useState<MetadataSyncSelection>(DEFAULT_METADATA_SYNC_SELECTION)
  const [metadataSyncPreviewOpen, setMetadataSyncPreviewOpen] = useState(false)
  const [uploadPermissionOpen, setUploadPermissionOpen] = useState(false)
  const [artifactMatchReviewIds, setArtifactMatchReviewIds] = useState<string[]>([])
  const [openUploadPermissionAfterArtifactReview, setOpenUploadPermissionAfterArtifactReview] = useState(false)
  const [recentUploadedCount, setRecentUploadedCount] = useState(0)
  const [parsingFileName, setParsingFileName] = useState(false)
  const [submittingAll, setSubmittingAll] = useState(false)
  const [submitNotice, setSubmitNotice] = useState<SubmitNotice | null>(null)
  const [draftStorageReady, setDraftStorageReady] = useState(false)

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  )
  const artifactMatchReviewItem = useMemo(
    () => items.find((item) => item.id === artifactMatchReviewIds[0]) ?? null,
    [artifactMatchReviewIds, items],
  )
  const activeFieldWarnings = useMemo(() => {
    if (!selectedItem) return []
    const activeCandidate = ensureCandidates(selectedItem.candidates).find(
      (candidate) => candidate.status === "success"
        && candidate.description === selectedItem.form.description,
    )
    return activeCandidate?.field_warnings ?? []
  }, [selectedItem])

  function warningForField(field: ArtifactFieldWarning["field"]) {
    return activeFieldWarnings.find((warning) => warning.field === field)
  }

  const stats = useMemo(() => {
    const describedCount = items.filter((item) =>
      ensureCandidates(item.candidates).some((candidate) => candidate.status === "success"),
    ).length
    const submittedCount = items.filter((item) => item.submitState === "submitted").length
    const gpsCount = items.filter((item) => item.form.latitude.trim() && item.form.longitude.trim()).length
    return {
      itemCount: items.length,
      describedCount,
      submittedCount,
      gpsCount,
    }
  }, [items])

  const needsDirectoryAuthorization = useMemo(
    () => items.some((item) => !item.fileHandle || (item.fileName !== item.originalFileName && !directoryHandle)),
    [directoryHandle, items],
  )

  const allItemsSubmitted = useMemo(
    () => items.length > 0 && items.every((item) => item.submitState === "submitted" && changedParts(item).length === 0),
    [items],
  )

  const batchRenameCount = useMemo(() => items.filter((item) => (
    normalizedFileName(`${batchPrefix}${fileBaseName(item.fileName).split(batchRemove).join("")}${batchSuffix}`, item.fileName) !== item.fileName
  )).length, [items, batchPrefix, batchRemove, batchSuffix])

  const metadataSyncSource = useMemo(
    () => items.find((item) => item.id === metadataSyncSourceId) ?? null,
    [items, metadataSyncSourceId],
  )

  const metadataSyncAvailableTargets = useMemo(
    () => items.filter((item) => item.id !== metadataSyncSource?.id),
    [items, metadataSyncSource],
  )

  const metadataSyncTargets = useMemo(() => {
    if (!metadataSyncSource) return []
    if (metadataSyncTargetMode === "current") {
      return selectedItem && selectedItem.id !== metadataSyncSource.id ? [selectedItem] : []
    }
    if (metadataSyncTargetMode === "selected") {
      const targetIds = new Set(metadataSyncTargetIds)
      return metadataSyncAvailableTargets.filter((item) => targetIds.has(item.id))
    }
    return items.filter((item) => item.id !== metadataSyncSource.id)
  }, [
    items,
    metadataSyncAvailableTargets,
    metadataSyncSource,
    metadataSyncTargetIds,
    metadataSyncTargetMode,
    selectedItem,
  ])

  const metadataSyncDiffs = useMemo(() => metadataSyncTargets.map((target) => {
    const rows = METADATA_SYNC_GROUPS
      .flatMap((group) => group.fields)
      .filter((field) => metadataSyncSelection[field.key])
      .flatMap((field) => buildMetadataSyncDiffRows(target.form, metadataSyncSource?.form ?? EMPTY_FORM, field.key))
      .filter((row) => row.changed)
    return { target, rows }
  }), [metadataSyncSelection, metadataSyncSource, metadataSyncTargets])

  const metadataSyncSelectedCount = useMemo(
    () => Object.values(metadataSyncSelection).filter(Boolean).length,
    [metadataSyncSelection],
  )

  const metadataSyncChangedCount = useMemo(
    () => metadataSyncDiffs.reduce((count, entry) => count + entry.rows.length, 0),
    [metadataSyncDiffs],
  )

  useEffect(() => { itemsRef.current = items }, [items])

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        // Ask the browser to retain large, unsubmitted image drafts when it
        // supports persistent storage. A refusal still falls back to IndexedDB.
        await navigator.storage?.persist?.()
        const draft = await readExifDraft()
        if (disposed || !draft || draft.version !== 1 || draft.items.length === 0) return
        const restoredItems = await restoreExifDraftItems(draft.items, apiBaseUrl)
        if (disposed) {
          restoredItems.forEach((item) => revokePreviewUrl(item.previewUrl))
          return
        }
        setItems(restoredItems)
        setSelectedId(restoredItems.some((item) => item.id === draft.selectedId) ? draft.selectedId : restoredItems[0]?.id ?? null)
        setSharedForm(cloneFormState(draft.sharedForm))
        setSubmitNotice({ type: "success", text: `已恢复 ${restoredItems.length} 张未提交图片的本地草稿；如需回写原文件，请重新授权照片文件夹。` })
      } catch {
        if (!disposed) setSubmitNotice({ type: "error", text: "本地草稿无法恢复；请重新添加图片。" })
      } finally {
        if (!disposed) setDraftStorageReady(true)
      }
    })()
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (!draftStorageReady) return
    if (draftWriteTimerRef.current !== null) window.clearTimeout(draftWriteTimerRef.current)
    const pendingItems = items.filter((item) => item.submitState !== "submitted" || changedParts(item).length > 0)
    draftWriteTimerRef.current = window.setTimeout(() => {
      const persist = pendingItems.length > 0
        ? writeExifDraft({
            version: 1,
            items: pendingItems.map(serializeExifDraftItem),
            selectedId: pendingItems.some((item) => item.id === selectedId) ? selectedId : pendingItems[0]?.id ?? null,
            sharedForm: cloneFormState(sharedForm),
          })
        : clearExifDraft()
      void Promise.all([persist, writeReuploadHints(items)]).then(() => {
        draftStorageFailureRef.current = false
      }).catch(() => {
        if (draftStorageFailureRef.current) return
        draftStorageFailureRef.current = true
        setSubmitNotice({ type: "error", text: "本地草稿存储空间不足，未提交内容仍保留在当前页面；请先完成部分入库或清理浏览器站点数据。" })
      })
    }, 650)
    return () => {
      if (draftWriteTimerRef.current !== null) window.clearTimeout(draftWriteTimerRef.current)
    }
  }, [draftStorageReady, items, selectedId, sharedForm])

  useEffect(() => {
    if (!draftStorageReady) return
    const target = items.find((item) => {
      if (item.existingArtifactId != null || (item.existingArtifactCandidates?.length ?? 0) > 0) return false
      const identity = artifactReviewIdentityKey(item.form)
      return Boolean(identity) && item.existingArtifactReviewKey !== identity
    })
    if (!target) return
    const identity = artifactReviewIdentityKey(target.form)
    const lookupKey = `${target.id}:${identity}`
    if (artifactMatchLookupRef.current.has(lookupKey)) return
    artifactMatchLookupRef.current.add(lookupKey)
    setItems((current) => current.map((item) => item.id === target.id
      ? { ...item, existingArtifactReviewKey: identity }
      : item))
    void lookupExistingArtifactCandidates(apiBaseUrl, target.form)
      .then((matches) => {
        if (matches.length === 0) return
        setItems((current) => current.map((item) => item.id === target.id ? {
          ...item,
          existingArtifactCandidates: matches,
          descriptionMeta: `发现 ${matches.length} 件可能对应的已入库文物，请确认后填入。`,
          submitMessage: "发现可能对应的已入库文物，请先选择是否复用。",
        } : item))
        setArtifactMatchReviewIds((current) => (
          current.includes(target.id) ? current : [...current, target.id]
        ))
      })
      .finally(() => artifactMatchLookupRef.current.delete(lookupKey))
  }, [apiBaseUrl, draftStorageReady, items])

  useEffect(() => {
    if (metadataSyncSourceId && items.some((item) => item.id === metadataSyncSourceId)) return
    setMetadataSyncSourceId(items[0]?.id ?? "")
  }, [items, metadataSyncSourceId])

  useEffect(() => {
    const availableIds = new Set(metadataSyncAvailableTargets.map((item) => item.id))
    setMetadataSyncTargetIds((current) => current.filter((id) => availableIds.has(id)))
  }, [metadataSyncAvailableTargets])

  useEffect(() => () => {
    itemsRef.current.forEach((item) => revokePreviewUrl(item.previewUrl))
  }, [])

  useEffect(() => {
    if (!selectedItem || !showMuseumSuggestions) {
      return
    }
    const timer = window.setTimeout(() => {
      void loadMuseumSuggestions(apiBaseUrl, selectedItem.form.museumName.trim(), setMuseumSuggestions)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [apiBaseUrl, selectedItem, showMuseumSuggestions])

  useEffect(() => {
    if (!selectedItem || !showLocationSuggestions) {
      return
    }
    const timer = window.setTimeout(() => {
      void loadMuseumSuggestions(apiBaseUrl, selectedItem.form.displayLocationName.trim(), setLocationSuggestions)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [apiBaseUrl, selectedItem, showLocationSuggestions])

  useEffect(() => {
    if (!selectedItem?.fileName.trim()) return
    if (selectedItem.parsedName?.original_name === selectedItem.fileName) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setParsingFileName(true)
      try {
        const parsed = await fetchJson<ParsedArtifactName>(
          `${apiBaseUrl}/api/artifacts/parse-name?${new URLSearchParams({ name: selectedItem.fileName }).toString()}`,
        )
        if (cancelled) return
        let museum: MuseumOption | null = null
        if (parsed.museum_name) {
          try { museum = await resolveMuseum(apiBaseUrl, parsed.museum_name) } catch { /* keep parsed metadata */ }
        }
        if (cancelled) return
        updateItem(selectedItem.id, (item) => ({
          ...item,
          parsedName: parsed,
          form: {
            ...item.form,
            name: parsed.artifact_name ?? item.form.name,
            era: parsed.era ?? item.form.era,
            museumName: parsed.museum_name ?? item.form.museumName,
            placeOfExcavation: parsed.Place_of_Excavation ?? item.form.placeOfExcavation,
            displayLocationName: parsed.museum_name ?? item.form.displayLocationName,
            latitude: museum?.latitude?.toString() ?? item.form.latitude,
            longitude: museum?.longitude?.toString() ?? item.form.longitude,
          },
        }))
      } catch {
        // Keep manual fields usable while the filename is incomplete.
      } finally {
        if (!cancelled) setParsingFileName(false)
      }
    }, 280)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [apiBaseUrl, selectedId, selectedItem?.fileName])

  function updateItem(itemId: string, updater: (item: ExifWorkbenchItem) => ExifWorkbenchItem) {
    setItems((current) => current.map((item) => (item.id === itemId ? updater(item) : item)))
  }

  function beginArtifactMatchReview(
    builtItems: ExifWorkbenchItem[],
    shouldOpenUploadPermission: boolean,
  ) {
    const reviewIds = builtItems
      .filter((item) => (item.existingArtifactCandidates?.length ?? 0) > 0)
      .map((item) => item.id)
    if (reviewIds.length === 0) {
      if (shouldOpenUploadPermission) setUploadPermissionOpen(true)
      return
    }
    setArtifactMatchReviewIds(reviewIds)
    setOpenUploadPermissionAfterArtifactReview(shouldOpenUploadPermission)
  }

  function advanceArtifactMatchReview() {
    const remaining = artifactMatchReviewIds.slice(1)
    setArtifactMatchReviewIds(remaining)
    if (remaining.length === 0 && openUploadPermissionAfterArtifactReview) {
      setOpenUploadPermissionAfterArtifactReview(false)
      setUploadPermissionOpen(true)
    }
  }

  function selectExistingArtifactMatch(match: ExistingArtifactMatch) {
    if (!artifactMatchReviewItem) return
    const itemId = artifactMatchReviewItem.id
    updateItem(itemId, (item) => {
      const nextForm = applyExistingArtifactToForm(item.form, match.artifact)
      return {
        ...item,
        form: nextForm,
        existingArtifactId: match.artifact.id,
        existingArtifactMatch: match.match_reason,
        existingArtifactCandidates: [],
        existingArtifactReviewKey: artifactReviewIdentityKey(nextForm),
        descriptionMeta: `已关联云端文物 #${match.artifact.id}`,
        submitMessage: `已采用“${match.artifact.name}”的文物信息，新照片将追加到这件文物。`,
      }
    })
    setSelectedId(itemId)
    advanceArtifactMatchReview()
  }

  function rejectExistingArtifactMatches() {
    if (!artifactMatchReviewItem) return
    updateItem(artifactMatchReviewItem.id, (item) => ({
      ...item,
      existingArtifactId: null,
      existingArtifactMatch: null,
      existingArtifactCandidates: [],
      existingArtifactReviewKey: artifactReviewIdentityKey(item.form),
      descriptionMeta: null,
      submitMessage: "已选择不复用已有文物信息，本次将按新文物提交。",
    }))
    advanceArtifactMatchReview()
  }

  function updateSelectedForm(patch: Partial<FormState>) {
    if (!selectedItem) {
      return
    }
    updateItem(selectedItem.id, (item) => ({
      ...item,
      form: { ...item.form, ...patch },
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    }))
  }

  async function locateDisplayLocation(locationName: string, preferredMuseum?: MuseumOption) {
    if (!selectedItem || locatingDisplayLocationRef.current) return
    const normalizedName = locationName.trim()
    if (!normalizedName) {
      setSubmitNotice({ type: "error", text: "请先输入展出地点名称" })
      return
    }

    const itemId = selectedItem.id
    locatingDisplayLocationRef.current = true
    setSubmitNotice(null)
    try {
      let museum = preferredMuseum
        ?? locationSuggestions.find((option) => option.name === normalizedName)
        ?? null
      if (!museum) {
        try {
          museum = await resolveMuseum(apiBaseUrl, normalizedName)
        } catch {
          museum = null
        }
      }

      let coordinates = museum?.latitude !== null
        && museum?.latitude !== undefined
        && museum.longitude !== null
        && museum.longitude !== undefined
        ? { latitude: museum.latitude, longitude: museum.longitude }
        : null
      if (!coordinates) {
        coordinates = await geocodeLocationName(normalizedName)
      }
      if (!coordinates) {
        throw new Error("未找到可用坐标")
      }

      updateItem(itemId, (item) => ({
        ...item,
        form: {
          ...item.form,
          displayLocationName: museum?.name || normalizedName,
          latitude: coordinates.latitude.toFixed(6),
          longitude: coordinates.longitude.toFixed(6),
        },
        submitState: item.submitState === "submitted" ? "idle" : item.submitState,
        submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
      }))
      setShowLocationSuggestions(false)
      setSubmitNotice({ type: "success", text: `已定位“${museum?.name || normalizedName}”并补充 GPS` })
    } catch {
      setSubmitNotice({ type: "error", text: `未能定位“${normalizedName}”，请从候选地点中选择或在地图上取点` })
    } finally {
      locatingDisplayLocationRef.current = false
    }
  }

  function renameSelected(baseName: string) {
    if (!selectedItem) return
    updateItem(selectedItem.id, (item) => ({
      ...item,
      fileName: normalizedFileName(baseName, item.fileName),
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    }))
  }

  function applyBatchRename() {
    if (!batchPrefix && !batchSuffix && !batchRemove) return
    const renamed = items.map((item) => ({
      id: item.id,
      fileName: normalizedFileName(
        `${batchPrefix}${fileBaseName(item.fileName).split(batchRemove).join("")}${batchSuffix}`,
        item.fileName,
      ),
    }))
    setItems((current) => current.map((item) => ({
      ...item,
      fileName: renamed.find((entry) => entry.id === item.id)?.fileName ?? item.fileName,
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    })))
    void Promise.all(renamed.map(async (entry) => {
      try {
        const parsed = await fetchJson<ParsedArtifactName>(
          `${apiBaseUrl}/api/artifacts/parse-name?${new URLSearchParams({ name: entry.fileName }).toString()}`,
        )
        updateItem(entry.id, (item) => ({
          ...item,
          parsedName: parsed,
          form: {
            ...item.form,
            name: parsed.artifact_name ?? item.form.name,
            era: parsed.era ?? item.form.era,
            museumName: parsed.museum_name ?? item.form.museumName,
            placeOfExcavation: parsed.Place_of_Excavation ?? item.form.placeOfExcavation,
            displayLocationName: parsed.museum_name ?? item.form.displayLocationName,
          },
        }))
      } catch { /* retain the renamed filename and existing metadata */ }
    }))
    setSubmitNotice({ type: "success", text: `已按规则更新 ${items.length} 个目标文件名，入库时将使用新名称` })
  }

  function useSelectedLocationForBatch() {
    if (!selectedItem) return
    setBatchLocationName(selectedItem.form.displayLocationName)
    setBatchExhibitionName(selectedItem.form.exhibitionName)
    setBatchCatalogExhibitionId(selectedItem.form.catalogExhibitionId)
    setBatchCatalogExhibitionSourceId(selectedItem.form.catalogExhibitionSourceId)
    setBatchLatitude(selectedItem.form.latitude)
    setBatchLongitude(selectedItem.form.longitude)
    setSubmitNotice({ type: "success", text: "已带入当前图片的展出地点与 GPS，可继续微调后应用到全部图片" })
  }

  function selectMetadataSyncPreset(preset: "default" | "location" | "content" | "all" | "none") {
    setMetadataSyncSelection(preset === "default"
      ? { ...DEFAULT_METADATA_SYNC_SELECTION }
      : preset === "location"
        ? metadataSyncSelectionFor(["displayLocation", "exhibition", "gps"])
        : preset === "content"
          ? metadataSyncSelectionFor(["description", "tags"])
          : metadataSyncSelectionFor(
              preset === "all"
                ? METADATA_SYNC_GROUPS.flatMap((group) => group.fields.map((field) => field.key))
                : [],
            ))
  }

  function openMetadataSyncPreview() {
    if (!metadataSyncSource) {
      setSubmitNotice({ type: "error", text: "请先选择一张来源照片" })
      return
    }
    if (!Object.values(metadataSyncSelection).some(Boolean)) {
      setSubmitNotice({ type: "error", text: "请至少开启一项需要同步的信息" })
      return
    }
    if (metadataSyncTargets.length === 0 && metadataSyncTargetMode !== "selected") {
      setSubmitNotice({
        type: "error",
        text: metadataSyncTargetMode === "current" && selectedItem?.id === metadataSyncSource.id
          ? "当前图片就是来源照片，请选择另一张目标图片"
          : "没有可同步的目标照片",
      })
      return
    }
    setMetadataSyncPreviewOpen(true)
  }

  function syncSelectedMetadataToOthers() {
    if (!selectedItem || items.length < 2) {
      setSubmitNotice({ type: "error", text: "至少需要两张图片，才能同步当前照片的信息" })
      return
    }
    setMetadataSyncSourceId(selectedItem.id)
    setMetadataSyncTargetMode("selected")
    setMetadataSyncTargetIds([])
    if (!Object.values(metadataSyncSelection).some(Boolean)) {
      selectMetadataSyncPreset("default")
    }
    setMetadataSyncPreviewOpen(true)
  }

  function applyMetadataSync() {
    if (!metadataSyncSource || metadataSyncTargets.length === 0) return
    const targetIds = new Set(metadataSyncTargets.map((item) => item.id))
    setItems((current) => current.map((item) => targetIds.has(item.id) ? {
      ...item,
      form: applySourceMetadata(item.form, metadataSyncSource.form, metadataSyncSelection),
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    } : item))
    setMetadataSyncPreviewOpen(false)
    setSubmitNotice({
      type: "success",
      text: `已从“${metadataSyncSource.fileName}”同步 ${metadataSyncChangedCount} 项信息到 ${metadataSyncTargets.length} 张照片`,
    })
  }

  function applyBatchLocation() {
    const latitude = toNullableNumber(batchLatitude)
    const longitude = toNullableNumber(batchLongitude)
    if ((latitude === null) !== (longitude === null)) {
      setSubmitNotice({ type: "error", text: "批量 GPS 需要同时填写纬度和经度" })
      return
    }
    setItems((current) => current.map((item) => ({
      ...item,
      form: {
        ...item.form,
        displayLocationName: batchLocationName.trim() || item.form.displayLocationName,
        exhibitionName: batchExhibitionName.trim() || item.form.exhibitionName,
        catalogExhibitionId: batchCatalogExhibitionId,
        catalogExhibitionSourceId: batchCatalogExhibitionSourceId,
        latitude: latitude === null ? item.form.latitude : String(latitude),
        longitude: longitude === null ? item.form.longitude : String(longitude),
      },
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    })))
    setSubmitNotice({ type: "success", text: `已将展出地点与 GPS 应用到 ${items.length} 张图片` })
  }

  function updateSharedForm(patch: Partial<FormState>) {
    setSharedForm((current) => ({ ...current, ...patch }))
  }

  function fillSharedFromSelected() {
    if (!selectedItem) {
      return
    }
    setSharedForm(cloneFormState(selectedItem.form))
    setSubmitNotice({ type: "success", text: "已用当前图片内容刷新共享文物信息" })
  }

  function applySharedToAll() {
    if (items.length === 0) {
      return
    }
    const nextShared = cloneFormState(sharedForm)
    setItems((current) => current.map((item) => ({
      ...item,
      form: applySharedForm(item.form, nextShared),
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    })))
    setSubmitNotice({ type: "success", text: `已将共享字段应用到 ${items.length} 张图片` })
  }

  async function createWorkbenchItem(
    file: File,
    index: number,
    fileHandle: WritableFileHandle | null = null,
  ): Promise<ExifWorkbenchItem> {
    let parsedName: ParsedArtifactName | null = null
    let form = buildBaseForm()
    let previewUrl = ""
    let existingArtifactId: number | null = null
    let existingArtifactMatch: string | null = null
    let existingArtifactCandidates: ExistingArtifactMatch[] = []

    try {
      const exifForm = new FormData()
      exifForm.append("file", file)
      const metadata = await fetchJson<ImageExifMetadata>(`${apiBaseUrl}/api/artifacts/extract-exif-file`, {
        method: "POST",
        body: exifForm,
      })
      form = {
        ...form,
        cameraModel: metadata.camera_model ?? "",
        lensModel: metadata.lens_model ?? "",
        capturedAt: formatCapturedAt(metadata.captured_at),
        shutterSpeed: metadata.shutter_speed ?? "",
        aperture: metadata.aperture ?? "",
        iso: metadata.iso?.toString() ?? "",
        latitude: metadata.latitude?.toString() ?? "",
        longitude: metadata.longitude?.toString() ?? "",
      }
      if (metadata.latitude !== null && metadata.longitude !== null) {
        try {
          form = {
            ...form,
            displayLocationName: await reverseGeocodeCoordinates(
              metadata.latitude,
              metadata.longitude,
            ),
          }
        } catch {
          // GPS is still sufficient for nearest-museum recommendation.
        }
      }
      previewUrl = metadata.preview_data_url ?? ""
    } catch {
      // Images without readable EXIF remain fully editable.
    }

    if (!previewUrl) previewUrl = await createFallbackPreviewUrl(file)

    try {
      parsedName = await fetchJson<ParsedArtifactName>(
        `${apiBaseUrl}/api/artifacts/parse-name?${new URLSearchParams({ name: file.name }).toString()}`,
      )
      form = {
        ...form,
        museumName: parsedName.museum_name ?? form.museumName,
        name: parsedName.artifact_name ?? form.name,
        era: parsedName.era ?? form.era,
        placeOfExcavation: parsedName.Place_of_Excavation ?? form.placeOfExcavation,
        displayLocationName: parsedName.museum_name ?? form.displayLocationName,
      }

      if (parsedName.museum_name) {
        const museum = await resolveMuseum(apiBaseUrl, parsedName.museum_name)
        if (museum) {
          form = {
            ...form,
            museumName: form.museumName || museum.name,
            displayLocationName: form.displayLocationName || museum.name,
            latitude: form.latitude || museum.latitude?.toString() || "",
            longitude: form.longitude || museum.longitude?.toString() || "",
          }
        }
      }
    } catch {
      // keep default form
    }

    try {
      const hint = await readReuploadHint(file.name)
      if (hint) form = applyReuploadHintToForm(form, hint)
    } catch {
      // A missing local hint must not block normal image intake.
    }
    existingArtifactCandidates = await lookupExistingArtifactCandidates(apiBaseUrl, form)

    return {
      id: buildItemId(file, index),
      fileName: file.name,
      originalFileName: file.name,
      previewUrl,
      localFile: file,
      fileHandle,
      parsedName,
      form,
      originalForm: cloneFormState(form),
      candidates: [],
      unavailableProviders: [],
      descriptionMeta: existingArtifactCandidates.length > 0
        ? `发现 ${existingArtifactCandidates.length} 件可能对应的已入库文物，请确认后填入。`
        : null,
      existingArtifactId,
      existingArtifactMatch,
      existingArtifactCandidates,
      existingArtifactReviewKey: artifactReviewIdentityKey(form) || null,
      submitState: "idle",
      submitMessage: existingArtifactCandidates.length > 0
        ? "发现可能对应的已入库文物，请先选择是否复用。"
        : null,
      uploadProgress: 0,
      uploadStage: null,
    }
  }

  function handleSelectImages() {
    fileInputRef.current?.click()
  }

  async function handleSelectDirectory() {
    const pickerWindow = window as FilePickerWindow
    if (!pickerWindow.showDirectoryPicker) {
      fileInputRef.current?.click()
      setSubmitNotice({ type: "error", text: "当前浏览器不支持文件夹读写授权；保存并入库需要同步改名和写回 EXIF，请使用最新版 Chrome 或 Edge。" })
      return
    }
    try {
      setUploadActivity("directory")
      setUploading(true)
      const nextDirectoryHandle = await pickerWindow.showDirectoryPicker({ mode: "readwrite" })
      if (!await verifyWritablePermission(nextDirectoryHandle)) {
        setSubmitNotice({ type: "error", text: "需要授予文件夹读写权限，才能批量回写照片" })
        return
      }

      const entries = await listDirectoryImageEntries(nextDirectoryHandle)

      const currentNames = new Set(items.flatMap((item) => [item.fileName, item.originalFileName]))
      const addedEntries = entries.filter((entry) => !currentNames.has(entry.file.name))
      const builtItems: ExifWorkbenchItem[] = []
      for (let index = 0; index < addedEntries.length; index += 1) {
        const entry = addedEntries[index]
        setSubmitNotice({ type: "success", text: `正在解析文件夹照片 ${index + 1}/${addedEntries.length}：${entry.file.name}` })
        const builtItem = await createWorkbenchItem(entry.file, items.length + index, entry.handle)
        builtItems.push(builtItem)
        setItems((current) => [...current, builtItem])
        setSelectedId((current) => current ?? builtItem.id)
        await yieldToMainThread()
      }

      setDirectoryHandle(nextDirectoryHandle)
      const matchCount = builtItems.filter((item) => item.existingArtifactCandidates.length > 0).length
      setSubmitNotice({
        type: "success",
        text: `已从文件夹“${nextDirectoryHandle.name}”载入 ${builtItems.length} 张照片${matchCount > 0 ? `，其中 ${matchCount} 张发现已有文物候选，请确认选择` : ""}，并获得批量原地回写权限；未提交内容会自动保存在本机浏览器。`,
      })
      beginArtifactMatchReview(builtItems, false)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setSubmitNotice({ type: "error", text: error instanceof Error ? error.message : "读取照片文件夹失败" })
    } finally {
      setUploading(false)
      setUploadActivity(null)
    }
  }

  async function handleBindDirectory() {
    const pickerWindow = window as FilePickerWindow
    if (!pickerWindow.showDirectoryPicker) {
      setSubmitNotice({ type: "error", text: "当前浏览器不支持文件夹授权，请使用最新版 Chrome 或 Edge" })
      return
    }
    if (items.length === 0) {
      setSubmitNotice({ type: "error", text: "请先添加需要处理的图片，再授权其所在文件夹" })
      return
    }

    setBindingDirectory(true)
    try {
      const nextDirectoryHandle = await pickerWindow.showDirectoryPicker({ mode: "readwrite" })
      if (!await verifyWritablePermission(nextDirectoryHandle)) {
        setSubmitNotice({ type: "error", text: "需要授予文件夹读写权限，才能绑定并回写原照片" })
        return
      }
      const entries = await listDirectoryImageEntries(nextDirectoryHandle)
      const entriesByName = new Map<string, Array<{ handle: WritableFileHandle; file: File; index: number }>>()
      entries.forEach((entry, index) => {
        const candidates = entriesByName.get(entry.file.name) ?? []
        candidates.push({ ...entry, index })
        entriesByName.set(entry.file.name, candidates)
      })

      let matched = 0
      let exactMatched = 0
      let fallbackMatched = 0
      let missing = 0
      let ambiguous = 0
      const usedIndexes = new Set<number>()
      setItems((current) => current.map((item) => {
        if (item.fileHandle) return item
        const candidates = (entriesByName.get(item.originalFileName) ?? entriesByName.get(item.fileName) ?? [])
          .filter((entry) => !usedIndexes.has(entry.index))
        if (candidates.length === 0) {
          missing += 1
          return item
        }
        const exact = candidates.filter((entry) => (
          entry.file.size === item.localFile.size && entry.file.lastModified === item.localFile.lastModified
        ))
        if (exact.length === 1) {
          usedIndexes.add(exact[0].index)
          matched += 1
          exactMatched += 1
          return { ...item, fileHandle: exact[0].handle }
        }
        const sameSize = candidates.filter((entry) => entry.file.size === item.localFile.size)
        if (sameSize.length === 1) {
          usedIndexes.add(sameSize[0].index)
          matched += 1
          fallbackMatched += 1
          return { ...item, fileHandle: sameSize[0].handle }
        }
        ambiguous += 1
        return item
      }))
      setDirectoryHandle(nextDirectoryHandle)
      const summary = [`已绑定 ${matched} 张`]
      if (exactMatched > 0) summary.push(`精确匹配 ${exactMatched} 张`)
      if (fallbackMatched > 0) summary.push(`文件名和大小匹配 ${fallbackMatched} 张`)
      if (missing > 0) summary.push(`${missing} 张未找到`)
      if (ambiguous > 0) summary.push(`${ambiguous} 张重名未绑定`)
      setSubmitNotice({
        type: matched > 0 ? "success" : "error",
        text: `${nextDirectoryHandle.name}：${summary.join("，")}；未载入文件夹内其他照片`,
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setSubmitNotice({
          type: "success",
          text: "已取消文件夹授权；队列图片仍会保留，可稍后点击图片列表上方的文件夹按钮继续。",
        })
        return
      }
      setSubmitNotice({ type: "error", text: error instanceof Error ? error.message : "授权并绑定原文件夹失败" })
    } finally {
      setBindingDirectory(false)
    }
  }

  async function handleUpload(nextFiles: File[]) {
    if (nextFiles.length === 0) {
      setSubmitNotice({ type: "error", text: "请先选择至少一张图片" })
      return
    }

    setUploadActivity("files")
    setUploading(true)
    setSubmitNotice(null)
    try {
      const builtItems: ExifWorkbenchItem[] = []
      const baseIndex = items.length
      for (let index = 0; index < nextFiles.length; index += 1) {
        const file = nextFiles[index]
        setSubmitNotice({ type: "success", text: `正在解析 ${index + 1}/${nextFiles.length}：${file.name}` })
        const builtItem = await createWorkbenchItem(file, baseIndex + index)
        builtItems.push(builtItem)
        setItems((current) => [...current, builtItem])
        setSelectedId((current) => current ?? builtItem.id)
        await yieldToMainThread()
      }
      setSharedForm((current) => {
        if (hasMeaningfulFormValue(current)) {
          return current
        }
        const seedForm = builtItems.find((item) => hasMeaningfulFormValue(item.form))?.form
        return seedForm ? cloneFormState(seedForm) : current
      })
      const matchCount = builtItems.filter((item) => item.existingArtifactCandidates.length > 0).length
      setSubmitNotice({
        type: "success",
        text: `已读取 ${builtItems.length} 张图片${matchCount > 0 ? `，其中 ${matchCount} 张发现已有文物候选，请先确认选择` : ""}。`,
      })
      setRecentUploadedCount(builtItems.length)
      beginArtifactMatchReview(builtItems, true)
    } catch (error) {
      setSubmitNotice({
        type: "error",
        text: error instanceof Error ? error.message : "载入图片失败",
      })
    } finally {
      setUploading(false)
      setUploadActivity(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  async function removeItem(itemId: string) {
    const target = items.find((item) => item.id === itemId)
    if (!target) {
      return
    }
    try {
      await writeReuploadHints([target])
    } catch {
      // Removing a queue item should still work if browser storage is unavailable.
    }
    revokePreviewUrl(target.previewUrl)
    const remaining = items.filter((item) => item.id !== itemId)
    setItems(remaining)
    setSelectedId((current) => (current === itemId ? remaining[0]?.id ?? null : current))
  }

  async function clearAll() {
    const currentItems = [...items]
    try {
      await writeReuploadHints(currentItems)
    } catch {
      // Clearing the queue should still work if browser storage is unavailable.
    }
    currentItems.forEach((item) => revokePreviewUrl(item.previewUrl))
    setItems([])
    setSelectedId(null)
    setDirectoryHandle(null)
    setTagInput("")
    setSharedForm(buildBaseForm())
    setSubmitNotice(null)
  }

  async function handleGenerateDescription(target: "selected" | "shared" = "selected") {
    if (!selectedItem) {
      return
    }
    const isSharedTarget = target === "shared"
    const fallbackName = selectedItem.parsedName?.artifact_name || fileBaseName(selectedItem.fileName)
    const targetForm = isSharedTarget ? sharedForm : selectedItem.form
    const generationTargetIds = isSharedTarget ? items.map((item) => item.id) : [selectedItem.id]
    const resolvedForm = targetForm.name.trim() ? targetForm : { ...targetForm, name: fallbackName }
    if (!resolvedForm.name.trim()) return
    if (!targetForm.name.trim()) {
      if (isSharedTarget) setSharedForm((current) => ({ ...current, name: resolvedForm.name }))
      else updateSelectedForm({ name: resolvedForm.name })
    }

    setGenerating(true)
    setDescriptionGeneratingItemIds((current) => Array.from(new Set([...current, ...generationTargetIds])))
    setDescriptionProgress(["正在整理名称、年代、博物馆与出土地点…"])
    setLiveResearchSummary("")
    setLiveProviders({})
    setSubmitNotice(null)
    try {
      const descriptionForm = new FormData()
      descriptionForm.append("museum_name", resolvedForm.museumName.trim())
      descriptionForm.append("name", resolvedForm.name.trim())
      descriptionForm.append("era", resolvedForm.era.trim())
      descriptionForm.append("Place_of_Excavation", resolvedForm.placeOfExcavation.trim())
      const response = await fetch(`${apiBaseUrl}/api/artifacts/generate-description-stream-file`, {
        method: "POST",
        body: descriptionForm,
      })
      if (!response.ok || !response.body) throw new Error(`生成描述失败（HTTP ${response.status}）`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ""
      let generated: GeneratedDescription | null = null
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const event = JSON.parse(line.slice(5).trim()) as {
            type: string
            message?: string
            result?: GeneratedDescription
            provider?: string
            model?: string
            reasoning?: string
            summary?: string
            description_length?: number
            tag_count?: number
          }
          if (event.type === "progress" && event.message) {
            const message = event.message
            setDescriptionProgress((current) => current.includes(message) ? current : [...current, message])
          }
          if (event.type === "research_start" && event.message) {
            setDescriptionProgress((current) => current.includes(event.message!) ? current : [...current, event.message!])
          }
          if (event.type === "research_complete") {
            if (event.message) {
              setDescriptionProgress((current) => current.includes(event.message!) ? current : [...current, event.message!])
            }
            setLiveResearchSummary(event.summary || "")
          }
          if (event.type === "provider_start" && event.provider) {
            setLiveProviders((current) => ({
              ...current,
              [event.provider!]: {
                model: event.model || "",
                status: "running",
                reasoning: "",
                message: "正在阅读检索证据并组织描述…",
                descriptionLength: 0,
                tagCount: 0,
              },
            }))
          }
          if (event.type === "provider_complete" && event.provider) {
            setLiveProviders((current) => ({
              ...current,
              [event.provider!]: {
                model: event.model || current[event.provider!]?.model || "",
                status: "complete",
                reasoning: event.reasoning || "",
                message: "核验摘要与候选描述已返回",
                descriptionLength: event.description_length || 0,
                tagCount: event.tag_count || 0,
              },
            }))
          }
          if (event.type === "provider_error" && event.provider) {
            setLiveProviders((current) => ({
              ...current,
              [event.provider!]: {
                model: event.model || current[event.provider!]?.model || "",
                status: "error",
                reasoning: "",
                message: event.message || "模型调用失败",
                descriptionLength: 0,
                tagCount: 0,
              },
            }))
          }
          if (event.type === "result" && event.result) generated = event.result
        }
      }
      if (!generated) throw new Error("模型未返回可用结果")

      const nextCandidates = ensureCandidates(generated.candidates)
      const preferredDescription = nextCandidates.find(
        (candidate) => candidate.provider === generated.provider
          && candidate.model === generated.model
          && candidate.status === "success",
      )?.description ?? normalizeVerifiedClaims(generated.description, []).description
      const nextSharedForm: FormState = {
        ...cloneFormState(resolvedForm),
        description: preferredDescription,
        tags: [...resolvedForm.tags],
      }
      const nextUnavailableProviders = ensureStringList(generated.unavailable_providers)
      const nextMeta = isSharedTarget
        ? `共享描述采用：${generated.provider} / ${generated.model}${generated.research_id ? ` · 研究 ${generated.research_id.slice(0, 8)}` : ""}`
        : `默认采用：${generated.provider} / ${generated.model}${generated.research_id ? ` · 研究 ${generated.research_id.slice(0, 8)}` : ""}`

      if (isSharedTarget) {
        setSharedForm(nextSharedForm)
        setItems((current) => current.map((item) => ({
          ...item,
          form: applySharedForm(item.form, nextSharedForm),
          candidates: nextCandidates,
          unavailableProviders: nextUnavailableProviders,
          descriptionMeta: nextMeta,
          verificationDecisions: {},
          submitState: item.submitState === "submitted" ? "idle" : item.submitState,
          submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
        })))
        setSubmitNotice({
          type: "success",
          text: `已根据共享字段并行请求千问和豆包，并把完整描述应用到 ${items.length} 张图片`,
        })
      } else {
        updateItem(selectedItem.id, (item) => ({
          ...item,
          form: {
            ...item.form,
            description: preferredDescription,
            tags: [...item.form.tags],
          },
          candidates: nextCandidates,
          unavailableProviders: nextUnavailableProviders,
          descriptionMeta: nextMeta,
          verificationDecisions: {},
        }))
        setSubmitNotice({ type: "success", text: "已根据名称、年代、博物馆与出土地点生成完整描述" })
      }
    } catch (error) {
      setSubmitNotice({
        type: "error",
        text: error instanceof Error ? error.message : "生成描述失败",
      })
    } finally {
      setGenerating(false)
      const completedIds = new Set(generationTargetIds)
      setDescriptionGeneratingItemIds((current) => current.filter((id) => !completedIds.has(id)))
    }
  }

  function applyCandidate(candidate: DescriptionCandidate) {
    if (!selectedItem || candidate.status !== "success") {
      return
    }
    updateItem(selectedItem.id, (item) => ({
      ...item,
      form: {
        ...item.form,
        description: candidate.description,
        tags: [...item.form.tags],
      },
      descriptionMeta: `当前采用：${candidate.provider} / ${candidate.model}`,
    }))
    setSubmitNotice({ type: "success", text: `已采用 ${candidate.provider} 的描述；标签仍可跨模型单独点选` })
  }

  function toggleCandidateTag(tag: string) {
    if (!selectedItem) return
    const selected = selectedItem.form.tags.includes(tag)
    updateItem(selectedItem.id, (item) => ({
      ...item,
      form: {
        ...item.form,
        tags: selected
          ? item.form.tags.filter((entry) => entry !== tag)
          : uniqueTags([...item.form.tags, tag]),
      },
    }))
  }

  function reviewVerifiedClaim(claim: VerifiedClaim, decision: "accepted" | "rejected") {
    if (!selectedItem) return
    updateItem(selectedItem.id, (item) => {
      const withoutClaim = item.form.description
        .replace(claim.text, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
      const description = decision === "accepted"
        ? [withoutClaim, claim.text].filter(Boolean).join(withoutClaim ? "\n\n" : "")
        : withoutClaim
      return {
        ...item,
        form: { ...item.form, description },
        verificationDecisions: {
          ...(item.verificationDecisions ?? {}),
          [claim.text]: decision,
        },
      }
    })
    setSubmitNotice({
      type: "success",
      text: decision === "accepted"
        ? "已将这条联网核验内容加入最终正文"
        : "已从最终正文移除这条联网核验内容",
    })
  }

  async function submitOne(itemId: string): Promise<boolean> {
    const target = items.find((item) => item.id === itemId)
    if (!target) {
      return false
    }
    if (target.submitState === "submitted" && changedParts(target).length === 0) {
      setSubmitNotice({ type: "success", text: "该图片已入库且没有新的修改，无需重复提交。" })
      return true
    }
    if (!target.form.name.trim() || !target.form.museumName.trim()) {
      updateItem(itemId, (item) => ({
        ...item,
        submitState: "error",
        submitMessage: "请先确认名称和馆藏信息",
      }))
      return false
    }
    if (!target.fileHandle) {
      updateItem(itemId, (item) => ({
        ...item,
        submitState: "error",
        submitMessage: "提交前请先点击图片列表上方的文件夹按钮并授权原文件；保存并入库会同时修改本地文件名和 EXIF。",
      }))
      return false
    }
    if (target.fileName !== target.originalFileName && !directoryHandle) {
      updateItem(itemId, (item) => ({
        ...item,
        submitState: "error",
        submitMessage: "目标文件名已修改，请先点击图片列表上方的文件夹按钮授权原文件，才能在本地完成重命名。",
      }))
      return false
    }

    updateItem(itemId, (item) => ({ ...item, submitState: "submitting", submitMessage: null, uploadProgress: 8, uploadStage: "正在准备 EXIF 信息" }))
    try {
      // A retry click is a fresh user gesture, so request write permission
      // before any network request can consume that activation.
      if (directoryHandle && !await verifyWritablePermission(directoryHandle)) {
        throw new Error("文件夹写入权限未授权，请重新选择照片文件夹")
      }
      if (!await verifyWritablePermission(target.fileHandle)) {
        throw new Error(`“${target.originalFileName}”的写入权限未授权，请点击图片列表上方的文件夹按钮重新授权`)
      }

      const latestLocalFile = await target.fileHandle.getFile()
      const latitude = toNullableNumber(target.form.latitude)
      const longitude = toNullableNumber(target.form.longitude)
      const appendMetadata = (data: FormData, includeArtifactLink = false) => {
        data.append("museum_name", target.form.museumName.trim())
        data.append("name", target.form.name.trim())
        data.append("era", target.form.era.trim() || "")
        data.append("Place_of_Excavation", target.form.placeOfExcavation.trim() || "")
        data.append("description", target.form.description.trim() || "")
        data.append("display_location_name", target.form.displayLocationName.trim() || "")
        data.append("exhibition_name", target.form.exhibitionName.trim() || "常设")
        if (target.form.catalogExhibitionSourceId) {
          data.append("catalog_exhibition_source_id", target.form.catalogExhibitionSourceId)
        }
        if (target.form.catalogExhibitionId !== null) {
          data.append("catalog_exhibition_id", String(target.form.catalogExhibitionId))
        }
        if (latitude !== null) data.append("latitude", String(latitude))
        if (longitude !== null) data.append("longitude", String(longitude))
        data.append("camera_model", target.form.cameraModel.trim())
        data.append("lens_model", target.form.lensModel.trim())
        if (target.form.capturedAt.trim()) data.append("captured_at", target.form.capturedAt.trim())
        data.append("shutter_speed", target.form.shutterSpeed.trim())
        data.append("aperture", target.form.aperture.trim())
        if (target.form.iso.trim()) data.append("iso", target.form.iso.trim())
        if (includeArtifactLink && target.existingArtifactId != null) {
          data.append("existing_artifact_id", String(target.existingArtifactId))
        }
      }

      let response: Response | null = null
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const useCleanExif = attempt === 3
        updateItem(itemId, (item) => ({
          ...item,
          uploadProgress: 13 + attempt * 3,
          uploadStage: useCleanExif
            ? "正在使用兼容模式重建 EXIF（第 3/3 次）"
            : `正在生成最终 EXIF 图片（第 ${attempt}/3 次）`,
        }))
        const exifForm = new FormData()
        exifForm.append("file", latestLocalFile)
        appendMetadata(exifForm)
        if (useCleanExif) exifForm.append("clean_exif", "true")
        response = await fetch(`${apiBaseUrl}/api/artifacts/prepare-exif-file`, {
          method: "POST",
          body: exifForm,
        })
        if (response.ok) break

        const message = await responseErrorMessage(response, "本地 EXIF 回写准备失败")
        if (attempt === 3) throw new Error(`已重试 3 次，${message}`)
        await waitForRetry(350 * attempt)
      }
      if (!response?.ok) throw new Error("本地 EXIF 回写准备失败")
      const sourceHash = response.headers.get("X-Source-Hash")
      const cleanRewriteUsed = response.headers.get("X-Exif-Rewrite-Mode") === "clean"
      const editedBlob = await response.blob()

      let resolvedWriteHandle = target.fileHandle
      if (directoryHandle && target.fileName !== target.originalFileName) {
        try {
          // A previous attempt may have completed the local rename and only
          // failed during cloud submission. Reuse and overwrite that target
          // instead of treating it as a duplicate.
          resolvedWriteHandle = await directoryHandle.getFileHandle(target.fileName)
        } catch (error) {
          if ((error as Error).name !== "NotFoundError") throw error
          if (!await verifyWritablePermission(resolvedWriteHandle)) {
            throw new Error(`“${target.originalFileName}”的写入权限已失效，请点击图片列表上方的文件夹按钮重新授权`)
          }
          resolvedWriteHandle = await directoryHandle.getFileHandle(target.fileName, { create: true })
        }
      } else if (!await verifyWritablePermission(resolvedWriteHandle)) {
        throw new Error(`“${target.originalFileName}”的写入权限已失效，请点击图片列表上方的文件夹按钮重新授权`)
      }

      updateItem(itemId, (item) => ({ ...item, uploadProgress: 30, uploadStage: "正在改名并写回本地原图" }))
      const writable = await resolvedWriteHandle.createWritable()
      await writable.write(editedBlob)
      await writable.close()
      if (directoryHandle && target.fileName !== target.originalFileName) {
        try {
          await directoryHandle.removeEntry(target.originalFileName)
        } catch (error) {
          // Retrying after a successful local rename is normal: the old source
          // name has already disappeared, while the target file is durable.
          if ((error as Error).name !== "NotFoundError") throw error
        }
      }

      const writtenFile = await resolvedWriteHandle.getFile()
      if (writtenFile.name !== target.fileName || writtenFile.size !== editedBlob.size) {
        throw new Error("本地图片写入校验失败，已停止云端提交")
      }
      const verifyForm = new FormData()
      verifyForm.append("file", writtenFile)
      const writtenMetadata = await fetchJson<ImageExifMetadata>(`${apiBaseUrl}/api/artifacts/extract-exif-file`, {
        method: "POST",
        body: verifyForm,
      })
      assertWrittenExif(writtenMetadata, target.form)
      const uploadFile = new File([writtenFile], target.fileName, {
        type: editedBlob.type || target.localFile.type,
        lastModified: writtenFile.lastModified,
      })

      // The local save is already durable at this point. Keep the refreshed
      // handle and filename even if the subsequent cloud request fails, so a
      // retry does not look for the deleted pre-rename file.
      updateItem(itemId, (item) => ({
        ...item,
        localFile: uploadFile,
        fileHandle: resolvedWriteHandle,
        originalFileName: item.fileName,
        originalForm: cloneFormState(item.form),
      }))

      updateItem(itemId, (item) => ({ ...item, uploadProgress: 45, uploadStage: "正在上传 OSS 并写入档案" }))

      const formData = new FormData()
      formData.append("file", uploadFile)
      appendMetadata(formData, true)
      formData.append("tags", JSON.stringify(target.form.tags))
      formData.append("exif_prepared", "true")
      if (sourceHash) formData.append("source_hash", sourceHash)
      let result: ArtifactSubmitResult | null = null
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          updateItem(itemId, (item) => ({
            ...item,
            uploadStage: `正在上传 OSS 并写入档案（第 ${attempt}/3 次）`,
          }))
          result = await postFormDataWithProgress<ArtifactSubmitResult>(
            `${apiBaseUrl}/api/artifacts/exif-submit-file`,
            formData,
            (progress) => {
              updateItem(itemId, (item) => ({
                ...item,
                uploadProgress: progress,
                uploadStage: `正在上传 OSS 并写入档案（第 ${attempt}/3 次）`,
              }))
            },
          )
          break
        } catch (error) {
          if (attempt === 3) {
            const message = error instanceof Error ? error.message : "未知错误"
            throw new Error(`云端提交已重试 3 次：${message}`, { cause: error })
          }
          await waitForRetry(700 * attempt)
        }
      }
      if (!result) throw new Error("云端提交失败")
      updateItem(itemId, (item) => ({
        ...item,
        localFile: uploadFile,
        fileHandle: resolvedWriteHandle,
        originalFileName: item.fileName,
        originalForm: cloneFormState(item.form),
        submitState: "submitted",
        submitMessage: result.duplicate_image_replaced
          ? (result.duplicate_image_detail || "已用本次校正覆盖云端已有图片。")
          : result.duplicate_image_skipped
          ? (result.duplicate_image_detail || "云端已存在相同原图，本次未重复上传。")
          : cleanRewriteUsed
            ? "已通过兼容模式重建 EXIF，并同步上传 OSS 与云端数据库"
            : "已修改本地文件名与 EXIF，并同步上传 OSS 与云端数据库",
        uploadProgress: 100,
        uploadStage: "已完成",
      }))
      return true
    } catch (error) {
      updateItem(itemId, (item) => ({
        ...item,
        submitState: "error",
        submitMessage: error instanceof Error ? error.message : "提交失败",
        uploadStage: "提交失败",
      }))
      return false
    }
  }

  async function handleSubmitAll() {
    if (items.length === 0) {
      return
    }
    setSubmittingAll(true)
    setSubmitNotice(null)
    const pendingItems = items.filter((item) => item.submitState !== "submitted" || changedParts(item).length > 0)
    const unboundItems = pendingItems.filter((item) => (
      !item.fileHandle || (item.fileName !== item.originalFileName && !directoryHandle)
    ))
    if (unboundItems.length > 0) {
      setSubmittingAll(false)
      setSubmitNotice({
        type: "error",
        text: `还有 ${unboundItems.length} 张图片未绑定可写原文件；请先点击图片列表上方的文件夹按钮完成授权，再执行全部入库。`,
      })
      return
    }
    let succeeded = 0
    let failed = 0
    const queue = [...pendingItems]
    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) return
        if (await submitOne(item.id)) {
          succeeded += 1
        } else {
          failed += 1
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, pendingItems.length) }, () => worker()))
    setSubmittingAll(false)
    setSubmitNotice(failed > 0
      ? { type: "error", text: `批量提交完成：${succeeded} 张成功，${failed} 张失败。可在队列中点击“重试”后再次提交。` }
      : { type: "success", text: `已完成批量提交：${succeeded} 张图片已入库。` })
  }

  function addTags(rawValue: string) {
    if (!selectedItem) {
      return
    }
    const nextTags = rawValue
      .split(/[,\n，、；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (nextTags.length === 0) {
      return
    }
    updateItem(selectedItem.id, (item) => ({
      ...item,
      form: { ...item.form, tags: uniqueTags([...item.form.tags, ...nextTags]) },
    }))
    setTagInput("")
  }

  return (
    <section className="exif-console">
      <section className="panel workbench-head exif-workbench-head">
        <div>
          <h2>文物图片入库工作台</h2>
          <p className="muted">解析文件名、校对展出地点、补全描述，一次完成本地 EXIF、OSS 和云数据库。</p>
        </div>
        <div className="upload-actions exif-toolbar">
          {directoryHandle ? <Tag color="success">已授权：{directoryHandle.name}</Tag> : null}
          <Button
            htmlType="button"
            type="primary"
            icon={uploadActivity === "files"
              ? <Loader2 size={14} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
              : <ImagePlus size={14} strokeWidth={1.8} aria-hidden="true" />}
            onClick={handleSelectImages}
            disabled={uploading}
          >
            {uploadActivity === "files" ? "正在读取…" : "添加图片"}
          </Button>
          <Button
            htmlType="button"
            icon={uploadActivity === "directory"
              ? <Loader2 size={14} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
              : <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" />}
            onClick={() => void handleSelectDirectory()}
            disabled={uploading || bindingDirectory}
          >
            {uploadActivity === "directory" ? "正在载入文件夹…" : "载入文件夹"}
          </Button>
        </div>
        <input
          aria-label="选择图片"
          id={EXIF_FILE_INPUT_ID}
          ref={fileInputRef}
          type="file"
          accept="image/*,.tif,.tiff"
          multiple
          className="exif-file-input"
          onChange={(event) => void handleUpload(Array.from(event.target.files ?? []))}
        />
      </section>

      <div className="layout exif-layout exif-layout-wide">
        <section className="column column-left exif-sidebar">
          <div className="panel exif-queue-panel">
            <div className="section-heading compact">
              <div className="exif-sidebar-head">
                <h2>图片列表</h2>
                <p className="muted">当前批次 {stats.itemCount} 张，优先处理名称和地点信息</p>
              </div>
              <Space className="exif-queue-actions" size={6} role="toolbar" aria-label="图片列表操作">
                <Tooltip title={uploadActivity === "files" ? "正在读取图片" : "添加指定图片"} mouseEnterDelay={0.45}>
                  <Button
                    htmlType="button"
                    size="small"
                    icon={uploadActivity === "files"
                      ? <Loader2 size={15} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                      : <ImagePlus size={15} strokeWidth={1.8} aria-hidden="true" />}
                    onClick={handleSelectImages}
                    disabled={uploading}
                    aria-label={uploadActivity === "files" ? "正在读取图片" : "添加图片"}
                  />
                </Tooltip>
                <Tooltip
                  title={bindingDirectory
                    ? "正在授权并匹配原文件"
                    : uploadActivity === "directory"
                      ? "正在载入文件夹"
                      : needsDirectoryAuthorization
                        ? "继续授权队列照片的原文件"
                        : directoryHandle
                          ? `已授权：${directoryHandle.name}；点击可载入其他文件夹`
                          : "载入文件夹全部照片"}
                  mouseEnterDelay={0.45}
                >
                  <Button
                    htmlType="button"
                    size="small"
                    icon={bindingDirectory || uploadActivity === "directory"
                      ? <Loader2 size={15} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                      : directoryHandle && !needsDirectoryAuthorization
                        ? <Check size={15} strokeWidth={2.1} aria-hidden="true" />
                        : <FolderOpen size={15} strokeWidth={1.8} aria-hidden="true" />}
                    onClick={() => void (needsDirectoryAuthorization ? handleBindDirectory() : handleSelectDirectory())}
                    disabled={uploading || bindingDirectory}
                    aria-label={bindingDirectory
                      ? "正在授权原文件夹"
                      : needsDirectoryAuthorization
                        ? "授权队列照片的原文件"
                        : directoryHandle
                          ? "原文件夹已授权"
                          : "载入文件夹"}
                  />
                </Tooltip>
                <Tooltip title="清空图片列表" mouseEnterDelay={0.45}>
                  <Button
                    htmlType="button"
                    danger
                    size="small"
                    icon={<Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />}
                    onClick={() => void clearAll()}
                    disabled={items.length === 0}
                    aria-label="清空图片列表"
                  />
                </Tooltip>
                <Tooltip title={submittingAll ? "正在全部入库" : allItemsSubmitted ? "当前批次已全部入库" : "全部入库"} mouseEnterDelay={0.45}>
                  <Button
                    htmlType="button"
                    type="primary"
                    size="small"
                    icon={submittingAll
                      ? <Loader2 size={15} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                      : allItemsSubmitted
                        ? <Check size={15} strokeWidth={2.1} aria-hidden="true" />
                        : <CloudUpload size={15} strokeWidth={1.8} aria-hidden="true" />}
                    onClick={() => void handleSubmitAll()}
                    disabled={submittingAll || items.length === 0 || allItemsSubmitted}
                    aria-label={submittingAll ? "正在全部入库" : allItemsSubmitted ? "当前批次已全部入库" : "全部入库"}
                  />
                </Tooltip>
              </Space>
            </div>
            <div className="exif-sidebar-stats" aria-label="当前批次统计">
              <div className="exif-sidebar-stat">
                <span>总计</span>
                <strong>{stats.itemCount}</strong>
              </div>
              <div className="exif-sidebar-stat success">
                <span>已入库</span>
                <strong>{stats.submittedCount}</strong>
              </div>
              <div className="exif-sidebar-stat">
                <span>已补描述</span>
                <strong>{stats.describedCount}</strong>
              </div>
              <div className="exif-sidebar-stat">
                <span>已带坐标</span>
                <strong>{stats.gpsCount}</strong>
              </div>
            </div>
            <div className="exif-sidebar-scroll">
              <div className="exif-sidebar-tools">
              <details className="batch-rename-panel">
                <summary>
                  <span className="exif-tool-summary-copy">
                    <strong>批量修改目标文件名</strong>
                    <small>清理命名并统一前后缀</small>
                  </span>
                  <span className="exif-tool-summary-meta">
                    <span className="exif-tool-summary-count">影响 {batchRenameCount}/{items.length}</span>
                    <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                </summary>
                <div className="exif-tool-grid">
                  <label className="exif-tool-field">
                    <span>删除文本</span>
                    <Input value={batchRemove} placeholder="例如：IMG_" onChange={(event) => setBatchRemove(event.target.value)} />
                  </label>
                  <label className="exif-tool-field">
                    <span>添加前缀</span>
                    <Input value={batchPrefix} placeholder="例如：南博-" onChange={(event) => setBatchPrefix(event.target.value)} />
                  </label>
                  <label className="exif-tool-field">
                    <span>添加后缀</span>
                    <Input value={batchSuffix} placeholder="例如：-展厅A" onChange={(event) => setBatchSuffix(event.target.value)} />
                  </label>
                </div>
                <div className="exif-tool-actions">
                  <Button htmlType="button" onClick={applyBatchRename} disabled={items.length === 0}>应用文件名规则</Button>
                </div>
                <p className="muted">名称变动后会自动重解析时代、馆藏与出土信息，适合先统一处理文件名。</p>
              </details>
              <details className="metadata-sync-panel">
                <summary>
                  <span className="exif-tool-summary-copy">
                    <strong>从照片同步信息</strong>
                    <small>逐项选择要复用的地点、时间、参数与内容</small>
                  </span>
                  <span className="exif-tool-summary-meta">
                    <span className="exif-tool-summary-count">{items.length > 1 ? `${items.length - 1} 张可同步` : "至少需要 2 张"}</span>
                    <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                </summary>
                <div className="metadata-sync-controls">
                  <label className="exif-tool-field metadata-sync-source">
                    <span>来源照片</span>
                    <Select
                      value={metadataSyncSourceId || undefined}
                      placeholder="选择包含完整信息的照片"
                      options={items.map((item, index) => ({
                        value: item.id,
                        label: indexedFileName(item.fileName, index),
                        title: item.fileName,
                      }))}
                      onChange={setMetadataSyncSourceId}
                      disabled={items.length === 0}
                      popupMatchSelectWidth={360}
                      showSearch
                      optionFilterProp="label"
                    />
                  </label>
                  <Button
                    htmlType="button"
                    type="default"
                    onClick={() => selectedItem && setMetadataSyncSourceId(selectedItem.id)}
                    disabled={!selectedItem || selectedItem.id === metadataSyncSourceId}
                  >
                    当前图片设为来源
                  </Button>
                </div>
                <div className="metadata-sync-target-row">
                  <span>同步到</span>
                  <Segmented<MetadataSyncTargetMode>
                    size="small"
                    value={metadataSyncTargetMode}
                    options={[
                      { label: "当前图片", value: "current" },
                      { label: "指定照片", value: "selected" },
                      { label: "全部其他图片", value: "others" },
                    ]}
                    onChange={setMetadataSyncTargetMode}
                  />
                </div>
                <div className="metadata-sync-presets" aria-label="同步范围快捷选择">
                  <span>快捷选择</span>
                  <Space.Compact size="small">
                    <Button htmlType="button" onClick={() => selectMetadataSyncPreset("default")}>默认</Button>
                    <Button htmlType="button" onClick={() => selectMetadataSyncPreset("location")}>地点</Button>
                    <Button htmlType="button" onClick={() => selectMetadataSyncPreset("content")}>内容</Button>
                    <Button htmlType="button" onClick={() => selectMetadataSyncPreset("all")}>全部</Button>
                    <Button htmlType="button" onClick={() => selectMetadataSyncPreset("none")}>清空</Button>
                  </Space.Compact>
                </div>
                <MetadataSyncFieldControls
                  context="sidebar"
                  selection={metadataSyncSelection}
                  onChange={(field, checked) => setMetadataSyncSelection((current) => ({
                    ...current,
                    [field]: checked,
                  }))}
                />
                <div className="metadata-sync-status">
                  <span title={metadataSyncSource?.fileName}>
                    {metadataSyncSource
                      ? `来源：${indexedFileName(metadataSyncSource.fileName, items.findIndex((item) => item.id === metadataSyncSource.id))}`
                      : "尚未选择来源"}
                  </span>
                  <strong>{metadataSyncSelectedCount}/{METADATA_SYNC_FIELD_COUNT} 字段 · {metadataSyncChangedCount} 项差异</strong>
                </div>
                <div className="exif-tool-actions">
                  <Button
                    htmlType="button"
                    type="primary"
                    block
                    onClick={openMetadataSyncPreview}
                    disabled={items.length < 2 || !metadataSyncSource}
                  >
                    {metadataSyncTargetMode === "selected" ? "选择目标并预览" : "预览并同步"}
                  </Button>
                </div>
              </details>
              <details className="batch-location-panel">
                <summary>
                  <span className="exif-tool-summary-copy">
                    <strong>手动统一展出地点</strong>
                    <small>地图选点后统一展览与 GPS</small>
                  </span>
                  <span className="exif-tool-summary-meta">
                    <span className="exif-tool-summary-count">{selectedItem ? "可套用当前图片" : "等待选择"}</span>
                    <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                </summary>
                <div className="batch-location-actions">
                  <Button htmlType="button" onClick={useSelectedLocationForBatch} disabled={!selectedItem}>
                    采用当前图片地点
                  </Button>
                </div>
                <div className="batch-location-fields exif-tool-grid">
                  <label className="exif-tool-field">
                    <span>展出地点</span>
                    <Input value={batchLocationName} placeholder="例如：历代青铜馆" onChange={(event) => setBatchLocationName(event.target.value)} />
                  </label>
                  <label className="exif-tool-field">
                    <span>对应展览</span>
                    <Input
                      value={batchExhibitionName}
                      placeholder="例如：常设展"
                      onChange={(event) => {
                        setBatchExhibitionName(event.target.value)
                        setBatchCatalogExhibitionId(null)
                        setBatchCatalogExhibitionSourceId("")
                      }}
                    />
                  </label>
                  <label className="exif-tool-field">
                    <span>纬度</span>
                    <Input value={batchLatitude} placeholder="39.9087" onChange={(event) => setBatchLatitude(event.target.value)} />
                  </label>
                  <label className="exif-tool-field">
                    <span>经度</span>
                    <Input value={batchLongitude} placeholder="116.3975" onChange={(event) => setBatchLongitude(event.target.value)} />
                  </label>
                </div>
                <div className="exif-sidebar-map">
                  <GpsMapPicker
                    latitude={batchLatitude}
                    longitude={batchLongitude}
                    onPick={(latitude, longitude, locationName) => {
                      setBatchLatitude(latitude)
                      setBatchLongitude(longitude)
                      if (locationName) setBatchLocationName(locationName)
                    }}
                  />
                </div>
                <div className="exif-tool-actions">
                  <Button htmlType="button" type="primary" block onClick={applyBatchLocation} disabled={items.length === 0}>应用到全部图片</Button>
                </div>
              </details>
              </div>
              <div className="exif-queue-list">
              {items.length > 0 ? items.map((item) => (
                <div key={item.id} className="exif-queue-item-shell">
                  <button
                    type="button"
                    data-ui="interactive-surface"
                    className={`exif-queue-item ${selectedId === item.id ? "is-selected" : ""}`}
                    aria-pressed={selectedId === item.id}
                    onClick={() => {
                      setSelectedId(item.id)
                      setTagInput("")
                    }}
                  >
                    <img
                      src={item.previewUrl}
                      alt={item.fileName}
                      className="exif-queue-thumb"
                      loading="lazy"
                      decoding="async"
                    />
                    <div className="exif-queue-copy">
                      <strong title={item.fileName}>{item.fileName}</strong>
                      <span>
                        {item.form.name || item.parsedName?.artifact_name || "待确认名称"}
                        {item.existingArtifactMatch ? " · 已匹配已有文物" : ""}
                      </span>
                      <span className="queue-state-tags">
                        {descriptionGeneratingItemIds.includes(item.id) ? (
                          <Tag
                            color="processing"
                            icon={<Loader2 size={11} strokeWidth={2.2} className="animate-spin" aria-hidden="true" />}
                          >
                            描述中
                          </Tag>
                        ) : ensureCandidates(item.candidates).some((candidate) => candidate.status === "success") ? (
                          <Tag
                            color="success"
                            icon={<Check size={11} strokeWidth={2.2} aria-hidden="true" />}
                          >
                            描述完成
                          </Tag>
                        ) : null}
                        <Tag
                          color={
                            item.submitState === "submitted"
                              ? "success"
                              : item.submitState === "error"
                                ? "error"
                                : item.submitState === "submitting"
                                  ? "processing"
                                  : changedParts(item).length > 0
                                    ? "warning"
                                    : undefined
                          }
                          className="queue-submit-state"
                          icon={item.submitState === "submitted"
                            ? <Check size={11} strokeWidth={2.2} aria-hidden="true" />
                            : item.submitState === "submitting"
                              ? <Loader2 size={11} strokeWidth={2.2} className="animate-spin" aria-hidden="true" />
                              : item.submitState === "error"
                                ? <X size={11} strokeWidth={2.2} aria-hidden="true" />
                                : changedParts(item).length > 0
                                  ? <FileCheck2 size={11} strokeWidth={2} aria-hidden="true" />
                                  : undefined}
                        >
                          {item.submitState === "submitted"
                            ? "已提交"
                            : item.submitState === "submitting"
                              ? "提交中"
                              : item.submitState === "error"
                                ? "提交失败"
                                : changedParts(item).length > 0
                                  ? `待提交 · ${changedParts(item).length} 项`
                                  : "待处理"}
                        </Tag>
                      </span>
                      {changedParts(item).length > 0 ? (
                        <span className="queue-change-summary" aria-label={`待提交的变更：${changedParts(item).join("、")}`}>
                          已修改：{changedParts(item).join("、")}
                        </span>
                      ) : null}
                      {item.submitState === "submitting" ? (
                        <span className="queue-upload" aria-label={`${item.uploadStage ?? "提交中"} ${item.uploadProgress}%`}>
                          <i style={{ width: `${item.uploadProgress}%` }} />
                          <small>{item.uploadStage ?? "提交中"} · {item.uploadProgress}%</small>
                        </span>
                      ) : null}
                    </div>
                  </button>
                  <Space className="exif-queue-item-actions" size={6}>
                    {item.submitState === "error" ? (
                      <Button
                        htmlType="button"
                        danger
                        size="small"
                        icon={<RefreshCw size={13} strokeWidth={2} aria-hidden="true" />}
                        onClick={() => void submitOne(item.id)}
                      >
                        授权并重试
                      </Button>
                    ) : null}
                    <Button
                      htmlType="button"
                      size="small"
                      danger
                      icon={<Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />}
                      aria-label={`移除 ${item.fileName}`}
                      onClick={() => void removeItem(item.id)}
                    />
                  </Space>
                </div>
              )) : <p className="muted">还没有图片，先上传一批图片开始处理。</p>}
              </div>
            </div>
          </div>
        </section>

        <section className="column column-right exif-main">
          {selectedItem ? (
            <form
              className="panel form-wide exif-editor-form"
              onSubmit={(event) => {
                event.preventDefault()
              }}
            >
              <div className="section-heading exif-editor-heading">
                <div>
                  <h2>{selectedItem.form.name || "校对文物信息"}</h2>
                  <p className="muted">自动解析结果已填入表单，只需修正有误字段</p>
                </div>
              </div>

              <div className="exif-editor-scroll">
                <details className="exif-shared-section">
                  <summary>
                    <div>
                      <strong>批量套用同一件文物的信息</strong>
                      <p>多张图片属于同一件文物时，再展开统一填写。</p>
                    </div>
                    <span>可选</span>
                  </summary>
                  <div className="form-section-body">
                    <p className="muted">这些图片指向同一件文物时，在这里统一填写基础字段和描述，再一键应用到全部图片。</p>
                    <div className="field-row">
                      <label className="field">
                        <span>馆藏单位</span>
                        <Input
                          value={sharedForm.museumName}
                          placeholder="例如：山东省博物馆"
                          onChange={(event) => updateSharedForm({ museumName: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>文物名称</span>
                        <Input
                          value={sharedForm.name}
                          placeholder="例如：夫妇宴享行乐图"
                          onChange={(event) => updateSharedForm({ name: event.target.value })}
                        />
                      </label>
                    </div>
                    <div className="field-row">
                      <label className="field">
                        <span>时代</span>
                        <Input
                          value={sharedForm.era}
                          placeholder="例如：隋代"
                          onChange={(event) => updateSharedForm({ era: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>出土地</span>
                        <Input
                          value={sharedForm.placeOfExcavation}
                          placeholder="例如：1976年嘉祥英山一号隋墓出土"
                          onChange={(event) => updateSharedForm({ placeOfExcavation: event.target.value })}
                        />
                      </label>
                    </div>
                    <div className="field-row">
                      <label className="field">
                        <span>展出地点名称</span>
                        <Input
                          value={sharedForm.displayLocationName}
                          placeholder="例如：山东省博物馆"
                          onChange={(event) => updateSharedForm({ displayLocationName: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>对应展览</span>
                        <Input
                          value={sharedForm.exhibitionName}
                          placeholder="例如：常设展 / 汉唐文明展"
                          onChange={(event) => updateSharedForm({
                            exhibitionName: event.target.value,
                            catalogExhibitionId: null,
                            catalogExhibitionSourceId: "",
                          })}
                        />
                      </label>
                      <label className="field">
                        <span>纬度 / 经度</span>
                        <div className="field-row">
                          <Input
                            value={sharedForm.latitude}
                            placeholder="纬度"
                            onChange={(event) => updateSharedForm({ latitude: event.target.value })}
                          />
                          <Input
                            value={sharedForm.longitude}
                            placeholder="经度"
                            onChange={(event) => updateSharedForm({ longitude: event.target.value })}
                          />
                        </div>
                      </label>
                    </div>
                    <label className="field">
                      <span>共享描述</span>
                      <Textarea
                        rows={4}
                        value={sharedForm.description}
                        placeholder="这里的描述会作为同一文物的默认描述应用到全部图片"
                        onChange={(event) => updateSharedForm({ description: event.target.value })}
                      />
                    </label>
                    <div className="upload-actions exif-shared-actions">
                      <Button htmlType="button" type="default" onClick={fillSharedFromSelected}>
                        从当前图片带入
                      </Button>
                      <Button htmlType="button" type="default" onClick={applySharedToAll} disabled={items.length === 0}>
                        应用到全部图片
                      </Button>
                      <Button htmlType="button" type="primary" onClick={() => void handleGenerateDescription("shared")} disabled={generating}>
                        并行生成共享描述
                      </Button>
                    </div>
                    <p className="field-help">当前会同步到 {items.length || 0} 张图片，建议先统一名称和地点，再批量生成共享描述。</p>
                  </div>
                </details>

                <Card className="exif-preview-card">
                  <div className="exif-selected-head">
                    <img
                      src={selectedItem.previewUrl}
                      alt={selectedItem.fileName}
                      className="exif-selected-preview"
                      decoding="async"
                    />
                    <div className="exif-file-block">
                      <div className="result-head">
                        <h3>文件名</h3>
                      </div>
                      <p className="result-desc exif-file-name">{selectedItem.fileName}</p>
                      <label className="exif-file-rename">
                        <span>目标文件名</span>
                        <Input
                          value={fileBaseName(selectedItem.fileName)}
                          onChange={(event) => renameSelected(event.target.value)}
                        />
                        <em>{fileExtension(selectedItem.fileName)}</em>
                      </label>
                      <p className="muted exif-file-parse-status">
                        {parsingFileName ? "正在从文件名更新字段…" : "文件名变化会自动回填时代、名称、出土与馆藏"}
                      </p>
                      {selectedItem.parsedName ? (
                        <div className="result-meta">
                          {selectedItem.parsedName.era ? <Tag>时代：{selectedItem.parsedName.era}</Tag> : null}
                          {selectedItem.parsedName.museum_name ? <Tag>馆藏：{selectedItem.parsedName.museum_name}</Tag> : null}
                          {selectedItem.parsedName.Place_of_Excavation ? <Tag>出土地：{selectedItem.parsedName.Place_of_Excavation}</Tag> : null}
                        </div>
                      ) : <p className="muted">当前文件名暂无解析结果，可手动填写。</p>}
                    </div>
                  </div>
                </Card>

                <div className="form-fields exif-form-card-grid">
                  <Card
                    size="small"
                    className="form-section exif-form-card"
                    title={<FormSectionHeader icon={Landmark} title="基础信息" description="优先确认文物名称、馆藏单位和时代。" />}
                  >
                    <div className="form-section-body">
                      <div className="field-row">
                        <label className="field">
                          <span>馆藏单位 <FieldReviewBadge warning={warningForField("museum_name")} /></span>
                          <AutoComplete
                            value={selectedItem.form.museumName}
                            options={museumSuggestions.map((museum) => ({
                              key: museum.id,
                              value: museum.name,
                              label: museum.name,
                            }))}
                            filterOption={false}
                            open={showMuseumSuggestions && museumSuggestions.length > 0}
                            placeholder="例如：山东省博物馆"
                            onFocus={() => setShowMuseumSuggestions(true)}
                            onOpenChange={setShowMuseumSuggestions}
                            onChange={(value) => {
                              updateSelectedForm({ museumName: value })
                              setShowMuseumSuggestions(true)
                            }}
                            onSelect={(value) => {
                              updateSelectedForm({ museumName: value })
                              setShowMuseumSuggestions(false)
                            }}
                          />
                        </label>

                        <label className="field">
                          <span>文物名称 <FieldReviewBadge warning={warningForField("artifact_name")} /></span>
                          <Input
                            value={selectedItem.form.name}
                            placeholder="例如：夫妇宴享行乐图"
                            onChange={(event) => updateSelectedForm({ name: event.target.value })}
                          />
                        </label>
                      </div>

                      <div className="field-row">
                        <label className="field">
                          <span>时代 <FieldReviewBadge warning={warningForField("era")} /></span>
                          <Input
                            value={selectedItem.form.era}
                            placeholder="例如：隋代"
                            onChange={(event) => updateSelectedForm({ era: event.target.value })}
                          />
                        </label>

                        <label className="field">
                          <span>出土地 <FieldReviewBadge warning={warningForField("place_of_excavation")} /></span>
                          <Input
                            value={selectedItem.form.placeOfExcavation}
                            placeholder="例如：1976年嘉祥英山一号隋墓出土"
                            onChange={(event) => updateSelectedForm({ placeOfExcavation: event.target.value })}
                          />
                        </label>
                      </div>
                    </div>
                  </Card>

                  <Card
                    size="small"
                    className="form-section exif-form-card exif-capture-card"
                    title={<FormSectionHeader icon={Camera} title="拍摄信息" description="自动读取图片 EXIF，可在入库前校正。" />}
                  >
                    <div className="form-section-body">
                      <div className="field-row">
                        <label className="field">
                          <span>相机型号</span>
                          <Input value={selectedItem.form.cameraModel} placeholder="未读取" onChange={(event) => updateSelectedForm({ cameraModel: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>镜头型号</span>
                          <Input value={selectedItem.form.lensModel} placeholder="未读取" onChange={(event) => updateSelectedForm({ lensModel: event.target.value })} />
                        </label>
                      </div>
                      <div className="exif-capture-grid">
                        <label className="field exif-captured-at-field">
                          <span>拍摄时间</span>
                          <Input
                            value={selectedItem.form.capturedAt}
                            placeholder="yyyy-MM-dd HH:mm:ss"
                            onChange={(event) => updateSelectedForm({ capturedAt: event.target.value })}
                            onBlur={(event) => updateSelectedForm({ capturedAt: formatCapturedAt(event.target.value) })}
                          />
                        </label>
                        <label className="field">
                          <span>快门</span>
                          <Input value={selectedItem.form.shutterSpeed} placeholder="例如：1/80s" onChange={(event) => updateSelectedForm({ shutterSpeed: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>光圈</span>
                          <Input value={selectedItem.form.aperture} placeholder="例如：f/8" onChange={(event) => updateSelectedForm({ aperture: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>ISO</span>
                          <Input inputMode="numeric" value={selectedItem.form.iso} placeholder="例如：400" onChange={(event) => updateSelectedForm({ iso: event.target.value.replace(/\D/g, "") })} />
                        </label>
                      </div>
                    </div>
                  </Card>

                  <Card
                    size="small"
                    className="form-section exif-form-card"
                    title={<FormSectionHeader icon={MapPin} title="展出地点" description="填写展出地点、展览名称和定位坐标。" />}
                  >
                    <div className="form-section-body">
                      <label className="field">
                        <span>展出地点名称</span>
                        <AutoComplete
                          value={selectedItem.form.displayLocationName}
                          options={locationSuggestions.map((museum) => ({
                            key: museum.id,
                            value: museum.name,
                            label: (
                              <span className="autocomplete-option">
                                <span>{museum.name}</span>
                                {(museum.latitude !== null && museum.longitude !== null) ? (
                                  <span className="autocomplete-option-meta">{museum.latitude}, {museum.longitude}</span>
                                ) : null}
                              </span>
                            ),
                          }))}
                          filterOption={false}
                          open={showLocationSuggestions && locationSuggestions.length > 0}
                          placeholder="例如：山东省博物馆"
                          onFocus={() => setShowLocationSuggestions(true)}
                          onOpenChange={setShowLocationSuggestions}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" || event.nativeEvent.isComposing) return
                            event.preventDefault()
                            event.stopPropagation()
                            void locateDisplayLocation(selectedItem.form.displayLocationName)
                          }}
                          onChange={(value) => {
                            updateSelectedForm({ displayLocationName: value })
                            setShowLocationSuggestions(true)
                          }}
                          onSelect={(value) => {
                            const museum = locationSuggestions.find((option) => option.name === value)
                            setShowLocationSuggestions(false)
                            if (!museum) {
                              void locateDisplayLocation(value)
                              return
                            }
                            void locateDisplayLocation(value, museum)
                          }}
                        />
                      </label>

                      <label className="field">
                        <span>对应展览</span>
                        <ExhibitionRecommendationPicker
                          apiBaseUrl={apiBaseUrl}
                          capturedAt={selectedItem.form.capturedAt}
                          latitude={selectedItem.form.latitude}
                          longitude={selectedItem.form.longitude}
                          location={selectedItem.form.displayLocationName}
                          selectedSourceId={selectedItem.form.catalogExhibitionSourceId}
                          selectedName={selectedItem.form.exhibitionName}
                          onSelect={(item) => updateSelectedForm(item ? {
                            exhibitionName: item.title,
                            catalogExhibitionId: item.id,
                            catalogExhibitionSourceId: item.source_id,
                          } : {
                            exhibitionName: "常设",
                            catalogExhibitionId: null,
                            catalogExhibitionSourceId: "",
                          })}
                          onManualChange={(value) => updateSelectedForm({
                            exhibitionName: value,
                            catalogExhibitionId: null,
                            catalogExhibitionSourceId: "",
                          })}
                        />
                      </label>

                      <div className="field-row">
                        <label className="field">
                          <span>纬度</span>
                          <Input
                            value={selectedItem.form.latitude}
                            placeholder="例如：35.117"
                            onChange={(event) => updateSelectedForm({ latitude: event.target.value })}
                          />
                        </label>
                        <label className="field">
                          <span>经度</span>
                          <Input
                            value={selectedItem.form.longitude}
                            placeholder="例如：117.188"
                            onChange={(event) => updateSelectedForm({ longitude: event.target.value })}
                          />
                        </label>
                      </div>
                      <GpsMapPicker
                        latitude={selectedItem.form.latitude}
                        longitude={selectedItem.form.longitude}
                        onPick={(latitude, longitude, displayLocationName) => updateSelectedForm({
                          latitude,
                          longitude,
                          ...(displayLocationName ? { displayLocationName } : {}),
                        })}
                      />
                    </div>
                  </Card>

                  <Card
                    size="small"
                    className="form-section exif-form-card"
                    title={<FormSectionHeader icon={Sparkles} title="AI 补充描述" description="生成多份候选描述后，选一版写回当前图片。" />}
                  >
                    <div className="form-section-body">
                      <div className="upload-actions exif-model-actions">
                        <Button htmlType="button" type="primary" onClick={() => void handleGenerateDescription()} disabled={generating}>
                          生成描述
                        </Button>
                        {selectedItem.descriptionMeta ? <p className="muted">{selectedItem.descriptionMeta}</p> : null}
                      </div>
                      {generating ? (
                        <div className="research-live-panel" aria-live="polite">
                          <div className="research-live-head">
                            <span className="research-orbit" aria-hidden="true"><Sparkles size={16} /></span>
                            <div>
                              <strong>正在核验与生成</strong>
                              <span>检索 Agent 和两个模型的进度会实时更新</span>
                            </div>
                            <Loader2 className="research-live-spinner" size={18} aria-hidden="true" />
                          </div>
                          <div className="research-trace">
                            {descriptionProgress.map((step, index) => (
                              <span key={step} className={index === descriptionProgress.length - 1 ? "is-active" : "is-done"}>
                                {index < descriptionProgress.length - 1 ? <Check size={12} /> : <Loader2 size={12} />}
                                {step}
                              </span>
                            ))}
                          </div>
                          {liveResearchSummary ? (
                            <details className="live-reasoning" open>
                              <summary>Agent 实时核验摘要</summary>
                              <p>{liveResearchSummary}</p>
                            </details>
                          ) : null}
                          {Object.keys(liveProviders).length > 0 ? (
                            <div className="live-provider-grid">
                              {Object.entries(liveProviders).map(([provider, state]) => (
                                <article key={provider} className={`live-provider is-${state.status}`}>
                                  <header>
                                    <strong>{provider}</strong>
                                    <span>{state.model}</span>
                                  </header>
                                  <p>{state.message}</p>
                                  {state.reasoning ? <pre>{state.reasoning}</pre> : (
                                    <div className="reasoning-skeleton" aria-hidden="true">
                                      <i /><i /><i />
                                    </div>
                                  )}
                                  {state.status === "complete" ? (
                                    <small>{state.descriptionLength} 字描述 · {state.tagCount} 个标签</small>
                                  ) : null}
                                </article>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="exif-model-grid">
                        {selectedItem.candidates.length > 0 ? selectedItem.candidates.map((candidate) => (
                          <article key={`${candidate.provider}-${candidate.model}`} className={`exif-model-card ${candidate.status !== "success" ? "is-error" : ""}`}>
                            <div className="result-head">
                              <h3>{candidate.provider}</h3>
                              <span>{candidate.model}</span>
                            </div>
                            <details className="exif-model-details">
                              <summary>查看模型依据</summary>
                              <pre className="exif-model-reasoning">{candidate.reasoning || candidate.error || "暂无依据返回"}</pre>
                            </details>
                            {candidate.research_summary ? (
                              <details className="exif-model-details">
                                <summary>查看联网核验报告</summary>
                                <pre className="exif-model-reasoning">{candidate.research_summary}</pre>
                              </details>
                            ) : null}
                            {candidate.status === "success" ? (
                              <>
                                <AnnotatedDescription
                                  description={candidate.description || "暂无描述"}
                                  warnings={candidate.field_warnings ?? []}
                                />
                                {(candidate.verified_claims?.length ?? 0) > 0 ? (
                                  <div className="verified-claim-list">
                                    {candidate.verified_claims
                                      ?.filter((claim) => selectedItem.verificationDecisions?.[claim.text] !== "rejected")
                                      .map((claim) => {
                                        const accepted = selectedItem.verificationDecisions?.[claim.text] === "accepted"
                                        return (
                                          <article key={claim.text} className={accepted ? "is-accepted" : ""}>
                                            <div className="verified-claim-copy">
                                              <div className="verified-claim-tags">
                                                <Tag color="blue">联网核验</Tag>
                                                {claim.source_refs
                                                  .filter((source) => source !== "联网核验")
                                                  .map((source) => <Tag key={source}>{source}</Tag>)}
                                              </div>
                                              <p>{claim.text}</p>
                                            </div>
                                            <div className="verified-claim-actions">
                                              <Tooltip title="内容正确，加入最终正文">
                                                <Button
                                                  htmlType="button"
                                                  type={accepted ? "primary" : "default"}
                                                  shape="circle"
                                                  size="small"
                                                  aria-label="确认联网核验内容并加入正文"
                                                  icon={<Check size={14} />}
                                                  onClick={() => reviewVerifiedClaim(claim, "accepted")}
                                                />
                                              </Tooltip>
                                              <Tooltip title="内容错误，从最终正文删除">
                                                <Button
                                                  htmlType="button"
                                                  danger
                                                  shape="circle"
                                                  size="small"
                                                  aria-label="否认联网核验内容并删除"
                                                  icon={<X size={14} />}
                                                  onClick={() => reviewVerifiedClaim(claim, "rejected")}
                                                />
                                              </Tooltip>
                                            </div>
                                          </article>
                                        )
                                      })}
                                  </div>
                                ) : null}
                                {(candidate.search_hits?.length ?? 0) > 0 ? (
                                  <details className="exif-model-details exif-research-sources">
                                    <summary>查看检索来源（{candidate.search_hits?.length}）</summary>
                                    <div className="exif-source-list">
                                      {candidate.search_hits?.map((hit, index) => (
                                        <article key={hit.url}>
                                          <a href={researchSourceUrl(apiBaseUrl, hit.url)} target="_blank" rel="noreferrer">
                                            [{index + 1}] {hit.title}
                                          </a>
                                          {hit.source ? <span>{hit.source}</span> : null}
                                          {hit.snippet ? <p>{hit.snippet}</p> : null}
                                        </article>
                                      ))}
                                    </div>
                                  </details>
                                ) : null}
                                <div className="result-meta selectable-model-tags">
                                  {candidate.tags.length > 0 ? candidate.tags.map((tag) => (
                                    <Tag.CheckableTag
                                      key={tag}
                                      checked={selectedItem.form.tags.includes(tag)}
                                      onChange={() => toggleCandidateTag(tag)}
                                    >
                                      {selectedItem.form.tags.includes(tag) ? <Check size={12} /> : <span>＋</span>}
                                      {tag}
                                    </Tag.CheckableTag>
                                  )) : <span>暂无标签</span>}
                                </div>
                                {candidate.tags.length > 0 ? <p className="model-tag-help">点击任意模型标签，可加入或移出最终标签。</p> : null}
                                <Button htmlType="button" type="primary" icon={<Check size={14} aria-hidden="true" />} onClick={() => applyCandidate(candidate)}>
                                  采用此描述
                                </Button>
                              </>
                            ) : <p className="error-text">{candidate.error || "模型调用失败"}</p>}
                          </article>
                        )) : <p className="muted">点击上方按钮生成两份结果。</p>}
                      </div>
                      {selectedItem.unavailableProviders.length > 0 ? (
                        <p className="muted">未配置模型：{selectedItem.unavailableProviders.join(" / ")}</p>
                      ) : null}
                    </div>
                  </Card>

                  <Card
                    size="small"
                    className="form-section exif-form-card"
                    title={<FormSectionHeader icon={FileCheck2} title="最终写入内容" description="这里的描述与标签会写入 EXIF 和云端数据库。" />}
                  >
                    <div className="form-section-body">
                      <label className="field">
                        <span>描述</span>
                        <Textarea
                          rows={5}
                          value={selectedItem.form.description}
                          placeholder="文物描述会写入 EXIF 与云端数据库中"
                          onChange={(event) => updateSelectedForm({ description: event.target.value })}
                        />
                      </label>

                      <label className="field">
                        <span>标签</span>
                        <div className="tag-editor">
                          <div className="tag-editor-chips">
                            {selectedItem.form.tags.length > 0 ? selectedItem.form.tags.map((tag) => (
                              <Tag
                                key={tag}
                                closable
                                onClose={() => updateItem(selectedItem.id, (item) => ({
                                  ...item,
                                  form: { ...item.form, tags: item.form.tags.filter((entry) => entry !== tag) },
                                }))}
                              >
                                {tag}
                              </Tag>
                            )) : <span className="tag-editor-placeholder">暂无标签</span>}
                          </div>
                          <Input
                            value={tagInput}
                            placeholder="输入后回车或逗号添加"
                            onChange={(event) => setTagInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === ",") {
                                event.preventDefault()
                                addTags(tagInput)
                              }
                            }}
                            onBlur={() => addTags(tagInput)}
                          />
                        </div>
                      </label>
                    </div>
                  </Card>
                </div>
              </div>

              <div className="form-footer exif-form-footer">
                <div className="exif-form-footer-copy">
                  {selectedItem.submitMessage ? (
                    <p className={selectedItem.submitState === "error" ? "error-text" : "success-text"}>{selectedItem.submitMessage}</p>
                  ) : submitNotice ? (
                    <p className={submitNotice.type === "error" ? "error-text" : "success-text"}>{submitNotice.text}</p>
                  ) : <p className="muted">确认当前图片信息无误后，再执行保存入库。</p>}
                </div>
                <Button
                  htmlType="button"
                  onClick={syncSelectedMetadataToOthers}
                  disabled={items.length < 2 || selectedItem.submitState === "submitting"}
                >
                  同步到其他照片
                </Button>
                <Button
                  htmlType="button"
                  type="primary"
                  onClick={() => void submitOne(selectedItem.id)}
                  disabled={selectedItem.submitState === "submitting" || (selectedItem.submitState === "submitted" && changedParts(selectedItem).length === 0)}
                >
                  {selectedItem.submitState === "submitting" ? "正在入库…" : selectedItem.submitState === "submitted" && changedParts(selectedItem).length === 0 ? "已入库" : selectedItem.submitState === "error" ? "授权并重试" : "保存并入库"}
                </Button>
              </div>
            </form>
          ) : (
            <div className="panel empty-state exif-main-empty">
              <span className="exif-empty-symbol" aria-hidden="true">
                <ImagePlus size={22} strokeWidth={1.6} />
              </span>
              <h2>从一张文物照片开始</h2>
              <p className="muted">选择图片后，系统会从文件名提取基础信息；只需校对后保存入库。</p>
              <div className="upload-actions exif-empty-actions">
                <Button
                  htmlType="button"
                  type="primary"
                  icon={uploadActivity === "files"
                    ? <Loader2 size={14} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                    : <ImagePlus size={14} strokeWidth={1.8} aria-hidden="true" />}
                  onClick={handleSelectImages}
                  disabled={uploading}
                >
                  {uploadActivity === "files" ? "正在读取…" : "添加图片"}
                </Button>
                <Button
                  htmlType="button"
                  icon={uploadActivity === "directory"
                    ? <Loader2 size={14} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                    : <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" />}
                  onClick={() => void handleSelectDirectory()}
                  disabled={uploading}
                >
                  {uploadActivity === "directory" ? "正在载入…" : "载入文件夹"}
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
      <Modal
        title="发现可能对应的已入库文物"
        open={artifactMatchReviewItem !== null}
        centered
        width={780}
        closable={false}
        maskClosable={false}
        keyboard={false}
        destroyOnHidden
        footer={[
          <Button key="new" htmlType="button" onClick={rejectExistingArtifactMatches}>
            都不是，按新文物填写
          </Button>,
        ]}
      >
        {artifactMatchReviewItem ? (
          <div className="artifact-match-review">
            <div className="artifact-match-review-intro">
              <div>
                <span>当前上传</span>
                <strong>{artifactMatchReviewItem.fileName}</strong>
              </div>
              <Tag color="processing">
                {artifactMatchReviewIds.length > 1 ? `还有 ${artifactMatchReviewIds.length} 张待确认` : "请选择对应文物"}
              </Tag>
            </div>
            <p className="muted">
              选择后会填入已有文物的名称、馆藏、时代、描述和标签，并把这张新照片追加到该文物；新照片自己的相机参数和拍摄时间不会被覆盖。
            </p>
            <div className="artifact-match-candidates">
              {(artifactMatchReviewItem.existingArtifactCandidates ?? []).map((match) => {
                const cover = match.artifact.images[0]
                const previewUrl = cover
                  ? `${apiBaseUrl}/api/image-variant?${new URLSearchParams({ url: cover.url, size: "360" }).toString()}`
                  : ""
                return (
                  <button
                    key={match.artifact.id}
                    type="button"
                    className="artifact-match-candidate"
                    onClick={() => selectExistingArtifactMatch(match)}
                  >
                    <span className="artifact-match-thumb">
                      {cover ? (
                        <img
                          src={previewUrl}
                          alt={match.artifact.name}
                          onError={(event) => {
                            event.currentTarget.onerror = null
                            event.currentTarget.src = cover.url
                          }}
                        />
                      ) : <span>无图</span>}
                    </span>
                    <span className="artifact-match-copy">
                      <strong>{match.artifact.name}</strong>
                      <span>{match.artifact.era || "时代未填写"} · {match.artifact.museum_name}</span>
                      <small>{match.match_reason}</small>
                      {match.artifact.description ? <p>{match.artifact.description}</p> : null}
                      <span className="artifact-match-tags">
                        {match.artifact.tags
                          .filter((tag) => !/^(机型|镜头)\s*[:：]/.test(tag))
                          .slice(0, 6)
                          .map((tag) => <Tag key={tag}>{tag}</Tag>)}
                      </span>
                      <b>选择并填入这件文物</b>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </Modal>
      <Modal
        title="图片已读取，继续授权原文件"
        open={uploadPermissionOpen}
        centered
        width={520}
        destroyOnHidden
        onCancel={() => {
          setUploadPermissionOpen(false)
          setSubmitNotice({
            type: "success",
            text: `已读取 ${recentUploadedCount} 张图片；尚未授权原文件，稍后可点击图片列表上方的文件夹按钮继续。`,
          })
        }}
        footer={[
          <Button
            key="later"
            htmlType="button"
            onClick={() => {
              setUploadPermissionOpen(false)
              setSubmitNotice({
                type: "success",
                text: `已读取 ${recentUploadedCount} 张图片；尚未授权原文件，稍后可点击图片列表上方的文件夹按钮继续。`,
              })
            }}
          >
            稍后授权
          </Button>,
          <Button
            key="authorize"
            htmlType="button"
            type="primary"
            loading={bindingDirectory}
            onClick={() => {
              setUploadPermissionOpen(false)
              void handleBindDirectory()
            }}
          >
            选择原文件夹并授权
          </Button>,
        ]}
      >
        <div className="exif-upload-permission">
          <p>
            已读取 {recentUploadedCount} 张图片。为了在保存入库时同时修改本地文件名和 EXIF，
            请继续选择这些照片所在的文件夹，并允许浏览器读写。
          </p>
          <div className="exif-upload-permission-note">
            刚才选择图片只授予了读取权限，这是浏览器要求的原文件写入确认。系统只会绑定当前队列里的同名照片，不会把文件夹中的其他图片加入队列。
          </div>
        </div>
      </Modal>
      <Modal
        title="选择目标与同步内容"
        open={metadataSyncPreviewOpen}
        width={760}
        centered
        destroyOnHidden
        onCancel={() => setMetadataSyncPreviewOpen(false)}
        footer={[
          <Button key="cancel" htmlType="button" onClick={() => setMetadataSyncPreviewOpen(false)}>取消</Button>,
          <Button
            key="apply"
            htmlType="button"
            type="primary"
            onClick={applyMetadataSync}
            disabled={metadataSyncTargets.length === 0 || metadataSyncChangedCount === 0}
          >
            同步到 {metadataSyncTargets.length} 张照片
          </Button>,
        ]}
      >
        <div className="metadata-sync-preview">
          {metadataSyncTargetMode === "selected" ? (
            <section className="metadata-sync-target-picker">
              <div className="metadata-sync-target-picker-head">
                <div>
                  <strong>选择目标照片</strong>
                  <span>可以只选一张，也可以多选；来源照片不会出现在这里。</span>
                </div>
                <Space.Compact size="small">
                  <Button
                    htmlType="button"
                    onClick={() => setMetadataSyncTargetIds(metadataSyncAvailableTargets.map((item) => item.id))}
                    disabled={metadataSyncAvailableTargets.length === 0}
                  >
                    全选
                  </Button>
                  <Button
                    htmlType="button"
                    onClick={() => setMetadataSyncTargetIds([])}
                    disabled={metadataSyncTargetIds.length === 0}
                  >
                    清空
                  </Button>
                </Space.Compact>
              </div>
              <div className="metadata-sync-target-list">
                {metadataSyncAvailableTargets.map((item) => {
                  const itemIndex = items.findIndex((entry) => entry.id === item.id)
                  return (
                    <Checkbox
                      key={item.id}
                      className="metadata-sync-target-option"
                      checked={metadataSyncTargetIds.includes(item.id)}
                      onChange={(event) => setMetadataSyncTargetIds((current) => (
                        event.target.checked
                          ? Array.from(new Set([...current, item.id]))
                          : current.filter((id) => id !== item.id)
                      ))}
                    >
                      <span className="metadata-sync-target-option-content">
                        <img src={item.previewUrl} alt="" loading="lazy" decoding="async" />
                        <span title={item.fileName}>{indexedFileName(item.fileName, itemIndex)}</span>
                      </span>
                    </Checkbox>
                  )
                })}
              </div>
              <p className="metadata-sync-target-picker-count">
                已选择 {metadataSyncTargets.length}/{metadataSyncAvailableTargets.length} 张目标照片
              </p>
            </section>
          ) : null}
          <section className="metadata-sync-preview-fields">
            <div className="metadata-sync-preview-fields-head">
              <div>
                <strong>选择同步内容</strong>
                <span>相机、拍摄参数与时间默认关闭，避免覆盖每张照片自己的 EXIF。</span>
              </div>
              <span>{metadataSyncSelectedCount}/{METADATA_SYNC_FIELD_COUNT} 项已开启</span>
            </div>
            <div className="metadata-sync-presets" aria-label="同步范围快捷选择">
              <span>快捷选择</span>
              <Space.Compact size="small">
                <Button htmlType="button" onClick={() => selectMetadataSyncPreset("default")}>恢复默认</Button>
                <Button htmlType="button" onClick={() => selectMetadataSyncPreset("location")}>只选地点</Button>
                <Button htmlType="button" onClick={() => selectMetadataSyncPreset("content")}>只选内容</Button>
                <Button htmlType="button" onClick={() => selectMetadataSyncPreset("all")}>全部开启</Button>
                <Button htmlType="button" onClick={() => selectMetadataSyncPreset("none")}>清空</Button>
              </Space.Compact>
            </div>
            <MetadataSyncFieldControls
              context="preview"
              selection={metadataSyncSelection}
              onChange={(field, checked) => setMetadataSyncSelection((current) => ({
                ...current,
                [field]: checked,
              }))}
            />
          </section>
          <div className="metadata-sync-preview-summary">
            <div>
              <span>来源照片</span>
              <strong>{metadataSyncSource?.fileName ?? "未选择"}</strong>
            </div>
            <div>
              <span>目标范围</span>
              <strong>
                {metadataSyncTargetMode === "current"
                  ? "当前图片"
                  : metadataSyncTargetMode === "selected"
                    ? `指定照片（${metadataSyncTargets.length} 张）`
                    : `全部其他图片（${metadataSyncTargets.length} 张）`}
              </strong>
            </div>
            <div className="is-emphasis">
              <span>预计变更</span>
              <strong>{metadataSyncChangedCount} 项</strong>
            </div>
          </div>
          {metadataSyncTargets.length === 0 ? (
            <div className="metadata-sync-no-change">请先选择至少一张目标照片。</div>
          ) : metadataSyncDiffs.every((entry) => entry.rows.length === 0) ? (
            <div className="metadata-sync-no-change">来源照片与目标照片在所选范围内没有差异。</div>
          ) : (
            <div className="metadata-sync-preview-targets">
              {metadataSyncDiffs.filter((entry) => entry.rows.length > 0).map(({ target, rows }) => (
                <section key={target.id} className="metadata-sync-preview-target">
                  <header>
                    <img src={target.previewUrl} alt="" loading="lazy" decoding="async" />
                    <div>
                      <strong>{target.fileName}</strong>
                      <span className="metadata-sync-target-change-count">{rows.length} 项将变更</span>
                    </div>
                  </header>
                  <div className="metadata-sync-diff-list" role="table" aria-label={`${target.fileName} 的同步差异`}>
                    <div className="metadata-sync-diff-row is-head" role="row">
                      <span role="columnheader">字段</span>
                      <span role="columnheader">同步前</span>
                      <span role="columnheader">同步后</span>
                    </div>
                    {rows.map((row) => (
                      <div key={row.label} className="metadata-sync-diff-row" role="row">
                        <strong className="metadata-sync-table-field" role="cell">{row.label}</strong>
                        <span className={`metadata-sync-table-before ${row.targetValue === "未填写" ? "is-empty" : ""}`} title={row.targetValue} role="cell">
                          {row.targetValue}
                        </span>
                        <span className={`metadata-sync-table-after ${row.sourceValue === "未填写" ? "is-empty" : ""}`} title={row.sourceValue} role="cell">
                          <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
                          <strong>{row.sourceValue}</strong>
                          {row.willClearTarget ? <Tag color="warning">将清空</Tag> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          {metadataSyncDiffs.some((entry) => entry.rows.some((row) => row.willClearTarget)) ? (
            <p className="metadata-sync-clear-warning">来源照片中有空字段，确认后会清空目标照片对应内容。</p>
          ) : null}
        </div>
      </Modal>
    </section>
  )
}

export default ExifConsole
