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
  plugin?: (plugins: string | string[], callback: () => void) => void
}

declare global { interface Window { AMap?: AMapSdk; _AMapSecurityConfig?: Record<string, string> } }

const scriptId = import.meta.env.VITE_AMAP_SCRIPT_ID as string | undefined ?? "museum-console-amap-script"
const securityCode = import.meta.env.VITE_AMAP_SECURITY_CODE as string | undefined
const scriptSrc = import.meta.env.VITE_AMAP_SCRIPT_SRC as string | undefined
let loadPromise: Promise<AMapSdk> | null = null

function loadAmap(): Promise<AMapSdk> {
  if (loadPromise) return loadPromise
  if (!scriptSrc) return Promise.reject(new Error("未配置高德地图脚本"))
  if (securityCode) window._AMapSecurityConfig = { securityJsCode: securityCode }
  const ensureGeocoder = (sdk: AMapSdk) => {
    if (sdk.Geocoder) return Promise.resolve(sdk)
    if (!sdk.plugin) return Promise.reject(new Error("高德地图地理编码插件不可用"))
    return new Promise<AMapSdk>((resolve, reject) => sdk.plugin?.(["AMap.Geocoder", "AMap.PlaceSearch"], () => sdk.Geocoder ? resolve(sdk) : reject(new Error("高德地图地理编码插件加载失败"))))
  }
  const loadScript = new Promise<AMapSdk>((resolve, reject) => {
    if (window.AMap) return resolve(window.AMap)
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null
    const finish = () => window.AMap ? resolve(window.AMap) : reject(new Error("高德地图脚本未初始化"))
    if (existing) { existing.addEventListener("load", finish, { once: true }); existing.addEventListener("error", () => reject(new Error("高德地图脚本加载失败")), { once: true }); return }
    const script = document.createElement("script")
    script.id = scriptId; script.src = scriptSrc; script.async = true; script.onload = finish; script.onerror = () => reject(new Error("高德地图脚本加载失败")); document.head.appendChild(script)
  })
  loadPromise = loadScript.then(ensureGeocoder).catch((error) => { loadPromise = null; throw error })
  return loadPromise
}

export async function geocodeLocationName(name: string): Promise<{ latitude: number; longitude: number } | null> {
  const Geocoder = (await loadAmap()).Geocoder
  if (!Geocoder) return null
  return new Promise((resolve) => new Geocoder({ city: "全国" }).getLocation(name, (status, result) => {
    const location = status === "complete" ? result.geocodes?.[0]?.location : undefined
    const longitude = location?.getLng?.() ?? location?.lng; const latitude = location?.getLat?.() ?? location?.lat
    resolve(Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude: Number(latitude), longitude: Number(longitude) } : null)
  }))
}

export async function reverseGeocodeCoordinates(latitude: number, longitude: number): Promise<string> {
  const Geocoder = (await loadAmap()).Geocoder
  if (!Geocoder) return ""
  return new Promise((resolve) => new Geocoder({}).getAddress([longitude, latitude], (status, result) => resolve(status === "complete" ? result.regeocode?.formattedAddress?.trim() ?? "" : "")))
}

export function GpsMapPicker({ latitude, longitude, onPick }: { latitude: string; longitude: string; onPick: (latitude: string, longitude: string, locationName?: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null); const mapRef = useRef<AMapInstance | null>(null); const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading")
  async function applyPoint(event: AMapEvent) {
    if (!event.lnglat) return
    const nextLatitude = event.lnglat.getLat().toFixed(6); const nextLongitude = event.lnglat.getLng().toFixed(6)
    let locationName = ""; try { locationName = await reverseGeocodeCoordinates(Number(nextLatitude), Number(nextLongitude)) } catch { /* Coordinates remain usable if reverse geocoding is unavailable. */ }
    onPick(nextLatitude, nextLongitude, locationName || undefined)
  }
  useEffect(() => {
    if (!containerRef.current || !scriptSrc) { setState("missing"); return }
    let disposed = false
    const mount = async () => { try {
      const AMap = await loadAmap(); if (disposed || !containerRef.current) return
      const latitudeValue = Number(latitude) || 39.90923; const longitudeValue = Number(longitude) || 116.397428
      const map = new AMap.Map(containerRef.current, { zoom: 15, center: [longitudeValue, latitudeValue] }); map.on("click", (event) => { void applyPoint(event) })
      if (Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) { const marker = new AMap.Marker({ position: [longitudeValue, latitudeValue], draggable: true }); marker.on("dragend", (event) => { void applyPoint(event) }); map.add(marker) }
      mapRef.current = map; setState("ready")
    } catch { if (!disposed) setState("error") } }
    void mount(); return () => { disposed = true; mapRef.current?.destroy?.(); mapRef.current = null }
  }, [])
  useEffect(() => {
    const latitudeValue = Number(latitude); const longitudeValue = Number(longitude); const map = mapRef.current
    if (!map || !window.AMap || !Number.isFinite(latitudeValue) || !Number.isFinite(longitudeValue)) return
    map.clearMap(); map.setZoomAndCenter(15, [longitudeValue, latitudeValue]); const marker = new window.AMap.Marker({ position: [longitudeValue, latitudeValue], draggable: true }); marker.on("dragend", (event) => { void applyPoint(event) }); map.add(marker)
  }, [latitude, longitude, onPick])
  if (state === "missing") return <p className="muted gps-map-hint">高德地图配置未载入，请检查前端重启后是否读取项目 .env。</p>
  if (state === "error") return <p className="error-text">地图加载失败，请直接填写坐标。</p>
  return <div className="gps-map-wrap"><div ref={containerRef} className="gps-map" />{state === "loading" ? <span>正在加载地图…</span> : null}</div>
}
