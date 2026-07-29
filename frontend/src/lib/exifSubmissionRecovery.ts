import type { ExifWorkbenchItem, PersistedExifDraftItem } from "../components/exif/types"

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
        reject(new Error((payload as { detail?: string } | null)?.detail || `HTTP ${request.status}`))
        return
      }
      resolve(payload as T)
    }
    request.send(formData)
  })
}

export async function confirmSubmittedSourceHash(apiBaseUrl: string, sourceHash: string) {
  for (const delayMs of [0, 800, 1600]) {
    if (delayMs > 0) await waitForRetry(delayMs)
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/artifact-images/by-source-hash?${new URLSearchParams({ source_hash: sourceHash }).toString()}`,
      )
      if (response.ok && await response.json()) return true
    } catch {
      // A failed confirmation request should fall through to the normal retry.
    }
  }
  return false
}

export async function confirmSubmittedFileHash(apiBaseUrl: string, file: File) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
    const imageHash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const response = await fetch(
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
