/* Shared geocoding helpers are intentionally colocated with the map widget. */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from "react"

type AMapEvent = { lnglat?: { getLng: () => number; getLat: () => number } }
type AMapGeocodeLocation = { getLng?: () => number; getLat?: () => number; lng?: number; lat?: number }
type AMapInstance = { on: (event: string, handler: (event: AMapEvent) => void) => void; clearMap: () => void; setZoomAndCenter: (zoom: number, center: [number, number]) => void; add: (marker: unknown) => void; destroy?: () => void }
type AMapSdk = {
  Map: new (element: HTMLDivElement, options: Record<string, unknown>) => AMapInstance
  Marker: new (options: Record<string, unknown>) => { on: (event: string, handler: (event: AMapEvent) => void) => void }
  Geocoder?: new (options: Record<string, unknown>) => { getAddress: (position: [number, number], callback: (status: string, result: { regeocode?: { formattedAddress?: string } }) => void) => void; getLocation: (address: string, callback: (status: string, result: { geocodes?: Array<{ location?: AMapGeocodeLocation }> }) => void) => void }
  PlaceSearch?: new (options: Record<string, unknown>) => { search: (keyword: string, callback: (status: string, result: { poiList?: { pois?: Array<{ location?: AMapGeocodeLocation }> } }) => void) => void }
  plugin?: (plugins: string | string[], callback: () => void) => void
}

declare global { interface Window { AMap?: AMapSdk; _AMapSecurityConfig?: Record<string, string> } }

const scriptId = import.meta.env.VITE_AMAP_SCRIPT_ID as string | undefined ?? "museum-console-amap-script"
const securityCode = import.meta.env.VITE_AMAP_SECURITY_CODE as string | undefined
const scriptSrc = import.meta.env.VITE_AMAP_SCRIPT_SRC as string | undefined
let loadPromise: Promise<AMapSdk> | null = null
const GEOCODING_FAILURE_COOLDOWN_MS = 45_000
let geocodingDisabledUntil = 0
const DEFAULT_CENTER: [number, number] = [116.397428, 39.90923]

function markGeocodingFailure() {
  geocodingDisabledUntil = Date.now() + GEOCODING_FAILURE_COOLDOWN_MS
}

function markGeocodingSuccess() {
  if (geocodingDisabledUntil <= Date.now()) geocodingDisabledUntil = 0
}

function parseCoordinate(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function getMapCoordinates(latitude: number | null, longitude: number | null): [number, number] | null {
  if (latitude === null || longitude === null) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return [longitude, latitude]
}

function loadAmap(): Promise<AMapSdk> {
  if (loadPromise) return loadPromise
  if (!scriptSrc) return Promise.reject(new Error("未配置高德地图脚本"))
  if (securityCode) window._AMapSecurityConfig = { securityJsCode: securityCode }
  const ensureGeocoder = (sdk: AMapSdk) => {
    if (sdk.Geocoder && sdk.PlaceSearch) return Promise.resolve(sdk)
    if (!sdk.plugin) return Promise.reject(new Error("高德地图地理编码插件不可用"))
    return new Promise<AMapSdk>((resolve, reject) => {
      let settled = false
      const timer = window.setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error("高德地图地理编码插件加载超时"))
      }, 8000)
      const finish = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (sdk.Geocoder && sdk.PlaceSearch) resolve(sdk)
        else reject(new Error("高德地图地理编码插件加载失败"))
      }
      try {
        sdk.plugin?.(["AMap.Geocoder", "AMap.PlaceSearch"], finish)
      } catch (error) {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error("高德地图地理编码插件加载失败"))
      }
    })
  }
  const loadScript = new Promise<AMapSdk>((resolve, reject) => {
    if (window.AMap) return resolve(window.AMap)
    let settled = false
    const timeoutId = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error("高德地图脚本加载超时"))
    }, 10000)
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      if (window.AMap) resolve(window.AMap)
      else reject(new Error("高德地图脚本未初始化"))
    }
    const fail = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      reject(new Error("高德地图脚本加载失败"))
    }
    if (existing) { existing.addEventListener("load", finish, { once: true }); existing.addEventListener("error", fail, { once: true }); return }
    const script = document.createElement("script")
    script.id = scriptId; script.src = scriptSrc; script.async = true; script.onload = finish; script.onerror = fail; document.head.appendChild(script)
  })
  loadPromise = loadScript.then(ensureGeocoder).catch((error) => { loadPromise = null; throw error })
  return loadPromise
}

