import { Button, Dropdown, Space, Tooltip } from "antd"
import { Check, CloudUpload, FolderOpen, ImagePlus, Loader2, Trash2 } from "lucide-react"
import { indexedFileName } from "../lib/exifDisplay"
import { changedParts, ensureCandidates } from "../lib/exifFormDomain"
import { BatchLocationPanel } from "./BatchLocationPanel"
import { ExifQueueList } from "./ExifQueueList"
import { MetadataSyncSidebar } from "./MetadataSyncSidebar"
import type { MetadataSyncSelection } from "./MetadataSyncFieldControls"
import type { MetadataSyncTargetMode } from "./MetadataSyncPreview"
import type { ExifWorkbenchItem } from "./types"

type BatchLocationApplyPayload = {
  locationName: string
  exhibitionName: string
  latitude: string
  longitude: string
  catalogExhibitionId: number | null
  catalogExhibitionSourceId: string
}

type ExifSidebarQueueState = {
  items: ExifWorkbenchItem[]
  selectedId: string | null
  stats: {
    itemCount: number
    submittedCount: number
    gpsCount: number
  }
  needsDirectoryAuthorization: boolean
  allItemsSubmitted: boolean
  uploading: boolean
  bindingDirectory: boolean
  descriptionGeneratingItemIds: string[]
  submittingAll: boolean
}

type ExifSidebarQueueActions = {
  selectItem: (itemId: string) => void
  selectImages: () => void
  selectDirectory: () => Promise<void> | void
  bindDirectory: () => Promise<void> | void
  retryItem: (item: ExifWorkbenchItem) => void
  removeItem: (itemId: string) => Promise<void> | void
  clearAll: () => Promise<void> | void
  submitAll: () => Promise<void> | void
}

type ExifSidebarSyncPanel = {
  source: ExifWorkbenchItem | null
  sourceId: string
  targetMode: MetadataSyncTargetMode
  selection: MetadataSyncSelection
  selectedFieldCount: number
  changedCount: number
  setSourceId: (id: string) => void
  setTargetMode: (mode: MetadataSyncTargetMode) => void
  setSelection: (selection: MetadataSyncSelection) => void
  openPreview: () => void
}

type ExifSidebarSectionProps = {
  queueState: ExifSidebarQueueState
  queueActions: ExifSidebarQueueActions
  selectedItem: ExifWorkbenchItem | null
  batchLocationApply: (payload: BatchLocationApplyPayload) => void
  syncPanel: ExifSidebarSyncPanel
  showDescriptionTools: boolean
}

export function ExifSidebarSection({
  queueState,
  queueActions,
  selectedItem,
  batchLocationApply,
  syncPanel,
  showDescriptionTools,
}: ExifSidebarSectionProps) {
  return <section className="column column-left exif-sidebar">
    <div className="panel exif-queue-panel">
      <div className="section-heading compact">
        <div className="exif-sidebar-head">
          <h2>图片列表</h2>
        </div>
        {queueState.items.length > 0 ? <Space className="exif-queue-actions" size={2} role="toolbar" aria-label="图片列表操作">
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "images", icon: <ImagePlus size={14} strokeWidth={1.8} aria-hidden="true" />, label: "添加图片" },
                { key: "folder", icon: <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" />, label: queueState.needsDirectoryAuthorization ? "授权原文件" : "载入文件夹" },
              ],
              onClick: ({ key }) => {
                if (key === "images") queueActions.selectImages()
                if (key === "folder") void (queueState.needsDirectoryAuthorization ? queueActions.bindDirectory() : queueActions.selectDirectory())
              },
            }}
          >
            <Button
              htmlType="button"
              size="small"
              icon={<ImagePlus size={15} strokeWidth={1.8} aria-hidden="true" />}
              disabled={queueState.uploading || queueState.bindingDirectory}
              aria-label="添加图片或载入文件夹"
            />
          </Dropdown>
          <Tooltip title="清空图片列表" mouseEnterDelay={0.45}>
            <Button
              htmlType="button"
              danger
              size="small"
              icon={<Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />}
              onClick={() => void queueActions.clearAll()}
              disabled={queueState.items.length === 0}
              aria-label="清空图片列表"
            />
          </Tooltip>
          <Tooltip title={queueState.submittingAll ? "正在全部入库" : queueState.allItemsSubmitted ? "当前批次已全部入库" : "全部入库"} mouseEnterDelay={0.45}>
            <Button
              htmlType="button"
              type="primary"
              size="small"
              icon={queueState.submittingAll
                ? <Loader2 size={15} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                : queueState.allItemsSubmitted
                  ? <Check size={15} strokeWidth={1.8} aria-hidden="true" />
                  : <CloudUpload size={15} strokeWidth={1.8} aria-hidden="true" />}
              onClick={() => void queueActions.submitAll()}
              disabled={queueState.submittingAll || queueState.items.length === 0 || queueState.allItemsSubmitted}
              aria-label={queueState.submittingAll ? "正在全部入库" : queueState.allItemsSubmitted ? "当前批次已全部入库" : "全部入库"}
            />
          </Tooltip>
        </Space> : null}
      </div>
      {queueState.items.length > 0 ? (
        <p className="exif-sidebar-summary" aria-label="当前批次统计">
          <strong>{queueState.stats.itemCount}</strong> 张
          <span>·</span>
          {queueState.stats.submittedCount} 已入库
          <span>·</span>
          {queueState.stats.gpsCount} 带坐标
        </p>
      ) : null}
      <div className="exif-sidebar-scroll">
        <div className="exif-sidebar-tools">
          <MetadataSyncSidebar
            items={queueState.items}
            selectedItem={selectedItem}
            source={syncPanel.source}
            sourceId={syncPanel.sourceId}
            targetMode={syncPanel.targetMode}
            selection={syncPanel.selection}
            selectedFieldCount={syncPanel.selectedFieldCount}
            changedCount={syncPanel.changedCount}
            indexedFileName={indexedFileName}
            onSourceChange={syncPanel.setSourceId}
            onTargetModeChange={syncPanel.setTargetMode}
            onSelectionChange={syncPanel.setSelection}
            onPreview={syncPanel.openPreview}
          />
          <BatchLocationPanel
            selectedItem={selectedItem}
            itemCount={queueState.items.length}
            onApply={batchLocationApply}
          />
          <ExifQueueList
            items={queueState.items}
            selectedId={queueState.selectedId}
            descriptionGeneratingItemIds={queueState.descriptionGeneratingItemIds}
            showDescriptionTools={showDescriptionTools}
            changedParts={changedParts}
            hasGeneratedDescription={(item) => ensureCandidates(item.candidates).some((candidate) => candidate.status === "success")}
            onSelect={queueActions.selectItem}
            onRetry={queueActions.retryItem}
            onRemove={(id) => void queueActions.removeItem(id)}
          />
        </div>
      </div>
    </div>
  </section>
}
