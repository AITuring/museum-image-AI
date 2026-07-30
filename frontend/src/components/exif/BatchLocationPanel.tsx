import { useState } from "react"
import { Button, Input } from "antd"
import { ChevronDown } from "lucide-react"
import { GpsMapPicker } from "./GpsMapPicker"
import type { ExifWorkbenchItem } from "./types"

type BatchLocationPanelProps = {
  selectedItem: ExifWorkbenchItem | null
  itemCount: number
  onApply: (payload: {
    locationName: string
    exhibitionName: string
    latitude: string
    longitude: string
    catalogExhibitionId: number | null
    catalogExhibitionSourceId: string
  }) => void
}

export function BatchLocationPanel({
  selectedItem,
  itemCount,
  onApply,
}: BatchLocationPanelProps) {
  const [open, setOpen] = useState(false)
  const [locationName, setLocationName] = useState("")
  const [exhibitionName, setExhibitionName] = useState("常设")
  const [latitude, setLatitude] = useState("")
  const [longitude, setLongitude] = useState("")
  const [catalogExhibitionId, setCatalogExhibitionId] = useState<number | null>(null)
  const [catalogExhibitionSourceId, setCatalogExhibitionSourceId] = useState("")

  function useSelectedLocation() {
    if (!selectedItem) return
    setLocationName(selectedItem.form.displayLocationName)
    setExhibitionName(selectedItem.form.exhibitionName)
    setCatalogExhibitionId(selectedItem.form.catalogExhibitionId)
    setCatalogExhibitionSourceId(selectedItem.form.catalogExhibitionSourceId)
    setLatitude(selectedItem.form.latitude)
    setLongitude(selectedItem.form.longitude)
  }

  return <details className="batch-location-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span className="exif-tool-summary-copy"><strong>手动统一展出地点</strong><small>地图选点后统一展览与 GPS</small></span><span className="exif-tool-summary-meta"><span className="exif-tool-summary-count">{selectedItem ? "可套用当前图片" : "等待选择"}</span><ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" /></span></summary>
    {open ? <>
      <div className="batch-location-actions"><Button htmlType="button" onClick={useSelectedLocation} disabled={!selectedItem}>采用当前图片地点</Button></div>
      <div className="batch-location-fields exif-tool-grid">
        <label className="exif-tool-field"><span>展出地点</span><Input value={locationName} placeholder="例如：历代青铜馆" onChange={(event) => setLocationName(event.target.value)} /></label>
        <label className="exif-tool-field"><span>对应展览</span><Input value={exhibitionName} placeholder="例如：常设展" onChange={(event) => { setExhibitionName(event.target.value); setCatalogExhibitionId(null); setCatalogExhibitionSourceId("") }} /></label>
        <label className="exif-tool-field"><span>纬度</span><Input value={latitude} placeholder="39.9087" onChange={(event) => setLatitude(event.target.value)} /></label>
        <label className="exif-tool-field"><span>经度</span><Input value={longitude} placeholder="116.3975" onChange={(event) => setLongitude(event.target.value)} /></label>
      </div>
      <div className="exif-sidebar-map"><GpsMapPicker latitude={latitude} longitude={longitude} onPick={(nextLatitude, nextLongitude, nextLocationName) => { setLatitude(nextLatitude); setLongitude(nextLongitude); if (nextLocationName) setLocationName(nextLocationName) }} /></div>
      <div className="exif-tool-actions"><Button htmlType="button" type="primary" block onClick={() => onApply({ locationName, exhibitionName, latitude, longitude, catalogExhibitionId, catalogExhibitionSourceId })} disabled={itemCount === 0}>应用到全部图片</Button></div>
    </> : null}
  </details>
}
