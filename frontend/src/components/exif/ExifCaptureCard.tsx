import { Card, Input, Tooltip } from "antd"
import { Camera } from "lucide-react"
import type { FormState } from "./types"

type ExifCaptureCardProps = {
  form: FormState
  onChange: (changes: Partial<FormState>) => void
  formatCapturedAt: (value: string) => string
}

export function ExifCaptureCard({ form, onChange, formatCapturedAt }: ExifCaptureCardProps) {
  return <Card
    size="small"
    className="form-section exif-form-card exif-capture-card"
    title={<Tooltip title="自动读取图片 EXIF，可在入库前校正。" placement="topLeft" trigger={["hover", "focus"]}><span className="exif-section-title" tabIndex={0}><Camera size={16} strokeWidth={1.8} aria-hidden="true" /><span>拍摄信息</span></span></Tooltip>}
  >
    <div className="form-section-body">
      <div className="field-row">
        <label className="field"><span>相机型号</span><Input value={form.cameraModel} placeholder="未读取" onChange={(event) => onChange({ cameraModel: event.target.value })} /></label>
        <label className="field"><span>镜头型号</span><Input value={form.lensModel} placeholder="未读取" onChange={(event) => onChange({ lensModel: event.target.value })} /></label>
      </div>
      <div className="exif-capture-grid">
        <label className="field exif-captured-at-field"><span>拍摄时间</span><Input value={form.capturedAt} placeholder="yyyy-MM-dd HH:mm:ss" onChange={(event) => onChange({ capturedAt: event.target.value })} onBlur={(event) => onChange({ capturedAt: formatCapturedAt(event.target.value) })} /></label>
        <label className="field"><span>快门</span><Input value={form.shutterSpeed} placeholder="例如：1/80s" onChange={(event) => onChange({ shutterSpeed: event.target.value })} /></label>
        <label className="field"><span>光圈</span><Input value={form.aperture} placeholder="例如：f/8" onChange={(event) => onChange({ aperture: event.target.value })} /></label>
        <label className="field"><span>ISO</span><Input inputMode="numeric" value={form.iso} placeholder="例如：400" onChange={(event) => onChange({ iso: event.target.value.replace(/\D/g, "") })} /></label>
      </div>
    </div>
  </Card>
}
