import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react"
import { changedParts } from "../lib/exifFormDomain"
import { listDirectoryImageEntries, verifyWritablePermission } from "../lib/exifArtifactLookup"
import type {
  ExifWorkbenchItem,
  FilePickerWindow,
  SubmitNotice,
  UploadActivity,
  WritableDirectoryHandle,
  WritableFileHandle,
} from "../components/types"

type UseExifDirectoryAuthorizationOptions = {
  fileInputRef: RefObject<HTMLInputElement | null>
  itemsRef: MutableRefObject<ExifWorkbenchItem[]>
  setItems: Dispatch<SetStateAction<ExifWorkbenchItem[]>>
  setSelectedId: Dispatch<SetStateAction<string | null>>
  setDirectoryHandle: Dispatch<SetStateAction<WritableDirectoryHandle | null>>
  setBindingDirectory: Dispatch<SetStateAction<boolean>>
  setUploading: Dispatch<SetStateAction<boolean>>
  setUploadActivity: Dispatch<SetStateAction<UploadActivity>>
  setSubmitNotice: Dispatch<SetStateAction<SubmitNotice | null>>
  clearHistory: () => void
  createItem: (file: File, index: number, fileHandle?: WritableFileHandle | null) => Promise<ExifWorkbenchItem>
  beginArtifactMatchReview: (items: ExifWorkbenchItem[], openPermissionAfterReview: boolean) => void
  submitOne: (itemId: string) => Promise<boolean>
  yieldToMainThread: () => Promise<void>
}

