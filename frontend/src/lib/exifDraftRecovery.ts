import type { ExifWorkbenchItem, PersistedExifDraftItem, ReuploadHint } from "../components/exif/types"
import { cloneFormState, normalizedReuploadHintKeys } from "./exifWorkbenchFormState"
import { ensureCandidates, ensureStringList } from "./exifFormDomain"
import { createRestoredPreviewUrl } from "./exifPreview"
import { confirmPreviouslySubmittedItem } from "./exifSubmissionRecovery"

const DATABASE_NAME = "museum-exif-drafts"
const DRAFT_STORE_NAME = "workbench"
const REUPLOAD_HINT_STORE_NAME = "reupload-hints"

export function openExifDraftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        request.result.createObjectStore(DRAFT_STORE_NAME)
      }
      if (!request.result.objectStoreNames.contains(REUPLOAD_HINT_STORE_NAME)) {
        request.result.createObjectStore(REUPLOAD_HINT_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("无法打开本地草稿存储"))
  })
}

export async function writeReuploadHints(items: ExifWorkbenchItem[]) {
  const candidates = items.filter((item) => (
    item.form.name.trim()
    && item.form.museumName.trim()
    && (item.form.description.trim() || item.form.tags.length > 0)
  ))
  if (candidates.length === 0) return
  const database = await openExifDraftDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(REUPLOAD_HINT_STORE_NAME, "readwrite")
      const store = transaction.objectStore(REUPLOAD_HINT_STORE_NAME)
      candidates.forEach((item) => {
        const hint: ReuploadHint = {
          version: 1,
          form: cloneFormState(item.form),
          existingArtifactId: item.existingArtifactId ?? null,
          updatedAt: new Date().toISOString(),
        }
        const keys = new Set([
          ...normalizedReuploadHintKeys(item.originalFileName),
          ...normalizedReuploadHintKeys(item.fileName),
        ])
        keys.forEach((key) => store.put(hint, key))
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("保存重新上传线索失败"))
      transaction.onabort = () => reject(transaction.error ?? new Error("保存重新上传线索失败"))
    })
  } finally {
    database.close()
  }
}

export function serializeExifDraftItem(item: ExifWorkbenchItem): PersistedExifDraftItem {
  const { previewUrl: _previewUrl, fileHandle: _fileHandle, ...persistedItem } = item
  return {
    ...persistedItem,
    form: cloneFormState(item.form),
    originalForm: cloneFormState(item.originalForm),
    candidates: ensureCandidates(item.candidates),
    unavailableProviders: ensureStringList(item.unavailableProviders),
    // A directory permission cannot be silently restored after reload. The
    // photo and its edits are retained; the operator can re-authorize later.
    submitState: item.submitState === "submitting" ? "error" : item.submitState,
    submitMessage: item.submitState === "submitting" ? "页面刷新前提交未完成，请确认后重试" : item.submitMessage,
    uploadProgress: item.submitState === "submitting" ? 0 : item.uploadProgress,
    uploadStage: item.submitState === "submitting" ? "等待重试" : item.uploadStage,
  }
}

export async function restoreExifDraftItems(
  draft: PersistedExifDraftItem[],
  apiBaseUrl: string,
  fetchJson: <T>(input: string, init?: RequestInit) => Promise<T>,
) {
  return Promise.all(draft.map(async (item) => {
    const sourceHash = item.sourceHash ?? null
    const confirmedSubmitted = await confirmPreviouslySubmittedItem(apiBaseUrl, {
      ...item,
      sourceHash,
    })
    return {
      ...item,
      form: cloneFormState(item.form),
      originalForm: cloneFormState(item.originalForm),
      candidates: ensureCandidates(item.candidates),
      unavailableProviders: ensureStringList(item.unavailableProviders),
      existingArtifactId: item.existingArtifactId ?? null,
      existingArtifactMatch: item.existingArtifactMatch ?? null,
      existingArtifactCandidates: item.existingArtifactCandidates ?? [],
      existingArtifactReviewKey: item.existingArtifactReviewKey ?? null,
      sourceHash,
      fileHandle: null,
      previewUrl: await createRestoredPreviewUrl(item.localFile, apiBaseUrl, fetchJson),
      submitState: confirmedSubmitted ? "submitted" as const : item.submitState,
      submitMessage: confirmedSubmitted ? "已从云端确认这张图片完成入库。" : item.submitMessage,
      uploadProgress: confirmedSubmitted ? 100 : item.uploadProgress,
      uploadStage: confirmedSubmitted ? "已完成" : item.uploadStage,
    }
  }))
}
