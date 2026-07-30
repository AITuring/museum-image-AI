import { useCallback, useEffect, useRef, useState, type ImgHTMLAttributes } from "react"
import { App as AntApp, AutoComplete, Button, Input, Select, Tag } from "antd"
import "./styles/gallery.css"
import { compactArtifactNameForMatch, getBackendImageVariantUrl, normalizeIdentityText, toAbsoluteUrl } from "./lib/galleryArtifactIdentity"
import {
  Aperture,
  ArrowLeft,
  Building2,
  CalendarRange,
  Camera,
  CircleDot,
  Clock3,
  FileText,
  Gauge,
  History,
  Images,
  MapPin,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tag as TagIcon,
  Timer,
  Trash2,
} from "lucide-react"
import GalleryImagePreview from "./GalleryImagePreview"

const Textarea = Input.TextArea

const AMAP_SCRIPT_ID = "museum-console-amap-script"
const AMAP_SECURITY_CODE = "3ba01835420271d5405dccba5e089b46"
const AMAP_SCRIPT_SRC =
  "https://webapi.amap.com/maps?v=1.4.15&key=7a9513e700e06c00890363af1bd2d926&plugin=AMap.ToolBar"

type GalleryImage = {
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

type RawGalleryArtifact = Omit<GalleryArtifact, "tags" | "images" | "exhibitions"> & {
  tags?: string[]
  images?: GalleryImage[]
  exhibitions?: GalleryArtifact["exhibitions"]
}

type GalleryEditFormState = {
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

type HistoricalExhibitionDraft = {
  imageId: number
  artifactId: number
  captureMuseumName: string
  exhibitionName: string
  catalogSourceId: string
  catalogExhibitionId: number | null
  startAt: string | null
  endAt: string | null
}

type HistoricalExhibitionGroup = HistoricalExhibitionDraft & { imageIds: number[] }

function groupHistoricalExhibitions(records: HistoricalExhibitionDraft[]) {
  const groups = new Map<string, HistoricalExhibitionGroup>()
  for (const record of records) {
    const key = `${record.captureMuseumName}\u0000${record.exhibitionName}\u0000${record.startAt ?? ""}\u0000${record.endAt ?? ""}`
    const existing = groups.get(key)
    if (existing) existing.imageIds.push(record.imageId)
    else groups.set(key, { ...record, imageIds: [record.imageId] })
  }
  return Array.from(groups.values())
}

function formatExhibitionPeriod(
  startAt: string | null,
  endAt: string | null,
  exhibitionName = "",
  missingLabel = "时间未注明",
) {
  if (!startAt && !endAt) {
    return normalizeLookupText(exhibitionName).includes("常设")
      ? "常设展"
      : missingLabel
  }
  return `${startAt?.slice(0, 10) ?? "未知"} – ${endAt?.slice(0, 10) ?? "至今"}`
}

type GeneratedDescription = {
  provider: string
  model: string
  description: string
  candidates?: Array<{
    provider: string
    model: string
    description: string
    status: string
  }>
}

type MuseumOption = {
  id: number
  name: string
}

const SHANGHAI_MUSEUM_BRANCHES = [
  "上海博物馆东馆",
  "上海博物馆人民广场馆",
] as const

function normalizeMuseumOptions(options: MuseumOption[]) {
  const genericKey = normalizeLookupText("上海博物馆")
  const next = options.filter((museum) => normalizeLookupText(museum.name) !== genericKey)
  const existingNames = new Set(next.map((museum) => normalizeLookupText(museum.name)))
  SHANGHAI_MUSEUM_BRANCHES.forEach((name, index) => {
    if (!existingNames.has(normalizeLookupText(name))) {
      next.push({ id: -(index + 1), name })
    }
  })
  return next.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
}

function catalogMuseumQueryName(museumName: string) {
  return normalizeLookupText(museumName) === normalizeLookupText("上海博物馆人民广场馆")
    ? "上海博物馆"
    : museumName
}

function canonicalCatalogMuseumName(item: {
  museum_name: string | null
  address?: string | null
}) {
  const museumName = item.museum_name?.trim() ?? ""
  if (normalizeLookupText(museumName) === normalizeLookupText("上海博物馆")) {
    return "上海博物馆人民广场馆"
  }
  if (isFloorLabel(museumName)) {
    const addressKey = normalizeLookupText(item.address)
    if (addressKey.includes(normalizeLookupText("世纪大道1952号"))) {
      return "上海博物馆东馆"
    }
    if (addressKey.includes(normalizeLookupText("人民大道201号"))) {
      return "上海博物馆人民广场馆"
    }
  }
  return museumName
}

type CatalogExhibitionOption = {
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

type LocalExhibitionOption = {
  id: number
  museum_name: string
  name: string
  start_at: string | null
  end_at: string | null
  catalog_source_id: string | null
  catalog_exhibition_id: number | null
}

type HistoricalExhibitionChoice = {
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

type EraOption = {
  id: number
  name: string
  sort_order: number
}

 function galleryArtifactMergeKey(artifact: GalleryArtifact) {
  const museumKey = normalizeIdentityText(artifact.museum_name)
  const eraKey = normalizeIdentityText(artifact.era)
  const nameKey = compactArtifactNameForMatch(artifact.name)
  return museumKey && eraKey && nameKey ? `${museumKey}\u0000${eraKey}\u0000${nameKey}` : null
}

function mergeGalleryArtifacts(items: GalleryArtifact[]) {
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

function FallbackImage({
  src,
  fallbackSrc,
  onError,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { src: string; fallbackSrc?: string }) {
  const [currentSrc, setCurrentSrc] = useState(src)

  useEffect(() => {
    setCurrentSrc(src)
  }, [src])

  return (
    <img
      {...props}
      src={currentSrc}
      onError={(event) => {
        onError?.(event)
        if (fallbackSrc && currentSrc !== fallbackSrc) {
          setCurrentSrc(fallbackSrc)
        }
      }}
    />
  )
}

function normalizeArtifact(item: RawGalleryArtifact): GalleryArtifact {
  return {
    ...item,
    tags: Array.isArray(item.tags) ? item.tags : [],
    images: Array.isArray(item.images) ? item.images : [],
    exhibitions: Array.isArray(item.exhibitions) ? item.exhibitions : [],
  }
}

function getGalleryArtifactIdFromLocation() {
  const routeMatch = window.location.pathname.match(/^\/gallery\/(\d+)$/)
  const routeId = routeMatch ? Number(routeMatch[1]) : Number.NaN
  if (Number.isInteger(routeId) && routeId > 0) return routeId

  const legacyValue = new URLSearchParams(window.location.search).get("artifact")
  const legacyId = legacyValue ? Number(legacyValue) : Number.NaN
  return Number.isInteger(legacyId) && legacyId > 0 ? legacyId : null
}

function getGalleryReturnTarget() {
  const params = new URLSearchParams(window.location.search)
  if (params.get("from") !== "eras") return { path: "/gallery", label: "图库" }
  const era = params.get("era")?.trim()
  const eraQuery = era ? `?${new URLSearchParams({ era }).toString()}` : ""
  return { path: `/eras${eraQuery}`, label: "时代" }
}

function formatMetaDate(value?: string | null) {
  if (!value) return ""
  const normalized = value.replace("T", " ")
  return normalized.length >= 19 ? normalized.slice(0, 19) : normalized
}

function formatMetaValue(value?: string | number | null) {
  if (value === null || value === undefined) return ""
  return String(value)
}

function normalizeTags(tags: string[]) {
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

function getSubjectTags(tags: string[]) {
  return tags.filter((tag) => !/^(机型|镜头)[:：]/.test(tag))
}

function isFloorLabel(value: string | null | undefined) {
  return /^\s*[负-]?\d+\s*楼\s*$/.test(value ?? "")
}

function buildEditForm(artifact: GalleryArtifact, image?: GalleryImage | null): GalleryEditFormState {
  const storedCaptureMuseum = image?.capture_museum_name ?? ""
  // A floor is a venue detail, not a museum. Repair legacy catalog-derived
  // values in the editable form so saving corrects the persisted record.
  const captureMuseumName = isFloorLabel(storedCaptureMuseum)
    ? artifact.museum_name
    : storedCaptureMuseum
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

function normalizeLookupText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s·•・,，。．()（）[\]【】<>《》\-—–_/]+/g, "")
}

function HistoricalExhibitionRow({
  activeImageId,
  apiBaseUrl,
  draggedImageId,
  group,
  imageIndexes,
  index,
  museumOptions,
  onActivateImage,
  onDelete,
  onDropImage,
  onSetDraggedImage,
  onUpdate,
}: {
  activeImageId: number | null
  apiBaseUrl: string
  draggedImageId: number | null
  group: HistoricalExhibitionGroup
  imageIndexes: Map<number, number>
  index: number
  museumOptions: MuseumOption[]
  onActivateImage: (imageIndex: number) => void
  onDelete: () => void
  onDropImage: (imageId: number) => void
  onSetDraggedImage: (imageId: number | null) => void
  onUpdate: (patch: Partial<HistoricalExhibitionDraft>) => void
}) {
  const [exhibitionQuery, setExhibitionQuery] = useState(group.exhibitionName)
  const [exhibitionChoices, setExhibitionChoices] = useState<HistoricalExhibitionChoice[]>([])
  const [loadingExhibitions, setLoadingExhibitions] = useState(false)
  const hydratedCatalogSourceRef = useRef<string | null>(null)

  useEffect(() => {
    if (
      !group.catalogSourceId
      || group.startAt
      || group.endAt
      || hydratedCatalogSourceRef.current === group.catalogSourceId
    ) return
    hydratedCatalogSourceRef.current = group.catalogSourceId
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/exhibition-catalog/source/${encodeURIComponent(group.catalogSourceId)}`,
          { signal: controller.signal },
        )
        if (!response.ok) return
        const catalogItem = (await response.json()) as CatalogExhibitionOption
        onUpdate({
          catalogExhibitionId: catalogItem.id,
          startAt: catalogItem.start_date,
          endAt: catalogItem.end_date,
        })
      } catch {
        // Keep the saved exhibition link when the catalog is temporarily unavailable.
      }
    })()
    return () => controller.abort()
  }, [apiBaseUrl, group.catalogSourceId, group.endAt, group.startAt, onUpdate])

  useEffect(() => {
    const museumName = group.captureMuseumName.trim()
    if (!museumName) {
      setExhibitionChoices([])
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoadingExhibitions(true)
      try {
        const catalogMuseumName = catalogMuseumQueryName(museumName)
        const catalogParams = new URLSearchParams({
          include_facets: "false",
          museum_name: catalogMuseumName,
          page_size: "50",
        })
        const keyword = exhibitionQuery.trim()
        if (keyword) catalogParams.set("q", keyword)
        const localParams = new URLSearchParams({
          museum_name: museumName,
          limit: "100",
        })
        if (keyword) localParams.set("q", keyword)

        const broadCatalogParams = new URLSearchParams({
          include_facets: "false",
          page_size: "50",
        })
        if (keyword) broadCatalogParams.set("q", keyword)
        const [catalogResponse, broadCatalogResponse, localResponse] = await Promise.all([
          fetch(`${apiBaseUrl}/api/exhibition-catalog?${catalogParams.toString()}`, {
            signal: controller.signal,
          }),
          keyword
            ? fetch(`${apiBaseUrl}/api/exhibition-catalog?${broadCatalogParams.toString()}`, {
                signal: controller.signal,
              })
            : Promise.resolve(null),
          fetch(`${apiBaseUrl}/api/exhibitions?${localParams.toString()}`, {
            signal: controller.signal,
          }),
        ])
        if (!catalogResponse.ok || (broadCatalogResponse && !broadCatalogResponse.ok) || !localResponse.ok) {
          throw new Error("展览联想加载失败")
        }

        const catalogPayload = (await catalogResponse.json()) as { items: CatalogExhibitionOption[] }
        const broadCatalogPayload = broadCatalogResponse
          ? (await broadCatalogResponse.json()) as { items: CatalogExhibitionOption[] }
          : { items: [] }
        const localPayload = (await localResponse.json()) as LocalExhibitionOption[]
        const museumKey = normalizeLookupText(museumName)
        const catalogMuseumQueryKey = normalizeLookupText(catalogMuseumName)
        const constrainedCatalogItems = [...catalogPayload.items, ...broadCatalogPayload.items].filter((item) => {
          const catalogMuseumKey = normalizeLookupText(canonicalCatalogMuseumName(item))
          const museumMatches = (
            Boolean(catalogMuseumKey)
            && (
              catalogMuseumKey.includes(museumKey)
              || museumKey.includes(catalogMuseumKey)
              || catalogMuseumKey === catalogMuseumQueryKey
            )
          )
          return item.source_id === group.catalogSourceId || museumMatches
        })
        const combined: HistoricalExhibitionChoice[] = [
          ...constrainedCatalogItems.map((item) => ({
            key: `catalog:${item.source_id}`,
            name: item.title,
            museumName: canonicalCatalogMuseumName(item) || museumName,
            venue: item.venue ?? "",
            catalogSourceId: item.source_id,
            catalogExhibitionId: item.id,
            startAt: item.start_date,
            endAt: item.end_date,
            isPermanent: item.is_permanent,
          })),
          ...localPayload.map((item) => ({
            key: item.catalog_source_id ? `catalog:${item.catalog_source_id}` : `local:${item.id}`,
            name: item.name,
            museumName: canonicalCatalogMuseumName({ museum_name: item.museum_name }),
            venue: "",
            catalogSourceId: item.catalog_source_id ?? "",
            catalogExhibitionId: item.catalog_exhibition_id,
            startAt: item.start_at,
            endAt: item.end_at,
            isPermanent: normalizeLookupText(item.name).includes("常设"),
          })),
        ]
        const seen = new Set<string>()
        setExhibitionChoices(combined.filter((choice) => {
          const identity = `${normalizeLookupText(choice.museumName)}:${normalizeLookupText(choice.name)}`
          if (seen.has(identity)) return false
          seen.add(identity)
          return true
        }))
      } catch {
        if (!controller.signal.aborted) setExhibitionChoices([])
      } finally {
        if (!controller.signal.aborted) setLoadingExhibitions(false)
      }
    }, 180)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [apiBaseUrl, exhibitionQuery, group.captureMuseumName])

  const exhibitionOptions = exhibitionChoices.map((choice) => ({
    value: choice.name,
    label: (
      <span className="gallery-exhibition-option">
        <strong>{choice.name}</strong>
        <small>
          {[choice.museumName, choice.venue, formatExhibitionPeriod(choice.startAt, choice.endAt, choice.name)]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </span>
    ),
  }))

  return (
    <div
      className={`gallery-history-row${draggedImageId !== null && !group.imageIds.includes(draggedImageId) ? " is-drop-target" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => {
        if (draggedImageId === null || group.imageIds.includes(draggedImageId)) return
        onDropImage(draggedImageId)
      }}
    >
      <span className="gallery-history-index" title={`第 ${index + 1} 条展出记录`}>
        {index + 1}
      </span>
      <AutoComplete
        className="gallery-history-museum"
        value={group.captureMuseumName}
        options={museumOptions.map((museum) => ({ value: museum.name }))}
        filterOption={(input, option) =>
          normalizeLookupText(String(option?.value ?? "")).includes(normalizeLookupText(input))
        }
        aria-label={`第 ${index + 1} 条历史展出的场馆`}
        placeholder="输入场馆名称联想搜索…"
        onChange={(value) => onUpdate({
          captureMuseumName: value,
          catalogSourceId: "",
          catalogExhibitionId: null,
          startAt: null,
          endAt: null,
        })}
      >
        <Input />
      </AutoComplete>
      <AutoComplete
        className="gallery-history-exhibition"
        value={group.exhibitionName}
        options={exhibitionOptions}
        filterOption={false}
        aria-label={`第 ${index + 1} 条历史展出的展览`}
        placeholder={group.captureMuseumName.trim() ? "输入展览名称联想搜索…" : "请先选择场馆…"}
        notFoundContent={loadingExhibitions ? "正在检索展览…" : "没有匹配展览"}
        onFocus={() => setExhibitionQuery(group.exhibitionName)}
        onSearch={setExhibitionQuery}
        onChange={(value) => {
          setExhibitionQuery(value)
          onUpdate({
            exhibitionName: value,
            catalogSourceId: "",
            catalogExhibitionId: null,
            startAt: null,
            endAt: null,
          })
        }}
        onSelect={(value) => {
          const choice = exhibitionChoices.find((item) => item.name === value)
          if (!choice) return
          setExhibitionQuery(choice.name)
          onUpdate({
            captureMuseumName: choice.museumName || group.captureMuseumName,
            exhibitionName: choice.name,
            catalogSourceId: choice.catalogSourceId,
            catalogExhibitionId: choice.catalogExhibitionId,
            startAt: choice.startAt,
            endAt: choice.endAt,
          })
        }}
      >
        <Input />
      </AutoComplete>
      <span className="gallery-history-period">
        {formatExhibitionPeriod(
          group.startAt,
          group.endAt,
          group.exhibitionName,
          "请选择目录展览以带回时间",
        )}
      </span>
      <div className="gallery-history-images" aria-label={`第 ${index + 1} 条历史展出的图片`}>
        {group.imageIds.map((imageId) => {
          const imageIndex = imageIndexes.get(imageId) ?? -1
          return (
            <button
              key={imageId}
              type="button"
              draggable
              className={`gallery-history-image-link${imageId === activeImageId ? " is-active" : ""}`}
              onClick={() => onActivateImage(imageIndex)}
              onDragStart={() => onSetDraggedImage(imageId)}
              onDragEnd={() => onSetDraggedImage(null)}
            >
              图{imageIndex + 1}
            </button>
          )
        })}
      </div>
      <Button
        type="text"
        danger
        size="small"
        className="gallery-history-delete"
        aria-label={`删除第 ${index + 1} 条历史展出`}
        title="删除这条展出记录"
        icon={<Trash2 size={13} aria-hidden="true" />}
        onClick={onDelete}
      >
        <span className="sr-only">删除</span>
      </Button>
    </div>
  )
}

function parseOptionalNumber(value: string, label: string) {
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

function hasValidCoordinates(latitude: string, longitude: string) {
  const lat = Number(latitude)
  const lng = Number(longitude)
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

function createEditMapMarker() {
  const element = document.createElement("div")
  element.className = "museum-map-marker edit"
  return element
}

function loadAmap(): Promise<any> {
  return new Promise((resolve, reject) => {
    const mapWindow = window as unknown as Window & {
      AMap?: any
      _AMapSecurityConfig?: { securityJsCode: string }
    }

    if (mapWindow.AMap) {
      resolve(mapWindow.AMap)
      return
    }

    mapWindow._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE }

    const existing = document.getElementById(AMAP_SCRIPT_ID) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener("load", () => resolve(mapWindow.AMap), { once: true })
      existing.addEventListener("error", () => reject(new Error("高德地图加载失败")), { once: true })
      return
    }

    const script = document.createElement("script")
    script.id = AMAP_SCRIPT_ID
    script.src = AMAP_SCRIPT_SRC
    script.async = true
    script.onload = () => resolve(mapWindow.AMap)
    script.onerror = () => reject(new Error("高德地图加载失败"))
    document.head.appendChild(script)
  })
}

function ensureAmapPlugin(AMap: any, plugins: string[]) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timeoutId = window.setTimeout(() => {
      if (settled) return
      const missing = plugins.some((plugin) => {
        const name = plugin.replace(/^AMap\./, "")
        return !AMap?.[name]
      })
      if (missing) {
        settled = true
        reject(new Error("地图插件加载失败"))
      }
    }, 1200)

    AMap.plugin(plugins, () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      resolve()
    })
  })
}

function GalleryLocationPicker({
  latitude,
  longitude,
  locationText,
  onChange,
  onLocationTextChange,
}: {
  latitude: string
  longitude: string
  locationText: string
  onChange(next: { latitude: string; longitude: string }): void
  onLocationTextChange(next: string): void
}) {
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [mapLoading, setMapLoading] = useState(false)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const geocoderRef = useRef<any>(null)
  const lastSyncedCoordinateRef = useRef<string>("")

  const reverseLookup = useCallback(async (lat: string, lng: string) => {
    const AMap = await loadAmap()
    await ensureAmapPlugin(AMap, ["AMap.Geocoder"])
    const geocoder =
      geocoderRef.current ??
      new AMap.Geocoder({
        city: "全国",
      })
    geocoderRef.current = geocoder

    return new Promise<string | null>((resolve) => {
      geocoder.getAddress([Number(lng), Number(lat)], (status: string, result: any) => {
        if (status !== "complete" || !result?.regeocode) {
          resolve(null)
          return
        }
        resolve(result.regeocode.formattedAddress || null)
      })
    })
  }, [])

  useEffect(() => {
    let disposed = false

    async function initializeMap() {
      if (!mapContainerRef.current) return
      setMapLoading(true)
      setError(null)
      try {
        const AMap = await loadAmap()
        if (disposed || !mapContainerRef.current || mapRef.current) return

        const hasCoordinates = hasValidCoordinates(latitude, longitude)
        const center = hasCoordinates ? [Number(longitude), Number(latitude)] : [116.397428, 39.90923]
        const map = new AMap.Map(mapContainerRef.current, {
          zoom: hasCoordinates ? 11 : 4,
          center,
          mapStyle: "amap://styles/whitesmoke",
          resizeEnable: true,
          dragEnable: true,
          zoomEnable: true,
        })

        const marker = new AMap.Marker({
          position: center,
          content: createEditMapMarker(),
          offset: new AMap.Pixel(-11, -11),
          zIndex: 120,
        })
        marker.setMap(map)
        if (!hasCoordinates) {
          marker.hide()
        }

        map.on("click", (event: any) => {
          const nextLongitude = event.lnglat.getLng().toFixed(6)
          const nextLatitude = event.lnglat.getLat().toFixed(6)
          marker.show()
          marker.setPosition([Number(nextLongitude), Number(nextLatitude)])
          map.setZoomAndCenter?.(13, [Number(nextLongitude), Number(nextLatitude)])
          onChange({ latitude: nextLatitude, longitude: nextLongitude })
          const traceKey = `${nextLatitude},${nextLongitude}`
          lastSyncedCoordinateRef.current = traceKey
          void reverseLookup(nextLatitude, nextLongitude).then((address) => {
            onLocationTextChange(address || traceKey)
          })
          setStatus("已通过地图选点更新坐标")
          setError(null)
        })

        mapRef.current = map
        markerRef.current = marker
        setMapReady(true)
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : "地图初始化失败")
        }
      } finally {
        if (!disposed) {
          setMapLoading(false)
        }
      }
    }

    void initializeMap()

    return () => {
      disposed = true
      markerRef.current?.setMap?.(null)
      markerRef.current = null
      mapRef.current?.destroy?.()
      mapRef.current = null
      geocoderRef.current = null
    }
  }, [onChange, onLocationTextChange, reverseLookup])

  useEffect(() => {
    if (!mapReady) return
    const marker = markerRef.current
    const map = mapRef.current
    if (!marker || !map) return

    if (!hasValidCoordinates(latitude, longitude)) {
      marker.hide?.()
      return
    }

    const position: [number, number] = [Number(longitude), Number(latitude)]
    marker.show?.()
    marker.setPosition(position)
    map.setZoomAndCenter?.(13, position)

    const traceKey = `${latitude},${longitude}`
    if (lastSyncedCoordinateRef.current === traceKey) {
      return
    }
    lastSyncedCoordinateRef.current = traceKey
    setStatus("已根据输入坐标同步地图位置")
  }, [latitude, longitude, mapReady])

  const handleResolveLocation = useCallback(async () => {
    const keyword = locationText.trim()
    if (!keyword) {
      setError("请先输入地点名称")
      setStatus(null)
      return
    }

    setMapLoading(true)
    setError(null)
    setStatus(null)

    try {
      const AMap = await loadAmap()
      await ensureAmapPlugin(AMap, ["AMap.Geocoder"])
      const location = await new Promise<{ lat: string; lng: string }>((resolve, reject) => {
        const geocoder =
          geocoderRef.current ??
          new AMap.Geocoder({
            city: "全国",
          })
        geocoderRef.current = geocoder
        geocoder.getLocation(keyword, (status: string, result: any) => {
          if (status !== "complete" || !result?.geocodes?.length) {
            reject(new Error("未找到该地点，请尝试更完整的名称"))
            return
          }
          const first = result.geocodes[0]
          const lng = first.location?.lng
          const lat = first.location?.lat
          if (typeof lat !== "number" || typeof lng !== "number") {
            reject(new Error("地点解析结果缺少坐标"))
            return
          }
          resolve({ lat: lat.toFixed(6), lng: lng.toFixed(6) })
        })
      })

      onChange({ latitude: location.lat, longitude: location.lng })
      const marker = markerRef.current
      const map = mapRef.current
      if (marker && map) {
        const position: [number, number] = [Number(location.lng), Number(location.lat)]
        marker.show?.()
        marker.setPosition(position)
        map.setZoomAndCenter?.(13, position)
      }
      lastSyncedCoordinateRef.current = `${location.lat},${location.lng}`
      onLocationTextChange(keyword)
      setStatus(`已定位到“${keyword}”`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "地点定位失败")
    } finally {
      setMapLoading(false)
    }
  }, [locationText, onChange, onLocationTextChange])

  return (
    <div className="gallery-location-picker">
      <div className="gallery-location-toolbar">
        <label className="gallery-location-query">
          <Input
            value={locationText}
            onChange={(event) => onLocationTextChange(event.target.value)}
            aria-label="地点定位输入"
            placeholder="输入地点、地址或博物馆名称…"
          />
        </label>
        <Button
          htmlType="button"
          type="default"
          onClick={() => void handleResolveLocation()}
          disabled={mapLoading}
        >
          <Search size={14} aria-hidden="true" />
          <span>{mapLoading ? "定位中…" : "地点定位"}</span>
        </Button>
      </div>
      <div className="gallery-location-map-shell">
        <div ref={mapContainerRef} className="gallery-location-map" />
        {mapLoading ? <div className="gallery-location-map-overlay">地图处理中…</div> : null}
        {error ? <div className="gallery-location-map-overlay error">{error}</div> : null}
      </div>
      <div className="gallery-location-meta">
        <p className="field-help">可输入地点自动解析坐标，或直接在地图上点击选点。</p>
        {status ? <p className="field-help">{status}</p> : null}
      </div>
    </div>
  )
}

