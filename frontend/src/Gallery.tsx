import { useCallback, useEffect, useRef, useState, type ImgHTMLAttributes } from "react"
import { createPortal } from "react-dom"
import { AutoComplete, Button, Input, Select, Tag } from "antd"
import "./styles/gallery.css"
import {
  Aperture,
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
  Search,
  SlidersHorizontal,
  Sparkles,
  Tag as TagIcon,
  Timer,
  X,
} from "lucide-react"
import GalleryImagePreview from "./GalleryImagePreview"

const Textarea = Input.TextArea

const AMAP_SCRIPT_ID = "museum-console-amap-script"
const AMAP_SECURITY_CODE = "3ba01835420271d5405dccba5e089b46"
const AMAP_SCRIPT_SRC =
  "https://webapi.amap.com/maps?v=1.4.15&key=7a9513e700e06c00890363af1bd2d926&plugin=AMap.ToolBar"

type GalleryImage = {
  id: number
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

type GalleryArtifact = {
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

type CatalogExhibitionOption = {
  id: number
  source_id: string
  title: string
  museum_name: string | null
  venue: string | null
  city: string
  start_date: string | null
  end_date: string | null
  is_permanent: boolean
}

type LocalExhibitionOption = {
  id: number
  museum_name: string
  name: string
  catalog_source_id: string | null
  catalog_exhibition_id: number | null
}

type GalleryExhibitionChoice = {
  key: string
  name: string
  museumName: string
  meta: string
  catalogSourceId: string
  catalogExhibitionId: number | null
}

type EraOption = {
  id: number
  name: string
  sort_order: number
}

function toAbsoluteUrl(apiBaseUrl: string, url: string) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${apiBaseUrl}${url}`
}

function getBackendImageVariantUrl(apiBaseUrl: string, url: string, size: number) {
  const params = new URLSearchParams({ url, size: String(size) })
  return `${apiBaseUrl}/api/image-variant?${params.toString()}`
}

function normalizeIdentityText(value: string | null | undefined) {
  const text = (value ?? "").trim().toLocaleLowerCase()
  return text || null
}

function compactArtifactNameForMatch(value: string | null | undefined) {
  const text = normalizeIdentityText(value)
  if (!text) return null
  const compact = text.replace(/[\s\-_·•,，.。:：;；/\\|()（）[\]【】<>《》"'“”‘’]+/g, "")
  return compact || null
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

function buildEditForm(artifact: GalleryArtifact, image?: GalleryImage | null): GalleryEditFormState {
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
    captureMuseumName: image?.capture_museum_name ?? "",
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

function GalleryExhibitionPicker({
  apiBaseUrl,
  museumName,
  selectedName,
  selectedSourceId,
  onSelect,
  onManualChange,
}: {
  apiBaseUrl: string
  museumName: string
  selectedName: string
  selectedSourceId: string
  onSelect: (choice: GalleryExhibitionChoice | null) => void
  onManualChange: (value: string) => void
}) {
  const [query, setQuery] = useState("")
  const [choices, setChoices] = useState<GalleryExhibitionChoice[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const keyword = query.trim()
    const museum = museumName.trim()
    if (!keyword && !museum) {
      setChoices([])
      setError(null)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const catalogParams = new URLSearchParams({
          include_facets: "false",
          page_size: "30",
        })
        catalogParams.set("q", keyword || museum)
        const localParams = new URLSearchParams({ limit: "100" })
        if (museum) localParams.set("museum_name", museum)
        if (keyword) localParams.set("q", keyword)

        const [catalogResponse, localResponse] = await Promise.all([
          fetch(`${apiBaseUrl}/api/exhibition-catalog?${catalogParams.toString()}`, {
            signal: controller.signal,
          }),
          fetch(`${apiBaseUrl}/api/exhibitions?${localParams.toString()}`, {
            signal: controller.signal,
          }),
        ])
        if (!catalogResponse.ok || !localResponse.ok) {
          throw new Error("展览联想加载失败")
        }
        const catalogPayload = (await catalogResponse.json()) as { items: CatalogExhibitionOption[] }
        const localPayload = (await localResponse.json()) as LocalExhibitionOption[]
        const museumKey = normalizeLookupText(museum)
        const catalogChoices: GalleryExhibitionChoice[] = catalogPayload.items.map((item) => ({
          key: `catalog:${item.source_id}`,
          name: item.title,
          museumName: item.museum_name ?? "",
          meta: [item.museum_name, item.venue, item.city, item.is_permanent ? "常设展" : null]
            .filter(Boolean)
            .join(" · "),
          catalogSourceId: item.source_id,
          catalogExhibitionId: item.id,
        }))
        const localChoices: GalleryExhibitionChoice[] = localPayload
          .filter((item) => (
            !museumKey
            || normalizeLookupText(item.museum_name).includes(museumKey)
            || museumKey.includes(normalizeLookupText(item.museum_name))
          ))
          .map((item) => ({
            key: item.catalog_source_id ? `catalog:${item.catalog_source_id}` : `local:${item.id}`,
            name: item.name,
            museumName: item.museum_name,
            meta: `${item.museum_name} · 已入库展览`,
            catalogSourceId: item.catalog_source_id ?? "",
            catalogExhibitionId: item.catalog_exhibition_id ?? null,
          }))

        const seen = new Set<string>()
        const combined = [...catalogChoices, ...localChoices]
          .sort((left, right) => {
            const leftMuseumMatch = museumKey && normalizeLookupText(left.museumName).includes(museumKey) ? 1 : 0
            const rightMuseumMatch = museumKey && normalizeLookupText(right.museumName).includes(museumKey) ? 1 : 0
            return rightMuseumMatch - leftMuseumMatch
          })
          .filter((choice) => {
            const identity = `${normalizeLookupText(choice.museumName)}:${normalizeLookupText(choice.name)}`
            if (seen.has(identity)) return false
            seen.add(identity)
            return true
          })
        setChoices(combined.slice(0, 30))
      } catch (nextError) {
        if (!controller.signal.aborted) {
          setChoices([])
          setError(nextError instanceof Error ? nextError.message : "展览联想加载失败")
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 240)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [apiBaseUrl, museumName, query])

  const options = choices.map((choice) => ({
    value: choice.key,
    label: (
      <span className="gallery-exhibition-option">
        <strong>{choice.name}</strong>
        <small>{choice.meta}</small>
      </span>
    ),
  }))
  if (selectedSourceId && !options.some((option) => option.value === `catalog:${selectedSourceId}`)) {
    options.unshift({
      value: `catalog:${selectedSourceId}`,
      label: (
        <span className="gallery-exhibition-option">
          <strong>{selectedName || "已关联展览"}</strong>
          <small>已保存的目录关联</small>
        </span>
      ),
    })
  }

  return (
    <div className="gallery-exhibition-picker">
      <Select
        allowClear
        showSearch
        filterOption={false}
        loading={loading}
        value={selectedSourceId ? `catalog:${selectedSourceId}` : undefined}
        options={options}
        placeholder={museumName.trim() ? "输入展名检索该馆及目录展览" : "请先填写拍摄馆"}
        popupMatchSelectWidth={420}
        notFoundContent={loading ? "正在检索…" : "没有匹配展览，可在下方手动填写"}
        onSearch={setQuery}
        onClear={() => onSelect(null)}
        onSelect={(key) => {
          const choice = choices.find((item) => item.key === key)
          if (choice) onSelect(choice)
        }}
      />
      <Input
        value={selectedName}
        placeholder="也可手动填写；再次匹配时会自动复用同名展览"
        onChange={(event) => onManualChange(event.target.value)}
      />
      {error ? <span className="field-help error">{error}</span> : null}
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
          <MapPin size={14} aria-hidden="true" />
          <Input
            value={locationText}
            onChange={(event) => onLocationTextChange(event.target.value)}
            aria-label="地点定位输入"
            placeholder="输入地点、地址或博物馆名称"
          />
        </label>
        <Button
          htmlType="button"
          type="default"
          onClick={() => void handleResolveLocation()}
          disabled={mapLoading}
        >
          <Search size={14} aria-hidden="true" />
          <span>{mapLoading ? "定位中..." : "地点定位"}</span>
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
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [items, setItems] = useState<GalleryArtifact[]>([])
  const [museumOptions, setMuseumOptions] = useState<MuseumOption[]>([])
  const [eraOptions, setEraOptions] = useState<EraOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<GalleryArtifact | null>(null)
  const [activeImageIndex, setActiveImageIndex] = useState(0)
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<GalleryEditFormState | null>(null)
  const [tagInput, setTagInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [generatingDescription, setGeneratingDescription] = useState(false)
  const [descriptionProgress, setDescriptionProgress] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const thumbnailStripRef = useRef<HTMLDivElement | null>(null)
  const requestedArtifactIdRef = useRef<number | null>((() => {
    const value = new URLSearchParams(window.location.search).get("artifact")
    const parsed = value ? Number(value) : Number.NaN
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  })())

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
    const requestedArtifactId = requestedArtifactIdRef.current
    if (requestedArtifactId === null || items.length === 0) return
    const requestedArtifact = items.find((item) => item.id === requestedArtifactId)
    requestedArtifactIdRef.current = null
    if (requestedArtifact) setActive(requestedArtifact)
  }, [items])

  useEffect(() => {
    void (async () => {
      try {
        const [museums, eras] = await Promise.all([
          fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?limit=200`),
          fetchJson<EraOption[]>(`${apiBaseUrl}/api/era-options`),
        ])
        setMuseumOptions(museums)
        setEraOptions(eras)
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载联想选项失败")
      }
    })()
  }, [apiBaseUrl, fetchJson])

  useEffect(() => {
    setEditing(false)
    setEditForm(null)
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
        if (!editing) setActive(null)
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
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = prevOverflow
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

  function handleStartEdit(event?: { preventDefault?: () => void; stopPropagation?: () => void }) {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (!active) {
      return
    }
    const image = active.images[activeImageIndex] ?? active.images[0] ?? null
    setEditForm(buildEditForm(active, image))
    setTagInput("")
    setSaveError(null)
    setSaveNotice(null)
    setDescriptionProgress(null)
    setEditing(true)
  }

  function handleCancelEdit() {
    setEditing(false)
    setEditForm(null)
    setTagInput("")
    setSaveError(null)
    setDescriptionProgress(null)
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

      const response = await fetch(`${apiBaseUrl}/api/artifacts/${active.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          museum_name: editForm.museumName.trim(),
          name: editForm.name.trim(),
          era: editForm.era.trim() || null,
          Place_of_Excavation: editForm.Place_of_Excavation.trim() || null,
          description: editForm.description.trim() || null,
          tags: editForm.tags,
          image_id: editForm.imageId,
          camera_model: editForm.cameraModel.trim() || null,
          lens_model: editForm.lensModel.trim() || null,
          capture_museum_name: editForm.captureMuseumName.trim() || null,
          exhibition_name: editForm.exhibitionName.trim() || "常设",
          catalog_exhibition_source_id: editForm.catalogExhibitionSourceId || null,
          catalog_exhibition_id: editForm.catalogExhibitionId,
          capture_location: editForm.captureLocation.trim() || null,
          latitude: parseOptionalNumber(editForm.latitude, "纬度"),
          longitude: parseOptionalNumber(editForm.longitude, "经度"),
          captured_at: editForm.capturedAt.trim() || null,
          shutter_speed: editForm.shutterSpeed.trim() || null,
          aperture: editForm.aperture.trim() || null,
          iso: parseOptionalNumber(editForm.iso, "ISO"),
          edit_method: editForm.editMethod || null,
        }),
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

      const updated = normalizeArtifact((await response.json()) as RawGalleryArtifact)
      const nextIndex =
        updated.images.findIndex((image) => image.id === editForm.imageId) >= 0
          ? updated.images.findIndex((image) => image.id === editForm.imageId)
          : 0
      let mergedUpdated = updated
      setItems((current) => {
        const mergedItems = mergeGalleryArtifacts([
          ...current.map((item) => (item.id === updated.id ? updated : item)),
          ...(current.some((item) => item.id === updated.id) ? [] : [updated]),
        ])
        mergedUpdated = mergedItems.find((item) => galleryArtifactMergeKey(item) === galleryArtifactMergeKey(updated)) ?? updated
        return mergedItems
      })
      setActive(mergedUpdated)
      setActiveImageIndex(Math.min(nextIndex, Math.max(mergedUpdated.images.length - 1, 0)))
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
      <header className="gallery-page-head">
        <div className="gallery-page-copy">
          <span className="page-kicker">COLLECTION ARCHIVE</span>
          <h2 id="gallery-page-title">文物图库</h2>
          <p>按名称、时代与馆藏快速检索图像档案。</p>
        </div>
        <form className="gallery-search" role="search" onSubmit={handleSearch}>
        <Input
          prefix={<Search size={16} aria-hidden="true" />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、时代、馆藏、出土地点或描述，按回车检索"
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
              onClick={() => setActive(artifact)}
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

      {active
        ? createPortal(
            <div className="gallery-modal" onClick={() => !editing && setActive(null)}>
              <div
                className={`gallery-modal-body ${editing ? "is-editing" : "is-reading"}`}
                onClick={(e) => e.stopPropagation()}
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
                            <h3 className="gallery-detail-title">{active.name}</h3>
                            
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
                                  {saving ? "保存中..." : generatingDescription ? "描述生成中..." : "保存"}
                                </Button>
                                <Button
                                  htmlType="button"
                                  type="text"
                                  shape="circle"
                                  onClick={() => !editing && setActive(null)}
                                  disabled={editing}
                                  aria-label={editing ? "编辑中不可关闭弹窗" : "关闭弹窗"}
                                >
                                  <X size={16} aria-hidden="true" />
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  htmlType="button"
                                  type="default"
                                  onClick={(event) => void handleGenerateDescription(event)}
                                  disabled={generatingDescription}
                                >
                                  <Sparkles size={14} aria-hidden="true" />
                                  {generatingDescription ? "生成中..." : "AI 补充描述"}
                                </Button>
                                <Button htmlType="button" type="primary" onClick={handleStartEdit}>
                                  编辑资料
                                </Button>
                                <Button
                                  htmlType="button"
                                  type="text"
                                  shape="circle"
                                  onClick={() => !editing && setActive(null)}
                                  disabled={editing}
                                  aria-label={editing ? "编辑中不可关闭弹窗" : "关闭弹窗"}
                                >
                                  <X size={16} aria-hidden="true" />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>

                        {editing && editForm ? (
                          <form id={editFormId} className="gallery-edit-form" onSubmit={handleSave}>
                            <div className="gallery-edit-scroll">
                              <div className="form-fields">
                                <section className="form-section">
                                  <div className="form-section-head">
                                    <h3>基本信息</h3>
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
                                            museumOptions.length > 0 ? "输入或选择博物馆名称" : "加载博物馆选项中..."
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
                                          placeholder="例如：如意云纹金盘"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>时代</span>
                                        <Input
                                          list="gallery-era-options"
                                          value={editForm.era}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, era: event.target.value } : current,
                                            )
                                          }
                                          placeholder={eraOptions.length > 0 ? "输入或选择时代" : "加载时代选项中..."}
                                        />
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
                                          placeholder="例如：陕西西安何家村"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>拍摄馆</span>
                                        <AutoComplete
                                          value={editForm.captureMuseumName}
                                          options={museumOptions.map((museum) => ({
                                            value: museum.name,
                                            label: museum.name,
                                          }))}
                                          filterOption={(input, option) => (
                                            normalizeLookupText(String(option?.value ?? "")).includes(
                                              normalizeLookupText(input),
                                            )
                                          )}
                                          onChange={(value) =>
                                            setEditForm((current) =>
                                              current ? {
                                                ...current,
                                                captureMuseumName: value,
                                                catalogExhibitionSourceId: "",
                                                catalogExhibitionId: null,
                                              } : current,
                                            )
                                          }
                                          onSelect={(value) =>
                                            setEditForm((current) =>
                                              current ? {
                                                ...current,
                                                captureMuseumName: value,
                                                captureLocation: current.captureLocation || value,
                                              } : current,
                                            )
                                          }
                                          placeholder="输入或选择标准场馆名称"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>展览</span>
                                        <GalleryExhibitionPicker
                                          apiBaseUrl={apiBaseUrl}
                                          museumName={editForm.captureMuseumName}
                                          selectedName={editForm.exhibitionName}
                                          selectedSourceId={editForm.catalogExhibitionSourceId}
                                          onSelect={(choice) =>
                                            setEditForm((current) =>
                                              current ? {
                                                ...current,
                                                exhibitionName: choice?.name ?? "常设",
                                                captureMuseumName: choice?.museumName || current.captureMuseumName,
                                                catalogExhibitionSourceId: choice?.catalogSourceId ?? "",
                                                catalogExhibitionId: choice?.catalogExhibitionId ?? null,
                                              } : current,
                                            )
                                          }
                                          onManualChange={(value) =>
                                            setEditForm((current) =>
                                              current ? {
                                                ...current,
                                                exhibitionName: value,
                                                catalogExhibitionSourceId: "",
                                                catalogExhibitionId: null,
                                              } : current,
                                            )
                                          }
                                        />
                                      </label>
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
                                            placeholder="输入后回车或逗号添加"
                                          />
                                        </div>
                                      </label>
                                    </div>
                                    <label className="field">
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
                                          {generatingDescription ? "AI 生成中..." : "AI 补充描述"}
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
                                        placeholder="文物简介，可补充或修正"
                                      />
                                      {descriptionProgress ? (
                                        <span className="field-help" aria-live="polite">{descriptionProgress}</span>
                                      ) : null}
                                    </label>
                                  </div>
                                </section>

                                <section className="form-section">
                                  <div className="form-section-head">
                                    <h3>拍摄信息</h3>
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
                                          placeholder="自动读取后可补充修正"
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
                                          placeholder="自动读取后可补充修正"
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
                                          placeholder="例如：2024-05-01T14:30:00"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>修图方式</span>
                                        <Select
                                          allowClear
                                          placeholder="未填写"
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
                                    <div className="gallery-advanced-details">
                                      <div className="gallery-advanced-summary">
                                        <span>高级信息</span>
                                        <span className="gallery-advanced-hint">坐标与曝光参数</span>
                                      </div>
                                      <div className="gallery-advanced-body">
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
                                              placeholder="例如：32.060255"
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
                                              placeholder="例如：118.796877"
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
                                              placeholder="例如：1/125s"
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
                                              placeholder="例如：f/2.8"
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
                                              placeholder="例如：400"
                                            />
                                          </label>
                                          <div className="field">
                                            <span>上传时间</span>
                                            <Input value={uploadedAt} readOnly placeholder="暂无记录" />
                                          </div>
                                        </div>
                                      </div>
                                    </div>
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
                                      const label = (
                                        <>
                                          {exhibition.museum_name} · {exhibition.name}
                                          {exhibition.start_at || exhibition.end_at
                                            ? ` (${exhibition.start_at?.slice(0, 10) ?? "未知"} - ${exhibition.end_at?.slice(0, 10) ?? "至今"})`
                                            : ""}
                                        </>
                                      )
                                      const detailPath = exhibition.catalog_source_id
                                        ? `/exhibitions/source/${encodeURIComponent(exhibition.catalog_source_id)}`
                                        : exhibition.catalog_exhibition_id
                                          ? `/exhibitions/${exhibition.catalog_exhibition_id}`
                                          : `/exhibitions/history/${encodeURIComponent(exhibition.name)}?${new URLSearchParams({
                                              museum: exhibition.museum_name,
                                            }).toString()}`
                                      return (
                                        <a
                                          key={exhibition.id}
                                          className="gallery-exhibition-link"
                                          href={detailPath}
                                        >
                                          {label}
                                        </a>
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
              </div>
            </div>,
            document.body,
          )
        : null}
      <datalist id="gallery-museum-options">
        {museumOptions.map((museum) => (
          <option key={museum.id} value={museum.name} />
        ))}
      </datalist>
      <datalist id="gallery-era-options">
        {eraOptions.map((era) => (
          <option key={era.id} value={era.name} />
        ))}
      </datalist>
    </section>
  )
}
