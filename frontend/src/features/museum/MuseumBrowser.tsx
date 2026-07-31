import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ImgHTMLAttributes } from "react"
import { Button, Input, Segmented } from "antd"
import "./museum.css"

const AMAP_SCRIPT_ID = "museum-console-amap-script"
const AMAP_SECURITY_CODE = "3ba01835420271d5405dccba5e089b46"
const AMAP_SCRIPT_SRC =
  "https://webapi.amap.com/maps?v=1.4.15&key=7a9513e700e06c00890363af1bd2d926&plugin=AMap.ToolBar"

// #region debug-point A:reporter
const MAP_DEBUG_URL = "http://127.0.0.1:7777/event"
const MAP_DEBUG_SESSION = "museum-map-load"
function reportMapDebug(hypothesisId: "A" | "B" | "C" | "D", msg: string, data: Record<string, unknown>) {
  fetch(MAP_DEBUG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: MAP_DEBUG_SESSION,
      runId: "pre-fix",
      hypothesisId,
      location: "MuseumBrowser.tsx",
      msg: `[DEBUG] ${msg}`,
      data,
      ts: Date.now(),
    }),
  }).catch(() => {})
}
// #endregion

type MuseumExhibition = {
  id: number
  museum_id: number
  museum_name: string
  name: string
  start_at: string | null
  end_at: string | null
}

type MuseumRecord = {
  id: number
  museum_id: number | null
  museum_ids: number[]
  name: string
  location: string | null
  latitude: number | null
  longitude: number | null
  description: string | null
  artifact_count: number
  exhibition_count: number
  catalog_exhibition_count: number
  first_year: number | null
  last_year: number | null
  cover_url: string | null
  catalog_museum_name: string | null
  catalog_address: string | null
  catalog_venue: string | null
  catalog_city: string | null
  catalog_region: string | null
  derived_from_catalog: boolean
  exhibitions: MuseumExhibition[]
}

type RawMuseumRecord = Omit<
  MuseumRecord,
  | "museum_id"
  | "museum_ids"
  | "catalog_exhibition_count"
  | "first_year"
  | "last_year"
  | "cover_url"
  | "catalog_museum_name"
  | "catalog_address"
  | "catalog_venue"
  | "catalog_city"
  | "catalog_region"
  | "derived_from_catalog"
> & Partial<
  Pick<
    MuseumRecord,
    | "museum_id"
    | "museum_ids"
    | "catalog_exhibition_count"
    | "first_year"
    | "last_year"
    | "cover_url"
    | "catalog_museum_name"
    | "catalog_address"
    | "catalog_venue"
    | "catalog_city"
    | "catalog_region"
    | "derived_from_catalog"
  >
>

type CatalogExhibition = {
  id: number
  title: string
  museum_name: string | null
  venue: string | null
  city: string
  region: string
  start_date: string | null
  end_date: string | null
  start_year: number | null
  end_year: number | null
  is_permanent: boolean
  status: "ongoing" | "upcoming" | "ended" | "permanent"
  cover_url: string | null
}

type CatalogExhibitionResponse = {
  items: CatalogExhibition[]
  total: number
  page: number
  page_size: number
}

type GalleryImage = {
  id: number
  url: string
  exhibition_name?: string | null
  captured_at?: string | null
}

type MuseumArtifact = {
  id: number
  name: string
  era: string | null
  museum_name: string
  description: string | null
  exhibitions: MuseumExhibition[]
  images: GalleryImage[]
}

type RawMuseumArtifact = Omit<MuseumArtifact, "images" | "exhibitions"> & {
  images?: GalleryImage[]
  exhibitions?: MuseumExhibition[]
}

type MuseumMode = "cards" | "map"

type FolderEntry = {
  artifactId: number
  artifactName: string
  artifactEra: string | null
  previewUrl: string
  fallbackUrl: string
  capturedAt: string | null
  imageCount: number
}

function museumIdFromPath(pathname: string) {
  const match = pathname.match(/^\/museums\/(\d+)\/?$/)
  return match ? Number(match[1]) : null
}

function museumDetailPath(museumId: number) {
  return `/museums/${museumId}`
}

