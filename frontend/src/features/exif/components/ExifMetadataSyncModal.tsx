import type { MetadataSyncFieldKey, MetadataSyncSelection } from "./MetadataSyncFieldControls"
import { MetadataSyncPreview, type MetadataSyncDiffRow, type MetadataSyncPreviewItem, type MetadataSyncTargetMode } from "./MetadataSyncPreview"

type ExifMetadataSyncModalProps = {
  items: Array<{ id: string }>
  metadataSync: {
    previewOpen: boolean
    source: MetadataSyncPreviewItem | null
    targetMode: MetadataSyncTargetMode
    availableTargets: MetadataSyncPreviewItem[]
    targets: MetadataSyncPreviewItem[]
    targetIds: string[]
    selection: MetadataSyncSelection
    selectedFieldCount: number
    changedCount: number
    diffs: Array<{ target: MetadataSyncPreviewItem; rows: MetadataSyncDiffRow[] }>
    setPreviewOpen: (open: boolean) => void
    apply: () => void
    setTargetIds: (ids: string[]) => void
    setSelection: (updater: (current: MetadataSyncSelection) => MetadataSyncSelection) => void
    selectPreset: (preset: "default" | "location" | "content" | "all" | "none") => void
  }
}

export function ExifMetadataSyncModal({ items, metadataSync }: ExifMetadataSyncModalProps) {
  const itemIndex = (id: string) => items.findIndex((item) => item.id === id)

  const handleSelectionChange = (field: MetadataSyncFieldKey, checked: boolean) => {
    metadataSync.setSelection((current) => ({ ...current, [field]: checked }))
  }

  return <MetadataSyncPreview
    open={metadataSync.previewOpen}
    source={metadataSync.source}
    targetMode={metadataSync.targetMode}
    availableTargets={metadataSync.availableTargets}
    targets={metadataSync.targets}
    targetIds={metadataSync.targetIds}
    selection={metadataSync.selection}
    selectedFieldCount={metadataSync.selectedFieldCount}
    changedCount={metadataSync.changedCount}
    diffs={metadataSync.diffs}
    itemIndex={itemIndex}
    onCancel={() => metadataSync.setPreviewOpen(false)}
    onApply={metadataSync.apply}
    onTargetIdsChange={metadataSync.setTargetIds}
    onSelectionChange={handleSelectionChange}
    onPreset={metadataSync.selectPreset}
  />
}
