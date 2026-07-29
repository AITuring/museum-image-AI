import { useEffect, useRef, useState } from "react"
import { AutoComplete, Button, Input, Select, Tag } from "antd"
import { isMissingValue, needsSelection, normalizeTags, statusClass } from "./lib/batchHelpers"
import { fetchBatchJson as fetchJson } from "./lib/batchApi"
import { GooglePhotosConfigModal } from "./components/batch/GooglePhotosConfigModal"
import { BatchSubmitNotice } from "./components/batch/BatchSubmitNotice"
import { BatchImportPanel } from "./components/batch/BatchImportPanel"
import {
  enrichPendingItemTags,
  normalizePersistedPendingItem,
  STATUS_LABEL,
  type BatchScanResponse,
  type EraOption,
  type ExhibitionOption,
  type ExistingArtifactMatch,
  type FileWithRelativePath,
  type GooglePhotosConfig,
  type GooglePhotosImportResult,
  type GooglePhotosMediaItem,
  type GooglePhotosMediaList,
  type GooglePhotosPickerSession,
  type GooglePhotosStatus,
  type MuseumOption,
  type PendingArtifact,
  type PendingArtifactSubmitResult,
  type RawPendingArtifact,
  type SubmitNotice,
  type VisionAnalyzeResponse,
  type VisionCandidate,
} from "./lib/batchDomain"