export default function Gallery({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { message } = AntApp.useApp()
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [items, setItems] = useState<GalleryArtifact[]>([])
  const [museumOptions, setMuseumOptions] = useState<MuseumOption[]>([])
  const [eraOptions, setEraOptions] = useState<EraOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<GalleryArtifact | null>(null)
  const [artifactRouteId, setArtifactRouteId] = useState<number | null>(getGalleryArtifactIdFromLocation)
  const [activeImageIndex, setActiveImageIndex] = useState(0)
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<GalleryEditFormState | null>(null)
  const [historicalExhibitions, setHistoricalExhibitions] = useState<HistoricalExhibitionDraft[]>([])
  const [draggedImageId, setDraggedImageId] = useState<number | null>(null)
  const activeImageIndexById = new Map(
    (active?.images ?? []).map((image, index) => [image.id, index]),
  )
  const [advancedEditingOpen, setAdvancedEditingOpen] = useState(false)
  const [tagInput, setTagInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [generatingDescription, setGeneratingDescription] = useState(false)
  const [descriptionProgress, setDescriptionProgress] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const thumbnailStripRef = useRef<HTMLDivElement | null>(null)

  const fetchJson = useCallback(async <T,>(input: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(input, init)
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const payload = (await response.json()) as { detail?: string }
        if (payload.detail) {
          message = payload.detail
        }
      } catch {
        // Ignore non-JSON error bodies.
      }
      throw new Error(message)
    }
    return (await response.json()) as T
  }, [])

  const load = useCallback(
    async (q: string) => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (q.trim()) params.set("q", q.trim())
        const res = await fetch(`${apiBaseUrl}/api/artifacts?${params.toString()}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const payload = (await res.json()) as RawGalleryArtifact[]
        setItems(mergeGalleryArtifacts(payload.map(normalizeArtifact)))
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载失败")
      } finally {
        setLoading(false)
      }
    },
    [apiBaseUrl],
  )

  useEffect(() => {
    void load("")
  }, [load])

  useEffect(() => {
    const syncRoute = () => {
      const routeId = getGalleryArtifactIdFromLocation()
      setArtifactRouteId(routeId)
      if (routeId === null) setActive(null)
    }
    window.addEventListener("popstate", syncRoute)
    return () => window.removeEventListener("popstate", syncRoute)
  }, [])

  useEffect(() => {
    if (artifactRouteId === null) return
    const requestedArtifact = items.find((item) => item.id === artifactRouteId)
    if (!requestedArtifact) return
    const timer = window.setTimeout(() => setActive(requestedArtifact), 0)
    return () => window.clearTimeout(timer)
  }, [artifactRouteId, items])

  useEffect(() => {
    void (async () => {
      try {
        const [museums, eras] = await Promise.all([
          fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?limit=200`),
          fetchJson<EraOption[]>(`${apiBaseUrl}/api/era-options`),
        ])
        setMuseumOptions(normalizeMuseumOptions(museums))
        setEraOptions(eras)
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载联想选项失败")
      }
    })()
  }, [apiBaseUrl, fetchJson])

  useEffect(() => {
    setEditing(false)
    setEditForm(null)
    setAdvancedEditingOpen(false)
    setTagInput("")
    setSaveError(null)
    setSaveNotice(null)
    setGeneratingDescription(false)
    setDescriptionProgress(null)
    setImagePreviewOpen(false)
    if (!active) return
    setActiveImageIndex(0)
  }, [active?.id])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")

      if (isEditableTarget) return
      if (event.key === "Escape") {
        if (imagePreviewOpen) {
          setImagePreviewOpen(false)
          return
        }
        if (!editing) navigateToGallery()
        return
      }
      if (editing || active.images.length < 2) return
      if (event.key === "ArrowRight") {
        event.preventDefault()
        setActiveImageIndex((current) => (current + 1) % active.images.length)
        return
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        setActiveImageIndex((current) => (current - 1 + active.images.length) % active.images.length)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [active, editing, imagePreviewOpen])

  useEffect(() => {
    if (!active || active.images.length < 2) return

    const imageIndexes =
      active.images.length <= 8
        ? active.images.map((_, index) => index)
        : [
            (activeImageIndex - 1 + active.images.length) % active.images.length,
            (activeImageIndex + 1) % active.images.length,
          ]

    imageIndexes
      .filter((index) => index !== activeImageIndex)
      .forEach((index) => {
        const preloadImage = new window.Image()
        preloadImage.src = getBackendImageVariantUrl(apiBaseUrl, active.images[index].url, 1280)
      })
  }, [active, activeImageIndex, apiBaseUrl])

  useEffect(() => {
    const activeThumbnail = thumbnailStripRef.current?.querySelector<HTMLElement>(
      `[data-image-index="${activeImageIndex}"]`,
    )
    activeThumbnail?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active?.id, activeImageIndex])

  function handleSearch(event: { preventDefault(): void }) {
    event.preventDefault()
    setSubmittedQuery(query)
    void load(query)
  }

  function navigateToArtifact(artifact: GalleryArtifact) {
    const nextPath = `/gallery/${artifact.id}`
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath)
    }
    setArtifactRouteId(artifact.id)
    setActive(artifact)
    window.scrollTo(0, 0)
  }

  function navigateToGallery() {
    const returnTarget = getGalleryReturnTarget()
    if (window.location.pathname !== returnTarget.path || window.location.search) {
      window.history.pushState({}, "", returnTarget.path)
    }
    setArtifactRouteId(null)
    setActive(null)
  }

  function handleStartEdit(event?: { preventDefault?: () => void; stopPropagation?: () => void }) {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (!active) {
      return
    }
    const image = active.images[activeImageIndex] ?? active.images[0] ?? null
    setEditForm(buildEditForm(active, image))
    setHistoricalExhibitions(active.images.map((item) => {
      const sameNameExhibitions = active.exhibitions.filter((candidate) => (
        normalizeLookupText(candidate.name) === normalizeLookupText(item.exhibition_name)
      ))
      const exhibition = active.exhibitions.find((candidate) => (
        candidate.id === item.exhibition_id
        || (
          normalizeLookupText(candidate.museum_name) === normalizeLookupText(item.capture_museum_name)
          && normalizeLookupText(candidate.name) === normalizeLookupText(item.exhibition_name)
        )
      )) ?? (sameNameExhibitions.length === 1 ? sameNameExhibitions[0] : undefined)
      return {
        imageId: item.id,
        artifactId: item.artifact_id ?? active.id,
        captureMuseumName: isFloorLabel(item.capture_museum_name) ? active.museum_name : item.capture_museum_name ?? active.museum_name,
        exhibitionName: item.exhibition_name ?? "常设",
        catalogSourceId: item.catalog_exhibition_source_id ?? exhibition?.catalog_source_id ?? "",
        catalogExhibitionId: item.catalog_exhibition_id ?? exhibition?.catalog_exhibition_id ?? null,
        startAt: exhibition?.start_at ?? null,
        endAt: exhibition?.end_at ?? null,
      }
    }))
    setTagInput("")
    setSaveError(null)
    setSaveNotice(null)
    setDescriptionProgress(null)
    setAdvancedEditingOpen(false)
    setEditing(true)
  }

  function handleCancelEdit() {
    setEditing(false)
    setEditForm(null)
    setAdvancedEditingOpen(false)
    setTagInput("")
    setSaveError(null)
    setDescriptionProgress(null)
  }

  function handleAddHistoricalExhibition() {
    if (!active) return
    const image = active.images[activeImageIndex]
    if (!image) return
    const existing = historicalExhibitions.find((item) => item.imageId === image.id)
    if (existing && !existing.captureMuseumName.trim() && !existing.exhibitionName.trim()) {
      message.info(`图${activeImageIndex + 1}已在新增展览行中`)
      return
    }
    const blankRecord: HistoricalExhibitionDraft = {
      imageId: image.id,
      artifactId: image.artifact_id ?? active.id,
      captureMuseumName: "",
      exhibitionName: "",
      catalogSourceId: "",
      catalogExhibitionId: null,
      startAt: null,
      endAt: null,
    }
    setHistoricalExhibitions((current) => (
      current.some((item) => item.imageId === image.id)
        ? current.map((item) => item.imageId === image.id ? blankRecord : item)
        : [...current, blankRecord]
    ))
    setSaveError(null)
    setSaveNotice(`已为图${activeImageIndex + 1}新增展览行，请选择场馆和展览`)
  }

  async function handleGenerateDescription(
    event?: { preventDefault?: () => void; stopPropagation?: () => void },
  ) {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (!active || generatingDescription) {
      return
    }

    const image = active.images[activeImageIndex] ?? active.images[0] ?? null
    const targetForm = editForm ?? buildEditForm(active, image)
    if (!targetForm.name.trim()) {
      setSaveError("请先填写文物名称")
      return
    }
    if (!editForm) {
      setEditForm(targetForm)
      setTagInput("")
      setEditing(true)
    }

    setGeneratingDescription(true)
    setDescriptionProgress("正在整理资料并生成描述，这不会影响已经入库的图片…")
    setSaveError(null)
    setSaveNotice(null)

    try {
      const form = new FormData()
      form.append("museum_name", targetForm.museumName.trim())
      form.append("name", targetForm.name.trim())
      form.append("era", targetForm.era.trim())
      form.append("Place_of_Excavation", targetForm.Place_of_Excavation.trim())
      const response = await fetch(`${apiBaseUrl}/api/artifacts/generate-description-stream-file`, {
        method: "POST",
        body: form,
      })
      if (!response.ok || !response.body) {
        throw new Error(`生成描述失败（HTTP ${response.status}）`)
      }

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
          const payload = JSON.parse(line.slice(5).trim()) as {
            type: string
            message?: string
            result?: GeneratedDescription
          }
          if (payload.message) setDescriptionProgress(payload.message)
          if (payload.type === "result" && payload.result) generated = payload.result
        }
      }
      if (!generated) {
        throw new Error("模型未返回可用描述")
      }

      const preferred =
        generated.candidates?.find(
          (candidate) =>
            candidate.status === "success" &&
            candidate.provider === generated.provider &&
            candidate.model === generated.model,
        )?.description ||
        generated.candidates?.find((candidate) => candidate.status === "success")?.description ||
        generated.description
      if (!preferred.trim()) {
        throw new Error("模型返回的描述为空")
      }

      setEditForm((current) => current ? { ...current, description: preferred } : current)
      setDescriptionProgress(`已由 ${generated.provider} / ${generated.model} 生成，请检查后保存`)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "生成描述失败")
      setDescriptionProgress(null)
    } finally {
      setGeneratingDescription(false)
    }
  }

  function addTags(rawValue: string) {
    if (!editForm) {
      return
    }
    const nextTags = normalizeTags(rawValue.split(/[,\n，、；;]/).map((tag) => tag.trim()))
    if (nextTags.length === 0) {
      return
    }
    setEditForm((current) =>
      current
        ? {
            ...current,
            tags: normalizeTags([...current.tags, ...nextTags]),
          }
        : current,
    )
    setTagInput("")
  }

  function removeTag(tagToRemove: string) {
    setEditForm((current) =>
      current
        ? {
            ...current,
            tags: current.tags.filter((tag) => tag !== tagToRemove),
          }
        : current,
    )
  }

  const handleCoordinateChange = useCallback((next: { latitude: string; longitude: string }) => {
    setEditForm((current) => (current ? { ...current, latitude: next.latitude, longitude: next.longitude } : current))
  }, [])

  const handleLocationTextChange = useCallback((next: string) => {
    setEditForm((current) => (current ? { ...current, captureLocation: next } : current))
  }, [])

  async function handleSave(event: { preventDefault(): void }) {
    event.preventDefault()
    if (!active || !editForm) {
      return
    }

    const historyByImageId = new Map(historicalExhibitions.map((record) => [record.imageId, record]))
    const incompleteImageNumbers = active.images.flatMap((image, index) => {
      const history = historyByImageId.get(image.id)
      return history?.captureMuseumName.trim() && history.exhibitionName.trim()
        ? []
        : [index + 1]
    })
    if (incompleteImageNumbers.length > 0) {
      const errorMessage = `图${incompleteImageNumbers.join("、图")}缺少展出场馆或展览，无法保存`
      setSaveError(errorMessage)
      message.error(errorMessage)
      return
    }

    setSaving(true)
    setSaveError(null)
    setSaveNotice(null)

    try {
      if (!editForm.museumName.trim()) {
        throw new Error("请填写或确认博物馆名称")
      }
      if (!editForm.name.trim()) {
        throw new Error("请填写或确认文物名称")
      }

      // Merged historical cards can contain images that belong to a different
      // underlying artifact record. Update the record that owns the selected
      // image, otherwise the cloud correctly rejects the image_id with 404.
      const selectedImage = editForm.imageId === null
        ? null
        : active.images.find((image) => image.id === editForm.imageId) ?? null
      const targetArtifactId = selectedImage?.artifact_id ?? active.id
      const buildImageUpdatePayload = (image: GalleryImage, isSelected: boolean) => {
        const history = historyByImageId.get(image.id)
        return {
          museum_name: editForm.museumName.trim(),
          name: editForm.name.trim(),
          era: editForm.era.trim() || null,
          Place_of_Excavation: editForm.Place_of_Excavation.trim() || null,
          description: editForm.description.trim() || null,
          tags: editForm.tags,
          image_id: image.id,
          camera_model: isSelected ? editForm.cameraModel.trim() || null : image.camera_model ?? null,
          lens_model: isSelected ? editForm.lensModel.trim() || null : image.lens_model ?? null,
          capture_museum_name: history?.captureMuseumName.trim() || image.capture_museum_name || null,
          exhibition_name: history ? history.exhibitionName.trim() || null : null,
          catalog_exhibition_source_id: history?.catalogSourceId || null,
          catalog_exhibition_id: history?.catalogExhibitionId ?? null,
          capture_location: isSelected ? editForm.captureLocation.trim() || null : image.capture_location ?? null,
          latitude: isSelected ? parseOptionalNumber(editForm.latitude, "纬度") : image.latitude ?? null,
          longitude: isSelected ? parseOptionalNumber(editForm.longitude, "经度") : image.longitude ?? null,
          captured_at: isSelected ? editForm.capturedAt.trim() || null : image.captured_at ?? null,
          shutter_speed: isSelected ? editForm.shutterSpeed.trim() || null : image.shutter_speed ?? null,
          aperture: isSelected ? editForm.aperture.trim() || null : image.aperture ?? null,
          iso: isSelected ? parseOptionalNumber(editForm.iso, "ISO") : image.iso ?? null,
          edit_method: isSelected ? editForm.editMethod || null : image.edit_method ?? null,
        }
      }
      const primaryImage = selectedImage ?? active.images[0] ?? null
      if (primaryImage === null) throw new Error("这件文物没有可编辑的图片")
      const response = await fetch(`${apiBaseUrl}/api/artifacts/${targetArtifactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildImageUpdatePayload(primaryImage, true)),
      })
      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const payload = (await response.json()) as { detail?: string }
          if (payload.detail) {
            message = payload.detail
          }
        } catch {
          // Ignore non-JSON error bodies.
        }
        throw new Error(message)
      }

      const otherImages = active.images.filter((image) => image.id !== primaryImage.id)
      for (const image of otherImages) {
        const historyResponse = await fetch(`${apiBaseUrl}/api/artifacts/${image.artifact_id ?? active.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildImageUpdatePayload(image, false)),
        })
        if (!historyResponse.ok) throw new Error(`第 ${active.images.findIndex((item) => item.id === image.id) + 1} 张图的历史展出保存失败`)
      }

      await response.json()
      const refreshParams = new URLSearchParams({ q: editForm.name.trim() })
      const refreshResponse = await fetch(`${apiBaseUrl}/api/artifacts?${refreshParams.toString()}`)
      if (!refreshResponse.ok) throw new Error("修改已保存，但刷新详情失败")
      const refreshedItems = mergeGalleryArtifacts(
        ((await refreshResponse.json()) as RawGalleryArtifact[]).map(normalizeArtifact),
      )
      const refreshedActive = refreshedItems.find((item) => (
        item.images.some((image) => active.images.some((previous) => previous.id === image.id))
      ))
      if (!refreshedActive) throw new Error("修改已保存，但未找到刷新后的文物")
      setItems((current) => mergeGalleryArtifacts([
        ...current.filter((item) => item.id !== active.id),
        refreshedActive,
      ]))
      setActive(refreshedActive)
      const nextIndex = refreshedActive.images.findIndex((image) => image.id === primaryImage.id)
      setActiveImageIndex(nextIndex >= 0 ? nextIndex : 0)
      setEditing(false)
      setEditForm(null)
      setTagInput("")
      setSaveNotice("已保存修改")
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="gallery-workbench" aria-labelledby="gallery-page-title">
      {!active ? (
        <>
      <header className="gallery-page-head">
        <div className="gallery-page-copy">
          <h2 id="gallery-page-title">图库</h2>
          {!loading ? <span className="gallery-result-count">{items.length} 件</span> : null}
        </div>
        <form className="gallery-search" role="search" onSubmit={handleSearch}>
        <Input
          prefix={<Search size={16} aria-hidden="true" />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、时代、馆藏或出土地点…"
          aria-label="图库搜索"
          name="gallery-search"
          autoComplete="off"
        />
        </form>
      </header>

      {error ? <p className="error-text">{error}</p> : null}

      {!loading && items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">🏺</span>
          <strong>{submittedQuery ? "没有匹配的文物" : "图库为空"}</strong>
          <p className="muted">
            {submittedQuery ? "换个关键词试试。" : "提交入库后，文物会显示在这里。"}
          </p>
        </div>
      ) : null}

      <div className="gallery-grid">
        {items.map((artifact) => {
          const cover = artifact.images[0]
          return (
            <button data-ui="interactive-surface"
              type="button"
              key={artifact.id}
              className="gallery-card"
              onClick={() => navigateToArtifact(artifact)}
            >
              <div className="gallery-thumb">
                {cover ? (
                  <FallbackImage
                    src={getBackendImageVariantUrl(apiBaseUrl, cover.url, 480)}
                    fallbackSrc={toAbsoluteUrl(apiBaseUrl, cover.url)}
                    alt={artifact.name}
                    width={480}
                    height={360}
                    loading="lazy"
                  />
                ) : (
                  <span className="gallery-noimg">无图</span>
                )}
              </div>
              <div className="gallery-meta">
                <strong className="gallery-title">{artifact.name}</strong>
                <div className="gallery-card-meta-row">
                  <span className="gallery-card-context">
                    {artifact.era || "待确认"} · {artifact.museum_name || "待识别"}
                  </span>
                  <span className="gallery-card-image-count">
                    <Images size={13} aria-hidden="true" />
                    <span>{artifact.images.length} 张</span>
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

        </>
      ) : null}

      {active
        ? (
            <article
                className={`gallery-detail-page gallery-modal-body ${editing ? "is-editing" : "is-reading"}`}
                aria-labelledby={`gallery-detail-title-${active.id}`}
              >
                {(() => {
                  const currentImage = active.images[activeImageIndex] ?? active.images[0] ?? null
                  const editFormId = `gallery-edit-form-${active.id}`
                  const subjectTags = getSubjectTags(active.tags)
                  const capturedAt = formatMetaDate(currentImage?.captured_at)
                  const uploadedAt = formatMetaDate(currentImage?.uploaded_at)
                  const shutterSpeed = formatMetaValue(currentImage?.shutter_speed)
                  const aperture = formatMetaValue(currentImage?.aperture)
                  const iso = formatMetaValue(currentImage?.iso)
                  return (
                    <>
                      <div className={`gallery-modal-media ${currentImage ? "has-image" : ""}`}>
                        {currentImage ? (
                          <>
                            <button data-ui="interactive-surface"
                              type="button"
                              className="gallery-modal-main-stage"
                              onClick={() => setImagePreviewOpen(true)}
                              aria-label={`查看第 ${activeImageIndex + 1} 张原比例大图`}
                            >
                              <FallbackImage
                                key={currentImage.id}
                                className="gallery-modal-main-img"
                                src={getBackendImageVariantUrl(apiBaseUrl, currentImage.url, 1280)}
                                fallbackSrc={toAbsoluteUrl(apiBaseUrl, currentImage.url)}
                                alt={active.name}
                                width={1280}
                                height={960}
                              />
                            </button>
                            <div className="gallery-media-foot">
                              {active.images.length > 1 ? (
                                <>
                                  <div
                                    ref={thumbnailStripRef}
                                    className={`gallery-modal-thumbs ${editing ? "edit-lock" : ""}`}
                                  >
                                    {active.images.map((image, index) => (
                                      <button data-ui="interactive-surface"
                                        type="button"
                                        key={image.id}
                                        className={`gallery-modal-thumb ${index === activeImageIndex ? "active" : ""}`}
                                        data-image-index={index}
                                        onClick={() => setActiveImageIndex(index)}
                                        aria-label={`查看第 ${index + 1} 张`}
                                        disabled={editing || saving}
                                      >
                                        <FallbackImage
                                          src={getBackendImageVariantUrl(apiBaseUrl, image.url, 160)}
                                          alt={active.name}
                                          width={160}
                                          height={160}
                                          loading={active.images.length > 20 ? "lazy" : "eager"}
                                        />
                                      </button>
                                    ))}
                                  </div>
                                  <div className="gallery-media-aside">
                                    {currentImage ? (
                                      <span className="gallery-media-page-indicator">
                                        {activeImageIndex + 1} / {active.images.length}
                                      </span>
                                    ) : null}
                                  </div>
                                </>
                              ) : null}
                            </div>
                          </>
                        ) : (
                          <div className="gallery-modal-empty">暂无图片</div>
                        )}
                      </div>

                      <div className={`gallery-modal-info ${editing ? "is-editing" : "is-reading"}`}>
                        <div className="gallery-detail-head">
                          <div className="gallery-detail-heading">
                            <h3 id={`gallery-detail-title-${active.id}`} className="gallery-detail-title">{active.name}</h3>
                            
                          </div>
                          <div className="gallery-actions" onClick={(event) => event.stopPropagation()}>
                            {editing ? (
                              <>
                                <Button
                                  htmlType="button"
                                  type="default"
                                  onClick={handleCancelEdit}
                                  disabled={saving || generatingDescription}
                                >
                                  取消
                                </Button>
                                <Button
                                  htmlType="submit"
                                  type="primary"
                                  form={editFormId}
                                  disabled={saving || generatingDescription}
                                >
                                  {saving ? "保存中…" : generatingDescription ? "描述生成中…" : "保存"}
                                </Button>
                                <Button
                                  htmlType="button"
                                  type="text"
                                  shape="circle"
                                  onClick={navigateToGallery}
                                  disabled={editing}
                                  aria-label={editing ? "编辑中不可返回" : `返回${getGalleryReturnTarget().label}`}
                                >
                                  <ArrowLeft size={16} aria-hidden="true" />
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button htmlType="button" type="primary" onClick={handleStartEdit}>
                                  编辑资料
                                </Button>
                                <Button
                                  htmlType="button"
                                  type="text"
                                  shape="circle"
                                  onClick={navigateToGallery}
                                  disabled={editing}
                                  aria-label={editing ? "编辑中不可返回" : `返回${getGalleryReturnTarget().label}`}
                                >
                                  <ArrowLeft size={16} aria-hidden="true" />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>

                        {editing && editForm ? (
                          <form id={editFormId} className="gallery-edit-form" onSubmit={handleSave}>
                            <div className="gallery-edit-scroll">
                              <div className="form-fields">
                                <section className="form-section gallery-edit-section gallery-edit-section-basic">
                                  <div className="form-section-head gallery-edit-section-head">
                                    <h3><Building2 size={15} aria-hidden="true" /> 基本信息</h3>
                                  </div>
                                  <div className="form-section-body">
                                    <div className="field-row">
                                      <label className="field">
                                        <span>博物馆名称</span>
                                        <Input
                                          list="gallery-museum-options"
                                          value={editForm.museumName}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, museumName: event.target.value } : current,
                                            )
                                          }
                                          placeholder={
                                            museumOptions.length > 0 ? "输入或选择博物馆名称…" : "加载博物馆选项中…"
                                          }
                                        />
                                      </label>
                                      <label className="field">
                                        <span>文物名称</span>
                                        <Input
                                          value={editForm.name}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, name: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：如意云纹金盘…"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>时代</span>
                                        <AutoComplete
                                          value={editForm.era}
                                          options={eraOptions.map((era) => ({ value: era.name, label: era.name }))}
                                          filterOption={(input, option) =>
                                            String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
                                          }
                                          onChange={(value) =>
                                            setEditForm((current) =>
                                              current ? { ...current, era: value } : current,
                                            )
                                          }
                                          placeholder={eraOptions.length > 0 ? "输入或选择时代…" : "加载时代选项中…"}
                                        >
                                          <Input />
                                        </AutoComplete>
                                      </label>
                                      <label className="field">
                                        <span>出土地点</span>
                                        <Input
                                          value={editForm.Place_of_Excavation}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, Place_of_Excavation: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：陕西西安何家村…"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <div className="field gallery-tags-field">
                                        <span>历史展出（可直接逐条修改；把图片拖到目标展览）</span>
                                        <div className="gallery-history-editor">
                                          {groupHistoricalExhibitions(historicalExhibitions).map((group, index) => (
                                            <HistoricalExhibitionRow
                                              key={group.imageIds.slice().sort((left, right) => left - right).join("-")}
                                              activeImageId={active.images[activeImageIndex]?.id ?? null}
                                              apiBaseUrl={apiBaseUrl}
                                              draggedImageId={draggedImageId}
                                              group={group}
                                              imageIndexes={activeImageIndexById}
                                              index={index}
                                              museumOptions={museumOptions}
                                              onActivateImage={setActiveImageIndex}
                                              onSetDraggedImage={setDraggedImageId}
                                              onUpdate={(patch) => setHistoricalExhibitions((current) => current.map((item) => (
                                                group.imageIds.includes(item.imageId)
                                                  ? { ...item, ...patch }
                                                  : item
                                              )))}
                                              onDropImage={(imageId) => {
                                                setHistoricalExhibitions((current) => current.map((item) => (
                                                  item.imageId === imageId
                                                    ? {
                                                        ...item,
                                                        captureMuseumName: group.captureMuseumName,
                                                        exhibitionName: group.exhibitionName,
                                                        catalogSourceId: group.catalogSourceId,
                                                        catalogExhibitionId: group.catalogExhibitionId,
                                                        startAt: group.startAt,
                                                        endAt: group.endAt,
                                                      }
                                                    : item
                                                )))
                                                setDraggedImageId(null)
                                              }}
                                              onDelete={() => {
                                                setHistoricalExhibitions((current) => current.map((item) => (
                                                  group.imageIds.includes(item.imageId)
                                                    ? {
                                                        ...item,
                                                        captureMuseumName: "",
                                                        exhibitionName: "",
                                                        catalogSourceId: "",
                                                        catalogExhibitionId: null,
                                                        startAt: null,
                                                        endAt: null,
                                                      }
                                                    : item
                                                )))
                                                setSaveNotice("已删除该条展出记录，请为这些图片重新选择场馆和展览")
                                              }}
                                            />
                                          ))}
                                          <Button
                                            htmlType="button"
                                            type="text"
                                            size="small"
                                            className="gallery-history-add"
                                            icon={<Plus size={13} aria-hidden="true" />}
                                            onClick={handleAddHistoricalExhibition}
                                          >
                                            新增展览
                                            <span className="gallery-history-add-hint">
                                              （当前图{activeImageIndex + 1}）
                                            </span>
                                          </Button>
                                        </div>
                                      </div>
                                    </div>
                                    <div className="field-row">
                                      <label className="field gallery-tags-field">
                                        <span>标签</span>
                                        <div className="tag-editor">
                                          <div className="tag-editor-chips">
                                            {editForm.tags.map((tag) => (
                                              <Tag key={tag} closable onClose={() => removeTag(tag)}>
                                                {tag}
                                              </Tag>
                                            ))}
                                          </div>
                                          <Input
                                            className="tag-editor-input"
                                            value={tagInput}
                                            onChange={(event) => setTagInput(event.target.value)}
                                            onKeyDown={(event) => {
                                              if (event.key === "Enter" || event.key === "," || event.key === "，") {
                                                event.preventDefault()
                                                addTags(tagInput)
                                              }
                                              if (
                                                event.key === "Backspace" &&
                                                !tagInput &&
                                                editForm.tags.length > 0
                                              ) {
                                                removeTag(editForm.tags[editForm.tags.length - 1])
                                              }
                                            }}
                                            onBlur={() => addTags(tagInput)}
                                            placeholder="输入后回车或逗号添加…"
                                          />
                                        </div>
                                      </label>
                                    </div>
                                    <label className="field gallery-edit-description-field">
                                      <span className="gallery-description-editor-head">
                                        <span>描述</span>
                                        <Button
                                          htmlType="button"
                                          type="default"
                                          size="small"
                                          onClick={(event) => void handleGenerateDescription(event)}
                                          disabled={generatingDescription || saving}
                                        >
                                          <Sparkles size={13} aria-hidden="true" />
                                          {generatingDescription ? "AI 生成中…" : "AI 补充描述"}
                                        </Button>
                                      </span>
                                      <Textarea
                                        rows={4}
                                        value={editForm.description}
                                        onChange={(event) =>
                                          setEditForm((current) =>
                                            current ? { ...current, description: event.target.value } : current,
                                          )
                                        }
                                        placeholder="文物简介，可补充或修正…"
                                      />
                                      {descriptionProgress ? (
                                        <span className="field-help" aria-live="polite">{descriptionProgress}</span>
                                      ) : null}
                                    </label>
                                  </div>
                                </section>

                                <section className="form-section gallery-edit-section gallery-edit-section-capture">
                                  <div className="form-section-head gallery-edit-section-head">
                                    <h3><Camera size={15} aria-hidden="true" /> 拍摄信息</h3>
                                  </div>
                                  <div className="form-section-body">
                                    <div className="field-row">
                                      <label className="field">
                                        <span>机型</span>
                                        <Input
                                          value={editForm.cameraModel}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, cameraModel: event.target.value } : current,
                                            )
                                          }
                                          placeholder="自动读取后可补充修正…"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>镜头</span>
                                        <Input
                                          value={editForm.lensModel}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, lensModel: event.target.value } : current,
                                            )
                                          }
                                          placeholder="自动读取后可补充修正…"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>拍摄时间</span>
                                        <Input
                                          value={editForm.capturedAt}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, capturedAt: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：2024-05-01T14:30:00…"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>修图方式</span>
                                        <Select
                                          allowClear
                                          placeholder="未填写…"
                                          value={editForm.editMethod || undefined}
                                          options={[
                                            { value: "简单调整", label: "简单调整" },
                                            { value: "堆栈合成", label: "堆栈合成" },
                                          ]}
                                          onChange={(value) =>
                                            setEditForm((current) =>
                                              current ? { ...current, editMethod: value ?? "" } : current,
                                            )
                                          }
                                        />
                                      </label>
                                    </div>
                                    <details
                                      className="gallery-advanced-details"
                                      open={advancedEditingOpen}
                                      onToggle={(event) => setAdvancedEditingOpen(event.currentTarget.open)}
                                    >
                                      <summary className="gallery-advanced-summary">
                                        <span>更多拍摄信息</span>
                                        <span className="gallery-advanced-hint">坐标与曝光参数</span>
                                      </summary>
                                      {advancedEditingOpen ? <div className="gallery-advanced-body">
                                        <GalleryLocationPicker
                                          latitude={editForm.latitude}
                                          longitude={editForm.longitude}
                                          locationText={editForm.captureLocation}
                                          onChange={handleCoordinateChange}
                                          onLocationTextChange={handleLocationTextChange}
                                        />
                                        <div className="field-row gallery-coordinate-grid">
                                          <label className="field">
                                            <span>纬度</span>
                                            <Input
                                              value={editForm.latitude}
                                              onChange={(event) =>
                                                setEditForm((current) =>
                                                  current ? { ...current, latitude: event.target.value } : current,
                                                )
                                              }
                                              placeholder="例如：32.060255…"
                                            />
                                          </label>
                                          <label className="field">
                                            <span>经度</span>
                                            <Input
                                              value={editForm.longitude}
                                              onChange={(event) =>
                                                setEditForm((current) =>
                                                  current ? { ...current, longitude: event.target.value } : current,
                                                )
                                              }
                                              placeholder="例如：118.796877…"
                                            />
                                          </label>
                                        </div>
                                        <div className="gallery-exposure-grid">
                                          <label className="field">
                                            <span>快门</span>
                                            <Input
                                              value={editForm.shutterSpeed}
                                              onChange={(event) =>
                                                setEditForm((current) =>
                                                  current ? { ...current, shutterSpeed: event.target.value } : current,
                                                )
                                              }
                                              placeholder="例如：1/125s…"
                                            />
                                          </label>
                                          <label className="field">
                                            <span>光圈</span>
                                            <Input
                                              value={editForm.aperture}
                                              onChange={(event) =>
                                                setEditForm((current) =>
                                                  current ? { ...current, aperture: event.target.value } : current,
                                                )
                                              }
                                              placeholder="例如：f/2.8…"
                                            />
                                          </label>
                                          <label className="field">
                                            <span>ISO</span>
                                            <Input
                                              value={editForm.iso}
                                              onChange={(event) =>
                                                setEditForm((current) =>
                                                  current ? { ...current, iso: event.target.value } : current,
                                                )
                                              }
                                              placeholder="例如：400…"
                                            />
                                          </label>
                                          <div className="field">
                                            <span>上传时间</span>
                                            <Input value={uploadedAt} readOnly placeholder="暂无记录…" />
                                          </div>
                                        </div>
                                      </div> : null}
                                    </details>
                                  </div>
                                </section>
                              </div>
                            </div>
                            {saveError ? (
                              <div className="form-footer gallery-form-footer">
                                <div className="gallery-form-status">
                                  <p className="error-text">{saveError}</p>
                                </div>
                              </div>
                            ) : null}
                          </form>
                        ) : (
                          <div className="gallery-detail-lines">
                            {saveNotice ? <p className="success-text gallery-save-notice">{saveNotice}</p> : null}
                            <section className="gallery-info-section">
                              <div className="gallery-info-grid">
                                <div className="gallery-info-item">
                                  <span className="gallery-info-label">
                                    <History size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>时代</span>
                                  </span>
                                  <span className="gallery-info-value">{active.era || "待确认"}</span>
                                </div>
                                <div className="gallery-info-item">
                                  <span className="gallery-info-label">
                                    <Building2 size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>馆藏</span>
                                  </span>
                                  <span className="gallery-info-value">{active.museum_name || "待识别"}</span>
                                </div>
                                {capturedAt ? (
                                  <div className="gallery-info-item gallery-info-item-wide">
                                    <span className="gallery-info-label">
                                      <Clock3 size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                      <span>拍摄时间</span>
                                    </span>
                                    <span className="gallery-info-value">{capturedAt}</span>
                                  </div>
                                ) : null}
                                <div className="gallery-info-item gallery-info-item-wide">
                                  <span className="gallery-info-label">
                                    <MapPin size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>出土地点</span>
                                  </span>
                                  <span className="gallery-info-value">{active.Place_of_Excavation || "待补充"}</span>
                                </div>
                                {subjectTags.length > 0 ? (
                                <div className="gallery-info-item gallery-info-item-wide">
                                  <span className="gallery-info-label">
                                    <TagIcon size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>标签</span>
                                  </span>
                                  <div className="gallery-badge-row">
                                    {subjectTags.map((tag) => (
                                      <Tag key={tag}>{tag}</Tag>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                              {active.exhibitions.length > 0 ? (
                                <div className="gallery-info-item gallery-info-item-wide">
                                  <span className="gallery-info-label">
                                    <CalendarRange size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>历史展出</span>
                                  </span>
                                  <div className="gallery-badge-row">
                                    {active.exhibitions.map((exhibition) => {
                                      const exhibitionMuseumName = isFloorLabel(exhibition.museum_name)
                                        ? active.museum_name
                                        : exhibition.museum_name
                                      const label = (
                                        <>
                                          {exhibitionMuseumName} · {exhibition.name}
                                          {` · ${formatExhibitionPeriod(exhibition.start_at, exhibition.end_at, exhibition.name)}`}
                                        </>
                                      )
                                      const detailPath = exhibition.catalog_source_id
                                        ? `/exhibitions/source/${encodeURIComponent(exhibition.catalog_source_id)}`
                                        : exhibition.catalog_exhibition_id
                                          ? `/exhibitions/${exhibition.catalog_exhibition_id}`
                                          : `/exhibitions/history/${encodeURIComponent(exhibition.name)}?${new URLSearchParams({
                                              museum: exhibitionMuseumName,
                                            }).toString()}`
                                      return (
                                        <a key={exhibition.id} className="gallery-exhibition-link" href={detailPath}>{label}</a>
                                      )
                                    })}
                                  </div>
                                </div>
                              ) : null}
                              </div>
                            </section>
                            {(currentImage?.camera_model || currentImage?.lens_model || shutterSpeed || aperture || iso) ? (
                              <section className="gallery-info-section gallery-camera-card">
                                <header className="gallery-info-section-head">
                                  <div className="gallery-card-title">
                                    <SlidersHorizontal size={15} aria-hidden="true" />
                                    <span>相机参数</span>
                                  </div>
                                </header>
                                <div className="gallery-camera-grid">
                                  {currentImage?.camera_model ? (
                                    <div className="gallery-camera-item">
                                      <span className="gallery-info-label">
                                        <Camera size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                        <span>相机</span>
                                      </span>
                                      <span className="gallery-info-value">{currentImage.camera_model}</span>
                                    </div>
                                  ) : null}
                                  {currentImage?.lens_model ? (
                                    <div className="gallery-camera-item gallery-camera-item-lens">
                                      <span className="gallery-info-label">
                                        <CircleDot size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                        <span>镜头</span>
                                      </span>
                                      <span className="gallery-info-value">{currentImage.lens_model}</span>
                                    </div>
                                  ) : null}
                                  {shutterSpeed ? (
                                    <div className="gallery-camera-item">
                                      <span className="gallery-info-label">
                                        <Timer size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                        <span>快门</span>
                                      </span>
                                      <span className="gallery-info-value">{shutterSpeed}</span>
                                    </div>
                                  ) : null}
                                  {aperture ? (
                                    <div className="gallery-camera-item">
                                      <span className="gallery-info-label">
                                        <Aperture size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                        <span>光圈</span>
                                      </span>
                                      <span className="gallery-info-value">{aperture}</span>
                                    </div>
                                  ) : null}
                                  {iso ? (
                                    <div className="gallery-camera-item">
                                      <span className="gallery-info-label">
                                        <Gauge size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                        <span>ISO</span>
                                      </span>
                                      <span className="gallery-info-value">{iso}</span>
                                    </div>
                                  ) : null}
                                </div>
                              </section>
                            ) : null}
                            <section className="gallery-info-section gallery-description-card">
                                <header className="gallery-info-section-head">
                                  <div className="gallery-card-title">
                                    <FileText size={15} aria-hidden="true" />
                                    <span>描述</span>
                                  </div>
                                </header>
                                <div>
                                  <p className="gallery-description-copy">{active.description || "暂未补充，可在闲暇时使用 AI 生成后检查保存。"}</p>
                                </div>
                            </section>
                          </div>
                        )}
                      </div>

                      {imagePreviewOpen && currentImage ? (
                        <GalleryImagePreview
                          open={imagePreviewOpen}
                          src={toAbsoluteUrl(apiBaseUrl, currentImage.url)}
                          alt={active.name}
                          onClose={() => setImagePreviewOpen(false)}
                        />
                      ) : null}
                    </>
                  )
                })()}
            </article>
          )
        : null}
      <datalist id="gallery-museum-options">
        {museumOptions.map((museum) => (
          <option key={museum.id} value={museum.name} />
        ))}
      </datalist>
    </section>
  )
}