export async function geocodeLocationName(name: string): Promise<{ latitude: number; longitude: number } | null> {
  if (geocodingDisabledUntil > Date.now()) return null
  let sdk: AMapSdk
  try {
    sdk = await loadAmap()
  } catch {
    markGeocodingFailure()
    return null
  }
  const coordinateFromLocation = (location?: AMapGeocodeLocation) => {
    const longitude = location?.getLng?.() ?? location?.lng; const latitude = location?.getLat?.() ?? location?.lat
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude: Number(latitude), longitude: Number(longitude) } : null
  }
  const withTimeout = <T,>(register: (finish: (value: T) => void) => void, fallback: T) => new Promise<T>((resolve) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      markGeocodingFailure()
      resolve(fallback)
    }, 8000)
    register((value) => { if (settled) return; settled = true; window.clearTimeout(timer); resolve(value) })
  })

  if (sdk.Geocoder) {
    const Geocoder = sdk.Geocoder
    const coordinate = await withTimeout<{ latitude: number; longitude: number } | null>((finish) => {
      new Geocoder({ city: "全国" }).getLocation(name, (status, result) => {
        if (status !== "complete") {
          markGeocodingFailure()
          finish(null)
          return
        }
        const value = coordinateFromLocation(result?.geocodes?.[0]?.location)
        if (value) markGeocodingSuccess()
        finish(value)
      })
    }, null)
    if (coordinate) return coordinate
    if (geocodingDisabledUntil > Date.now()) return null
  }

  if (!sdk.PlaceSearch) return null
  const PlaceSearch = sdk.PlaceSearch
  return withTimeout<{ latitude: number; longitude: number } | null>((finish) => {
    new PlaceSearch({ city: "全国", citylimit: false, pageSize: 10 }).search(name, (status, result) => {
      if (status !== "complete") {
        markGeocodingFailure()
        finish(null)
        return
      }
      const location = status === "complete" ? result.poiList?.pois?.[0]?.location : undefined
      const value = coordinateFromLocation(location)
      if (value) markGeocodingSuccess()
      finish(value)
    })
  }, null)
}

export async function reverseGeocodeCoordinates(latitude: number, longitude: number): Promise<string> {
  if (geocodingDisabledUntil > Date.now()) return ""
  let Geocoder: AMapSdk["Geocoder"]
  try {
    Geocoder = (await loadAmap()).Geocoder
  } catch {
    markGeocodingFailure()
    return ""
  }
  if (!Geocoder) return ""
  return new Promise((resolve) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      markGeocodingFailure()
      resolve("")
    }, 8000)
    new Geocoder({}).getAddress([longitude, latitude], (status, result) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      if (status !== "complete") {
        markGeocodingFailure()
        resolve("")
        return
      }
      markGeocodingSuccess()
      resolve(result?.regeocode?.formattedAddress?.trim() ?? "")
    })
  })
}

export function GpsMapPicker({ latitude, longitude, onPick }: { latitude: string; longitude: string; onPick: (latitude: string, longitude: string, locationName?: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null); const mapRef = useRef<AMapInstance | null>(null); const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading")
  const onPickRef = useRef(onPick)
  const initialCoordinatesRef = useRef({ latitude, longitude })
  useEffect(() => { onPickRef.current = onPick }, [onPick])
  function applyPoint(event: AMapEvent) {
    if (!event.lnglat) return
    const nextLatitude = event.lnglat.getLat().toFixed(6); const nextLongitude = event.lnglat.getLng().toFixed(6)
    onPickRef.current(nextLatitude, nextLongitude)
  }
  useEffect(() => {
    if (!containerRef.current || !scriptSrc) { setState("missing"); return }
    let disposed = false
    const mount = async () => { try {
      const AMap = await loadAmap(); if (disposed || !containerRef.current) return
      const initialCoordinates = initialCoordinatesRef.current
      const coordinates = getMapCoordinates(parseCoordinate(initialCoordinates.latitude), parseCoordinate(initialCoordinates.longitude))
      const center = coordinates ?? DEFAULT_CENTER
      const map = new AMap.Map(containerRef.current, { zoom: 15, center }); map.on("click", (event) => { void applyPoint(event) })
      if (coordinates) { const marker = new AMap.Marker({ position: coordinates, draggable: true }); marker.on("dragend", (event) => { void applyPoint(event) }); map.add(marker) }
      mapRef.current = map; setState("ready")
    } catch { if (!disposed) setState("error") } }
    void mount(); return () => { disposed = true; mapRef.current?.destroy?.(); mapRef.current = null }
  }, [])
  useEffect(() => {
    const coordinates = getMapCoordinates(parseCoordinate(latitude), parseCoordinate(longitude)); const map = mapRef.current
    if (!map || !window.AMap) return
    map.clearMap()
    if (!coordinates) return
    map.setZoomAndCenter(15, coordinates); const marker = new window.AMap.Marker({ position: coordinates, draggable: true }); marker.on("dragend", (event) => { void applyPoint(event) }); map.add(marker)
  }, [latitude, longitude, state])
  if (state === "missing") return <p className="muted gps-map-hint">高德地图配置未载入，请检查前端重启后是否读取项目 .env。</p>
  if (state === "error") return <p className="error-text">地图加载失败，请直接填写坐标。</p>
  return <div className="gps-map-wrap"><div ref={containerRef} className="gps-map" />{state === "loading" ? <span>正在加载地图…</span> : null}</div>
}
