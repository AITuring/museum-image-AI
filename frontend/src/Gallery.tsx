import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  Aperture,
  Building2,
  Camera,
  Clock3,
  MapPin,
  Search,
  Sparkles,
  Tag,
} from "lucide-react"
import GalleryImagePreview from "./GalleryImagePreview"

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
  captureLocation: string
  latitude: string
  longitude: string
  capturedAt: string
  shutterSpeed: string
  aperture: string
  iso: string
  editMethod: string
}

type MuseumOption = {
  id: number
  name: string
}

type EraOption = {
  id: number
  name: string
  sort_order: number
}

type MediaMetaItem = {
  icon: "camera" | "lens" | "museum" | "exhibition" | "capturedAt" | "editMethod"
  value: string
}

function toAbsoluteUrl(apiBaseUrl: string, url: string) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${apiBaseUrl}${url}`
}

function isOssImageUrl(url: string) {
  return /^https:\/\/.+\.aliyuncs\.com\//.test(url)
}

function withOssImageProcess(url: string, process: string) {
  if (!isOssImageUrl(url)) {
    return url
  }
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}x-oss-process=${encodeURIComponent(process)}`
}

function getDisplayImageUrl(apiBaseUrl: string, url: string, mode: "thumb" | "preview" | "original") {
  const absoluteUrl = toAbsoluteUrl(apiBaseUrl, url)
  if (mode === "original") {
    return absoluteUrl
  }
  if (mode === "thumb") {
    return withOssImageProcess(absoluteUrl, "image/resize,m_lfit,w_480/quality,q_75/format,webp")
  }
  return withOssImageProcess(absoluteUrl, "image/resize,m_lfit,w_1280/quality,q_82/format,webp")
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
    const mapWindow = window as Window & {
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
          <input
            value={locationText}
            onChange={(event) => onLocationTextChange(event.target.value)}
            aria-label="地点定位输入"
            placeholder="输入地点、地址或博物馆名称"
          />
        </label>
        <button
          type="button"
          className="gallery-secondary-button"
          onClick={() => void handleResolveLocation()}
          disabled={mapLoading}
        >
          <Search size={14} aria-hidden="true" />
          <span>{mapLoading ? "定位中..." : "地点定位"}</span>
        </button>
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
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

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
        setItems(payload.map(normalizeArtifact))
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
    setEditing(true)
  }

  function handleCancelEdit() {
    setEditing(false)
    setEditForm(null)
    setTagInput("")
    setSaveError(null)
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
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setActive(updated)
      setActiveImageIndex(nextIndex)
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
    <section className="panel form-wide">
      <form className="gallery-search" onSubmit={handleSearch}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、时代、馆藏、出土地点或描述，按回车检索"
          aria-label="图库搜索"
        />
      </form>

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
            <button
              type="button"
              key={artifact.id}
              className="gallery-card"
              onClick={() => setActive(artifact)}
            >
              <div className="gallery-thumb">
                {cover ? (
                  <img
                    src={getDisplayImageUrl(apiBaseUrl, cover.url, "thumb")}
                    alt={artifact.name}
                    loading="lazy"
                  />
                ) : (
                  <span className="gallery-noimg">无图</span>
                )}
              </div>
              <div className="gallery-meta">
                <strong className="gallery-title">{artifact.name}</strong>
                <span className="gallery-line">时代：{artifact.era || "待确认"}</span>
                <span className="gallery-line">馆藏：{artifact.museum_name || "待识别"}</span>
                <span className="gallery-line">图片：{artifact.images.length} 张</span>
              </div>
            </button>
          )
        })}
      </div>

      {active
        ? createPortal(
            <div className="gallery-modal" onClick={() => !editing && setActive(null)}>
              <div className="gallery-modal-body" onClick={(e) => e.stopPropagation()}>
                {(() => {
                  const currentImage = active.images[activeImageIndex] ?? active.images[0] ?? null
                  const editFormId = `gallery-edit-form-${active.id}`
                  const subjectTags = getSubjectTags(active.tags)
                  const equipmentMeta: MediaMetaItem[] = [
                    currentImage?.camera_model ? { icon: "camera", value: currentImage.camera_model } : null,
                    currentImage?.lens_model ? { icon: "lens", value: currentImage.lens_model } : null,
                  ].filter((item): item is MediaMetaItem => Boolean(item))
                  const captureMuseumName = formatMetaValue(currentImage?.capture_museum_name)
                  const exhibitionName = formatMetaValue(currentImage?.exhibition_name)
                  const capturedAt = formatMetaDate(currentImage?.captured_at)
                  const uploadedAt = formatMetaDate(currentImage?.uploaded_at)
                  const shutterSpeed = formatMetaValue(currentImage?.shutter_speed)
                  const aperture = formatMetaValue(currentImage?.aperture)
                  const iso = formatMetaValue(currentImage?.iso)
                  const mediaMeta: MediaMetaItem[] = [
                    ...equipmentMeta,
                    captureMuseumName ? { icon: "museum", value: captureMuseumName } : null,
                    exhibitionName ? { icon: "exhibition", value: exhibitionName } : null,
                    capturedAt ? { icon: "capturedAt", value: capturedAt } : null,
                    currentImage?.edit_method ? { icon: "editMethod", value: currentImage.edit_method } : null,
                  ].filter((item): item is MediaMetaItem => Boolean(item))
                  const stackedImages = active.images
                    .map((image, index) => ({
                      image,
                      index,
                      depth: (index - activeImageIndex + active.images.length) % active.images.length,
                    }))
                    .sort((a, b) => a.depth - b.depth)
                  const stackedPreviewImages = stackedImages
                    .filter(({ depth }) => depth < 4)
                    .sort((a, b) => b.depth - a.depth)
                  const mediaMetaIconMap = {
                    camera: Camera,
                    lens: Aperture,
                    museum: Building2,
                    exhibition: Tag,
                    capturedAt: Clock3,
                    editMethod: Sparkles,
                  } as const
                  return (
                    <>
                      <div className={`gallery-modal-media ${currentImage ? "has-image" : ""}`}>
                        {currentImage ? (
                          <>
                            <button
                              type="button"
                              className="gallery-modal-main-stage"
                              onClick={() => setImagePreviewOpen(true)}
                              aria-label={`查看第 ${activeImageIndex + 1} 张原比例大图`}
                            >
                              <img
                                className="gallery-modal-main-img"
                                src={getDisplayImageUrl(apiBaseUrl, currentImage.url, "original")}
                                alt={active.name}
                              />
                            </button>
                            <div className="gallery-media-foot">
                              {active.images.length > 1 || mediaMeta.length > 0 ? (
                                <>
                                  {active.images.length > 1 ? (
                                    <div className={`gallery-modal-thumbs ${editing ? "edit-lock" : ""}`}>
                                      {stackedPreviewImages.map(({ image, index, depth }) => (
                                        <button
                                          type="button"
                                          key={image.id}
                                          className={`gallery-modal-thumb stack-depth-${Math.min(depth, 3)} ${index === activeImageIndex ? "active" : ""}`}
                                          onClick={() => setActiveImageIndex(index)}
                                          aria-label={`查看第 ${index + 1} 张`}
                                          disabled={editing || saving}
                                        >
                                          <img
                                            src={getDisplayImageUrl(apiBaseUrl, image.url, "thumb")}
                                            alt={active.name}
                                            loading="lazy"
                                          />
                                        </button>
                                      ))}
                                    </div>
                                  ) : (
                                    <div />
                                  )}
                                  <div className="gallery-media-aside">
                                    {currentImage ? (
                                      <span className="gallery-media-page-indicator">
                                        {activeImageIndex + 1} / {active.images.length}
                                      </span>
                                    ) : null}
                                    {mediaMeta.length > 0 ? (
                                      <div className="gallery-media-meta">
                                        {mediaMeta.map((item) => (
                                          <span key={`${item.icon}-${item.value}`}>
                                            {(() => {
                                              const Icon = mediaMetaIconMap[item.icon]
                                              return <Icon className="gallery-media-meta-icon" size={12} aria-hidden="true" />
                                            })()}
                                            <span>{item.value}</span>
                                          </span>
                                        ))}
                                      </div>
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

                      <div className="gallery-modal-info">
                        <div className="gallery-detail-head">
                          <div className="gallery-detail-heading">
                            <h3 className="gallery-detail-title">{active.name}</h3>
                            
                          </div>
                          <div className="gallery-actions" onClick={(event) => event.stopPropagation()}>
                            {editing ? (
                              <>
                                <button
                                  type="button"
                                  className="ghost gallery-secondary-button"
                                  onClick={handleCancelEdit}
                                  disabled={saving}
                                >
                                  取消
                                </button>
                                <button
                                  type="submit"
                                  form={editFormId}
                                  className="primary gallery-primary-button"
                                  disabled={saving}
                                >
                                  {saving ? "保存中..." : "保存"}
                                </button>
                                <button
                                  type="button"
                                  className="gallery-close"
                                  onClick={() => !editing && setActive(null)}
                                  disabled={editing}
                                  aria-label={editing ? "编辑中不可关闭弹窗" : "关闭弹窗"}
                                >
                                  ×
                                </button>
                              </>
                            ) : (
                              <>
                                <button type="button" className="gallery-toolbar-button" onClick={handleStartEdit}>
                                  编辑资料
                                </button>
                                <button
                                  type="button"
                                  className="gallery-close"
                                  onClick={() => !editing && setActive(null)}
                                  disabled={editing}
                                  aria-label={editing ? "编辑中不可关闭弹窗" : "关闭弹窗"}
                                >
                                  ×
                                </button>
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
                                    <span className="form-section-kicker">文物记录</span>
                                    <h3>基本信息</h3>
                                  </div>
                                  <div className="form-section-body">
                                    <div className="field-row">
                                      <label className="field">
                                        <span>博物馆名称</span>
                                        <input
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
                                        <input
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
                                        <input
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
                                        <input
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
                                        <span>标签</span>
                                        <div className="tag-editor">
                                          <div className="tag-editor-chips">
                                            {editForm.tags.length > 0 ? (
                                              editForm.tags.map((tag) => (
                                                <span key={tag} className="tag-chip">
                                                  {tag}
                                                  <button
                                                    type="button"
                                                    onClick={() => removeTag(tag)}
                                                    aria-label={`删除标签 ${tag}`}
                                                  >
                                                    ×
                                                  </button>
                                                </span>
                                              ))
                                            ) : (
                                              <span className="tag-editor-placeholder">暂无标签</span>
                                            )}
                                          </div>
                                          <input
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
                                      <span>描述</span>
                                      <textarea
                                        rows={4}
                                        value={editForm.description}
                                        onChange={(event) =>
                                          setEditForm((current) =>
                                            current ? { ...current, description: event.target.value } : current,
                                          )
                                        }
                                        placeholder="文物简介，可补充或修正"
                                      />
                                    </label>
                                  </div>
                                </section>

                                <section className="form-section">
                                  <div className="form-section-head">
                                    <span className="form-section-kicker">当前图片</span>
                                    <h3>拍摄信息</h3>
                                  </div>
                                  <div className="form-section-body">
                                    <div className="field-row">
                                      <label className="field">
                                        <span>机型</span>
                                        <input
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
                                        <input
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
                                        <span>拍摄馆</span>
                                        <input
                                          value={editForm.captureMuseumName}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, captureMuseumName: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：南京博物院"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>展览</span>
                                        <input
                                          value={editForm.exhibitionName}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, exhibitionName: event.target.value } : current,
                                            )
                                          }
                                          placeholder="默认常设，可直接修改"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>拍摄时间</span>
                                        <input
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
                                        <select
                                          value={editForm.editMethod}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, editMethod: event.target.value } : current,
                                            )
                                          }
                                        >
                                          <option value="">未填写</option>
                                          <option value="简单调整">简单调整</option>
                                          <option value="堆栈合成">堆栈合成</option>
                                        </select>
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
                                        <div className="field-row">
                                          <label className="field">
                                            <span>纬度</span>
                                            <input
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
                                            <input
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
                                        <div className="field-row">
                                          <label className="field">
                                            <span>快门</span>
                                            <input
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
                                            <input
                                              value={editForm.aperture}
                                              onChange={(event) =>
                                                setEditForm((current) =>
                                                  current ? { ...current, aperture: event.target.value } : current,
                                                )
                                              }
                                              placeholder="例如：f/2.8"
                                            />
                                          </label>
                                        </div>
                                        <div className="field-row">
                                          <label className="field">
                                            <span>ISO</span>
                                            <input
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
                                            <input value={uploadedAt} readOnly placeholder="暂无记录" />
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
                            <section className="gallery-detail-section gallery-detail-section-primary">
                              <div className="gallery-detail-intro">
                                <div className="gallery-detail-line">
                                  <span className="gallery-detail-label">
                                    <Clock3 size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>时代</span>
                                  </span>
                                  <span className="gallery-detail-value">{active.era || "待确认"}</span>
                                </div>
                                <div className="gallery-detail-line">
                                  <span className="gallery-detail-label">
                                    <Building2 size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>馆藏</span>
                                  </span>
                                  <span className="gallery-detail-value">{active.museum_name || "待识别"}</span>
                                </div>
                                <div className="gallery-detail-line">
                                  <span className="gallery-detail-label">
                                    <MapPin size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>出土地点</span>
                                  </span>
                                  <span className="gallery-detail-value">{active.Place_of_Excavation || "待补充"}</span>
                                </div>
                              </div>
                              {subjectTags.length > 0 ? (
                                <div className="gallery-detail-line">
                                  <span className="gallery-detail-label">
                                    <Tag size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>标签</span>
                                  </span>
                                  <div className="tag-row">
                                    {subjectTags.map((tag) => (
                                      <span key={tag}>{tag}</span>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                              {active.exhibitions.length > 0 ? (
                                <div className="gallery-detail-line">
                                  <span className="gallery-detail-label">
                                    <Sparkles size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                    <span>历史展出</span>
                                  </span>
                                  <div className="tag-row">
                                    {active.exhibitions.map((exhibition) => (
                                      <span key={exhibition.id}>
                                        {exhibition.museum_name} · {exhibition.name}
                                        {exhibition.start_at || exhibition.end_at
                                          ? ` (${exhibition.start_at?.slice(0, 10) ?? "未知"} - ${exhibition.end_at?.slice(0, 10) ?? "至今"})`
                                          : ""}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </section>
                            {(shutterSpeed || aperture || iso) ? (
                              <section className="gallery-detail-section gallery-view-advanced-details">
                                <div className="gallery-detail-section-head">
                              
                                  <h4 className="gallery-detail-section-title">
                                    <Camera size={15} aria-hidden="true" />
                                    <span>相机参数</span>
                                  </h4>
                                </div>
                                <div className="gallery-advanced-body">
                                  {shutterSpeed ? (
                                    <div className="gallery-detail-line">
                                      <span className="gallery-detail-label">
                                        <Camera size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                        <span>快门</span>
                                      </span>
                                      <span className="gallery-detail-value">{shutterSpeed}</span>
                                    </div>
                                  ) : null}
                                  {aperture ? (
                                    <div className="gallery-detail-line">
                                      <span className="gallery-detail-label">
                                        <Aperture size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                        <span>光圈</span>
                                      </span>
                                      <span className="gallery-detail-value">{aperture}</span>
                                    </div>
                                  ) : null}
                                  {iso ? (
                                    <div className="gallery-detail-line">
                                      <span className="gallery-detail-label">
                                        <Sparkles size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                                        <span>ISO</span>
                                      </span>
                                      <span className="gallery-detail-value">{iso}</span>
                                    </div>
                                  ) : null}
                                </div>
                              </section>
                            ) : null}
                            {active.description ? (
                              <section className="gallery-detail-section gallery-detail-desc-section">
                                <div className="gallery-detail-section-head">
                        
                                  <h4 className="gallery-detail-section-title">
                                    <Sparkles size={15} aria-hidden="true" />
                                    <span>描述</span>
                                  </h4>
                                </div>
                                <div className="gallery-detail-line gallery-detail-desc">
                                  <div className="gallery-detail-value">
                                    <p className="result-desc">{active.description}</p>
                                  </div>
                                </div>
                              </section>
                            ) : null}
                          </div>
                        )}
                      </div>

                      {imagePreviewOpen && currentImage ? (
                        <GalleryImagePreview
                          open={imagePreviewOpen}
                          src={getDisplayImageUrl(apiBaseUrl, currentImage.url, "original")}
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
