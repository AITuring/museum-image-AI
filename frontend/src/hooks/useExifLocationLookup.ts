import type { MutableRefObject } from "react"
import { geocodeLocationName } from "../components/exif/GpsMapPicker"
import { resolveMuseum } from "../lib/exifArtifactLookup"
import type { ExifWorkbenchItem, MuseumOption, SubmitNotice } from "../components/exif/types"

type ItemChange = { label: string; detail: string; nextItems: ExifWorkbenchItem[]; affected: string[] }
type Options = {
  apiBaseUrl: string; itemsRef: MutableRefObject<ExifWorkbenchItem[]>; selectedItem: ExifWorkbenchItem | null; locationSuggestions: MuseumOption[]; locatingRef: MutableRefObject<boolean>
  recordItemsChange: (change: ItemChange) => unknown; setShowSuggestions: (open: boolean) => void; setNotice: (notice: SubmitNotice | null) => void
}
export function useExifLocationLookup({ apiBaseUrl, itemsRef, selectedItem, locationSuggestions, locatingRef, recordItemsChange, setShowSuggestions, setNotice }: Options) {
  async function locateDisplayLocation(locationName: string, preferredMuseum?: MuseumOption) {
    if (!selectedItem || locatingRef.current) return
    const normalizedName = locationName.trim()
    if (!normalizedName) { setNotice({ type: "error", text: "请先输入展出地点名称" }); return }
    const itemId = selectedItem.id; locatingRef.current = true; setNotice(null)
    try {
      let museum = preferredMuseum ?? locationSuggestions.find((option) => option.name === normalizedName) ?? null
      if (!museum) { try { museum = await resolveMuseum(apiBaseUrl, normalizedName) } catch { museum = null } }
      let coordinates = museum?.latitude != null && museum.longitude != null ? { latitude: museum.latitude, longitude: museum.longitude } : null
      if (!coordinates) coordinates = await geocodeLocationName(normalizedName)
      if (!coordinates) throw new Error("未找到可用坐标")
      const current = itemsRef.current.find((item) => item.id === itemId); if (!current) return
      const nextItems = itemsRef.current.map((item) => item.id === itemId ? { ...item, form: { ...item.form, displayLocationName: museum?.name || normalizedName, latitude: coordinates.latitude.toFixed(6), longitude: coordinates.longitude.toFixed(6) }, submitState: item.submitState === "submitted" ? "idle" : item.submitState, submitMessage: item.submitState === "submitted" ? null : item.submitMessage } : item)
      recordItemsChange({ label: "定位展出地点", detail: `${current.fileName} · ${museum?.name || normalizedName}`, nextItems, affected: [current.fileName] })
      setShowSuggestions(false); setNotice({ type: "success", text: `已定位“${museum?.name || normalizedName}”并补充 GPS` })
    } catch { setNotice({ type: "error", text: `未能定位“${normalizedName}”，请从候选地点中选择或在地图上取点` }) }
    finally { locatingRef.current = false }
  }
  return { locateDisplayLocation }
}
