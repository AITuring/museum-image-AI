import type { PersistedExifDraft } from "../components/types"

const DATABASE_NAME = "museum-exif-drafts"
const DRAFT_STORE_NAME = "workbench"
const DRAFT_RECORD_KEY = "active"

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        request.result.createObjectStore(DRAFT_STORE_NAME)
      }
      if (!request.result.objectStoreNames.contains("reupload-hints")) {
        request.result.createObjectStore("reupload-hints")
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("无法打开本地草稿存储"))
  })
}

export async function readExifDraft() {
  const database = await openDatabase()
  try {
    return await new Promise<PersistedExifDraft | null>((resolve, reject) => {
      const request = database.transaction(DRAFT_STORE_NAME, "readonly")
        .objectStore(DRAFT_STORE_NAME)
        .get(DRAFT_RECORD_KEY)
      request.onsuccess = () => resolve((request.result as PersistedExifDraft | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error("读取本地草稿失败"))
    })
  } finally {
    database.close()
  }
}

export async function writeExifDraft(draft: PersistedExifDraft) {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(DRAFT_STORE_NAME, "readwrite")
        .objectStore(DRAFT_STORE_NAME)
        .put(draft, DRAFT_RECORD_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error("保存本地草稿失败"))
    })
  } finally {
    database.close()
  }
}

export async function clearExifDraft() {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(DRAFT_STORE_NAME, "readwrite")
        .objectStore(DRAFT_STORE_NAME)
        .delete(DRAFT_RECORD_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error("清理本地草稿失败"))
    })
  } finally {
    database.close()
  }
}
