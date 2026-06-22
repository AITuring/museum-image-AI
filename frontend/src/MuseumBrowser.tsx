import { useCallback, useEffect, useMemo, useRef, useState } from "react"

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
  name: string
  location: string | null
  latitude: number | null
  longitude: number | null
  description: string | null
  artifact_count: number
  exhibition_count: number
  created_at: string
  exhibitions: MuseumExhibition[]
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
  imageId: number
  artifactId: number
  artifactName: string
  artifactEra: string | null
  previewUrl: string
  originalUrl: string
  capturedAt: string | null
}

function toAbsoluteUrl(apiBaseUrl: string, url: string) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${apiBaseUrl}${url}`
}

function isOssImageUrl(url: string) {
  return /^https:\/\/.+\.aliyuncs\.com\//.test(url)
}

function withOssImageProcess(url: string, process: string) {
  if (!isOssImageUrl(url)) return url
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}x-oss-process=${encodeURIComponent(process)}`
}

function getDisplayImageUrl(apiBaseUrl: string, url: string, mode: "thumb" | "preview" | "original") {
  const absoluteUrl = toAbsoluteUrl(apiBaseUrl, url)
  if (mode === "original") return absoluteUrl
  if (mode === "thumb") {
    return withOssImageProcess(absoluteUrl, "image/resize,m_lfit,w_480/quality,q_75/format,webp")
  }
  return withOssImageProcess(absoluteUrl, "image/resize,m_lfit,w_1280/quality,q_82/format,webp")
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

function formatCapturedAt(value: string | null | undefined) {
  if (!value) return "拍摄时间未记录"
  return value.replace("T", " ").slice(0, 16)
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

    artifact.images.forEach((image) => {
      const exhibitionName = image.exhibition_name?.trim() || artifact.exhibitions[0]?.name || "未归档展览"
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

      const previewUrl = getDisplayImageUrl(apiBaseUrl, image.url, "preview")
      current.entries.push({
        imageId: image.id,
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactEra: artifact.era,
        previewUrl,
        originalUrl: getDisplayImageUrl(apiBaseUrl, image.url, "original"),
        capturedAt: image.captured_at ?? null,
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
  const [artifactStore, setArtifactStore] = useState<Record<number, MuseumArtifact[]>>({})
  const [artifactLoadingId, setArtifactLoadingId] = useState<number | null>(null)
  const [artifactErrors, setArtifactErrors] = useState<Record<number, string | null>>({})
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
    () => filteredMuseums.find((museum) => museum.id === activeId) ?? filteredMuseums[0] ?? null,
    [activeId, filteredMuseums],
  )

  const activeArtifactsLoaded = activeMuseum ? Object.prototype.hasOwnProperty.call(artifactStore, activeMuseum.id) : false
  const activeArtifacts = activeMuseum ? artifactStore[activeMuseum.id] ?? [] : []
  const activeArtifactError = activeMuseum ? artifactErrors[activeMuseum.id] ?? null : null
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
      const response = await fetch(`${apiBaseUrl}/api/museums?limit=500`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = ((await response.json()) as MuseumRecord[]).map((item) => normalizeMuseumCoordinates(item))
      setItems(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载博物馆失败")
    } finally {
      setLoading(false)
    }
  }, [apiBaseUrl])

  const loadMuseumArtifacts = useCallback(
    async (museumId: number) => {
      setArtifactLoadingId(museumId)
      setArtifactErrors((current) => ({ ...current, [museumId]: null }))
      try {
        const response = await fetch(`${apiBaseUrl}/api/artifacts?museum_id=${museumId}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = ((await response.json()) as RawMuseumArtifact[]).map((item) => normalizeArtifact(item))
        setArtifactStore((current) => ({ ...current, [museumId]: payload }))
      } catch (err) {
        setArtifactErrors((current) => ({
          ...current,
          [museumId]: err instanceof Error ? err.message : "加载博物馆图片失败",
        }))
        setArtifactStore((current) => ({ ...current, [museumId]: [] }))
      } finally {
        setArtifactLoadingId((current) => (current === museumId ? null : current))
      }
    },
    [apiBaseUrl],
  )

  const ensureMuseumArtifacts = useCallback(
    (museumId: number) => {
      if (Object.prototype.hasOwnProperty.call(artifactStore, museumId)) return
      void loadMuseumArtifacts(museumId)
    },
    [artifactStore, loadMuseumArtifacts],
  )

  useEffect(() => {
    void loadMuseums()
  }, [loadMuseums])

  useEffect(() => {
    if (!activeMuseum) return
    if (Object.prototype.hasOwnProperty.call(artifactStore, activeMuseum.id)) return
    void loadMuseumArtifacts(activeMuseum.id)
  }, [activeMuseum, artifactStore, loadMuseumArtifacts])

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
        setActiveId(museum.id)
        infoWindow?.setContent?.(buildMarkerInfoHtml(museum))
        infoWindow?.open?.(map, [museum.longitude, museum.latitude])
      })

      marker.setMap(map)
      return marker
    })

    markersRef.current = markers
  }, [activeMuseum?.id, museumsWithCoordinates])

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
            <h3>{activeMuseum.name}</h3>
            <p className="museum-stage-meta-line">
              {activeMuseum.artifact_count} 件文物 · {activeMuseum.exhibition_count} 个展览 · {activeMuseum.location || "地点未记录"}
            </p>
            <p className="muted">
              {activeMuseum.description?.trim() || activeMuseum.location?.trim() || "暂无简介，先通过图片浏览这座馆的拍摄记录。"}
            </p>
          </div>
        </header>

        <div className="museum-stage-body">
          <div className="museum-folder-column">
            <div className="museum-folder-column-head">
              <strong>展览文件夹</strong>
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

            <div className="museum-folder-grid">
              {folders.map((folder) => (
                <button
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
          </div>

          <div className="museum-image-panel">
            {activeFolder ? (
              <>
                <div className="museum-image-panel-head">
                  <div>
                    <h4>{activeFolder.name}</h4>
                    <p className="muted">{activeFolder.period}</p>
                  </div>
                  <span className="museum-image-panel-count">{activeFolder.imageCount} 张图片</span>
                </div>

                <div className="museum-image-grid">
                  {activeFolder.entries.map((entry) => (
                    <a
                      key={`${entry.artifactId}-${entry.imageId}`}
                      className="museum-image-card"
                      href={entry.originalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img src={entry.previewUrl} alt={entry.artifactName} loading="lazy" />
                      <div className="museum-image-card-copy">
                        <strong>{entry.artifactName}</strong>
                        <span>{entry.artifactEra || "时代待确认"}</span>
                        <span>{formatCapturedAt(entry.capturedAt)}</span>
                      </div>
                    </a>
                  ))}
                </div>
              </>
            ) : (
              <div className="museum-state-card spacious">
                <strong>先选择一个展览文件夹</strong>
                <p className="muted">这里会按展览展开该博物馆的图片，并保留文物名称与拍摄时间。</p>
              </div>
            )}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="panel form-wide museum-console">
      <div className="museum-console-head">
        <div className="section-heading">
          <span className="step-badge">M</span>
          <div>
            <h2>博物馆浏览</h2>
            <p className="muted">先选博物馆，再按展览看图片；地图和卡片共用同一套详情。</p>
          </div>
        </div>

        <div className="museum-console-tools">
          <div className="museum-mode-switch" aria-label="博物馆展示模式">
            <button type="button" className={mode === "cards" ? "active" : ""} onClick={() => setMode("cards")}>
              卡片模式
            </button>
            <button type="button" className={mode === "map" ? "active" : ""} onClick={() => setMode("map")}>
              地图模式
            </button>
          </div>

          <label className="gallery-search museum-search">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索博物馆名称、地点或简介"
              aria-label="搜索博物馆"
            />
          </label>
        </div>
      </div>

      <p className="museum-console-summary">
        {filteredMuseums.length} / {items.length} 座博物馆，{museumsWithCoordinates.length} 座已落点
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
        <>
          <div className="museum-card-grid">
            {filteredMuseums.map((museum) => {
              const previewStack = getMuseumPreviewStack(apiBaseUrl, artifactStore[museum.id] ?? [])
              return (
                <button
                  type="button"
                  key={museum.id}
                  className={`museum-summary-card ${activeMuseum?.id === museum.id ? "active" : ""}`}
                  onClick={() => setActiveId(museum.id)}
                  onMouseEnter={() => ensureMuseumArtifacts(museum.id)}
                  onFocus={() => ensureMuseumArtifacts(museum.id)}
                >
                  <div className={`museum-summary-photo-stack ${previewStack.length === 0 ? "empty" : ""}`} aria-hidden="true">
                    {previewStack.length > 0 ? (
                      previewStack.map((previewUrl, index) => (
                        <img
                          key={`${museum.id}-preview-${index}`}
                          className={`museum-summary-photo photo-${index + 1}`}
                          src={previewUrl}
                          alt=""
                          loading="lazy"
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
                      <span>{museum.artifact_count} 件</span>
                    </div>
                    <p>{museum.description?.trim() || museum.location?.trim() || "暂无简介，先从展览文件夹进入。"}</p>
                    <div className="museum-summary-card-foot">
                      <span>{museum.exhibition_count} 个展览</span>
                      <span>{museum.latitude != null && museum.longitude != null ? "已记录坐标" : "未记录坐标"}</span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
          {renderMuseumStage()}
        </>
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
