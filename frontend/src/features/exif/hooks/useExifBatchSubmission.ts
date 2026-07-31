import type { Dispatch, SetStateAction } from "react"
import { changedParts } from "../lib/exifFormDomain"
import { cloneFormState } from "../lib/exifWorkbenchFormState"
import { confirmPreviouslySubmittedItem } from "../lib/exifSubmissionRecovery"
import type { ExifWorkbenchItem, SubmitNotice, WritableDirectoryHandle } from "../components/types"

type Options = {
  apiBaseUrl: string
  items: ExifWorkbenchItem[]
  directoryHandle: WritableDirectoryHandle | null
  setItems: Dispatch<SetStateAction<ExifWorkbenchItem[]>>
  setSelectedId: Dispatch<SetStateAction<string | null>>
  setSubmittingAll: Dispatch<SetStateAction<boolean>>
  setNotice: Dispatch<SetStateAction<SubmitNotice | null>>
  clearHistory: () => void
  submitOne: (itemId: string) => Promise<boolean>
}

export function useExifBatchSubmission({ apiBaseUrl, items, directoryHandle, setItems, setSelectedId, setSubmittingAll, setNotice, clearHistory, submitOne }: Options) {
  async function submitAll() {
    if (items.length === 0) return
    setSubmittingAll(true); setNotice(null)
    let pendingItems = items.filter((item) => item.submitState !== "submitted" || changedParts(item).length > 0)
    const confirmedIds = new Set((await Promise.all(pendingItems.map(async (item) => await confirmPreviouslySubmittedItem(apiBaseUrl, item) ? item.id : null))).filter((id): id is string => Boolean(id)))
    if (confirmedIds.size > 0) {
      setItems((current) => current.map((item) => confirmedIds.has(item.id) ? { ...item, submitState: "submitted", submitMessage: "已从云端确认这张图片完成入库。", uploadProgress: 100, uploadStage: "已完成", originalForm: cloneFormState(item.form) } : item))
      pendingItems = pendingItems.filter((item) => !confirmedIds.has(item.id))
    }
    const unboundItems = pendingItems.filter((item) => !item.fileHandle || (item.fileName !== item.originalFileName && !directoryHandle))
    if (unboundItems.length > 0) {
      if (confirmedIds.size > 0) clearHistory()
      setSubmittingAll(false); setSelectedId(unboundItems[0].id)
      setItems((current) => current.map((item) => unboundItems.some((unbound) => unbound.id === item.id) ? { ...item, submitState: "error", submitMessage: `未绑定可写原文件：${item.fileName}` } : item))
      const names = unboundItems.slice(0, 3).map((item) => `“${item.fileName}”`).join("、")
      setNotice({ type: "error", text: `未绑定可写原文件：${names}${unboundItems.length > 3 ? `等 ${unboundItems.length} 张` : ""}。已定位到第一张，请重新选择包含该原图的文件夹。` })
      return
    }
    let succeeded = confirmedIds.size; let failed = 0; const queue = [...pendingItems]
    const worker = async () => { while (queue.length > 0) { const item = queue.shift(); if (!item) return; if (await submitOne(item.id)) succeeded += 1; else failed += 1 } }
    await Promise.all(Array.from({ length: Math.min(2, pendingItems.length) }, () => worker()))
    if (succeeded > 0) clearHistory()
    setSubmittingAll(false)
    setNotice(failed > 0 ? { type: "error", text: `批量提交完成：${succeeded} 张成功，${failed} 张失败。可在队列中点击“重试”后再次提交。` } : { type: "success", text: `已完成批量提交：${succeeded} 张图片已入库。` })
  }
  return { submitAll }
}
