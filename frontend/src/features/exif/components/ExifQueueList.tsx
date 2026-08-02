import { useMemo } from "react"
import { Button, Space, Tag, Tooltip } from "antd"
import { Check, CircleAlert, FileCheck2, Loader2, RefreshCw, Trash2, X } from "lucide-react"
import { distinctiveFileNames } from "../lib/exifDisplay"
import { missingQuickEntryInfo } from "../lib/exifFormDomain"
import type { ExifWorkbenchItem } from "./types"

type ExifQueueListProps = {
  items: ExifWorkbenchItem[]
  selectedId: string | null
  descriptionGeneratingItemIds: string[]
  showDescriptionTools: boolean
  changedParts: (item: ExifWorkbenchItem) => string[]
  hasGeneratedDescription: (item: ExifWorkbenchItem) => boolean
  onSelect: (id: string) => void
  onRetry: (item: ExifWorkbenchItem) => void
  onRemove: (id: string) => void
}

function queueSubmitStateText(item: ExifWorkbenchItem, changes: string[]) {
  if (item.submitState === "submitted") return "已提交"
  if (item.submitState === "submitting") return "提交中"
  if (item.submitState === "error") return "提交失败"
  return changes.length > 0 ? `待提交 · ${changes.length} 项` : "待处理"
}

function QueueStateTag({ item, changes }: { item: ExifWorkbenchItem; changes: string[] }) {
  const isSubmitted = item.submitState === "submitted"
  const isSubmitting = item.submitState === "submitting"
  const isError = item.submitState === "error"
  const hasChanges = !isSubmitted && !isSubmitting && !isError && changes.length > 0
  return <Tag
    variant="filled"
    className={`queue-submit-state is-${item.submitState}${hasChanges ? " has-changes" : ""}`}
    icon={isSubmitted ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : isSubmitting ? <Loader2 size={12} strokeWidth={2} className="queue-state-icon is-active" aria-hidden="true" /> : isError ? <X size={12} strokeWidth={2} aria-hidden="true" /> : hasChanges ? <FileCheck2 size={12} strokeWidth={1.8} className="queue-state-icon is-pending" aria-hidden="true" /> : undefined}
  >
    {queueSubmitStateText(item, changes)}
  </Tag>
}

export function ExifQueueList({
  items,
  selectedId,
  descriptionGeneratingItemIds,
  showDescriptionTools,
  changedParts,
  hasGeneratedDescription,
  onSelect,
  onRetry,
  onRemove,
}: ExifQueueListProps) {
  const displayNames = useMemo(() => distinctiveFileNames(items.map((item) => item.fileName)), [items])
  if (items.length === 0) return <div className="exif-queue-list"><p className="muted">还没有图片，先上传一批图片开始处理。</p></div>

  return <div className="exif-queue-list">
    {items.map((item, index) => {
      const changes = changedParts(item)
      const missingInfo = missingQuickEntryInfo(item.form)
      const missingInfoText = missingInfo.length > 0 ? `缺 ${missingInfo.join("、")}` : ""
      const descriptionStateText = showDescriptionTools && descriptionGeneratingItemIds.includes(item.id)
        ? "描述中"
        : showDescriptionTools && hasGeneratedDescription(item) ? "描述完成" : ""
      const needsAuthorization = !item.fileHandle || /授权|权限|未绑定原文件/.test(item.submitMessage ?? "")
      return <div key={item.id} className={`exif-queue-item-shell${item.submitState === "error" ? " is-error" : ""}`}>
        <button
          type="button"
          data-ui="interactive-surface"
          className={`exif-queue-item ${selectedId === item.id ? "is-selected" : ""}`}
          aria-pressed={selectedId === item.id}
          aria-label={[`选择 ${item.fileName}`, missingInfoText || "信息完整", descriptionStateText, queueSubmitStateText(item, changes).replace(" · ", "，")].filter(Boolean).join("。")}
          onClick={() => onSelect(item.id)}
        >
          <img src={item.previewUrl} alt="" width="40" height="40" className="exif-queue-thumb" loading="lazy" decoding="async" />
          <div className="exif-queue-copy">
            <Tooltip title={item.fileName} mouseEnterDelay={0.4} placement="topLeft">
              <strong title={item.fileName}>{displayNames[index]}</strong>
            </Tooltip>
            <div className="queue-item-meta">
              {missingInfoText ? <Tooltip title={missingInfoText} mouseEnterDelay={0.4}>
                <span className="queue-missing-info"><CircleAlert size={12} strokeWidth={2} aria-hidden="true" />{missingInfoText}</span>
              </Tooltip> : changes.length > 0 ? <span className="queue-change-summary" aria-label={`待提交的变更：${changes.join("、")}`}>已改：{changes.join("、")}</span> : <span className="queue-info-complete">信息完整</span>}
              <span className="queue-state-tags">
                {descriptionStateText === "描述中" ? <Tag variant="filled" className="queue-aux-state is-active" icon={<Loader2 size={12} strokeWidth={2} className="queue-state-icon is-active" aria-hidden="true" />}>描述中</Tag> : descriptionStateText === "描述完成" ? <Tag variant="filled" className="queue-aux-state is-done" icon={<Check size={12} strokeWidth={2} aria-hidden="true" />}>描述完成</Tag> : null}
                <QueueStateTag item={item} changes={changes} />
              </span>
            </div>
            {item.submitState === "submitting" ? <span className="queue-upload" aria-label={`${item.uploadStage ?? "提交中"} ${item.uploadProgress}%`}><i style={{ width: `${item.uploadProgress}%` }} /><small>{item.uploadStage ?? "提交中"} · {item.uploadProgress}%</small></span> : null}
          </div>
        </button>
        <Space className="exif-queue-item-actions" size={2}>
          {item.submitState === "error" ? <Tooltip title={needsAuthorization ? "重新授权原文件夹" : "重试入库"}><Button htmlType="button" size="small" className="exif-queue-retry" icon={<RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" />} aria-label={needsAuthorization ? "重新授权原文件夹" : "重试入库"} onClick={() => onRetry(item)} /></Tooltip> : null}
          <Button htmlType="button" size="small" className="exif-queue-remove" icon={<Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />} aria-label={`移除 ${item.fileName}`} onClick={() => onRemove(item.id)} />
        </Space>
      </div>
    })}
  </div>
}
