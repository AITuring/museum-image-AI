import { Button, Segmented, Select } from "antd"
import { ChevronDown } from "lucide-react"
import {
  METADATA_SYNC_FIELD_COUNT,
  MetadataSyncFieldControls,
  type MetadataSyncSelection,
} from "./MetadataSyncFieldControls"
import type { ExifWorkbenchItem } from "./types"
import type { MetadataSyncTargetMode } from "./MetadataSyncPreview"

type MetadataSyncSidebarProps = {
  items: ExifWorkbenchItem[]
  selectedItem: ExifWorkbenchItem | null
  source: ExifWorkbenchItem | null
  sourceId: string
  targetMode: MetadataSyncTargetMode
  selection: MetadataSyncSelection
  selectedFieldCount: number
  changedCount: number
  indexedFileName: (fileName: string, index: number) => string
  onSourceChange: (id: string) => void
  onTargetModeChange: (mode: MetadataSyncTargetMode) => void
  onSelectionChange: (selection: MetadataSyncSelection) => void
  onPreview: () => void
}

export function MetadataSyncSidebar({
  items,
  selectedItem,
  source,
  sourceId,
  targetMode,
  selection,
  selectedFieldCount,
  changedCount,
  indexedFileName,
  onSourceChange,
  onTargetModeChange,
  onSelectionChange,
  onPreview,
}: MetadataSyncSidebarProps) {
  return <details className="metadata-sync-panel">
    <summary><span className="exif-tool-summary-copy"><strong>从照片同步信息</strong></span><span className="exif-tool-summary-meta"><span className="exif-tool-summary-count">{items.length > 1 ? `${items.length - 1} 张可同步` : "需 2 张"}</span><ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" /></span></summary>
    <div className="metadata-sync-controls">
      <div className="metadata-sync-source">
        <div className="metadata-sync-source-head"><span>来源照片</span><Button htmlType="button" type="link" size="small" onClick={() => selectedItem && onSourceChange(selectedItem.id)} disabled={!selectedItem || selectedItem.id === sourceId}>使用当前</Button></div>
        <Select aria-label="来源照片" value={sourceId || undefined} placeholder="选择来源照片" options={items.map((item, index) => ({ value: item.id, label: indexedFileName(item.fileName, index), title: item.fileName }))} onChange={onSourceChange} disabled={items.length === 0} popupMatchSelectWidth={360} showSearch optionFilterProp="label" />
      </div>
    </div>
    <div className="metadata-sync-target-row"><Segmented<MetadataSyncTargetMode> aria-label="同步目标" size="small" value={targetMode} options={[{ label: "当前图片", value: "current" }, { label: "指定照片", value: "selected" }, { label: "其他图片", value: "others" }]} onChange={onTargetModeChange} /></div>
    <MetadataSyncFieldControls context="sidebar" selection={selection} onChange={(field, checked) => onSelectionChange({ ...selection, [field]: checked })} />
    <div className="metadata-sync-status"><span title={source?.fileName}>{source ? `来源：${indexedFileName(source.fileName, items.findIndex((item) => item.id === source.id))}` : "尚未选择来源"}</span><strong>{selectedFieldCount}/{METADATA_SYNC_FIELD_COUNT} 字段 · {changedCount} 项差异</strong></div>
    <div className="exif-tool-actions"><Button htmlType="button" type="primary" block onClick={onPreview} disabled={items.length < 2 || !source}>{targetMode === "selected" ? "选择目标并预览" : "预览并同步"}</Button></div>
  </details>
}