const Textarea = Input.TextArea

 export default function BatchConsole({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [items, setItems] = useState<PendingArtifact[]>([])
  const [googlePhotosStatus, setGooglePhotosStatus] = useState<GooglePhotosStatus | null>(null)
  const [showGooglePhotosConfigModal, setShowGooglePhotosConfigModal] = useState(false)
  const [googlePhotosConfigForm, setGooglePhotosConfigForm] = useState({
    clientId: "",
    clientSecret: "",
    redirectUri: "",
  })
  const [googlePhotosSession, setGooglePhotosSession] = useState<GooglePhotosPickerSession | null>(null)
  const [googlePhotosMedia, setGooglePhotosMedia] = useState<GooglePhotosMediaItem[]>([])
  const [googlePhotosSelectedIds, setGooglePhotosSelectedIds] = useState<string[]>([])
  const [googlePhotosNextPageToken, setGooglePhotosNextPageToken] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [identifying, setIdentifying] = useState(false)
  const [googlePhotosBusy, setGooglePhotosBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedFolderLabel, setSelectedFolderLabel] = useState<string | null>(null)
  const [tagInputs, setTagInputs] = useState<Record<number, string>>({})
  const [museumOptions, setMuseumOptions] = useState<MuseumOption[]>([])
  const [eraOptions, setEraOptions] = useState<EraOption[]>([])
  const [museumSuggestions, setMuseumSuggestions] = useState<Record<number, MuseumOption[]>>({})
  const [exhibitionSuggestions, setExhibitionSuggestions] = useState<
    Record<number, ExhibitionOption[]>
  >({})
  const [matchedArtifacts, setMatchedArtifacts] = useState<Record<number, ExistingArtifactMatch | null>>({})

  const [sameArtifactDecisions, setSameArtifactDecisions] = useState<Record<number, "yes" | "no" | null>>({})
  const [matchIdentityKeys, setMatchIdentityKeys] = useState<Record<number, string>>({})
  const [submitNotice, setSubmitNotice] = useState<SubmitNotice | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const fileStoreRef = useRef<Map<number, File>>(new Map())
  const previewUrlStoreRef = useRef<Map<number, string>>(new Map())
  const matchingIdsRef = useRef<Set<number>>(new Set())
  const submittingIdsRef = useRef<Set<number>>(new Set())

  async function refreshGooglePhotosStatus() {
    try {
      const status = await fetchJson<GooglePhotosStatus>(`${apiBaseUrl}/api/google-photos/status`)
      setGooglePhotosStatus(status)
      return status
    } catch (err) {
      const nextError = err instanceof Error ? err.message : "读取 Google Photos 状态失败"
      setError(nextError)
      return null
    }
  }

  async function loadGooglePhotosMedia(options?: { sessionId?: string; pageToken?: string | null; append?: boolean }) {
    const sessionId = options?.sessionId ?? googlePhotosSession?.id ?? ""
    if (!sessionId) {
      setGooglePhotosMedia([])
      setGooglePhotosNextPageToken(null)
      return { items: [], next_page_token: null } satisfies GooglePhotosMediaList
    }
    const params = new URLSearchParams({
      session_id: sessionId,
      page_size: "100",
    })
    if (options?.pageToken) {
      params.set("page_token", options.pageToken)
    }
    const payload = await fetchJson<GooglePhotosMediaList>(
      `${apiBaseUrl}/api/google-photos/picker/media-items?${params.toString()}`,
    )
    setGooglePhotosMedia((current) => (options?.append ? [...current, ...payload.items] : payload.items))
    setGooglePhotosNextPageToken(payload.next_page_token)
    return payload
  }

  async function openGooglePhotosConfigModal() {
    setError(null)
    setMessage(null)
    try {
      const config = await fetchJson<GooglePhotosConfig>(`${apiBaseUrl}/api/google-photos/config`)
      setGooglePhotosConfigForm({
        clientId: config.client_id ?? "",
        clientSecret: "",
        redirectUri: config.redirect_uri || `${apiBaseUrl}/api/google-photos/callback`,
      })
    } catch {
      setGooglePhotosConfigForm({
        clientId: "",
        clientSecret: "",
        redirectUri: `${apiBaseUrl}/api/google-photos/callback`,
      })
    }
    setShowGooglePhotosConfigModal(true)
  }

  async function createGooglePhotosPickerSession() {
    const payload = await fetchJson<GooglePhotosPickerSession>(`${apiBaseUrl}/api/google-photos/picker/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_item_count: 200 }),
    })
    setGooglePhotosSession(payload)
    setGooglePhotosMedia([])
    setGooglePhotosSelectedIds([])
    setGooglePhotosNextPageToken(null)
    return payload
  }

  async function pollGooglePhotosSession(sessionId: string) {
    const startedAt = Date.now()
    while (true) {
      const session = await fetchJson<GooglePhotosPickerSession>(
        `${apiBaseUrl}/api/google-photos/picker/sessions/${encodeURIComponent(sessionId)}`,
      )
      setGooglePhotosSession(session)
      if (session.media_items_set) {
        return session
      }
      const pollDelay = Math.max(1000, session.poll_interval_ms ?? 3000)
      const timeoutMs = session.timeout_in_ms ?? 120000
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Google Photos 选择超时，请重新打开 Picker。")
      }
      await new Promise((resolve) => window.setTimeout(resolve, pollDelay))
    }
  }

  async function handleConnectGooglePhotos() {
    setGooglePhotosBusy(true)
    setError(null)
    setMessage(null)
    try {
      const { auth_url: authUrl } = await fetchJson<{ auth_url: string }>(
        `${apiBaseUrl}/api/google-photos/auth/start`,
      )
      const popup = window.open(authUrl, "google-photos-auth", "width=640,height=760")
      if (!popup) {
        throw new Error("浏览器拦截了授权弹窗，请允许弹窗后重试。")
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void) => {
          if (settled) return
          settled = true
          window.removeEventListener("message", onMessage)
          window.clearInterval(timer)
          callback()
        }
        const onMessage = (event: MessageEvent) => {
          const data = event.data as { source?: string; success?: boolean; message?: string } | null
          if (data?.source !== "google-photos-oauth") {
            return
          }
          finish(() => {
            if (data.success) {
              resolve()
              return
            }
            reject(new Error(data.message || "Google Photos 连接失败"))
          })
        }
        const timer = window.setInterval(() => {
          if (popup.closed) {
            finish(() => resolve())
          }
        }, 500)
        window.addEventListener("message", onMessage)
      })
      const status = await refreshGooglePhotosStatus()
      if (!status?.connected) {
        throw new Error(status?.detail || "Google Photos 尚未连接成功")
      }
      const session = await createGooglePhotosPickerSession()
      const pickerWindow = window.open(session.picker_uri, "google-photos-picker", "width=1280,height=860")
      if (!pickerWindow) {
        throw new Error("浏览器拦截了 Google Photos Picker 弹窗，请允许弹窗后重试。")
      }
      setGooglePhotosSelectedIds([])
      const completedSession = await pollGooglePhotosSession(session.id)
      if (!completedSession.media_items_set) {
        throw new Error("Google Photos Picker 尚未完成选择。")
      }
      await loadGooglePhotosMedia({ sessionId: completedSession.id })
      setMessage("Google Photos Picker 已完成选择，可勾选图片并导入。")
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接 Google Photos 失败")
    } finally {
      setGooglePhotosBusy(false)
    }
  }

  async function handleSaveGooglePhotosConfig() {
    setGooglePhotosBusy(true)
    setError(null)
    setMessage(null)
    try {
      await fetchJson<GooglePhotosConfig>(`${apiBaseUrl}/api/google-photos/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: googlePhotosConfigForm.clientId.trim(),
          client_secret: googlePhotosConfigForm.clientSecret.trim(),
          redirect_uri: googlePhotosConfigForm.redirectUri.trim(),
        }),
      })
      setShowGooglePhotosConfigModal(false)
      setGooglePhotosConfigForm((current) => ({ ...current, clientSecret: "" }))
      await refreshGooglePhotosStatus()
      await handleConnectGooglePhotos()
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存 Google Photos 配置失败")
    } finally {
      setGooglePhotosBusy(false)
    }
  }

  async function handleClearGooglePhotosToken() {
    setGooglePhotosBusy(true)
    setError(null)
    setMessage(null)
    try {
      const status = await fetchJson<GooglePhotosStatus>(`${apiBaseUrl}/api/google-photos/token`, {
        method: "DELETE",
      })
      setGooglePhotosStatus(status)
      setGooglePhotosSession(null)
      setGooglePhotosMedia([])
      setGooglePhotosSelectedIds([])
      setGooglePhotosNextPageToken(null)
      setMessage("已清除本地 Google Photos 授权，可重新发起授权。")
    } catch (err) {
      setError(err instanceof Error ? err.message : "清除 Google Photos 授权失败")
    } finally {
      setGooglePhotosBusy(false)
    }
  }

  function handleGooglePhotosPrimaryAction() {
    if (googlePhotosStatus?.auth_configured === false) {
      void openGooglePhotosConfigModal()
      return
    }
    void handleConnectGooglePhotos()
  }

  function isPersistedPendingItem(item: PendingArtifact) {
    return !fileStoreRef.current.has(item.id)
  }

  async function savePersistedPendingItem(item: PendingArtifact) {
    const payload = await fetchJson<RawPendingArtifact>(`${apiBaseUrl}/api/batch/pending/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        museum_name: item.museum_name?.trim() || null,
        name: item.name?.trim() || null,
        era: item.era?.trim() || null,
        description: item.description?.trim() || null,
        tags: normalizeTags(item.tags ?? []),
        camera_model: item.camera_model?.trim() || null,
        lens_model: item.lens_model?.trim() || null,
        capture_museum_name: item.capture_museum_name?.trim() || null,
        exhibition_name: item.exhibition_name?.trim() || null,
        latitude: item.latitude,
        longitude: item.longitude,
        captured_at: item.captured_at?.trim() || null,
        shutter_speed: item.shutter_speed?.trim() || null,
        aperture: item.aperture?.trim() || null,
        iso: item.iso,
        edit_method: item.edit_method || null,
        existing_artifact_id: item.existing_artifact_id,
      }),
    })
    return enrichPendingItemTags(normalizePersistedPendingItem(apiBaseUrl, payload))
  }

  async function identifyPersistedPendingItem(id: number) {
    const response = await fetch(`${apiBaseUrl}/api/batch/identify/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { detail?: string }
      throw new Error(payload.detail || `HTTP ${response.status}`)
    }
    if (!response.body) {
      throw new Error("识别流未返回内容")
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let result: PendingArtifact | null = null
    let itemError: string | null = null

    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const events = buffer.split("\n\n")
      buffer = events.pop() ?? ""
      for (const eventText of events) {
        for (const line of eventText.split("\n")) {
          if (!line.startsWith("data: ")) continue
          const payload = JSON.parse(line.slice(6)) as {
            stage?: string
            id?: number
            message?: string
            item?: RawPendingArtifact
          }
          if (payload.stage === "item" && payload.id === id && payload.item) {
            result = enrichPendingItemTags(normalizePersistedPendingItem(apiBaseUrl, payload.item))
          }
          if (payload.stage === "item_error" && payload.id === id) {
            itemError = payload.message || "识别失败"
          }
        }
      }
      if (done) break
    }
    if (result) {
      return result
    }
    if (itemError) {
      throw new Error(itemError)
    }
    throw new Error("未获得识别结果")
  }

  async function importGooglePhotosSelection() {
    if (googlePhotosSelectedIds.length === 0) {
      setError("请先选择要导入的 Google Photos 图片")
      return
    }
    setGooglePhotosBusy(true)
    setError(null)
    setMessage(null)
    try {
      const payload = await fetchJson<GooglePhotosImportResult>(`${apiBaseUrl}/api/google-photos/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: googlePhotosSession?.id ?? "",
          media_item_ids: googlePhotosSelectedIds,
        }),
      })
      const importedItems = payload.items
        .map((item) => enrichPendingItemTags(normalizePersistedPendingItem(apiBaseUrl, item)))
      setItems((current) => [...importedItems, ...current.filter((item) => !importedItems.some((next) => next.id === item.id))])
      setGooglePhotosSession(null)
      setGooglePhotosMedia([])
      setGooglePhotosSelectedIds([])
      setGooglePhotosNextPageToken(null)
      const warningText = payload.warnings.length > 0 ? `；${payload.warnings.join("；")}` : ""
      setMessage(`已从 Google Photos 导入 ${payload.imported} 张，跳过 ${payload.skipped} 张${warningText}`)
      if (importedItems.length > 0) {
        window.setTimeout(() => {
          void handleIdentifyAll(importedItems.map((item) => item.id))
        }, 0)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入 Google Photos 图片失败")
    } finally {
      setGooglePhotosBusy(false)
    }
  }

  useEffect(() => {
    return () => {
      previewUrlStoreRef.current.forEach((previewUrl) => URL.revokeObjectURL(previewUrl))
      previewUrlStoreRef.current.clear()
      fileStoreRef.current.clear()
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const [museums, eras, pendingItems] = await Promise.all([
          fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?limit=200`),
          fetchJson<EraOption[]>(`${apiBaseUrl}/api/era-options`),
          fetchJson<RawPendingArtifact[]>(`${apiBaseUrl}/api/batch/pending`),
        ])
        setMuseumOptions(museums)
        setEraOptions(eras)
        setItems(pendingItems.map((item) => enrichPendingItemTags(normalizePersistedPendingItem(apiBaseUrl, item))))
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载下拉选项失败")
      }
    })()
  }, [apiBaseUrl])

  useEffect(() => {
    void (async () => {
      await refreshGooglePhotosStatus()
    })()
  }, [apiBaseUrl])

  useEffect(() => {
    if (!submitNotice) {
      return
    }
    const timeout = window.setTimeout(
      () => setSubmitNotice(null),
      submitNotice.type === "error" ? 6000 : 3500,
    )
    return () => window.clearTimeout(timeout)
  }, [submitNotice])

  useEffect(() => {
    const cleanup: Array<() => void> = []
    items.forEach((item) => {
      const rawQuery = item.capture_museum_name?.trim() ?? ""
      if (!rawQuery.startsWith("@")) {
        setMuseumSuggestions((current) => {
          if (!current[item.id]?.length) return current
          const next = { ...current }
          delete next[item.id]
          return next
        })
        return
      }
      const q = rawQuery.slice(1).trim()
      const controller = new AbortController()
      const timer = window.setTimeout(async () => {
        try {
          const params = new URLSearchParams({ limit: "8" })
          if (q) params.set("q", q)
          const data = await fetchJson<MuseumOption[]>(
            `${apiBaseUrl}/api/museums?${params.toString()}`,
            { signal: controller.signal },
          )
          setMuseumSuggestions((current) => ({ ...current, [item.id]: data }))
        } catch {
          if (!controller.signal.aborted) {
            setMuseumSuggestions((current) => ({ ...current, [item.id]: [] }))
          }
        }
      }, 180)
      cleanup.push(() => {
        controller.abort()
        window.clearTimeout(timer)
      })
    })
    return () => {
      cleanup.forEach((fn) => fn())
    }
  }, [apiBaseUrl, items])

  useEffect(() => {
    const cleanup: Array<() => void> = []
    items.forEach((item) => {
      const selectedMuseum =
        museumOptions.find((museum) => museum.name === (item.capture_museum_name ?? "").trim()) ??
        museumSuggestions[item.id]?.find((museum) => museum.name === (item.capture_museum_name ?? "").trim()) ??
        null
      const rawQuery = item.exhibition_name?.trim() ?? ""
      if (!selectedMuseum || !rawQuery.startsWith("@")) {
        setExhibitionSuggestions((current) => {
          if (!current[item.id]?.length) return current
          const next = { ...current }
          delete next[item.id]
          return next
        })
        return
      }
      const q = rawQuery.slice(1).trim()
      const controller = new AbortController()
      const timer = window.setTimeout(async () => {
        try {
          const params = new URLSearchParams({
            museum_id: String(selectedMuseum.id),
            limit: "8",
          })
          if (q) params.set("q", q)
          const data = await fetchJson<ExhibitionOption[]>(
            `${apiBaseUrl}/api/exhibitions?${params.toString()}`,
            { signal: controller.signal },
          )
          setExhibitionSuggestions((current) => ({ ...current, [item.id]: data }))
        } catch {
          if (!controller.signal.aborted) {
            setExhibitionSuggestions((current) => ({ ...current, [item.id]: [] }))
          }
        }
      }, 180)
      cleanup.push(() => {
        controller.abort()
        window.clearTimeout(timer)
      })
    })
    return () => {
      cleanup.forEach((fn) => fn())
    }
  }, [apiBaseUrl, items, museumOptions, museumSuggestions])

  function patchLocal(id: number, patch: Partial<PendingArtifact>) {
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              ...patch,
              updated_at: patch.updated_at ?? new Date().toISOString(),
            }
          : item,
      ),
    )
  }

  function buildIdentityKey(item: PendingArtifact) {
    const name = (item.name ?? "").trim()
    const museumName = (item.museum_name ?? "").trim()
    const era = (item.era ?? "").trim()
    if (!name || !museumName || !era) {
      return null
    }
    return `${name}__${museumName}__${era}`
  }

  function clearMatchState(id: number) {
    setMatchedArtifacts((current) => {
      if (!(id in current)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
    setSameArtifactDecisions((current) => {
      if (!(id in current)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
    setMatchIdentityKeys((current) => {
      if (!(id in current)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  async function lookupMatchForItem(item: PendingArtifact) {
    const identityKey = buildIdentityKey(item)
    if (!identityKey) {
      clearMatchState(item.id)
      return null
    }

    const previousIdentityKey = matchIdentityKeys[item.id]
    if (previousIdentityKey === identityKey && item.id in matchedArtifacts) {
      return matchedArtifacts[item.id] ?? null
    }
    if (matchingIdsRef.current.has(item.id)) {
      return matchedArtifacts[item.id] ?? null
    }

    matchingIdsRef.current.add(item.id)
    try {
      const params = new URLSearchParams({ name: (item.name ?? "").trim() })
      params.set("museum_name", (item.museum_name ?? "").trim())
      params.set("era", (item.era ?? "").trim())
      const matched = await fetchJson<ExistingArtifactMatch | null>(
        `${apiBaseUrl}/api/artifacts/match?${params.toString()}`,
      )
      setMatchedArtifacts((current) => ({ ...current, [item.id]: matched }))
      setSameArtifactDecisions((current) => {
        if (previousIdentityKey === identityKey) {
          return current
        }
        return { ...current, [item.id]: null }
      })
      setMatchIdentityKeys((current) => ({ ...current, [item.id]: identityKey }))
      if (!matched && item.existing_artifact_id != null) {
        patchLocal(item.id, { existing_artifact_id: null })
      }
      return matched
    } catch (err) {
      setMatchedArtifacts((current) => ({ ...current, [item.id]: null }))
      setMatchIdentityKeys((current) => ({ ...current, [item.id]: identityKey }))
      throw err
    } finally {
      matchingIdsRef.current.delete(item.id)
    }
  }

  function pickPreferredCandidate(candidates: VisionCandidate[]) {
    return candidates.find((candidate) => candidate.provider === "qwen_web") ?? candidates[0] ?? null
  }

  function releaseLocalImage(item: PendingArtifact) {
    const previewUrl = previewUrlStoreRef.current.get(item.id)
    if (previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrl)
    }
    previewUrlStoreRef.current.delete(item.id)
    fileStoreRef.current.delete(item.id)
  }

  function addTags(id: number, rawValue: string) {
    const nextTags = normalizeTags(rawValue.split(/[,\n，、；;]/).map((tag) => tag.trim()))
    if (nextTags.length === 0) {
      return
    }
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, tags: normalizeTags([...(item.tags ?? []), ...nextTags]) } : item,
      ),
    )
    setTagInputs((current) => ({ ...current, [id]: "" }))
  }

  function removeTag(id: number, tagToRemove: string) {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, tags: item.tags.filter((tag) => tag !== tagToRemove) } : item,
      ),
    )
  }

  async function handleScan(files: FileList | null) {
    if (!files || files.length === 0) {
      setError("请先选择一个包含图片的文件夹")
      return
    }
    setScanning(true)
    setError(null)
    setMessage(null)
    try {
      const uploadFiles = Array.from(files)
      const firstFile = uploadFiles[0] as FileWithRelativePath
      const folderName = firstFile.webkitRelativePath?.split("/")[0] || "已选文件夹"
      setSelectedFolderLabel(`${folderName} · ${uploadFiles.length} 个文件`)
      const formData = new FormData()
      uploadFiles.forEach((file) => formData.append("files", file, file.name))
      const payload = await fetchJson<BatchScanResponse>(`${apiBaseUrl}/api/batch/scan-files`, {
        method: "POST",
        body: formData,
      })
      setItems(payload.items.map((item) => enrichPendingItemTags(normalizePersistedPendingItem(apiBaseUrl, item))))
      setMessage(`本地图片已同步到待处理池：新增 ${payload.added} 张，跳过 ${payload.skipped} 张`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "扫描失败")
    } finally {
      setScanning(false)
      if (folderInputRef.current) {
        folderInputRef.current.value = ""
      }
    }
  }

  async function handleIdentifyAll(ids: number[] = []) {
    setIdentifying(true)
    setError(null)
    setMessage(null)
    setProgress(null)
    let done = 0
    try {
      const targets = items.filter((item) =>
        ids.length > 0 ? ids.includes(item.id) : item.status === "pending" || item.status === "failed",
      )
      setProgress({ done: 0, total: targets.length })
      for (const item of targets) {
        patchLocal(item.id, { status: "identifying", error: null })
        try {
          const file = fileStoreRef.current.get(item.id)
          if (!file && isPersistedPendingItem(item)) {
            const identified = await identifyPersistedPendingItem(item.id)
            patchLocal(item.id, identified)
          } else if (!file) {
            throw new Error("当前图片文件已丢失，请重新选择文件夹")
          } else {
            const formData = new FormData()
            formData.append("file", file, file.name)
            formData.append("image_name", item.file_name)
            const response = await fetchJson<VisionAnalyzeResponse>(`${apiBaseUrl}/api/vision/analyze/file`, {
              method: "POST",
              body: formData,
            })
            const candidate = pickPreferredCandidate(response.candidates)
            if (!candidate) {
              throw new Error("未获得识别结果")
            }
            patchLocal(
              item.id,
              enrichPendingItemTags({
                ...item,
                museum_name: candidate.museum_name ?? item.museum_name,
                name: candidate.artifact_name ?? item.name,
                era: candidate.era ?? item.era,
                description: candidate.description ?? item.description,
                tags: normalizeTags(candidate.tags ?? []),
                confidence: candidate.confidence,
                provider: candidate.provider,
                analysis: candidate.analysis ?? item.analysis,
                status: "identified",
                error: null,
              }),
            )
          }
        } catch (identifyError) {
          patchLocal(item.id, {
            status: "failed",
            error: identifyError instanceof Error ? identifyError.message : "识别失败",
          })
        }
        done += 1
        setProgress((p) => (p ? { ...p, done } : { done, total: targets.length }))
      }
      setMessage("识别完成，请逐条核对后提交云端")
    } catch (err) {
      setError(err instanceof Error ? err.message : "识别失败")
    } finally {
      setIdentifying(false)
    }
  }

  async function saveItem(item: PendingArtifact) {
    if (isPersistedPendingItem(item)) {
      return savePersistedPendingItem(item)
    }
    return { ...item, updated_at: new Date().toISOString() }
  }

  async function handleSave(item: PendingArtifact) {
    setError(null)
    setMessage(null)
    setSubmitNotice(null)
    try {
      const matched = await lookupMatchForItem(item)
      const saved = await saveItem(item)
      patchLocal(item.id, saved)
      if (matched) {
        setMessage(`已保存「${saved.name ?? saved.file_name}」，下方列出了疑似冲突记录`)
        setSubmitNotice({
          type: "success",
          text: `已保存「${saved.name ?? saved.file_name}」，下方列出了疑似冲突记录`,
        })
      } else {
        setMessage(`已保存「${saved.name ?? saved.file_name}」`)
        setSubmitNotice({
          type: "success",
          text: `已保存「${saved.name ?? saved.file_name}」`,
        })
      }
    } catch (err) {
      const saveError = err instanceof Error ? err.message : "保存失败"
      setError(saveError)
      setSubmitNotice({ type: "error", text: saveError })
    }
  }

  async function handleSubmit(item: PendingArtifact) {
    if (submittingIdsRef.current.has(item.id) || item.status === "submitting" || item.status === "submitted") {
      return
    }

    submittingIdsRef.current.add(item.id)
    setError(null)
    setMessage(null)
    setSubmitNotice(null)
    try {
      const matchedArtifact = await lookupMatchForItem(item)
      const sameArtifactDecision = sameArtifactDecisions[item.id] ?? null
      const normalizedItem: PendingArtifact = {
        ...item,
        existing_artifact_id:
          sameArtifactDecision === "no" ? null : matchedArtifact?.artifact.id ?? item.existing_artifact_id ?? null,
      }
      if (!(item.museum_name ?? "").trim()) {
        throw new Error("请填写或确认博物馆名称")
      }
      if (!(item.name ?? "").trim()) {
        throw new Error("请填写或确认文物名称")
      }
      if (!(item.capture_museum_name ?? "").trim() || (item.capture_museum_name ?? "").trim().startsWith("@")) {
        throw new Error("请填写或选择拍摄时所在博物馆")
      }
      if (!(item.exhibition_name ?? "").trim() || (item.exhibition_name ?? "").trim().startsWith("@")) {
        throw new Error("请填写或选择展览名称")
      }
      if (matchedArtifact && sameArtifactDecision == null) {
        throw new Error("发现疑似同一件文物，请先在下方确认“是同一件”还是“不是同一件”后再提交。")
      }
      patchLocal(item.id, { ...normalizedItem, status: "submitting", error: null })
      const saved = await saveItem({ ...normalizedItem, status: "submitting", error: null })
      patchLocal(item.id, saved)
      const file = fileStoreRef.current.get(item.id)
      if (!file && isPersistedPendingItem(normalizedItem)) {
        const result = await fetchJson<PendingArtifactSubmitResult>(
          `${apiBaseUrl}/api/batch/pending/${normalizedItem.id}/submit`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ skip_existing_match: sameArtifactDecision === "no" }),
          },
        )
        const submittedItem = normalizePersistedPendingItem(apiBaseUrl, result.item)
        patchLocal(normalizedItem.id, {
          ...submittedItem,
          status: "submitted",
          error: null,
        })
        const submitText = result.duplicate_image_replaced
          ? `「${submittedItem.name ?? submittedItem.file_name}」已覆盖云端已有图片`
          : result.duplicate_image_skipped
          ? `「${submittedItem.name ?? submittedItem.file_name}」云端已存在相同图片，已跳过重复上传`
          : `「${submittedItem.name ?? submittedItem.file_name}」已提交云端`
        setMessage(submitText)
        setSubmitNotice({
          type: "success",
          text: result.duplicate_image_detail ?? submitText,
        })
        return
      }
      if (!file) {
        throw new Error("当前图片文件已丢失，请重新选择文件夹")
      }
      const formData = new FormData()
      formData.append("file", file, file.name)
      formData.append("museum_name", normalizedItem.museum_name ?? "")
      formData.append("name", normalizedItem.name ?? "")
      formData.append("era", normalizedItem.era ?? "")
      formData.append("description", normalizedItem.description ?? "")
      formData.append("skip_existing_match", String(sameArtifactDecision === "no"))
      formData.append("tags", JSON.stringify(normalizedItem.tags ?? []))
      formData.append("camera_model", normalizedItem.camera_model ?? "")
      formData.append("lens_model", normalizedItem.lens_model ?? "")
      formData.append("capture_museum_name", normalizedItem.capture_museum_name ?? "")
      formData.append("exhibition_name", normalizedItem.exhibition_name ?? "")
      formData.append("latitude", normalizedItem.latitude == null ? "" : String(normalizedItem.latitude))
      formData.append("longitude", normalizedItem.longitude == null ? "" : String(normalizedItem.longitude))
      formData.append("captured_at", normalizedItem.captured_at ?? "")
      formData.append("shutter_speed", normalizedItem.shutter_speed ?? "")
      formData.append("aperture", normalizedItem.aperture ?? "")
      formData.append("iso", normalizedItem.iso == null ? "" : String(normalizedItem.iso))
      formData.append("edit_method", normalizedItem.edit_method ?? "")
      if (normalizedItem.existing_artifact_id != null) {
        formData.append("existing_artifact_id", String(normalizedItem.existing_artifact_id))
      }
      const res = await fetch(`${apiBaseUrl}/api/artifacts/submit-cloud-file`, {
        method: "POST",
        body: formData,
      })
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(detail.detail ?? `HTTP ${res.status}`)
      }
      const created = (await res.json()) as { id: number; name: string }
      patchLocal(item.id, {
        status: "submitted",
        cloud_artifact_id: created.id,
        error: null,
      })
      setMessage(`「${created.name}」已提交云端`)
      setSubmitNotice({ type: "success", text: `「${created.name}」已提交云端` })
    } catch (err) {
      const submitError = err instanceof Error ? err.message : "提交失败"
      patchLocal(item.id, { status: "failed", error: submitError })
      setError(submitError)
      setSubmitNotice({ type: "error", text: submitError })
    } finally {
      submittingIdsRef.current.delete(item.id)
    }
  }

  async function handleDelete(id: number) {
    const current = items.find((item) => item.id === id)
    if (current) {
      if (isPersistedPendingItem(current)) {
        await fetchJson<unknown>(`${apiBaseUrl}/api/batch/pending/${id}`, { method: "DELETE" })
      }
      releaseLocalImage(current)
    }
    setItems((drafts) => drafts.filter((item) => item.id !== id))
  }

  async function handleClearAll() {
    if (items.length === 0) {
      return
    }
    const confirmed = window.confirm(`确认全部清除当前批量列表中的 ${items.length} 条记录吗？此操作不可撤销。`)
    if (!confirmed) {
      return
    }
    try {
      setError(null)
      setMessage(null)
      setSubmitNotice(null)
      await Promise.all(
        items.map(async (item) => {
          if (isPersistedPendingItem(item)) {
            await fetchJson<unknown>(`${apiBaseUrl}/api/batch/pending/${item.id}`, { method: "DELETE" })
          }
          releaseLocalImage(item)
        }),
      )
      setItems([])
      setTagInputs({})
      setMuseumSuggestions({})
      setExhibitionSuggestions({})
      setMatchedArtifacts({})
      setSameArtifactDecisions({})
      setMatchIdentityKeys({})
      setProgress(null)
      setSelectedFolderLabel(null)
      setMessage("已清空当前页面中的批量图片与草稿")
      setSubmitNotice({ type: "success", text: "已清空当前页面中的批量图片与草稿" })
    } catch (err) {
      const clearError = err instanceof Error ? err.message : "全部清除失败"
      setError(clearError)
      setSubmitNotice({ type: "error", text: clearError })
    }
  }

  const pendingCount = items.filter((i) => i.status === "pending" || i.status === "failed").length

  return (
    <section className="panel form-wide batch-workbench">
      <BatchImportPanel
        folderInputRef={folderInputRef} scanning={scanning} selectedFolderLabel={selectedFolderLabel} onScan={(files) => void handleScan(files)}
        googleStatus={googlePhotosStatus} googleBusy={googlePhotosBusy} media={googlePhotosMedia} selectedIds={googlePhotosSelectedIds} nextPageToken={googlePhotosNextPageToken} session={googlePhotosSession}
        onPrimary={handleGooglePhotosPrimaryAction} onConfig={() => void openGooglePhotosConfigModal()} onClearToken={() => void handleClearGooglePhotosToken()} onConnect={() => void handleConnectGooglePhotos()} onImport={() => void importGooglePhotosSelection()}
        onToggleMedia={(id) => setGooglePhotosSelectedIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])}
        onLoadMore={() => void loadGooglePhotosMedia({ sessionId: googlePhotosSession?.id ?? "", pageToken: googlePhotosNextPageToken, append: true })}
        identifying={identifying} pendingCount={pendingCount} itemCount={items.length} progress={progress} message={message} error={error}
        onIdentifyAll={() => void handleIdentifyAll([])} onClearAll={() => void handleClearAll()}
      />
      <div className="batch-list">
        {items.map((item) => {
          const hasMuseumOptions = museumOptions.length > 0
          const hasEraOptions = eraOptions.length > 0
          const selectedMuseum =
            museumOptions.find((museum) => museum.name === (item.capture_museum_name ?? "").trim()) ??
            museumSuggestions[item.id]?.find((museum) => museum.name === (item.capture_museum_name ?? "").trim()) ??
            null
          const activeIdentityKey = buildIdentityKey(item)
          const matchedArtifact =
            activeIdentityKey && matchIdentityKeys[item.id] === activeIdentityKey
              ? matchedArtifacts[item.id] ?? null
              : null
          const sameArtifactDecision =
            activeIdentityKey && matchIdentityKeys[item.id] === activeIdentityKey
              ? sameArtifactDecisions[item.id] ?? null
              : null

          return (
          <article key={item.id} className="batch-card">
            <div className="batch-thumb">
              <img
                src={item.image_url}
                alt={item.file_name}
                loading="lazy"
              />
              <span className={`pulse ${statusClass(item.status)}`} />
            </div>

            <div className="batch-fields">
              <div className="batch-head">
                <span className="muted small">{item.file_name}</span>
                <Tag color={item.status === "submitted" ? "success" : undefined}>
                  {STATUS_LABEL[item.status] ?? item.status}
                  {item.confidence != null ? ` · ${Math.round(item.confidence * 100)}%` : ""}
                </Tag>
              </div>

              <div className="batch-core-card">
                <div className="batch-section-head">
                  <strong>核心信息</strong>
                  <span>先确认这 4 项，其他字段再补充。</span>
                </div>
                <div className="batch-core-grid">
                  <label className={`field ${isMissingValue(item.museum_name) ? "field-invalid" : ""}`}>
                    <span>博物馆 / 出土地</span>
                    <Input
                      list="batch-museum-options"
                      value={item.museum_name ?? ""}
                      onChange={(e) => patchLocal(item.id, { museum_name: e.target.value || null })}
                      placeholder={hasMuseumOptions ? "输入或选择博物馆 / 出土地" : "加载博物馆选项中…"}
                    />
                    {isMissingValue(item.museum_name) ? (
                      <span className="field-help error">请先确认文物所属博物馆或出土地。</span>
                    ) : (
                      <span className="field-help">支持直接输入，也可从联想候选中选择，减少馆名不一致的问题。</span>
                    )}
                  </label>
                  <label className={`field ${isMissingValue(item.name) ? "field-invalid" : ""}`}>
                    <span>文物名称</span>
                    <Input
                      value={item.name ?? ""}
                      onChange={(e) => patchLocal(item.id, { name: e.target.value })}
                      placeholder="例如：天王俑"
                    />
                    {isMissingValue(item.name) ? (
                      <span className="field-help error">请填写最终入库名称，不要留空。</span>
                    ) : (
                      <span className="field-help">尽量用明确器名，避免“待确认文物”这类占位词。</span>
                    )}
                  </label>
                  <label className={`field ${isMissingValue(item.era) ? "field-soft-missing" : ""}`}>
                    <span>时代</span>
                    <Input
                      list="batch-era-options"
                      value={item.era ?? ""}
                      onChange={(e) => patchLocal(item.id, { era: e.target.value || null })}
                      placeholder={hasEraOptions ? "输入或选择时代" : "加载时代选项中…"}
                    />
                    <span className="field-help">
                      {isMissingValue(item.era)
                        ? "支持直接输入，也可从参考时代中联想选择，便于后续检索和筛选。"
                        : "可直接输入或从参考时代列表中联想选择。"}
                    </span>
                  </label>
                  <label
                    className={`field ${
                      isMissingValue(item.exhibition_name) || needsSelection(item.exhibition_name)
                        ? "field-invalid"
                        : ""
                    }`}
                  >
                    <span>展览</span>
                    <AutoComplete
                      value={item.exhibition_name ?? ""}
                      options={(exhibitionSuggestions[item.id] ?? []).map((exhibition) => ({
                        key: exhibition.id,
                        value: exhibition.name,
                        label: (
                          <span className="autocomplete-option">
                            <span>{exhibition.name}</span>
                            <span className="autocomplete-option-meta">{exhibition.museum_name}</span>
                          </span>
                        ),
                      }))}
                      filterOption={false}
                      onChange={(value) => patchLocal(item.id, { exhibition_name: value })}
                      onSelect={(value) => {
                        setExhibitionSuggestions((current) => ({ ...current, [item.id]: [] }))
                        patchLocal(item.id, { exhibition_name: value })
                      }}
                      placeholder={
                        selectedMuseum
                          ? "默认常设，输入 @ 后联想检索该馆展览"
                          : "例如：常设 / 大唐遗宝特展"
                      }
                    />
                    {needsSelection(item.exhibition_name) ? (
                      <span className="field-help error">请输入 `@关键词` 后从联想结果里选择展览。</span>
                    ) : isMissingValue(item.exhibition_name) ? (
                      <span className="field-help error">请填写或选择展览名称，常设展可直接填“常设”。</span>
                    ) : (
                      <span className="field-help">如果是常设展，可直接保留“常设”。</span>
                    )}
                  </label>
                </div>
              </div>

              {matchedArtifact ? (
                <section className="backend-match-card">
                  <div className="backend-match-head">
                    <div>
                      <h3>后端疑似同一件</h3>
                      <p className="muted">
                        {matchedArtifact.match_reason} 匹配度 {Math.round(matchedArtifact.match_score * 100)}%
                      </p>
                    </div>
                    <span className="backend-match-count">{matchedArtifact.artifact.images.length} 张历史图片</span>
                  </div>
                  <div className="backend-match-meta">
                    <span>名称：{matchedArtifact.artifact.name}</span>
                    <span>时代：{matchedArtifact.artifact.era || "待确认"}</span>
                    <span>馆藏：{matchedArtifact.artifact.museum_name}</span>
                  </div>
                  {matchedArtifact.artifact.tags.length > 0 ? (
                    <div className="tag-row">
                      {matchedArtifact.artifact.tags.map((tag) => (
                        <Tag key={`batch-match-tag-${item.id}-${tag}`}>
                          {tag}
                        </Tag>
                      ))}
                    </div>
                  ) : null}
                  {matchedArtifact.artifact.description ? (
                    <p className="result-desc">{matchedArtifact.artifact.description}</p>
                  ) : (
                    <p className="muted small">库中这条记录暂无描述。</p>
                  )}
                  {matchedArtifact.artifact.images.length > 0 ? (
                    <div className="existing-artifact-gallery">
                      {matchedArtifact.artifact.images.map((image) => (
                        <a
                          key={image.id}
                          href={`${apiBaseUrl}${image.url}`}
                          target="_blank"
                          rel="noreferrer"
                          className="existing-artifact-thumb"
                        >
                          <img src={`${apiBaseUrl}${image.url}`} alt={matchedArtifact.artifact.name} loading="lazy" />
                        </a>
                      ))}
                    </div>
                  ) : null}
                  <div className="backend-match-actions">
                    <Button
                      htmlType="button"
                      type="primary"
                      size="small"
                      onClick={() => {
                        patchLocal(item.id, {
                          museum_name: matchedArtifact.artifact.museum_name,
                          name: matchedArtifact.artifact.name,
                          era: matchedArtifact.artifact.era ?? "",
                          description: matchedArtifact.artifact.description ?? "",
                          tags: normalizeTags(matchedArtifact.artifact.tags),
                          existing_artifact_id: matchedArtifact.artifact.id,
                        })
                        setTagInputs((current) => ({ ...current, [item.id]: "" }))
                        setSameArtifactDecisions((current) => ({ ...current, [item.id]: "yes" }))
                        setMessage(`已确认「${item.file_name}」与「${matchedArtifact.artifact.name}」是同一件`)
                        setError(null)
                      }}
                    >
                      是同一件
                    </Button>
                    <Button
                      htmlType="button"
                      type={sameArtifactDecision === "no" ? "primary" : "text"}
                      onClick={() => {
                        patchLocal(item.id, { existing_artifact_id: null })
                        setSameArtifactDecisions((current) => ({ ...current, [item.id]: "no" }))
                        setMessage(`已标记「${item.file_name}」不是同一件，提交时会新建文物记录`)
                        setError(null)
                      }}
                    >
                      不是同一件
                    </Button>
                  </div>
                  {sameArtifactDecision === "yes" ? (
                    <p className="success-text">提交时会直接更新这条已有文物，并把当前图片作为新图追加。</p>
                  ) : sameArtifactDecision === "no" ? (
                    <p className="muted small">已按“不是同一件”处理，提交时会新建文物记录。</p>
                  ) : (
                    <p className="muted small">如不手动处理，提交时也会优先合并到这条已有文物，避免重复建档。</p>
                  )}
                </section>
              ) : null}

              <div className="field-row">
                <label className="field">
                  <span>标签</span>
                  <div className="tag-editor">
                    <div className="tag-editor-chips">
                      {item.tags.length > 0 ? (
                        item.tags.map((tag) => (
                          <Tag key={tag} closable onClose={() => removeTag(item.id, tag)}>
                            {tag}
                          </Tag>
                        ))
                      ) : (
                        <span className="tag-editor-placeholder">暂无标签</span>
                      )}
                    </div>
                    <Input
                      value={tagInputs[item.id] ?? ""}
                      onChange={(e) =>
                        setTagInputs((current) => ({ ...current, [item.id]: e.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === "," || event.key === "，") {
                          event.preventDefault()
                          addTags(item.id, tagInputs[item.id] ?? "")
                        }
                        if (event.key === "Backspace" && !(tagInputs[item.id] ?? "") && item.tags.length > 0) {
                          removeTag(item.id, item.tags[item.tags.length - 1])
                        }
                      }}
                      onBlur={() => addTags(item.id, tagInputs[item.id] ?? "")}
                      placeholder="输入后回车或逗号添加"
                    />
                  </div>
                  <span className="field-help">建议保留器型、工艺、题材、地域等检索标签。</span>
                </label>
                <label
                  className={`field ${
                    isMissingValue(item.capture_museum_name) || needsSelection(item.capture_museum_name)
                      ? "field-invalid"
                      : ""
                  }`}
                >
                  <span>拍摄时博物馆</span>
                  <AutoComplete
                    value={item.capture_museum_name ?? ""}
                    options={(museumSuggestions[item.id] ?? []).map((museum) => ({
                      key: museum.id,
                      value: museum.name,
                      label: museum.name,
                    }))}
                    filterOption={false}
                    onChange={(value) => {
                      patchLocal(item.id, {
                        capture_museum_name: value || null,
                        exhibition_name:
                          value && (!(item.exhibition_name ?? "").trim() || (item.exhibition_name ?? "").trim().startsWith("@"))
                            ? "常设"
                          : item.exhibition_name,
                      })
                    }}
                    onSelect={(value) => {
                      const museum = (museumSuggestions[item.id] ?? []).find((option) => option.name === value)
                      if (!museum) return
                      setMuseumSuggestions((current) => ({ ...current, [item.id]: [] }))
                      patchLocal(item.id, {
                        capture_museum_name: museum.name,
                        exhibition_name:
                          (item.exhibition_name ?? "").trim().startsWith("@") || !(item.exhibition_name ?? "").trim()
                            ? "常设"
                            : item.exhibition_name,
                      })
                    }}
                    placeholder={hasMuseumOptions ? "输入 @ 后联想检索，例如：@南博" : "加载博物馆选项中…"}
                  />
                  {needsSelection(item.capture_museum_name) ? (
                    <span className="field-help error">请输入 `@关键词` 后，从下方结果选择拍摄时所在博物馆。</span>
                  ) : isMissingValue(item.capture_museum_name) ? (
                    <span className="field-help error">提交前必须确认拍摄时所在博物馆。</span>
                  ) : (
                    <span className="field-help">支持直接输入，也可通过 `@关键词` 联想选择标准馆名。</span>
                  )}
                </label>
              </div>

              <label className="field">
                <span>描述</span>
                <Textarea
                  rows={4}
                  value={item.description ?? ""}
                  onChange={(e) => patchLocal(item.id, { description: e.target.value })}
                />
                <span className="field-help">描述里保留器型、工艺、用途和典型特征，不再重复标签列表。</span>
              </label>

              <div className="field-row">
                <label className="field">
                  <span>机型</span>
                  <Input
                    value={item.camera_model ?? ""}
                    onChange={(e) => patchLocal(item.id, { camera_model: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>镜头</span>
                  <Input
                    value={item.lens_model ?? ""}
                    onChange={(e) => patchLocal(item.id, { lens_model: e.target.value })}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>经度</span>
                  <Input
                    value={item.longitude ?? ""}
                    onChange={(e) =>
                      patchLocal(item.id, {
                        longitude: e.target.value.trim() ? Number(e.target.value) : null,
                      })
                    }
                    placeholder="例如：108.9402"
                  />
                </label>
                <label className="field">
                  <span>纬度</span>
                  <Input
                    value={item.latitude ?? ""}
                    onChange={(e) =>
                      patchLocal(item.id, {
                        latitude: e.target.value.trim() ? Number(e.target.value) : null,
                      })
                    }
                    placeholder="例如：34.3416"
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>拍摄时间</span>
                  <Input
                    value={item.captured_at ?? ""}
                    onChange={(e) => patchLocal(item.id, { captured_at: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>修图方式</span>
                  <Select
                    allowClear
                    placeholder="未填写"
                    value={item.edit_method || undefined}
                    options={[
                      { value: "简单调整", label: "简单调整" },
                      { value: "堆栈合成", label: "堆栈合成" },
                    ]}
                    onChange={(value) => patchLocal(item.id, { edit_method: value ?? null })}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>快门</span>
                  <Input
                    value={item.shutter_speed ?? ""}
                    onChange={(e) => patchLocal(item.id, { shutter_speed: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>光圈</span>
                  <Input
                    value={item.aperture ?? ""}
                    onChange={(e) => patchLocal(item.id, { aperture: e.target.value })}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>感光度</span>
                  <Input
                    value={item.iso ?? ""}
                    onChange={(e) =>
                      patchLocal(item.id, {
                        iso: e.target.value.trim() ? Number(e.target.value) : null,
                      })
                    }
                  />
                </label>
              </div>

              {item.error ? <p className="error-text">{item.error}</p> : null}
              {item.analysis ? <p className="muted">{item.analysis}</p> : null}

              <div className="batch-actions">
                <Button
                  htmlType="button"
                  type="text"
                  onClick={() => void handleSave(item)}
                >
                  保存
                </Button>
                <Button
                  htmlType="button"
                  type="primary"
                  size="small"
                  onClick={() => void handleSubmit(item)}
                  disabled={item.status === "submitting" || item.status === "submitted"}
                >
                  {item.status === "submitted"
                    ? "已入库"
                    : matchedArtifact && sameArtifactDecision !== "no"
                      ? "更新已有文物并上传图片"
                      : "提交云端"}
                </Button>
                <Button htmlType="button" type="text" danger onClick={() => void handleDelete(item.id)}>
                  删除
                </Button>
              </div>
            </div>
          </article>
          )
        })}
      </div>
      <datalist id="batch-museum-options">
        {museumOptions.map((museum) => (
          <option key={museum.id} value={museum.name} />
        ))}
      </datalist>
      <datalist id="batch-era-options">
        {eraOptions.map((era) => (
          <option key={era.id} value={era.name} />
        ))}
      </datalist>
      <BatchSubmitNotice notice={submitNotice} onClose={() => setSubmitNotice(null)} />
      <GooglePhotosConfigModal
        open={showGooglePhotosConfigModal}
        apiBaseUrl={apiBaseUrl}
        busy={googlePhotosBusy}
        value={googlePhotosConfigForm}
        onChange={setGooglePhotosConfigForm}
        onClose={() => setShowGooglePhotosConfigModal(false)}
        onSave={() => void handleSaveGooglePhotosConfig()}
      />
    </section>
  )
}
