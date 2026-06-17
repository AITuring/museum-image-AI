import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"

const AMAP_SCRIPT_ID = "museum-console-amap-script"
const AMAP_SECURITY_CODE = "3ba01835420271d5405dccba5e089b46"
const AMAP_SCRIPT_SRC =
  "https://webapi.amap.com/maps?v=1.4.15&key=7a9513e700e06c00890363af1bd2d926&plugin=AMap.PlaceSearch,AMap.Geocoder"

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

type MuseumEditForm = {
  name: string
  location: string
  latitude: string
  longitude: string
  description: string
}

function buildMuseumEditForm(museum: MuseumRecord): MuseumEditForm {
  return {
    name: museum.name ?? "",
    location: museum.location ?? "",
    latitude: museum.latitude?.toString() ?? "",
    longitude: museum.longitude?.toString() ?? "",
    description: museum.description ?? "",
  }
}

function parseOptionalNumber(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label}格式不正确`)
  }
  return parsed
}

function formatCoordinate(latitude: number | null, longitude: number | null) {
  if (latitude == null || longitude == null) return "未记录"
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
}

function formatDateRange(startAt: string | null, endAt: string | null) {
  if (!startAt && !endAt) return "时间未记录"
  return `${startAt?.slice(0, 10) ?? "未知"} - ${endAt?.slice(0, 10) ?? "至今"}`
}

function parseCoordinateValue(value: string) {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function getMuseumCoordinates(museum: MuseumRecord | null) {
  if (!museum || museum.latitude == null || museum.longitude == null) return null
  return { lng: museum.longitude, lat: museum.latitude }
}

function getEditFormCoordinates(editForm: MuseumEditForm | null) {
  if (!editForm) return null
  const lat = parseCoordinateValue(editForm.latitude)
  const lng = parseCoordinateValue(editForm.longitude)
  if (lat == null || lng == null) return null
  return { lng, lat }
}

function createMarkerContent(kind: "default" | "active" | "edit") {
  const element = document.createElement("div")
  element.className = `museum-map-marker ${kind}`
  return element
}

function formatReverseGeocodeResult(result: any) {
  const regeocode = result?.regeocode
  if (!regeocode) return null

  const poiName = regeocode.pois?.[0]?.name
  const formatted = regeocode.formattedAddress
  const district = [
    regeocode.addressComponent?.province,
    regeocode.addressComponent?.city,
    regeocode.addressComponent?.district,
    regeocode.addressComponent?.township,
  ]
    .filter(Boolean)
    .join("")

  return poiName || formatted || district || null
}

function loadAMapScript() {
  const mapWindow = window as any

  if (mapWindow.AMap) {
    return Promise.resolve(mapWindow.AMap)
  }

  mapWindow._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE }

  return new Promise<any>((resolve, reject) => {
    const existing = document.getElementById(AMAP_SCRIPT_ID) as HTMLScriptElement | null
    if (existing) {
      const handleLoad = () => resolve(mapWindow.AMap)
      const handleError = () => reject(new Error("高德地图加载失败"))
      existing.addEventListener("load", handleLoad, { once: true })
      existing.addEventListener("error", handleError, { once: true })
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

export default function MuseumConsole({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [items, setItems] = useState<MuseumRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<MuseumEditForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [mapLoading, setMapLoading] = useState(true)
  const [mapError, setMapError] = useState<string | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [locatingByName, setLocatingByName] = useState(false)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const museumMarkersRef = useRef<any[]>([])
  const editMarkerRef = useRef<any | null>(null)
  const reverseGeocodeRequestRef = useRef(0)

  const activeMuseum = useMemo(
    () => items.find((item) => item.id === activeId) ?? items[0] ?? null,
    [activeId, items],
  )

  const loadMuseums = useCallback(
    async (q: string) => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ limit: "500" })
        if (q.trim()) params.set("q", q.trim())
        const response = await fetch(`${apiBaseUrl}/api/museums?${params.toString()}`)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const payload = (await response.json()) as MuseumRecord[]
        setItems(payload)
        setActiveId((current) => {
          if (payload.length === 0) return null
          if (current && payload.some((item) => item.id === current)) return current
          return payload[0].id
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载博物馆失败")
      } finally {
        setLoading(false)
      }
    },
    [apiBaseUrl],
  )

  useEffect(() => {
    void loadMuseums("")
  }, [loadMuseums])

  useEffect(() => {
    setEditing(false)
    setEditForm(activeMuseum ? buildMuseumEditForm(activeMuseum) : null)
    setSaveError(null)
    setSaveNotice(null)
  }, [activeMuseum?.id])

  useEffect(() => {
    let disposed = false

    async function initializeMap() {
      if (!mapContainerRef.current || mapRef.current) return
      setMapLoading(true)
      setMapError(null)

      try {
        const AMap = await loadAMapScript()
        if (disposed || !mapContainerRef.current || mapRef.current) return
        const map = new AMap.Map(mapContainerRef.current, {
          zoom: 5,
          center: [104.195397, 35.86166],
          mapStyle: "amap://styles/whitesmoke",
        })
        mapRef.current = map
        map.on("complete", () => {
          if (disposed) return
          setMapReady(true)
          setMapLoading(false)
        })
      } catch (err) {
        if (disposed) return
        setMapLoading(false)
        setMapError(err instanceof Error ? err.message : "地图初始化失败")
      }
    }

    void initializeMap()

    return () => {
      disposed = true
      museumMarkersRef.current.forEach((marker) => marker.setMap?.(null))
      museumMarkersRef.current = []
      editMarkerRef.current?.setMap?.(null)
      editMarkerRef.current = null
      mapRef.current?.destroy?.()
      mapRef.current = null
      setMapReady(false)
    }
  }, [])

  const syncEditCoordinates = useCallback((lng: number, lat: number) => {
    setEditForm((current) =>
      current
        ? {
            ...current,
            latitude: lat.toFixed(6),
            longitude: lng.toFixed(6),
          }
        : current,
    )
  }, [])

  const reverseGeocodeLocation = useCallback(async (lng: number, lat: number) => {
    const AMap = (window as any).AMap
    if (!AMap?.Geocoder) return null

    return new Promise<string | null>((resolve) => {
      const geocoder = new AMap.Geocoder({})
      geocoder.getAddress([lng, lat], (status: string, result: any) => {
        if (status !== "complete") {
          resolve(null)
          return
        }
        resolve(formatReverseGeocodeResult(result))
      })
    })
  }, [])

  const applyCoordinateSelection = useCallback(
    async (lng: number, lat: number, source: "click" | "drag" | "search") => {
      syncEditCoordinates(lng, lat)
      setSaveError(null)

      const sourceText =
        source === "click" ? "已从地图回填坐标，正在反查地点…" : source === "drag" ? "已拖拽修正坐标，正在反查地点…" : "已按馆名定位，正在补全地点…"
      setSaveNotice(sourceText)

      const requestId = reverseGeocodeRequestRef.current + 1
      reverseGeocodeRequestRef.current = requestId
      const location = await reverseGeocodeLocation(lng, lat)
      if (reverseGeocodeRequestRef.current !== requestId) return

      if (location) {
        setEditForm((current) =>
          current
            ? {
                ...current,
                location,
              }
            : current,
        )
        setSaveNotice("已同步坐标并自动回填地点名称，保存后会写入数据库")
      } else {
        setSaveNotice("已更新坐标，但没有反查到地点名称，可手动补充 location")
      }
    },
    [reverseGeocodeLocation, syncEditCoordinates],
  )

  const focusMapOnCoordinates = useCallback((lng: number, lat: number, zoom = 14) => {
    const map = mapRef.current
    if (!map) return
    map.setZoomAndCenter?.(zoom, [lng, lat])
  }, [])

  const handleLocateByName = useCallback(async () => {
    if (!editing || !editForm || !window.AMap?.PlaceSearch) return
    const queryText = editForm.name.trim() || activeMuseum?.name || ""
    if (!queryText) {
      setSaveError("请先填写博物馆名称，再尝试自动定位")
      return
    }

    setLocatingByName(true)
    setSaveError(null)

    try {
      const resolved = await new Promise<{ lng: number; lat: number } | null>((resolve) => {
        const placeSearch = new window.AMap.PlaceSearch({
          city: "全国",
          citylimit: false,
          pageSize: 5,
          pageIndex: 1,
          extensions: "all",
        })
        placeSearch.search(queryText, (_status: string, result: any) => {
          const poi = result?.poiList?.pois?.find((item: any) => item?.location) ?? null
          const loc = poi?.location || poi?._location
          if (!loc) {
            resolve(null)
            return
          }
          resolve({ lng: loc.lng, lat: loc.lat })
        })
      })

      if (!resolved) {
        throw new Error("没有检索到可用坐标，请直接在地图上点击修正")
      }

      await applyCoordinateSelection(resolved.lng, resolved.lat, "search")
      focusMapOnCoordinates(resolved.lng, resolved.lat, 15)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "按馆名定位失败")
    } finally {
      setLocatingByName(false)
    }
  }, [activeMuseum?.name, applyCoordinateSelection, editForm, editing, focusMapOnCoordinates])

  const renderMarkers = useCallback(() => {
    const map = mapRef.current
    const AMap = window.AMap
    if (!map || !AMap) return

    museumMarkersRef.current.forEach((marker) => marker.setMap?.(null))
    museumMarkersRef.current = []
    editMarkerRef.current?.setMap?.(null)
    editMarkerRef.current = null

    const markers = items
      .filter((museum) => museum.latitude != null && museum.longitude != null)
      .map((museum) => {
        const marker = new AMap.Marker({
          position: [museum.longitude, museum.latitude],
          content: createMarkerContent(museum.id === activeMuseum?.id && !editing ? "active" : "default"),
          offset: new AMap.Pixel(-10, -10),
          title: museum.name,
          zIndex: museum.id === activeMuseum?.id ? 120 : 90,
        })
        marker.on("click", () => setActiveId(museum.id))
        marker.setMap(map)
        return marker
      })
    museumMarkersRef.current = markers

    if (editing && activeMuseum) {
      const editCoords = getEditFormCoordinates(editForm) ?? getMuseumCoordinates(activeMuseum)
      if (editCoords) {
        const editMarker = new AMap.Marker({
          position: [editCoords.lng, editCoords.lat],
          content: createMarkerContent("edit"),
          offset: new AMap.Pixel(-12, -12),
          draggable: true,
          zIndex: 180,
          title: `${activeMuseum.name}（编辑中）`,
        })
        editMarker.on("dragend", (event: any) => {
          const lng = event.lnglat?.getLng?.() ?? event.lnglat?.lng
          const lat = event.lnglat?.getLat?.() ?? event.lnglat?.lat
          if (lng == null || lat == null) return
          void applyCoordinateSelection(lng, lat, "drag")
        })
        editMarker.setMap(map)
        editMarkerRef.current = editMarker
      }
    }
  }, [activeMuseum, applyCoordinateSelection, editForm, editing, items])

  useEffect(() => {
    if (!mapReady) return
    renderMarkers()
  }, [mapReady, renderMarkers])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const coordinates =
      (editing ? getEditFormCoordinates(editForm) : null) ??
      getMuseumCoordinates(activeMuseum) ??
      null

    if (coordinates) {
      focusMapOnCoordinates(coordinates.lng, coordinates.lat, editing ? 15 : 13)
      return
    }

    if (museumMarkersRef.current.length > 0) {
      map.setFitView?.(museumMarkersRef.current, false, [64, 64, 64, 64])
    }
  }, [activeMuseum, editForm, editing, focusMapOnCoordinates, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !editing) return

    const handleMapClick = (event: any) => {
      const lng = event.lnglat?.getLng?.() ?? event.lnglat?.lng
      const lat = event.lnglat?.getLat?.() ?? event.lnglat?.lat
      if (lng == null || lat == null) return
      void applyCoordinateSelection(lng, lat, "click")
    }

    map.on("click", handleMapClick)
    return () => {
      map.off?.("click", handleMapClick)
    }
  }, [applyCoordinateSelection, editing, mapReady])

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmittedQuery(query)
    void loadMuseums(query)
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeMuseum || !editForm) return

    setSaving(true)
    setSaveError(null)
    setSaveNotice(null)

    try {
      if (!editForm.name.trim()) {
        throw new Error("请填写博物馆名称")
      }
      const response = await fetch(`${apiBaseUrl}/api/museums/${activeMuseum.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name.trim(),
          location: editForm.location.trim() || null,
          latitude: parseOptionalNumber(editForm.latitude, "纬度"),
          longitude: parseOptionalNumber(editForm.longitude, "经度"),
          description: editForm.description.trim() || null,
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

      const updated = (await response.json()) as MuseumRecord
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setActiveId(updated.id)
      setEditing(false)
      setEditForm(buildMuseumEditForm(updated))
      setSaveNotice("博物馆资料已保存")
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="panel form-wide museum-console">
      <div className="museum-console-head">
        <div className="section-heading">
          <span className="step-badge">M</span>
          <div>
            <h2>博物馆预览与编辑</h2>
            <p className="muted">浏览馆名、地理坐标和展览信息，并直接修正数据库中的博物馆资料。</p>
          </div>
        </div>
        <form className="gallery-search museum-search" onSubmit={handleSearch}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索博物馆名称或地点"
            aria-label="博物馆搜索"
          />
        </form>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      {!loading && items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">🏛️</span>
          <strong>{submittedQuery ? "没有匹配的博物馆" : "暂无博物馆数据"}</strong>
          <p className="muted">{submittedQuery ? "换个关键词试试。" : "参考馆藏同步后，这里会显示博物馆列表。"}</p>
        </div>
      ) : null}

      <div className="museum-console-layout">
        <div className="museum-list">
          {items.map((museum) => (
            <button
              type="button"
              key={museum.id}
              className={`museum-list-item ${activeMuseum?.id === museum.id ? "active" : ""}`}
              onClick={() => setActiveId(museum.id)}
            >
              <div className="museum-list-row">
                <strong>{museum.name}</strong>
                <span className="badge conf">{museum.artifact_count} 件</span>
              </div>
              <span className="museum-list-line">{museum.location || "未填写地点"}</span>
              <span className="museum-list-line">
                {museum.latitude != null && museum.longitude != null ? "已记录坐标" : "缺少坐标"}
              </span>
            </button>
          ))}
        </div>

        <div className="museum-detail">
          {activeMuseum ? (
            <>
              <div className="museum-detail-head">
                <div>
                  <h3 className="gallery-detail-title">{activeMuseum.name}</h3>
                  <p className="muted small">
                    已收录 {activeMuseum.artifact_count} 件文物，{activeMuseum.exhibition_count} 个展览
                  </p>
                </div>
                <div className="gallery-actions">
                  {!editing ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setEditForm(buildMuseumEditForm(activeMuseum))
                        setEditing(true)
                        setSaveError(null)
                        setSaveNotice(null)
                      }}
                    >
                      编辑资料
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setEditing(false)
                        setEditForm(buildMuseumEditForm(activeMuseum))
                        setSaveError(null)
                      }}
                      disabled={saving}
                    >
                      取消编辑
                    </button>
                  )}
                </div>
              </div>

              <section className="museum-map-shell">
                <div className="museum-map-toolbar">
                  <div className="museum-map-status">
                    <strong>地图预览</strong>
                    <span className="muted small">
                      {editing
                        ? "点击地图或拖拽高亮标记，会同时更新坐标并自动反查地点。"
                        : "列表与地图联动，选中博物馆会自动定位。"}
                    </span>
                  </div>
                  <div className="museum-map-actions">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => void handleLocateByName()}
                          disabled={locatingByName || !mapReady}
                        >
                          {locatingByName ? "定位中..." : "按馆名定位"}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => {
                            const original = getMuseumCoordinates(activeMuseum)
                            if (!original) {
                              setEditForm((current) =>
                                current ? { ...current, latitude: "", longitude: "" } : current,
                              )
                              return
                            }
                            syncEditCoordinates(original.lng, original.lat)
                            focusMapOnCoordinates(original.lng, original.lat, 14)
                          }}
                          disabled={!mapReady}
                        >
                          恢复原坐标
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="museum-map-canvas" ref={mapContainerRef}>
                  {mapLoading ? (
                    <div className="museum-map-overlay">
                      <strong>加载地图资源...</strong>
                    </div>
                  ) : null}
                  {mapError ? (
                    <div className="museum-map-overlay error">
                      <strong>地图不可用</strong>
                      <span>{mapError}</span>
                    </div>
                  ) : null}
                </div>
                <div className="museum-map-foot">
                  <span>
                    当前坐标：
                    {editing
                      ? formatCoordinate(
                          parseCoordinateValue(editForm?.latitude ?? ""),
                          parseCoordinateValue(editForm?.longitude ?? ""),
                        )
                      : formatCoordinate(activeMuseum.latitude, activeMuseum.longitude)}
                  </span>
                  <span>{editing ? "保存后写入数据库" : "进入编辑模式后可直接在地图上修正"}</span>
                </div>
              </section>

              {!editing || !editForm ? (
                <div className="gallery-detail-lines museum-detail-lines">
                  <div className="gallery-detail-line">
                    <span className="gallery-detail-label">地点</span>
                    <span className="gallery-detail-value">{activeMuseum.location || "未填写"}</span>
                  </div>
                  <div className="gallery-detail-line">
                    <span className="gallery-detail-label">坐标</span>
                    <span className="gallery-detail-value">
                      {formatCoordinate(activeMuseum.latitude, activeMuseum.longitude)}
                    </span>
                  </div>
                  <div className="gallery-detail-line gallery-detail-desc">
                    <span className="gallery-detail-label">说明</span>
                    <span className="gallery-detail-value">{activeMuseum.description || "暂无说明"}</span>
                  </div>
                  <div className="gallery-detail-line museum-exhibition-line">
                    <span className="gallery-detail-label">展览</span>
                    <div className="museum-exhibition-list">
                      {activeMuseum.exhibitions.length > 0 ? (
                        activeMuseum.exhibitions.map((exhibition) => (
                          <div key={exhibition.id} className="museum-exhibition-item">
                            <strong>{exhibition.name}</strong>
                            <span>{formatDateRange(exhibition.start_at, exhibition.end_at)}</span>
                          </div>
                        ))
                      ) : (
                        <span className="gallery-detail-value">暂无展览记录</span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <form className="gallery-edit-form museum-edit-form" onSubmit={handleSave}>
                  <div className="form-fields">
                    <section className="form-section">
                      <div className="form-section-head">
                        <span className="form-section-kicker">PROFILE</span>
                        <h3>馆藏资料</h3>
                      </div>
                      <div className="form-section-body">
                        <div className="field-row">
                          <label className="field">
                            <span>博物馆名称</span>
                            <input
                              value={editForm.name}
                              onChange={(event) =>
                                setEditForm((current) =>
                                  current ? { ...current, name: event.target.value } : current,
                                )
                              }
                              placeholder="例如：南京博物院"
                            />
                          </label>
                          <label className="field">
                            <span>地点</span>
                            <input
                              value={editForm.location}
                              onChange={(event) =>
                                setEditForm((current) =>
                                  current ? { ...current, location: event.target.value } : current,
                                )
                              }
                              placeholder="例如：南京市玄武区中山东路321号"
                            />
                          </label>
                        </div>
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
                              placeholder="例如：32.040802"
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
                              placeholder="例如：118.825064"
                            />
                          </label>
                        </div>
                        <label className="field">
                          <span>说明</span>
                          <textarea
                            rows={6}
                            value={editForm.description}
                            onChange={(event) =>
                              setEditForm((current) =>
                                current ? { ...current, description: event.target.value } : current,
                              )
                            }
                            placeholder="可补充馆藏说明、来源、校对备注"
                          />
                        </label>
                      </div>
                    </section>
                  </div>

                  <div className="form-footer">
                    {saveError ? (
                      <p className="error-text">{saveError}</p>
                    ) : saveNotice ? (
                      <p className="success-text">{saveNotice}</p>
                    ) : (
                      <span />
                    )}
                    <button type="submit" className="primary" disabled={saving}>
                      {saving ? "保存中..." : "保存博物馆资料"}
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : (
            <div className="empty-state museum-detail-empty">
              <span className="empty-icon">🗂️</span>
              <strong>请选择一座博物馆</strong>
              <p className="muted">左侧会展示当前数据库中的馆藏机构，点击后即可预览和修改。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
