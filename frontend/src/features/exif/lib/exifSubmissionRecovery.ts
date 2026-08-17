import type { ExifWorkbenchItem, PersistedExifDraftItem } from "../components/types"

export type HttpRequestError = Error & {
  status?: number
  code?: string
}

const SOURCE_HASH_LOOKUP_COOLDOWN_MS = 45_000
const OPTIONAL_LOOKUP_TIMEOUT_MS = 2_500
let sourceHashLookupDisabledUntil = 0

async function fetchWithTimeout(input: string, init?: RequestInit) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), OPTIONAL_LOOKUP_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

export function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs)
  })
}

export function postFormDataWithProgress<T>(url: string, formData: FormData, onProgress: (progress: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open("POST", url)
    request.timeout = 150_000
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(95, 45 + Math.round((event.loaded / event.total) * 50)))
    }
    request.onerror = () => reject(new Error("图片上传连接失败"))
    request.ontimeout = () => reject(new Error("等待云端入库确认超时"))
    request.onload = () => {
      let payload: { detail?: string } | T | null = null
      try { payload = JSON.parse(request.responseText) as { detail?: string } | T } catch { /* non-json error */ }
      if (request.status < 200 || request.status >= 300) {
        const error = new Error((payload as { detail?: string } | null)?.detail || `HTTP ${request.status}`) as HttpRequestError
        error.status = request.status
        error.code = request.getResponseHeader("X-Error-Code") || undefined
        reject(error)
        return
      }
      resolve(payload as T)
    }
    request.send(formData)
  })
}

export async function confirmSubmittedSourceHash(apiBaseUrl: string, sourceHash: string) {
  if (sourceHashLookupDisabledUntil > Date.now()) return false
  try {
    const response = await fetchWithTimeout(
      `${apiBaseUrl}/api/artifact-images/by-source-hash?${new URLSearchParams({ source_hash: sourceHash }).toString()}`,
    )
    if (response.ok) {
      sourceHashLookupDisabledUntil = 0
      return Boolean(await response.json())
    }
    const errorCode = response.headers.get("X-Error-Code")
    if (errorCode === "cloud_source_hash_endpoint_missing" || response.status >= 400) {
      sourceHashLookupDisabledUntil = Date.now() + SOURCE_HASH_LOOKUP_COOLDOWN_MS
      return false
    }
  } catch {
    // Source-hash confirmation is optional. A local/cloud outage must not
    // retry once per restored draft or delay the normal submit path.
  }
  sourceHashLookupDisabledUntil = Date.now() + SOURCE_HASH_LOOKUP_COOLDOWN_MS
  return false
}

export async function confirmSubmittedFileHash(apiBaseUrl: string, file: File) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
    const imageHash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const response = await fetchWithTimeout(
      `${apiBaseUrl}/api/artifact-images/by-hash?${new URLSearchParams({ image_hash: imageHash }).toString()}`,
    )
    return response.ok && Boolean(await response.json())
  } catch {
    return false
  }
}

export function shouldCheckLegacySubmittedDraft(item: Pick<ExifWorkbenchItem, "submitState" | "submitMessage" | "uploadProgress" | "uploadStage">) {
  return item.submitState === "submitting"
    || item.uploadProgress >= 45
    || item.uploadStage === "等待重试"
    || item.submitMessage?.includes("页面刷新前提交未完成") === true
}

export async function confirmPreviouslySubmittedItem(apiBaseUrl: string, item: ExifWorkbenchItem | PersistedExifDraftItem) {
  if (item.sourceHash && await confirmSubmittedSourceHash(apiBaseUrl, item.sourceHash)) return true
  return shouldCheckLegacySubmittedDraft(item)
    ? confirmSubmittedFileHash(apiBaseUrl, item.localFile)
    : false
}
