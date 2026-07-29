import type { MutableRefObject } from "react"
import { fileBaseName, normalizedFileName } from "../lib/exifFormDomain"
import { applyFilenameParseWithoutOverwritingEdits, createExifHistorySnapshot, type ExifHistorySnapshot } from "../lib/exifWorkbenchFormState"
import type { ExifWorkbenchItem, FormState, ParsedArtifactName, SubmitNotice } from "../components/exif/types"

type FetchJson = <T>(input: string, init?: RequestInit) => Promise<T>
type ItemChange = { label: string; detail: string; nextItems: ExifWorkbenchItem[]; affected: string[]; mergeKey?: string }

type Options = {
  apiBaseUrl: string
  itemsRef: MutableRefObject<ExifWorkbenchItem[]>
  selectedItem: ExifWorkbenchItem | null
  selectedId: string | null
  sharedForm: FormState
  prefix: string
  suffix: string
  remove: string
  revisionRef: MutableRefObject<number>
  historyOperationRef: MutableRefObject<Map<string, string>>
  recordItemsChange: (change: ItemChange) => string
  updateItem: (itemId: string, updater: (item: ExifWorkbenchItem) => ExifWorkbenchItem) => void
  updateOperationAfter: (operationId: string, snapshot: ExifHistorySnapshot) => void
  setNotice: (notice: SubmitNotice) => void
  fetchJson: FetchJson
}

export function useExifFilenameActions({ apiBaseUrl, itemsRef, selectedItem, selectedId, sharedForm, prefix, suffix, remove, revisionRef, historyOperationRef, recordItemsChange, updateItem, updateOperationAfter, setNotice, fetchJson }: Options) {
  function renameSelected(baseName: string) {
    if (!selectedItem) return
    const current = itemsRef.current.find((item) => item.id === selectedItem.id); if (!current) return
    const fileName = normalizedFileName(baseName, current.fileName); if (fileName === current.fileName) return
    const nextItems = itemsRef.current.map((item) => item.id === selectedItem.id ? { ...item, fileName, submitState: item.submitState === "submitted" ? "idle" : item.submitState, submitMessage: item.submitState === "submitted" ? null : item.submitMessage } : item)
    const operationId = recordItemsChange({ label: "修改目标文件名", detail: `${current.fileName} → ${fileName}`, nextItems, affected: [current.fileName], mergeKey: `filename:${current.id}` })
    historyOperationRef.current.set(current.id, operationId)
  }
  function applyBatchRename() {
    if (!prefix && !suffix && !remove) return
    const revision = ++revisionRef.current; const currentItems = itemsRef.current
    const renamed = currentItems.map((item) => ({ id: item.id, fileName: normalizedFileName(`${prefix}${fileBaseName(item.fileName).split(remove).join("")}${suffix}`, item.fileName) }))
    const nextItems = currentItems.map((item) => ({ ...item, fileName: renamed.find((entry) => entry.id === item.id)?.fileName ?? item.fileName, submitState: item.submitState === "submitted" ? "idle" : item.submitState, submitMessage: item.submitState === "submitted" ? null : item.submitMessage }))
    const changedItems = nextItems.filter((item, index) => item.fileName !== currentItems[index]?.fileName); if (changedItems.length === 0) return
    const operationId = recordItemsChange({ label: "批量修改目标文件名", detail: `前缀“${prefix || "无"}” · 后缀“${suffix || "无"}” · 影响 ${changedItems.length} 张`, nextItems, affected: changedItems.map((item) => item.fileName) })
    void Promise.all(renamed.map(async (entry) => {
      try {
        const parsed = await fetchJson<ParsedArtifactName>(`${apiBaseUrl}/api/artifacts/parse-name?${new URLSearchParams({ name: entry.fileName }).toString()}`)
        updateItem(entry.id, (item) => revisionRef.current === revision && item.fileName === entry.fileName ? { ...item, parsedName: parsed, form: applyFilenameParseWithoutOverwritingEdits(item.form, item.parsedName, parsed) } : item)
      } catch { /* Keep filename and current metadata when parsing fails. */ }
    })).then(() => { if (revisionRef.current === revision) updateOperationAfter(operationId, createExifHistorySnapshot(itemsRef.current, selectedId, sharedForm)) })
    setNotice({ type: "success", text: `已按规则更新 ${changedItems.length} 个目标文件名，入库时将使用新名称` })
  }
  return { renameSelected, applyBatchRename }
}
