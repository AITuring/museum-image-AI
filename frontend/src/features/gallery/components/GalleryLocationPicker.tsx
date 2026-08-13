import { Button, Input } from "antd"
import { Search } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

const AMAP_SCRIPT_ID = "museum-console-amap-script"
const AMAP_SECURITY_CODE = "3ba01835420271d5405dccba5e089b46"
const AMAP_SCRIPT_SRC =
  "https://webapi.amap.com/maps?v=2.0&key=7a9513e700e06c00890363af1bd2d926&plugin=AMap.PlaceSearch,AMap.Geocoder"

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

type Props = {
  latitude: string
  longitude: string
  locationText: string
  onChange(next: { latitude: string; longitude: string }): void
  onLocationTextChange(next: string): void
}

export function GalleryLocationPicker({
  latitude,
  longitude,
  locationText,
  onChange,
  onLocationTextChange,
}: Props) {
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
  }, [latitude, longitude, onChange, onLocationTextChange, reverseLookup])

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
        <Button htmlType="button" type="default" onClick={() => void handleResolveLocation()} disabled={mapLoading}>
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
