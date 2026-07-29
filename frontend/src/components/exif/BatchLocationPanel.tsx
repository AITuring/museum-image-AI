import { Button, Input } from "antd"
import { ChevronDown } from "lucide-react"
import { GpsMapPicker } from "./GpsMapPicker"
import type { ExifWorkbenchItem } from "./types"

type BatchLocationPanelProps = {
  open: boolean
  selectedItem: ExifWorkbenchItem | null
  itemCount: number
  locationName: string
  exhibitionName: string
  latitude: string
  longitude: string
  onOpenChange: (open: boolean) => void
  onUseSelected: () => void
  onLocationNameChange: (value: string) => void
  onExhibitionNameChange: (value: string) => void
  onLatitudeChange: (value: string) => void
  onLongitudeChange: (value: string) => void
  onApply: () => void
}

export function BatchLocationPanel({
  open,
  selectedItem,
  itemCount,
  locationName,
  exhibitionName,
  latitude,
  longitude,
  onOpenChange,
  onUseSelected,
  onLocationNameChange,
  onExhibitionNameChange,
  onLatitudeChange,
  onLongitudeChange,
  onApply,
}: BatchLocationPanelProps) {
  return <details className="batch-location-panel" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
    <summary><span className="exif-tool-summary-copy"><strong>手动统一展出地点</strong><small>地图选点后统一展览与 GPS</small></span><span className="exif-tool-summary-meta"><span className="exif-tool-summary-count">{selectedItem ? "可套用当前图片" : "等待选择"}</span><ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" /></span></summary>
    {open ? <>
      <div className="batch-location-actions"><Button htmlType="button" onClick={onUseSelected} disabled={!selectedItem}>采用当前图片地点</Button></div>
      <div className="batch-location-fields exif-tool-grid">
        <label className="exif-tool-field"><span>展出地点</span><Input value={locationName} placeholder="例如：历代青铜馆" onChange={(event) => onLocationNameChange(event.target.value)} /></label>
        <label className="exif-tool-field"><span>对应展览</span><Input value={exhibitionName} placeholder="例如：常设展" onChange={(event) => onExhibitionNameChange(event.target.value)} /></label>
        <label className="exif-tool-field"><span>纬度</span><Input value={latitude} placeholder="39.9087" onChange={(event) => onLatitudeChange(event.target.value)} /></label>
        <label className="exif-tool-field"><span>经度</span><Input value={longitude} placeholder="116.3975" onChange={(event) => onLongitudeChange(event.target.value)} /></label>
      </div>
      <div className="exif-sidebar-map"><GpsMapPicker latitude={latitude} longitude={longitude} onPick={(nextLatitude, nextLongitude, nextLocationName) => { onLatitudeChange(nextLatitude); onLongitudeChange(nextLongitude); if (nextLocationName) onLocationNameChange(nextLocationName) }} /></div>
      <div className="exif-tool-actions"><Button htmlType="button" type="primary" block onClick={onApply} disabled={itemCount === 0}>应用到全部图片</Button></div>
    </> : null}
  </details>
}
