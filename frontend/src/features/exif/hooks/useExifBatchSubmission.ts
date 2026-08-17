import type { Dispatch, SetStateAction } from "react"
import { changedParts } from "../lib/exifFormDomain"
import type { ExifWorkbenchItem, SubmitNotice, WritableDirectoryHandle } from "../components/types"

// The cloud backend deliberately admits one full-size ingest at a time to keep
// OSS upload, hashing, and image processing within the small production host's
// memory budget. Keep the browser queue aligned with that contract; competing
// workers only turn the second request into a 429 and add retry latency.
const SUBMISSION_WORKER_COUNT = 1

type Options = {
  items: ExifWorkbenchItem[]
  directoryHandle: WritableDirectoryHandle | null
  setItems: Dispatch<SetStateAction<ExifWorkbenchItem[]>>
  setSelectedId: Dispatch<SetStateAction<string | null>>
  setSubmittingAll: Dispatch<SetStateAction<boolean>>
  setNotice: Dispatch<SetStateAction<SubmitNotice | null>>
  clearHistory: () => void
  submitOne: (itemId: string) => Promise<boolean>
}

export function useExifBatchSubmission({ items, directoryHandle, setItems, setSelectedId, setSubmittingAll, setNotice, clearHistory, submitOne }: Options) {
  async function submitAll() {
    if (items.length === 0) return
    setSubmittingAll(true); setNotice(null)
    const pendingItems = items.filter((item) => item.submitState !== "submitted" || changedParts(item).length > 0)
    const unboundItems = pendingItems.filter((item) => !item.fileHandle || (item.fileName !== item.originalFileName && !directoryHandle))
    if (unboundItems.length > 0) {
      setSubmittingAll(false); setSelectedId(unboundItems[0].id)
      setItems((current) => current.map((item) => unboundItems.some((unbound) => unbound.id === item.id) ? { ...item, submitState: "error", submitMessage: `未绑定可写原文件：${item.fileName}` } : item))
      const names = unboundItems.slice(0, 3).map((item) => `“${item.fileName}”`).join("、")
      setNotice({ type: "error", text: `未绑定可写原文件：${names}${unboundItems.length > 3 ? `等 ${unboundItems.length} 张` : ""}。已定位到第一张，请重新选择包含该原图的文件夹。` })
      return
    }

    // Mark the first worker synchronously so the click is visible before the
    // first async recovery check starts; remaining rows stay queued until the
    // single cloud-ingest slot is available.
    const activeIds = new Set(pendingItems.slice(0, SUBMISSION_WORKER_COUNT).map((item) => item.id))
    setItems((current) => current.map((item) => activeIds.has(item.id)
      ? { ...item, submitState: "submitting", submitMessage: null, uploadProgress: 3, uploadStage: "正在准备提交" }
      : item))

    let succeeded = 0; let failed = 0; const queue = [...pendingItems]
    const worker = async () => { while (queue.length > 0) { const item = queue.shift(); if (!item) return; if (await submitOne(item.id)) succeeded += 1; else failed += 1 } }
    await Promise.all(Array.from({ length: Math.min(SUBMISSION_WORKER_COUNT, pendingItems.length) }, () => worker()))
    if (succeeded > 0) clearHistory()
    setSubmittingAll(false)
    setNotice(failed > 0 ? { type: "error", text: `批量提交完成：${succeeded} 张成功，${failed} 张失败。可在队列中点击“重试”后再次提交。` } : { type: "success", text: `已完成批量提交：${succeeded} 张图片已入库。` })
  }
  return { submitAll }
}
