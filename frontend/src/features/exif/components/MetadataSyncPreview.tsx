import { Button, Checkbox, Space, Tag } from "antd"
import { ArrowRight } from "lucide-react"
import {
  METADATA_SYNC_FIELD_COUNT,
  MetadataSyncFieldControls,
  type MetadataSyncFieldKey,
  type MetadataSyncSelection,
} from "./MetadataSyncFieldControls"
import { WorkbenchModal } from "./WorkbenchModal"
import { indexedFileName } from "../lib/exifDisplay"

export type MetadataSyncTargetMode = "current" | "selected" | "others"

export type MetadataSyncPreviewItem = {
  id: string
  fileName: string
  previewUrl: string
}

export type MetadataSyncDiffRow = {
  label: string
  targetValue: string
  sourceValue: string
  changed: boolean
  willClearTarget: boolean
}

type MetadataSyncPreviewProps = {
  open: boolean
  source: MetadataSyncPreviewItem | null
  targetMode: MetadataSyncTargetMode
  availableTargets: MetadataSyncPreviewItem[]
  targets: MetadataSyncPreviewItem[]
  targetIds: string[]
  selection: MetadataSyncSelection
  selectedFieldCount: number
  changedCount: number
  diffs: Array<{ target: MetadataSyncPreviewItem; rows: MetadataSyncDiffRow[] }>
  itemIndex: (id: string) => number
  onCancel: () => void
  onApply: () => void
  onTargetIdsChange: (ids: string[]) => void
  onSelectionChange: (field: MetadataSyncFieldKey, checked: boolean) => void
  onPreset: (preset: "default" | "location" | "content" | "all" | "none") => void
}

export function MetadataSyncPreview({
  open,
  source,
  targetMode,
  availableTargets,
  targets,
  targetIds,
  selection,
  selectedFieldCount,
  changedCount,
  diffs,
  itemIndex,
  onCancel,
  onApply,
  onTargetIdsChange,
  onSelectionChange,
  onPreset,
}: MetadataSyncPreviewProps) {
  const toggleTarget = (id: string, checked: boolean) => {
    onTargetIdsChange(checked ? Array.from(new Set([...targetIds, id])) : targetIds.filter((targetId) => targetId !== id))
  }

  return <WorkbenchModal
    title="选择目标与同步内容"
    open={open}
    width={760}
    onCancel={onCancel}
    footer={[
      <Button key="cancel" htmlType="button" onClick={onCancel}>取消</Button>,
      <Button key="apply" htmlType="button" type="primary" onClick={onApply} disabled={targets.length === 0 || changedCount === 0}>
        同步到 {targets.length} 张照片
      </Button>,
    ]}
  >
    <div className="metadata-sync-preview">
      {targetMode === "selected" ? <section className="metadata-sync-target-picker">
        <div className="metadata-sync-target-picker-head">
          <div><strong>选择目标照片</strong><span>可以只选一张，也可以多选；来源照片不会出现在这里。</span></div>
          <Space.Compact size="small">
            <Button htmlType="button" onClick={() => onTargetIdsChange(availableTargets.map((item) => item.id))} disabled={availableTargets.length === 0}>全选</Button>
            <Button htmlType="button" onClick={() => onTargetIdsChange([])} disabled={targetIds.length === 0}>清空</Button>
          </Space.Compact>
        </div>
        <div className="metadata-sync-target-list">
          {availableTargets.map((item) => <Checkbox
            key={item.id}
            className="metadata-sync-target-option"
            checked={targetIds.includes(item.id)}
            onChange={(event) => toggleTarget(item.id, event.target.checked)}
          >
            <span className="metadata-sync-target-option-content">
              <img src={item.previewUrl} alt="" loading="lazy" decoding="async" />
              <span title={item.fileName}>{indexedFileName(item.fileName, itemIndex(item.id))}</span>
            </span>
          </Checkbox>)}
        </div>
        <p className="metadata-sync-target-picker-count">已选择 {targets.length}/{availableTargets.length} 张目标照片</p>
      </section> : null}
      <section className="metadata-sync-preview-fields">
        <div className="metadata-sync-preview-fields-head">
          <div><strong>选择同步内容</strong><span>相机、拍摄参数与时间默认关闭，避免覆盖每张照片自己的 EXIF。</span></div>
          <span>{selectedFieldCount}/{METADATA_SYNC_FIELD_COUNT} 项已开启</span>
        </div>
        <div className="metadata-sync-presets" aria-label="同步范围快捷选择">
          <span>快捷选择</span>
          <Space.Compact size="small">
            <Button htmlType="button" onClick={() => onPreset("default")}>恢复默认</Button>
            <Button htmlType="button" onClick={() => onPreset("location")}>只选地点</Button>
            <Button htmlType="button" onClick={() => onPreset("content")}>只选内容</Button>
            <Button htmlType="button" onClick={() => onPreset("all")}>全部开启</Button>
            <Button htmlType="button" onClick={() => onPreset("none")}>清空</Button>
          </Space.Compact>
        </div>
        <MetadataSyncFieldControls context="preview" selection={selection} onChange={onSelectionChange} />
      </section>
      <div className="metadata-sync-preview-summary">
        <div><span>来源照片</span><strong>{source?.fileName ?? "未选择"}</strong></div>
        <div><span>目标范围</span><strong>{targetMode === "current" ? "当前图片" : targetMode === "selected" ? `指定照片（${targets.length} 张）` : `全部其他图片（${targets.length} 张）`}</strong></div>
        <div className="is-emphasis"><span>预计变更</span><strong>{changedCount} 项</strong></div>
      </div>
      {targets.length === 0 ? <div className="metadata-sync-no-change">请先选择至少一张目标照片。</div>
        : diffs.every((entry) => entry.rows.length === 0) ? <div className="metadata-sync-no-change">来源照片与目标照片在所选范围内没有差异。</div>
          : <div className="metadata-sync-preview-targets">
            {diffs.filter((entry) => entry.rows.length > 0).map(({ target, rows }) => <section key={target.id} className="metadata-sync-preview-target">
              <header><img src={target.previewUrl} alt="" loading="lazy" decoding="async" /><div><strong>{target.fileName}</strong><span className="metadata-sync-target-change-count">{rows.length} 项将变更</span></div></header>
              <div className="metadata-sync-diff-list" role="table" aria-label={`${target.fileName} 的同步差异`}>
                <div className="metadata-sync-diff-row is-head" role="row"><span role="columnheader">字段</span><span role="columnheader">同步前</span><span role="columnheader">同步后</span></div>
                {rows.map((row) => <div key={row.label} className="metadata-sync-diff-row" role="row">
                  <strong className="metadata-sync-table-field" role="cell">{row.label}</strong>
                  <span className={`metadata-sync-table-before ${row.targetValue === "未填写" ? "is-empty" : ""}`} title={row.targetValue} role="cell">{row.targetValue}</span>
                  <span className={`metadata-sync-table-after ${row.sourceValue === "未填写" ? "is-empty" : ""}`} title={row.sourceValue} role="cell"><ArrowRight size={13} strokeWidth={2} aria-hidden="true" /><strong>{row.sourceValue}</strong>{row.willClearTarget ? <Tag color="warning">将清空</Tag> : null}</span>
                </div>)}
              </div>
            </section>)}
          </div>}
      {diffs.some((entry) => entry.rows.some((row) => row.willClearTarget)) ? <p className="metadata-sync-clear-warning">来源照片中有空字段，确认后会清空目标照片对应内容。</p> : null}
    </div>
  </WorkbenchModal>
}
