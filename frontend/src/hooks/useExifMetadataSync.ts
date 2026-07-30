import { useMemo, useState } from "react"
import {
  DEFAULT_METADATA_SYNC_SELECTION,
  METADATA_SYNC_GROUPS,
  metadataSyncSelectionFor,
  type MetadataSyncSelection,
} from "../components/exif/MetadataSyncFieldControls"
import type { MetadataSyncTargetMode } from "../components/exif/MetadataSyncPreview"
import type { ExifWorkbenchItem, SubmitNotice } from "../components/exif/types"
import { applySourceMetadata, buildMetadataSyncDiffRows } from "../lib/exifMetadataSync"
import { replaceWorkbenchItemForm } from "../lib/exifWorkbenchItemMutations"

type MetadataSyncPreset = "default" | "location" | "content" | "all" | "none"

type UseExifMetadataSyncOptions = {
  items: ExifWorkbenchItem[]
  selectedItem: ExifWorkbenchItem | null
  itemsRef: { current: ExifWorkbenchItem[] }
  onItemsChange: (change: { label: string; detail: string; nextItems: ExifWorkbenchItem[]; affected: string[] }) => void
  onNotice: (notice: SubmitNotice) => void
}

export function useExifMetadataSync({ items, selectedItem, itemsRef, onItemsChange, onNotice }: UseExifMetadataSyncOptions) {
  const [sourceId, setSourceId] = useState("")
  const [targetMode, setTargetMode] = useState<MetadataSyncTargetMode>("others")
  const [targetIds, setTargetIds] = useState<string[]>([])
  const [selection, setSelection] = useState<MetadataSyncSelection>(DEFAULT_METADATA_SYNC_SELECTION)
  const [previewOpen, setPreviewOpen] = useState(false)

  const source = useMemo(() => items.find((item) => item.id === sourceId) ?? null, [items, sourceId])
  const availableTargets = useMemo(() => items.filter((item) => item.id !== source?.id), [items, source])
  const targets = useMemo(() => {
    if (!source) return []
    if (targetMode === "current") return selectedItem && selectedItem.id !== source.id ? [selectedItem] : []
    if (targetMode === "selected") {
      const idSet = new Set(targetIds)
      return availableTargets.filter((item) => idSet.has(item.id))
    }
    return items.filter((item) => item.id !== source.id)
  }, [availableTargets, items, selectedItem, source, targetIds, targetMode])
  const diffs = useMemo(() => targets.map((target) => ({
    target,
    rows: METADATA_SYNC_GROUPS.flatMap((group) => group.fields)
      .filter((field) => selection[field.key])
      .flatMap((field) => buildMetadataSyncDiffRows(target.form, source?.form ?? target.form, field.key))
      .filter((row) => row.changed),
  })), [selection, source, targets])
  const selectedFieldCount = useMemo(() => Object.values(selection).filter(Boolean).length, [selection])
  const changedCount = useMemo(() => diffs.reduce((count, entry) => count + entry.rows.length, 0), [diffs])

  const selectPreset = (preset: MetadataSyncPreset) => {
    setSelection(preset === "default" ? { ...DEFAULT_METADATA_SYNC_SELECTION }
      : preset === "location" ? metadataSyncSelectionFor(["displayLocation", "exhibition", "gps"])
        : preset === "content" ? metadataSyncSelectionFor(["description", "tags"])
          : metadataSyncSelectionFor(preset === "all" ? METADATA_SYNC_GROUPS.flatMap((group) => group.fields.map((field) => field.key)) : []))
  }

  const openPreview = () => {
    if (!source) {
      onNotice({ type: "error", text: "请先选择一张来源照片" })
      return
    }
    if (!Object.values(selection).some(Boolean)) {
      onNotice({ type: "error", text: "请至少开启一项需要同步的信息" })
      return
    }
    if (targets.length === 0 && targetMode !== "selected") {
      onNotice({ type: "error", text: targetMode === "current" && selectedItem?.id === source.id ? "当前图片就是来源照片，请选择另一张目标图片" : "没有可同步的目标照片" })
      return
    }
    setPreviewOpen(true)
  }

  const openSelectedItemSync = () => {
    if (!selectedItem || items.length < 2) {
      onNotice({ type: "error", text: "至少需要两张图片，才能同步当前照片的信息" })
      return
    }
    setSourceId(selectedItem.id)
    setTargetMode("selected")
    setTargetIds([])
    if (!Object.values(selection).some(Boolean)) selectPreset("default")
    setPreviewOpen(true)
  }

  const apply = () => {
    if (!source || targets.length === 0) return
    const targetIdSet = new Set(targets.map((item) => item.id))
    const nextItems = itemsRef.current.map((item) => targetIdSet.has(item.id) ? {
      ...replaceWorkbenchItemForm(item, applySourceMetadata(item.form, source.form, selection)),
    } : item)
    onItemsChange({ label: "同步照片信息", detail: `从“${source.fileName}”同步 ${changedCount} 项到 ${targets.length} 张照片`, nextItems, affected: targets.map((item) => item.fileName) })
    setPreviewOpen(false)
    onNotice({ type: "success", text: `已从“${source.fileName}”同步 ${changedCount} 项信息到 ${targets.length} 张照片` })
  }

  return {
    source, sourceId, setSourceId, targetMode, setTargetMode, targetIds, setTargetIds,
    selection, setSelection, previewOpen, setPreviewOpen, availableTargets, targets, diffs,
    selectedFieldCount, changedCount, selectPreset, openPreview, openSelectedItemSync, apply,
  }
}