export function useExifDirectoryAuthorization({
  fileInputRef,
  itemsRef,
  setItems,
  setSelectedId,
  setDirectoryHandle,
  setBindingDirectory,
  setUploading,
  setUploadActivity,
  setSubmitNotice,
  clearHistory,
  createItem,
  beginArtifactMatchReview,
  submitOne,
  yieldToMainThread,
}: UseExifDirectoryAuthorizationOptions) {
  async function selectDirectory() {
    const pickerWindow = window as FilePickerWindow
    if (!pickerWindow.showDirectoryPicker) {
      fileInputRef.current?.click()
      setSubmitNotice({ type: "error", text: "当前浏览器不支持文件夹读写授权；保存并入库需要同步改名和写回 EXIF，请使用最新版 Chrome 或 Edge。" })
      return
    }
    try {
      setUploadActivity("directory")
      setUploading(true)
      const nextDirectoryHandle = await pickerWindow.showDirectoryPicker({ mode: "readwrite" })
      if (!await verifyWritablePermission(nextDirectoryHandle)) {
        setSubmitNotice({ type: "error", text: "需要授予文件夹读写权限，才能批量回写照片" })
        return
      }
      const entries = await listDirectoryImageEntries(nextDirectoryHandle)
      const currentNames = new Set(itemsRef.current.flatMap((item) => [item.fileName, item.originalFileName]))
      const addedEntries = entries.filter((entry) => !currentNames.has(entry.file.name))
      const builtItems: ExifWorkbenchItem[] = []
      for (let index = 0; index < addedEntries.length; index += 1) {
        const entry = addedEntries[index]
        setSubmitNotice({ type: "success", text: `正在解析文件夹照片 ${index + 1}/${addedEntries.length}：${entry.file.name}` })
        const builtItem = await createItem(entry.file, itemsRef.current.length + index, entry.handle)
        builtItems.push(builtItem)
        setItems((current) => [...current, builtItem])
        setSelectedId((current) => current ?? builtItem.id)
        await yieldToMainThread()
      }
      setDirectoryHandle(nextDirectoryHandle)
      if (builtItems.length > 0) clearHistory()
      const matchCount = builtItems.filter((item) => item.existingArtifactCandidates.length > 0).length
      setSubmitNotice({
        type: "success",
        text: `已从文件夹“${nextDirectoryHandle.name}”载入 ${builtItems.length} 张照片${matchCount > 0 ? `，其中 ${matchCount} 张发现已有文物候选，请确认选择` : ""}，并获得批量原地回写权限；未提交内容会自动保存在本机浏览器。`,
      })
      beginArtifactMatchReview(builtItems, false)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setSubmitNotice({ type: "error", text: error instanceof Error ? error.message : "读取照片文件夹失败" })
    } finally {
      setUploading(false)
      setUploadActivity(null)
    }
  }

  async function bindDirectory() {
    const pickerWindow = window as FilePickerWindow
    const items = itemsRef.current
    if (!pickerWindow.showDirectoryPicker) {
      setSubmitNotice({ type: "error", text: "当前浏览器不支持文件夹授权，请使用最新版 Chrome 或 Edge" })
      return
    }
    if (items.length === 0) {
      setSubmitNotice({ type: "error", text: "请先添加需要处理的图片，再授权其所在文件夹" })
      return
    }
    setBindingDirectory(true)
    try {
      const nextDirectoryHandle = await pickerWindow.showDirectoryPicker({ mode: "readwrite" })
      if (!await verifyWritablePermission(nextDirectoryHandle)) {
        setSubmitNotice({ type: "error", text: "需要授予文件夹读写权限，才能绑定并回写原照片" })
        return
      }
      const entries = await listDirectoryImageEntries(nextDirectoryHandle)
      const entriesByName = new Map<string, Array<{ handle: WritableFileHandle; file: File; index: number }>>()
      entries.forEach((entry, index) => {
        const candidates = entriesByName.get(entry.file.name) ?? []
        candidates.push({ ...entry, index })
        entriesByName.set(entry.file.name, candidates)
      })
      let matched = 0
      let exactMatched = 0
      let fallbackMatched = 0
      let nameMatched = 0
      let missing = 0
      let ambiguous = 0
      const usedIndexes = new Set<number>()
      const bindingResults = new Map<string, WritableFileHandle>()
      const unresolved: Array<{ id: string; fileName: string; reason: string }> = []
      const pendingItems = items.filter((item) => item.submitState !== "submitted" || changedParts(item).length > 0)
      pendingItems.forEach((item) => {
        const candidateMap = new Map<number, { handle: WritableFileHandle; file: File; index: number }>()
        for (const fileName of new Set([item.originalFileName, item.fileName])) {
          for (const entry of entriesByName.get(fileName) ?? []) {
            if (!usedIndexes.has(entry.index)) candidateMap.set(entry.index, entry)
          }
        }
        const candidates = Array.from(candidateMap.values())
        if (candidates.length === 0) {
          missing += 1
          unresolved.push({ id: item.id, fileName: item.fileName, reason: "所选文件夹内未找到同名文件" })
          return
        }
        const exact = candidates.filter((entry) => entry.file.size === item.localFile.size && entry.file.lastModified === item.localFile.lastModified)
        if (exact.length === 1) {
          usedIndexes.add(exact[0].index); matched += 1; exactMatched += 1; bindingResults.set(item.id, exact[0].handle); return
        }
        const sameSize = candidates.filter((entry) => entry.file.size === item.localFile.size)
        if (sameSize.length === 1) {
          usedIndexes.add(sameSize[0].index); matched += 1; fallbackMatched += 1; bindingResults.set(item.id, sameSize[0].handle); return
        }
        if (candidates.length === 1) {
          usedIndexes.add(candidates[0].index); matched += 1; nameMatched += 1; bindingResults.set(item.id, candidates[0].handle); return
        }
        ambiguous += 1
        unresolved.push({ id: item.id, fileName: item.fileName, reason: "存在多个同名文件，无法唯一确认" })
      })
      setItems((current) => current.map((item) => {
        const handle = bindingResults.get(item.id)
        if (handle) return { ...item, fileHandle: handle, submitState: item.submitState === "error" ? "idle" : item.submitState, submitMessage: item.submitState === "error" ? null : item.submitMessage }
        const issue = unresolved.find((entry) => entry.id === item.id)
        return issue ? { ...item, fileHandle: null, submitState: "error", submitMessage: `未绑定原文件：${issue.reason}（${issue.fileName}）` } : item
      }))
      setDirectoryHandle(nextDirectoryHandle)
      clearHistory()
      const summary = [`已绑定 ${matched} 张`]
      if (exactMatched > 0) summary.push(`精确匹配 ${exactMatched} 张`)
      if (fallbackMatched > 0) summary.push(`文件名和大小匹配 ${fallbackMatched} 张`)
      if (nameMatched > 0) summary.push(`文件名匹配 ${nameMatched} 张`)
      if (missing > 0) summary.push(`${missing} 张未找到`)
      if (ambiguous > 0) summary.push(`${ambiguous} 张重名未绑定`)
      if (unresolved.length > 0) setSelectedId(unresolved[0].id)
      const unresolvedText = unresolved.length > 0 ? `；未绑定：${unresolved.slice(0, 3).map((item) => `“${item.fileName}”（${item.reason}）`).join("、")}${unresolved.length > 3 ? `等 ${unresolved.length} 张` : ""}` : ""
      setSubmitNotice({ type: unresolved.length === 0 ? "success" : "error", text: `${nextDirectoryHandle.name}：${summary.join("，")}${unresolvedText}；未载入文件夹内其他照片` })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setSubmitNotice({ type: "success", text: "已取消文件夹授权；队列图片仍会保留，可稍后点击图片列表上方的文件夹按钮继续。" })
        return
      }
      setSubmitNotice({ type: "error", text: error instanceof Error ? error.message : "授权并绑定原文件夹失败" })
    } finally {
      setBindingDirectory(false)
    }
  }

  function retryQueueItem(item: ExifWorkbenchItem) {
    if (!item.fileHandle || /授权|权限|未绑定原文件/.test(item.submitMessage ?? "")) {
      void bindDirectory()
      return
    }
    void submitOne(item.id)
  }

  return { selectDirectory, bindDirectory, retryQueueItem }
}