function toAbsoluteUrl(apiBaseUrl: string, url: string) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${apiBaseUrl}${url}`
}

function getBackendImageVariantUrl(apiBaseUrl: string, url: string, size: number) {
  const params = new URLSearchParams({ url, size: String(size) })
  return `${apiBaseUrl}/api/image-variant?${params.toString()}`
}

function getDisplayImageUrl(apiBaseUrl: string, url: string, mode: "thumb" | "preview" | "original") {
  if (mode === "thumb") return getBackendImageVariantUrl(apiBaseUrl, url, 480)
  return getBackendImageVariantUrl(apiBaseUrl, url, 1280)
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

function normalizeMuseumCoordinates<T extends { latitude: number | null; longitude: number | null }>(museum: T): T {
  if (museum.latitude == null || museum.longitude == null) return museum
  const hasReversedCoordinates = Math.abs(museum.latitude) > 90 && Math.abs(museum.longitude) <= 90
  if (!hasReversedCoordinates) return museum
  return {
    ...museum,
    latitude: museum.longitude,
    longitude: museum.latitude,
  }
}

function normalizeArtifact(item: RawMuseumArtifact): MuseumArtifact {
  return {
    ...item,
    images: Array.isArray(item.images) ? item.images : [],
    exhibitions: Array.isArray(item.exhibitions) ? item.exhibitions : [],
  }
}

function formatDateRange(startAt: string | null, endAt: string | null) {
  if (!startAt && !endAt) return "时间未记录"
  return `${startAt?.slice(0, 10) ?? "未知"} - ${endAt?.slice(0, 10) ?? "至今"}`
}

function exhibitionTouchesYear(exhibition: CatalogExhibition, year: number) {
  if (exhibition.is_permanent || exhibition.status === "permanent") return true
  const startYear = exhibition.start_year ?? (exhibition.start_date ? Number(exhibition.start_date.slice(0, 4)) : null)
  const endYear = exhibition.end_year ?? (exhibition.end_date ? Number(exhibition.end_date.slice(0, 4)) : startYear)
  return startYear != null && startYear <= year && (endYear == null || endYear >= year)
}

type TimelineExhibition = {
  exhibition: CatalogExhibition
  startMonth: number
  endMonth: number
  lane: number
  tone: number
}

function buildYearTimeline(exhibitions: CatalogExhibition[], year: number): TimelineExhibition[] {
  const monthSpan = (exhibition: CatalogExhibition) => {
    const startsThisYear = exhibition.start_date?.startsWith(String(year)) ?? false
    const endsThisYear = exhibition.end_date?.startsWith(String(year)) ?? false
    const startMonth = startsThisYear ? Number(exhibition.start_date?.slice(5, 7)) : 1
    const endMonth = endsThisYear ? Number(exhibition.end_date?.slice(5, 7)) : 12
    return { startMonth: Math.max(1, startMonth), endMonth: Math.min(12, Math.max(startMonth, endMonth)) }
  }
  const laneEnds: number[] = []
  return exhibitions
    .map((exhibition) => ({ exhibition, ...monthSpan(exhibition) }))
    .sort((left, right) => left.startMonth - right.startMonth || right.endMonth - left.endMonth)
    .map((item, index) => {
      let lane = laneEnds.findIndex((endMonth) => endMonth < item.startMonth)
      if (lane === -1) lane = laneEnds.length
      laneEnds[lane] = item.endMonth
      return { ...item, lane, tone: index % 6 }
    })
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function buildMarkerContent(kind: "default" | "active") {
  const element = document.createElement("div")
  element.className = `museum-map-marker ${kind}`
  return element
}

function buildMarkerInfoHtml(museum: MuseumRecord) {
  const intro = museum.description?.trim() || museum.location?.trim() || "暂无简介"
  return `
    <div class="museum-map-info-window">
      <strong>${escapeHtml(museum.name)}</strong>
      <p>${escapeHtml(intro)}</p>
      <span>${museum.artifact_count} 件文物 · ${museum.exhibition_count} 个展览</span>
    </div>
  `
}

function museumMatchesQuery(museum: MuseumRecord, query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [museum.name, museum.location, museum.description]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(normalized))
}

function buildMuseumFolders(apiBaseUrl: string, artifacts: MuseumArtifact[]) {
  const folderMap = new Map<
    string,
    {
      name: string
      period: string
      coverUrl: string | null
      entries: FolderEntry[]
      artifactIds: Set<number>
    }
  >()

  artifacts.forEach((artifact) => {
    const exhibitionMeta = new Map<string, string>()
    artifact.exhibitions.forEach((exhibition) => {
      exhibitionMeta.set(exhibition.name, formatDateRange(exhibition.start_at, exhibition.end_at))
    })

    const imagesByExhibition = new Map<string, GalleryImage[]>()
    artifact.images.forEach((image) => {
      const exhibitionName = image.exhibition_name?.trim() || artifact.exhibitions[0]?.name || "未归档展览"
      const images = imagesByExhibition.get(exhibitionName) ?? []
      images.push(image)
      imagesByExhibition.set(exhibitionName, images)
    })

    imagesByExhibition.forEach((images, exhibitionName) => {
      const key = exhibitionName.toLowerCase()
      const current =
        folderMap.get(key) ??
        {
          name: exhibitionName,
          period: exhibitionMeta.get(exhibitionName) ?? "拍摄时间散见于多次参观记录",
          coverUrl: null,
          entries: [],
          artifactIds: new Set<number>(),
        }

      const coverImage = images.toSorted((left, right) => {
        const leftTime = left.captured_at ? Date.parse(left.captured_at) : 0
        const rightTime = right.captured_at ? Date.parse(right.captured_at) : 0
        return rightTime - leftTime
      })[0]
      const previewUrl = getDisplayImageUrl(apiBaseUrl, coverImage.url, "preview")
      current.entries.push({
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactEra: artifact.era,
        previewUrl,
        fallbackUrl: toAbsoluteUrl(apiBaseUrl, coverImage.url),
        capturedAt: coverImage.captured_at ?? null,
        imageCount: images.length,
      })
      current.artifactIds.add(artifact.id)
      if (!current.coverUrl) current.coverUrl = previewUrl
      folderMap.set(key, current)
    })
  })

  return Array.from(folderMap.entries())
    .map(([key, folder]) => ({
      key,
      name: folder.name,
      period: folder.period,
      imageCount: folder.entries.length,
      artifactCount: folder.artifactIds.size,
      coverUrl: folder.coverUrl,
      entries: folder.entries.sort((left, right) => {
        const leftTime = left.capturedAt ? Date.parse(left.capturedAt) : 0
        const rightTime = right.capturedAt ? Date.parse(right.capturedAt) : 0
        return rightTime - leftTime
      }),
    }))
    .sort((left, right) => right.imageCount - left.imageCount || left.name.localeCompare(right.name, "zh-CN"))
}

function getMuseumPreviewStack(apiBaseUrl: string, artifacts: MuseumArtifact[], max = 3) {
  const previews: string[] = []
  for (const artifact of artifacts) {
    for (const image of artifact.images) {
      previews.push(getDisplayImageUrl(apiBaseUrl, image.url, "thumb"))
      if (previews.length >= max) return previews
    }
  }
  return previews
}

export default function MuseumBrowser({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [mode, setMode] = useState<MuseumMode>("cards")
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<MuseumRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [detailMuseumId, setDetailMuseumId] = useState<number | null>(() => museumIdFromPath(window.location.pathname))
  const [artifactStore, setArtifactStore] = useState<Record<number, MuseumArtifact[]>>({})
  const [artifactLoadingId, setArtifactLoadingId] = useState<number | null>(null)
  const [artifactErrors, setArtifactErrors] = useState<Record<number, string | null>>({})
  const [historyStore, setHistoryStore] = useState<Record<number, CatalogExhibitionResponse>>({})
  const [historyLoadingId, setHistoryLoadingId] = useState<number | null>(null)
  const [historyErrors, setHistoryErrors] = useState<Record<number, string | null>>({})
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [activeFolderKey, setActiveFolderKey] = useState<string | null>(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const infoWindowRef = useRef<any | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const filteredMuseums = useMemo(() => items.filter((museum) => museumMatchesQuery(museum, query)), [items, query])

  useEffect(() => {
    setActiveId((current) => {
      if (filteredMuseums.length === 0) return null
      if (current && filteredMuseums.some((museum) => museum.id === current)) return current
      return filteredMuseums[0].id
    })
  }, [filteredMuseums])

  const activeMuseum = useMemo(
    () => (detailMuseumId != null ? items.find((museum) => museum.id === detailMuseumId) : null)
      ?? filteredMuseums.find((museum) => museum.id === activeId)
      ?? filteredMuseums[0]
      ?? null,
    [activeId, detailMuseumId, filteredMuseums, items],
  )

  const activeArtifactsLoaded = activeMuseum ? Object.prototype.hasOwnProperty.call(artifactStore, activeMuseum.id) : false
  const activeArtifacts = useMemo(
    () => activeMuseum ? artifactStore[activeMuseum.id] ?? [] : [],
    [activeMuseum, artifactStore],
  )
  const activeArtifactError = activeMuseum ? artifactErrors[activeMuseum.id] ?? null : null
  const activeHistory = activeMuseum ? historyStore[activeMuseum.id] ?? null : null
  const activeHistoryError = activeMuseum ? historyErrors[activeMuseum.id] ?? null : null
  const historyGroups = useMemo(() => {
    const groups = new Map<string, CatalogExhibition[]>()
    for (const exhibition of activeHistory?.items ?? []) {
      const year = exhibition.is_permanent
        ? "常设"
        : String(exhibition.start_year ?? exhibition.end_year ?? "时间待确认")
      const items = groups.get(year) ?? []
      items.push(exhibition)
      groups.set(year, items)
    }
    return Array.from(groups.entries())
  }, [activeHistory])
  const currentHistoryYear = new Date().getFullYear()
  const currentYearExhibitions = useMemo(
    () => (activeHistory?.items ?? []).filter(
      (exhibition) => !exhibition.is_permanent && exhibition.status !== "permanent" && exhibitionTouchesYear(exhibition, currentHistoryYear),
    ),
    [activeHistory, currentHistoryYear],
  )
  const currentYearTimeline = useMemo(
    () => buildYearTimeline(currentYearExhibitions, currentHistoryYear),
    [currentHistoryYear, currentYearExhibitions],
  )
  const folders = useMemo(() => buildMuseumFolders(apiBaseUrl, activeArtifacts), [activeArtifacts, apiBaseUrl])
  const activeFolder = useMemo(() => folders.find((folder) => folder.key === activeFolderKey) ?? folders[0] ?? null, [activeFolderKey, folders])
  const museumsWithCoordinates = useMemo(
    () => filteredMuseums.filter((museum) => museum.latitude != null && museum.longitude != null),
    [filteredMuseums],
  )

  const loadMuseums = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let response = await fetch(`${apiBaseUrl}/api/museum-directory?limit=5000`)
      if (response.status === 404) {
        response = await fetch(`${apiBaseUrl}/api/museums?limit=500`)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = ((await response.json()) as RawMuseumRecord[]).map((item) => normalizeMuseumCoordinates({
        ...item,
        museum_id: item.museum_id ?? item.id,
        museum_ids: item.museum_ids?.length ? item.museum_ids : [item.museum_id ?? item.id],
        catalog_exhibition_count: item.catalog_exhibition_count ?? 0,
        first_year: item.first_year ?? null,
        last_year: item.last_year ?? null,
        cover_url: item.cover_url ?? null,
        catalog_museum_name: item.catalog_museum_name ?? null,
        catalog_address: item.catalog_address ?? null,
        catalog_venue: item.catalog_venue ?? null,
        catalog_city: item.catalog_city ?? null,
        catalog_region: item.catalog_region ?? null,
        derived_from_catalog: item.derived_from_catalog ?? false,
      }))
      setItems(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载博物馆失败")
    } finally {
      setLoading(false)
    }
  }, [apiBaseUrl])

  const navigateToMuseum = useCallback((museumId: number) => {
    setActiveId(museumId)
    setDetailMuseumId(museumId)
    const targetPath = museumDetailPath(museumId)
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, "", targetPath)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
  }, [])

  const returnToDirectory = useCallback(() => {
    setDetailMuseumId(null)
    if (window.location.pathname !== "/museums") {
      window.history.pushState({}, "", "/museums")
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
  }, [])

  const navigateToArtifact = useCallback((artifactId: number) => {
    const targetPath = `/gallery/${artifactId}`
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, "", targetPath)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
  }, [])

  const loadMuseumArtifacts = useCallback(
    async (museum: MuseumRecord) => {
      setArtifactLoadingId(museum.id)
      setArtifactErrors((current) => ({ ...current, [museum.id]: null }))
      try {
        // A card may merge duplicate historical Museum rows. Fetch every
        // precise museum id; a keyword query can match an unrelated artifact's
        // exhibition/location text and put it in the wrong venue.
        const museumIds = museum.museum_ids.length > 0
          ? museum.museum_ids
          : museum.museum_id == null ? [] : [museum.museum_id]
        const responses = await Promise.all(
          museumIds.map((museumId) => fetch(`${apiBaseUrl}/api/artifacts?museum_id=${museumId}`)),
        )
        const failed = responses.find((response) => !response.ok)
        if (failed) throw new Error(`HTTP ${failed.status}`)
        const payload = Array.from(
          new Map(
            (await Promise.all(responses.map((response) => response.json())))
              .flat()
              .map((item: RawMuseumArtifact) => {
                const artifact = normalizeArtifact(item)
                return [artifact.id, artifact] as const
              }),
          ).values(),
        )
        setArtifactStore((current) => ({ ...current, [museum.id]: payload }))
      } catch (err) {
        setArtifactErrors((current) => ({
          ...current,
          [museum.id]: err instanceof Error ? err.message : "加载博物馆图片失败",
        }))
        setArtifactStore((current) => ({ ...current, [museum.id]: [] }))
      } finally {
        setArtifactLoadingId((current) => (current === museum.id ? null : current))
      }
    },
    [apiBaseUrl],
  )

  const ensureMuseumArtifacts = useCallback(
    (museum: MuseumRecord) => {
      if (Object.prototype.hasOwnProperty.call(artifactStore, museum.id)) return
      void loadMuseumArtifacts(museum)
    },
    [artifactStore, loadMuseumArtifacts],
  )

  const loadMuseumHistory = useCallback(
    async (museum: MuseumRecord, page = 1) => {
      if (!museum.catalog_museum_name && !museum.catalog_address) {
        setHistoryStore((current) => ({
          ...current,
          [museum.id]: { items: [], total: 0, page: 1, page_size: 100 },
        }))
        return
      }
      setHistoryLoadingId(museum.id)
      setHistoryErrors((current) => ({ ...current, [museum.id]: null }))
      const params = new URLSearchParams({
        page: String(page),
        page_size: "100",
        include_facets: "false",
      })
      if (museum.catalog_address) {
        params.set("address", museum.catalog_address)
      } else if (museum.catalog_museum_name) {
        params.set("museum_name", museum.catalog_museum_name)
      }
      if (museum.catalog_city) params.set("city", museum.catalog_city)
      if (museum.catalog_region) params.set("region", museum.catalog_region)
      try {
        const response = await fetch(`${apiBaseUrl}/api/exhibition-catalog?${params.toString()}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as CatalogExhibitionResponse
        setHistoryStore((current) => {
          const previous = current[museum.id]
          return {
            ...current,
            [museum.id]: page > 1 && previous
              ? { ...payload, items: [...previous.items, ...payload.items] }
              : payload,
          }
        })
      } catch (err) {
        setHistoryErrors((current) => ({
          ...current,
          [museum.id]: err instanceof Error ? err.message : "加载历年展览失败",
        }))
      } finally {
        setHistoryLoadingId((current) => (current === museum.id ? null : current))
      }
    },
    [apiBaseUrl],
  )

  useEffect(() => {
    void loadMuseums()
  }, [loadMuseums])

  useEffect(() => {
    const syncDetailRoute = () => setDetailMuseumId(museumIdFromPath(window.location.pathname))
    window.addEventListener("popstate", syncDetailRoute)
    return () => window.removeEventListener("popstate", syncDetailRoute)
  }, [])

  useEffect(() => {
    if (!activeMuseum) return
    if (Object.prototype.hasOwnProperty.call(artifactStore, activeMuseum.id)) return
    void loadMuseumArtifacts(activeMuseum)
  }, [activeMuseum, artifactStore, loadMuseumArtifacts])

  useEffect(() => {
    if (!activeMuseum) return
    if (Object.prototype.hasOwnProperty.call(historyStore, activeMuseum.id)) return
    void loadMuseumHistory(activeMuseum)
  }, [activeMuseum, historyStore, loadMuseumHistory])

  useEffect(() => {
    setHistoryExpanded(false)
  }, [activeMuseum?.id])

  useEffect(() => {
    if (folders.length === 0) {
      setActiveFolderKey(null)
      return
    }
    setActiveFolderKey((current) => (current && folders.some((folder) => folder.key === current) ? current : folders[0].key))
  }, [folders])

  useEffect(() => {
    if (mode !== "map") return

    let disposed = false
    let finalizeTimer: number | null = null
    let onWinResize: (() => void) | null = null

    const initializeMap = () => {
      // #region debug-point C:init-entry
      reportMapDebug("C", "initializeMap entry", {
        hasContainer: Boolean(mapContainerRef.current),
        hasAMap: Boolean((window as any).AMap),
        hasMapInstance: Boolean(mapRef.current),
        mode,
      })
      // #endregion
      if (!mapContainerRef.current) {
        window.setTimeout(() => {
          if (!disposed && mapContainerRef.current && (window as any).AMap && !mapRef.current) {
            initializeMap()
          }
        }, 120)
        return
      }

      const mapWindow = window as any
      if (!mapWindow.AMap || mapRef.current) return

      try {
        // #region debug-point B:amap-shape
        reportMapDebug("B", "AMap shape before map creation", {
          hasPlugin: typeof mapWindow.AMap?.plugin === "function",
          hasToolBar: typeof mapWindow.AMap?.ToolBar,
          hasMapCtor: typeof mapWindow.AMap?.Map,
          containerWidth: mapContainerRef.current?.clientWidth ?? null,
          containerHeight: mapContainerRef.current?.clientHeight ?? null,
        })
        // #endregion
        const map = new mapWindow.AMap.Map(mapContainerRef.current, {
          zoom: 5,
          center: [116.397428, 39.90923],
          mapStyle: "amap://styles/whitesmoke",
        })

        const safeResize = () => {
          try {
            const anyMap = map as any
            if (typeof anyMap.resize === "function") {
              anyMap.resize()
            } else {
              const center = map.getCenter()
              const zoom = map.getZoom()
              map.setZoom(zoom)
              map.setCenter(center)
            }
          } catch {}
        }

        mapRef.current = map
        infoWindowRef.current = new mapWindow.AMap.InfoWindow({
          offset: new mapWindow.AMap.Pixel(0, -18),
          closeWhenClickMap: true,
        })
        // #region debug-point C:map-created
        reportMapDebug("C", "map instance created", {
          hasInfoWindow: Boolean(infoWindowRef.current),
          mapType: typeof map,
        })
        // #endregion

        let finalized = false
        const finalizeMap = () => {
          if (disposed || finalized) return
          finalized = true
          safeResize()
          window.setTimeout(() => {
            if (disposed) return
            safeResize()
            setMapReady(true)
            setMapLoading(false)
            // #region debug-point C:map-finalized
            reportMapDebug("C", "map finalized", {
              zoom: map.getZoom?.() ?? null,
              center: map.getCenter?.()?.toString?.() ?? null,
            })
            // #endregion
          }, 0)
        }

        map.on("complete", finalizeMap)
        map.on("tilesloaded", finalizeMap)

        // ToolBar 在不同地图脚本加载顺序下可能不存在，缺失时不应阻断地图主流程。
        mapWindow.AMap.plugin?.(["AMap.ToolBar"], () => {
          const ToolBar = mapWindow.AMap?.ToolBar
          // #region debug-point B:toolbar-plugin-callback
          reportMapDebug("B", "toolbar plugin callback", {
            hasPlugin: typeof mapWindow.AMap?.plugin === "function",
            hasToolBar: typeof ToolBar,
          })
          // #endregion
          if (typeof ToolBar === "function") {
            map.addControl?.(new ToolBar())
            // #region debug-point B:toolbar-added
            reportMapDebug("B", "toolbar added", { added: true })
            // #endregion
          } else {
            // #region debug-point B:toolbar-missing
            reportMapDebug("B", "toolbar missing after plugin load", { added: false })
            // #endregion
          }
        })

        onWinResize = () => safeResize()
        window.addEventListener("resize", onWinResize)

        if ("ResizeObserver" in window && mapContainerRef.current) {
          resizeObserverRef.current?.disconnect()
          const observer = new ResizeObserver(() => safeResize())
          observer.observe(mapContainerRef.current)
          resizeObserverRef.current = observer
        }

        finalizeTimer = window.setTimeout(finalizeMap, 1200)
      } catch (err) {
        // #region debug-point D:init-catch
        reportMapDebug("D", "map initialization catch", {
          error: err instanceof Error ? err.message : String(err),
        })
        // #endregion
        if (disposed) return
        setMapLoading(false)
        setMapError(err instanceof Error ? err.message : "地图初始化失败")
      }
    }

    const mountTimer = window.setTimeout(() => {
      const mapWindow = window as any
      setMapLoading(true)
      setMapError(null)
      // #region debug-point A:mount-timer
      reportMapDebug("A", "map mount timer fired", {
        hasExistingAMap: Boolean(mapWindow.AMap),
        scriptSrc: AMAP_SCRIPT_SRC,
      })
      // #endregion

      if (mapWindow.AMap) {
        // #region debug-point A:reuse-existing-amap
        reportMapDebug("A", "reuse existing AMap global", {
          hasPlugin: typeof mapWindow.AMap?.plugin === "function",
          hasToolBar: typeof mapWindow.AMap?.ToolBar,
        })
        // #endregion
        initializeMap()
        return
      }

      mapWindow._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE }

      const existing = document.getElementById(AMAP_SCRIPT_ID) as HTMLScriptElement | null
      if (existing) {
        // #region debug-point A:reuse-script-tag
        reportMapDebug("A", "reuse existing script tag", {
          existingSrc: existing.src,
        })
        // #endregion
        existing.addEventListener("load", initializeMap, { once: true })
        existing.addEventListener(
          "error",
          () => {
            // #region debug-point D:script-error-existing
            reportMapDebug("D", "existing script tag load error", {
              existingSrc: existing.src,
            })
            // #endregion
            setMapLoading(false)
            setMapError("高德地图加载失败")
          },
          { once: true },
        )
        return
      }

      const script = document.createElement("script")
      script.id = AMAP_SCRIPT_ID
      script.src = AMAP_SCRIPT_SRC
      script.async = true
      script.onload = () => {
        // #region debug-point A:new-script-loaded
        reportMapDebug("A", "new map script loaded", {
          scriptSrc: script.src,
          hasAMap: Boolean((window as any).AMap),
        })
        // #endregion
        initializeMap()
      }
      script.onerror = () => {
        // #region debug-point D:new-script-error
        reportMapDebug("D", "new map script load error", {
          scriptSrc: script.src,
        })
        // #endregion
        setMapLoading(false)
        setMapError("高德地图加载失败")
      }
      document.head.appendChild(script)
    }, 80)

    return () => {
      disposed = true
      window.clearTimeout(mountTimer)
      if (finalizeTimer !== null) window.clearTimeout(finalizeTimer)
      if (onWinResize) window.removeEventListener("resize", onWinResize)
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      infoWindowRef.current?.close?.()
      infoWindowRef.current = null
      markersRef.current.forEach((marker) => marker.setMap?.(null))
      markersRef.current = []
      mapRef.current?.destroy?.()
      mapRef.current = null
      setMapReady(false)
    }
  }, [mode])

  const renderMarkers = useCallback(() => {
    const map = mapRef.current
    const AMap = (window as any).AMap
    if (!map || !AMap) return

    const infoWindow = infoWindowRef.current
    markersRef.current.forEach((marker) => marker.setMap?.(null))
    markersRef.current = []

    const markers = museumsWithCoordinates.map((museum) => {
      const marker = new AMap.Marker({
        position: [museum.longitude, museum.latitude],
        content: buildMarkerContent(museum.id === activeMuseum?.id ? "active" : "default"),
        offset: new AMap.Pixel(-11, -11),
        zIndex: museum.id === activeMuseum?.id ? 120 : 80,
        title: museum.name,
      })

      marker.on("mouseover", () => {
        infoWindow?.setContent?.(buildMarkerInfoHtml(museum))
        infoWindow?.open?.(map, [museum.longitude, museum.latitude])
      })

      marker.on("mouseout", () => {
        if (museum.id !== activeMuseum?.id) {
          infoWindow?.close?.()
        }
      })

      marker.on("click", () => {
        navigateToMuseum(museum.id)
      })

      marker.setMap(map)
      return marker
    })

    markersRef.current = markers
  }, [activeMuseum?.id, museumsWithCoordinates, navigateToMuseum])

  useEffect(() => {
    if (mode !== "map" || !mapReady) return
    renderMarkers()
  }, [mapReady, mode, renderMarkers])

  useEffect(() => {
    if (mode !== "map" || !mapReady) return
    const map = mapRef.current
    if (!map) return

    if (activeMuseum?.latitude != null && activeMuseum.longitude != null) {
      map.setZoomAndCenter?.(11, [activeMuseum.longitude, activeMuseum.latitude])
      infoWindowRef.current?.setContent?.(buildMarkerInfoHtml(activeMuseum))
      infoWindowRef.current?.open?.(map, [activeMuseum.longitude, activeMuseum.latitude])
      return
    }

    if (markersRef.current.length > 0) {
      map.setFitView?.(markersRef.current, false, [56, 56, 56, 56])
    }
  }, [activeMuseum, mapReady, mode])

  const renderMuseumStage = () => {
    if (!activeMuseum) {
      return (
        <div className="empty-state museum-empty-state">
          <strong>没有可展示的博物馆</strong>
          <p className="muted">试试调整搜索词，或等待数据同步完成。</p>
        </div>
      )
    }

    return (
      <section className="museum-stage">
        <header className="museum-stage-head">
          <div className="museum-stage-copy">
            <div className="museum-stage-title-row">
              <div>
                <h3 id="museum-detail-title">{activeMuseum.name}</h3>
                <p className="museum-stage-meta-line">
                  {activeMuseum.description?.trim() || activeMuseum.location?.trim() || "暂无简介，可先浏览这座馆的历年展览。"}
                </p>
              </div>
              <div className="museum-stage-stats" aria-label="博物馆概况">
                <span>{activeMuseum.artifact_count} 件文物</span>
                <span>{activeMuseum.exhibition_count} 个展览</span>
                <span>{activeMuseum.location || "地点未记录"}</span>
              </div>
            </div>
          </div>
        </header>

        <section className="museum-history-panel">
          <div className="museum-history-head">
            <div>
              <strong>历年展览</strong>
              <p className="muted small">
                {activeMuseum.first_year && activeMuseum.last_year
                  ? `${activeMuseum.first_year}—${activeMuseum.last_year} 年展览档案`
                  : "按公开展览目录持续补全"}
              </p>
            </div>
            <div className="museum-history-actions">
              <span>
                {activeHistory
                  ? `已载入 ${activeHistory.items.length} / ${activeHistory.total}`
                  : `${activeMuseum.catalog_exhibition_count} 场`}
              </span>
              {activeHistory && activeHistory.total > 0 ? (
                <button
                  type="button"
                  className="museum-history-toggle"
                  aria-expanded={historyExpanded}
                  onClick={() => setHistoryExpanded((current) => !current)}
                >
                  {historyExpanded ? "收起历史" : "展开全部"}
                </button>
              ) : null}
            </div>
          </div>

          {historyLoadingId === activeMuseum.id && !activeHistory ? (
            <div className="museum-history-state">正在读取历年展览…</div>
          ) : null}
          {activeHistoryError ? (
            <div className="museum-history-state error">
              <span>历年展览暂时无法加载（{activeHistoryError}）</span>
              <Button size="small" onClick={() => void loadMuseumHistory(activeMuseum)}>重试</Button>
            </div>
          ) : null}
          {!activeHistoryError && activeHistory && activeHistory.items.length === 0 ? (
            <div className="museum-history-state">这座馆暂未关联到公开展览目录。</div>
          ) : null}

          {activeHistory ? (
            <section className="museum-current-year-timeline" aria-label={`${currentHistoryYear} 年展览时间轴`}>
              <div className="museum-current-year-timeline-head">
                <strong>{currentHistoryYear} 年时间轴</strong>
                <span>{currentYearExhibitions.length} 场临展</span>
              </div>
              {currentYearExhibitions.length > 0 ? (
                <div className="museum-current-year-timeline-scroll">
                  <div className="museum-current-year-timeline-grid" style={{ gridTemplateRows: `38px repeat(${Math.max(1, ...currentYearTimeline.map((item) => item.lane + 1))}, 22px)` }}>
                    {Array.from({ length: 12 }, (_, index) => (
                      <span className="museum-current-year-month" key={index} style={{ gridColumn: index + 1, gridRow: 1 }}>{index + 1}月</span>
                    ))}
                    {currentYearTimeline.map(({ exhibition, startMonth, endMonth, lane, tone }) => (
                      <a
                        href={`/exhibitions/${exhibition.id}`}
                        className={`museum-current-year-timeline-bar tone-${tone}`}
                        key={exhibition.id}
                        style={{ gridColumn: `${startMonth} / ${endMonth + 1}`, gridRow: lane + 2 }}
                        title={`${exhibition.title}｜${formatDateRange(exhibition.start_date, exhibition.end_date)}`}
                      >
                        <span>{exhibition.title}</span>
                      </a>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="museum-current-year-empty">本年度暂无已归档展览，可展开查看历年记录。</div>
              )}
            </section>
          ) : null}

          {historyExpanded && historyGroups.length > 0 ? (
            <div className="museum-history-years museum-history-years-expanded">
              {historyGroups.map(([year, exhibitions]) => (
                <section className="museum-history-year" key={year}>
                  <strong>{year}</strong>
                  <div>
                    {exhibitions.map((exhibition) => (
                      <a
                        href={`/exhibitions/${exhibition.id}`}
                        className="museum-history-item"
                        key={exhibition.id}
                      >
                        <span className={`museum-history-status ${exhibition.status}`}>
                          {exhibition.status === "ongoing"
                            ? "展出中"
                            : exhibition.status === "upcoming"
                              ? "即将开始"
                              : exhibition.status === "permanent"
                                ? "常设"
                                : "已结束"}
                        </span>
                        <span className="museum-history-copy">
                          <strong>{exhibition.title}</strong>
                          <span>{formatDateRange(exhibition.start_date, exhibition.end_date)}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}

          {activeHistory && activeHistory.items.length < activeHistory.total ? (
            <Button
              size="small"
              loading={historyLoadingId === activeMuseum.id}
              onClick={() => void loadMuseumHistory(activeMuseum, activeHistory.page + 1)}
            >
              加载更早展览
            </Button>
          ) : null}
        </section>

        <div className="museum-stage-body">
          <aside className="museum-folder-column">
            <div className="museum-folder-column-head">
              <div>
                <strong>展览文件夹</strong>
                <p className="muted small">按展览组织这座馆的拍摄记录</p>
              </div>
              <span className="muted small">{folders.length} 组</span>
            </div>

            {artifactLoadingId === activeMuseum.id && !activeArtifactsLoaded ? (
              <div className="museum-state-card">
                <span className="muted">正在整理这座馆的拍摄图片...</span>
              </div>
            ) : null}

            {activeArtifactError ? <p className="error-text">{activeArtifactError}</p> : null}

            {!activeArtifactError && activeArtifactsLoaded && folders.length === 0 ? (
              <div className="museum-state-card">
                <strong>还没有可展示的图片</strong>
                <p className="muted">这座馆已有记录，但暂时还没有可归入展览文件夹的图片。</p>
              </div>
            ) : null}

            <div className="museum-folder-list">
              {folders.map((folder) => (
                <button data-ui="interactive-surface"
                  type="button"
                  key={folder.key}
                  className={`museum-folder-card ${activeFolder?.key === folder.key ? "active" : ""}`}
                  onClick={() => setActiveFolderKey(folder.key)}
                >
                  <span className="museum-folder-icon" aria-hidden="true" />
                  <div className="museum-folder-text">
                    <strong>{folder.name}</strong>
                    <span>{folder.imageCount} 张图片 · {folder.artifactCount} 件文物</span>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <main className="museum-image-panel">
            {activeFolder ? (
              <>
                <div className="museum-image-panel-head">
                  <div>
                    <h4>{activeFolder.name}</h4>
                    <p className="muted">{activeFolder.period}</p>
                  </div>
                  <div className="museum-image-panel-meta">
                    <span className="museum-image-panel-count">{activeFolder.imageCount} 张图片</span>
                    <span className="museum-image-panel-count subtle">{activeFolder.artifactCount} 件文物</span>
                  </div>
                </div>

                <div className="museum-artifact-grid">
                  {activeFolder.entries.map((entry) => (
                    <button data-ui="interactive-surface"
                      type="button"
                      key={entry.artifactId}
                      className="museum-artifact-card"
                      onClick={() => navigateToArtifact(entry.artifactId)}
                    >
                      <FallbackImage
                        src={entry.previewUrl}
                        fallbackSrc={entry.fallbackUrl}
                        alt={entry.artifactName}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                      <div className="museum-artifact-card-copy">
                        <strong>{entry.artifactName}</strong>
                        <span>{entry.artifactEra || "时代待确认"}</span>
                        <span>{entry.imageCount} 张图片</span>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="museum-state-card spacious">
                <strong>先选择一个展览文件夹</strong>
                <p className="muted">这里会按展览展开该博物馆的图片，并保留文物名称与拍摄时间。</p>
              </div>
            )}
          </main>
        </div>
      </section>
    )
  }

  if (detailMuseumId != null) {
    return (
      <section className="museum-console museum-detail-page" aria-labelledby="museum-detail-title">
        <header className="museum-detail-page-head">
          <div>
            <span className="page-kicker">MUSEUM DIRECTORY</span>
            <h2>场馆详情</h2>
          </div>
          <Button onClick={returnToDirectory}>返回场馆列表</Button>
        </header>
        {loading ? (
          <div className="museum-state-card spacious">
            <strong>正在载入场馆详情…</strong>
            <p className="muted">正在从图库读取文物与图片，请稍候。</p>
          </div>
        ) : renderMuseumStage()}
      </section>
    )
  }

  return (
    <section className="museum-console" aria-labelledby="museum-page-title">
      <div className="museum-console-head">
        <div className="museum-page-copy">
          <span className="page-kicker">MUSEUM DIRECTORY</span>
          <h2 id="museum-page-title">博物馆浏览</h2>
          <p>仅展示图库中已上传图片的博物馆；选馆后可按展览查看图像与地点档案。</p>
        </div>

        <div className="museum-console-tools">
          <Segmented<MuseumMode>
            aria-label="博物馆展示模式"
            value={mode}
            options={[
              { label: "卡片模式", value: "cards" },
              { label: "地图模式", value: "map" },
            ]}
            onChange={setMode}
          />

          <label className="gallery-search museum-search">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索博物馆名称、地点或简介"
              aria-label="搜索博物馆"
            />
          </label>
        </div>
      </div>

      <p className="museum-console-summary">
        {filteredMuseums.length} / {items.length} 座有图库图片的博物馆，{museumsWithCoordinates.length} 座已落点
      </p>

      {error ? <p className="error-text">{error}</p> : null}

      {loading ? (
        <div className="museum-state-card">
          <span className="muted">正在加载博物馆目录...</span>
        </div>
      ) : null}

      {!loading && filteredMuseums.length === 0 ? (
        <div className="empty-state museum-empty-state">
          <strong>没有匹配到博物馆</strong>
          <p className="muted">试试搜索馆名、地点，或输入简介里的关键词。</p>
        </div>
      ) : null}

      {!loading && filteredMuseums.length > 0 && mode === "cards" ? (
        <div className="museum-card-grid">
          {filteredMuseums.map((museum) => {
              const artifactPreviews = getMuseumPreviewStack(apiBaseUrl, artifactStore[museum.id] ?? [])
              const previewStack = artifactPreviews.length > 0
                ? artifactPreviews
                : museum.cover_url
                  ? [getDisplayImageUrl(apiBaseUrl, museum.cover_url, "thumb")]
                  : []
              return (
                <button data-ui="interactive-surface"
                  type="button"
                  key={museum.id}
                  className={`museum-summary-card ${activeMuseum?.id === museum.id ? "active" : ""}`}
                  onClick={() => {
                    navigateToMuseum(museum.id)
                  }}
                  onMouseEnter={() => ensureMuseumArtifacts(museum)}
                  onFocus={() => ensureMuseumArtifacts(museum)}
                >
                  <div className={`museum-summary-photo-stack ${previewStack.length === 0 ? "empty" : ""}`} aria-hidden="true">
                    {previewStack.length > 0 ? (
                      previewStack.map((previewUrl, index) => (
                        <FallbackImage
                          key={`${museum.id}-preview-${index}`}
                          className={`museum-summary-photo photo-${index + 1}`}
                          src={previewUrl}
                          fallbackSrc={museum.cover_url ? toAbsoluteUrl(apiBaseUrl, museum.cover_url) : undefined}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ))
                    ) : (
                      <svg
                        className="museum-summary-empty-icon"
                        viewBox="0 0 1024 1024"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          className="museum-summary-empty-icon-shape"
                          d="M831.7 369.4H193.6L64 602v290.3h897.2V602L831.7 369.4zM626.6 604.6c0 62.9-51 113.9-114 113.9s-114-51-114-113.9H117.5l103.8-198h582.5l103.8 198h-281zM502.2 131h39.1v140.6h-39.1zM236.855 200.802l27.647-27.647 99.419 99.418-27.648 27.648zM667.547 272.637l99.418-99.419 27.648 27.648-99.418 99.418z"
                        />
                      </svg>
                    )}
                  </div>
                  <div className="museum-summary-card-copy">
                    <div className="museum-summary-card-head">
                      <strong>{museum.name}</strong>
                      <span>
                        {museum.artifact_count > 0
                          ? `${museum.artifact_count} 件`
                          : museum.derived_from_catalog
                            ? "目录补全"
                            : "暂无藏品"}
                      </span>
                    </div>
                    <p>{museum.description?.trim() || museum.location?.trim() || "暂无简介，先从展览文件夹进入。"}</p>
                    <div className="museum-summary-card-foot">
                      <span>{museum.exhibition_count} 个展览</span>
                      <span>
                        {museum.first_year
                          ? `${museum.first_year}—${museum.last_year ?? "至今"}`
                          : museum.latitude != null && museum.longitude != null
                            ? "已记录坐标"
                            : "时间待补全"}
                      </span>
                    </div>
                  </div>
                </button>
              )
          })}
        </div>
      ) : null}

      {!loading && filteredMuseums.length > 0 && mode === "map" ? (
        <div className="museum-map-layout">
          <section className="museum-map-panel">
            <div className="museum-map-panel-head">
              <div>
                <h3>按坐标浏览博物馆</h3>
                <p className="muted">悬停看简介，点击进入详情。</p>
              </div>
            </div>

            <div className="museum-map-frame">
              <div ref={mapContainerRef} className="museum-map-canvas" />
              {mapLoading ? (
                <div className="museum-map-overlay">
                  <span className="muted">地图加载中...</span>
                </div>
              ) : null}
              {mapError ? (
                <div className="museum-map-overlay error">
                  <span>{mapError}</span>
                </div>
              ) : null}
            </div>
          </section>

          {renderMuseumStage()}
        </div>
      ) : null}
    </section>
  )
}
