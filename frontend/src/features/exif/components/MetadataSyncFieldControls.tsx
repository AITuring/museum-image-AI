import { Checkbox } from "antd"
import { ChevronDown } from "lucide-react"

export type MetadataSyncFieldKey =
  | "displayLocation" | "exhibition" | "gps" | "cameraModel" | "lensModel"
  | "shutterSpeed" | "aperture" | "iso" | "capturedAt" | "description" | "tags"

export type MetadataSyncSelection = Record<MetadataSyncFieldKey, boolean>

export const METADATA_SYNC_GROUPS: Array<{
  key: string
  title: string
  description: string
  fields: Array<{ key: MetadataSyncFieldKey; label: string }>
}> = [
  { key: "location", title: "地点与展览", description: "同一批照片通常可以复用", fields: [
    { key: "displayLocation", label: "展出地点" }, { key: "exhibition", label: "对应展览" }, { key: "gps", label: "经纬度" },
  ] },
  { key: "camera", title: "相机与拍摄参数", description: "默认不同步，保留每张照片的原始 EXIF", fields: [
    { key: "cameraModel", label: "相机型号" }, { key: "lensModel", label: "镜头型号" }, { key: "shutterSpeed", label: "快门" }, { key: "aperture", label: "光圈" }, { key: "iso", label: "ISO" },
  ] },
  { key: "content", title: "时间与内容", description: "需要完全一致时再开启", fields: [
    { key: "capturedAt", label: "拍摄时间" }, { key: "description", label: "描述" }, { key: "tags", label: "标签" },
  ] },
]

export const DEFAULT_METADATA_SYNC_SELECTION: MetadataSyncSelection = {
  displayLocation: true, exhibition: true, gps: true, cameraModel: false, lensModel: false,
  shutterSpeed: false, aperture: false, iso: false, capturedAt: false, description: false, tags: false,
}

export const METADATA_SYNC_FIELD_COUNT = METADATA_SYNC_GROUPS.reduce((count, group) => count + group.fields.length, 0)

export function metadataSyncSelectionFor(fields: MetadataSyncFieldKey[]): MetadataSyncSelection {
  const enabled = new Set(fields)
  return Object.fromEntries(METADATA_SYNC_GROUPS.flatMap((group) => group.fields).map((field) => [field.key, enabled.has(field.key)])) as MetadataSyncSelection
}

export function MetadataSyncFieldControls({ selection, onChange, context }: {
  selection: MetadataSyncSelection
  onChange: (field: MetadataSyncFieldKey, checked: boolean) => void
  context: "sidebar" | "preview"
}) {
  const renderGroup = (group: (typeof METADATA_SYNC_GROUPS)[number]) => (
    <section key={group.key} className="metadata-sync-field-group">
      <header><strong>{group.title}</strong>{context === "preview" ? <span>{group.description}</span> : null}</header>
      <div className="metadata-sync-field-list">
        {group.fields.map((field) => <Checkbox key={field.key} className="metadata-sync-field" checked={selection[field.key]} onChange={(event) => onChange(field.key, event.target.checked)}>{field.label}</Checkbox>)}
      </div>
    </section>
  )
  const advancedSelectedCount = METADATA_SYNC_GROUPS.slice(1).flatMap((group) => group.fields).filter((field) => selection[field.key]).length
  return <div className={`metadata-sync-field-groups is-${context}`}>
    {renderGroup(METADATA_SYNC_GROUPS[0])}
    {context === "sidebar" ? <details className="metadata-sync-more"><summary><span>更多字段</span><small>{advancedSelectedCount > 0 ? `${advancedSelectedCount} 项已选` : "默认关闭"}</small><ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" /></summary><div>{METADATA_SYNC_GROUPS.slice(1).map(renderGroup)}</div></details> : METADATA_SYNC_GROUPS.slice(1).map(renderGroup)}
  </div>
}
