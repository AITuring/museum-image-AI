import { useCallback, useEffect, useRef, useState } from "react"

type PendingArtifact = {
  id: number
  source_path: string
  file_name: string
  status: string
  error: string | null
  museum_name: string | null
  name: string | null
  era: string | null
  description: string | null
  tags: string[]
  camera_model: string | null
  lens_model: string | null
  capture_museum_name: string | null
  exhibition_name: string | null
  latitude: number | null
  longitude: number | null
  captured_at: string | null
  shutter_speed: string | null
  aperture: string | null
  iso: number | null
  edit_method: string | null
  confidence: number | null
  provider: string | null
  analysis: string | null
  existing_artifact_id: number | null
  cloud_artifact_id: number | null
  created_at: string
  updated_at: string
}

type BatchScanResponse = {
  scanned: number
  added: number
  skipped: number
  items: PendingArtifact[]
}

type StreamEvent = {
  stage: string
  total?: number
  id?: number
  file_name?: string
  item?: PendingArtifact
  message?: string
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待识别",
  identifying: "识别中…",
  identified: "已识别",
  submitting: "提交中…",
  submitted: "已入库",
  failed: "失败",
}

function statusClass(status: string) {
  if (status === "submitted") return "ok"
  if (status === "failed") return "failed"
  if (status === "identifying" || status === "submitting") return "busy"
  return ""
}

type MuseumOption = {
  id: number
  name: string
}

type EraOption = {
  id: number
  name: string
  sort_order: number
}

type ExhibitionOption = {
  id: number
  museum_id: number
  museum_name: string
  name: string
  start_at: string | null
  end_at: string | null
}

type ExistingArtifactImage = {
  id: number
  url: string
}

type ExistingArtifactMatch = {
  artifact: {
    id: number
    name: string
    era: string | null
    description: string | null
    museum_name: string
    tags: string[]
    images: ExistingArtifactImage[]
  }
  match_score: number
  match_reason: string
}

type SubmitNotice = {
  type: "success" | "error"
  text: string
}

type FileWithRelativePath = File & {
  webkitRelativePath?: string
}

const DISMISSED_BATCH_IDS_KEY = "batch-dismissed-pending-ids"

function readDismissedBatchIds() {
  if (typeof window === "undefined") {
    return new Set<number>()
  }
  try {
    const raw = window.localStorage.getItem(DISMISSED_BATCH_IDS_KEY)
    if (!raw) {
      return new Set<number>()
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return new Set<number>()
    }
    return new Set(parsed.filter((value): value is number => typeof value === "number"))
  } catch {
    return new Set<number>()
  }
}

function writeDismissedBatchIds(ids: Set<number>) {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.setItem(DISMISSED_BATCH_IDS_KEY, JSON.stringify(Array.from(ids)))
}

function normalizeTags(values: string[]) {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const value of values) {
    const tag = value.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

function isMissingValue(value: string | null | undefined) {
  return !value || !value.trim()
}

function needsSelection(value: string | null | undefined) {
  return (value ?? "").trim().startsWith("@")
}

export default function BatchConsole({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [items, setItems] = useState<PendingArtifact[]>([])
  const [scanning, setScanning] = useState(false)
  const [identifying, setIdentifying] = useState(false)
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

  async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
    const response = await fetch(input, init)
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const data = (await response.json()) as { detail?: string }
        if (data.detail) {
          message = data.detail
        }
      } catch {
        // Ignore non-JSON error bodies.
      }
      throw new Error(message)
    }
    return (await response.json()) as T
  }

  const loadPending = useCallback(async () => {
    const res = await fetch(`${apiBaseUrl}/api/batch/pending`)
    if (res.ok) {
      const dismissedIds = readDismissedBatchIds()
      const nextItems = ((await res.json()) as PendingArtifact[]).filter((item) => !dismissedIds.has(item.id))
      setItems(nextItems)
    }
  }, [apiBaseUrl])

  useEffect(() => {
    void loadPending()
  }, [loadPending])

  useEffect(() => {
    void (async () => {
      try {
        const [museums, eras] = await Promise.all([
          fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?limit=200`),
          fetchJson<EraOption[]>(`${apiBaseUrl}/api/era-options`),
        ])
        setMuseumOptions(museums)
        setEraOptions(eras)
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载下拉选项失败")
      }
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

  useEffect(() => {
    const cleanup: Array<() => void> = []
    items.forEach((item) => {
      const name = (item.name ?? "").trim()
      const museumName = (item.museum_name ?? "").trim()
      const era = (item.era ?? "").trim()
      const identityKey = `${name}__${museumName}__${era}`
      if (!name || !museumName || !era) {
        setMatchedArtifacts((current) => {
          if (!(item.id in current)) return current
          return { ...current, [item.id]: null }
        })
        setSameArtifactDecisions((current) => {
          if (!(item.id in current)) return current
          return { ...current, [item.id]: null }
        })
        setMatchIdentityKeys((current) => {
          if (!(item.id in current)) return current
          const next = { ...current }
          delete next[item.id]
          return next
        })
        return
      }

      const controller = new AbortController()
      const timer = window.setTimeout(async () => {
        try {
          const params = new URLSearchParams({ name })
          params.set("museum_name", museumName)
          params.set("era", era)
          const matched = await fetchJson<ExistingArtifactMatch | null>(
            `${apiBaseUrl}/api/artifacts/match?${params.toString()}`,
            { signal: controller.signal },
          )
          if (controller.signal.aborted) {
            return
          }
          setMatchedArtifacts((current) => ({ ...current, [item.id]: matched }))
          setSameArtifactDecisions((current) => {
            const previousKey = matchIdentityKeys[item.id]
            if (previousKey === identityKey) {
              return current
            }
            return { ...current, [item.id]: null }
          })
          setMatchIdentityKeys((current) => ({ ...current, [item.id]: identityKey }))
          if (!matched && item.existing_artifact_id != null) {
            patchLocal(item.id, { existing_artifact_id: null })
          }
        } catch {
          if (!controller.signal.aborted) {
            setMatchedArtifacts((current) => ({ ...current, [item.id]: null }))
            setSameArtifactDecisions((current) => {
              const previousKey = matchIdentityKeys[item.id]
              if (previousKey === identityKey) {
                return current
              }
              return { ...current, [item.id]: null }
            })
            setMatchIdentityKeys((current) => ({ ...current, [item.id]: identityKey }))
          }
        }
      }, 220)

      cleanup.push(() => {
        controller.abort()
        window.clearTimeout(timer)
      })
    })

    return () => {
      cleanup.forEach((fn) => fn())
    }
  }, [apiBaseUrl, items, matchIdentityKeys])

  function patchLocal(id: number, patch: Partial<PendingArtifact>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
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
      const formData = new FormData()
      for (const file of uploadFiles) {
        formData.append("files", file)
      }
      const firstFile = uploadFiles[0] as FileWithRelativePath
      const folderName = firstFile.webkitRelativePath?.split("/")[0] || "已选文件夹"
      setSelectedFolderLabel(`${folderName} · ${uploadFiles.length} 个文件`)

      const res = await fetch(`${apiBaseUrl}/api/batch/scan-files`, {
        method: "POST",
        body: formData,
      })
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(detail.detail ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as BatchScanResponse
      const dismissedIds = readDismissedBatchIds()
      setItems(data.items.filter((item) => !dismissedIds.has(item.id)))
      setMessage(`扫描 ${data.scanned} 张，新增 ${data.added}，跳过 ${data.skipped}（已存在）`)
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
      const res = await fetch(`${apiBaseUrl}/api/batch/identify/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok || !res.body) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(detail.detail ?? `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() ?? ""
        for (const chunk of chunks) {
          const line = chunk.trim()
          if (!line.startsWith("data:")) continue
          let event: StreamEvent
          try {
            event = JSON.parse(line.replace(/^data:\s*/, "")) as StreamEvent
          } catch {
            continue
          }
          if (event.stage === "meta") {
            setProgress({ done: 0, total: event.total ?? 0 })
          } else if (event.stage === "start" && event.id != null) {
            patchLocal(event.id, { status: "identifying" })
          } else if (event.stage === "item" && event.item) {
            patchLocal(event.item.id, event.item)
            done += 1
            setProgress((p) => (p ? { ...p, done } : { done, total: done }))
          } else if (event.stage === "item_error" && event.id != null) {
            patchLocal(event.id, { status: "failed", error: event.message ?? "识别失败" })
            done += 1
            setProgress((p) => (p ? { ...p, done } : { done, total: done }))
          }
        }
      }
      setMessage("识别完成，请逐条核对后提交云端")
    } catch (err) {
      setError(err instanceof Error ? err.message : "识别失败")
    } finally {
      setIdentifying(false)
    }
  }

  async function saveItem(item: PendingArtifact) {
    const res = await fetch(`${apiBaseUrl}/api/batch/pending/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        museum_name: item.museum_name,
        name: item.name,
        era: item.era,
        description: item.description,
        tags: item.tags,
        camera_model: item.camera_model,
        lens_model: item.lens_model,
        capture_museum_name: item.capture_museum_name,
        exhibition_name: item.exhibition_name,
        latitude: item.latitude,
        longitude: item.longitude,
        captured_at: item.captured_at,
        shutter_speed: item.shutter_speed,
        aperture: item.aperture,
        iso: item.iso,
        edit_method: item.edit_method,
        existing_artifact_id: item.existing_artifact_id,
      }),
    })
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { detail?: string }
      throw new Error(detail.detail ?? `HTTP ${res.status}`)
    }
    return (await res.json()) as PendingArtifact
  }

  async function handleSubmit(item: PendingArtifact) {
    setError(null)
    setMessage(null)
    setSubmitNotice(null)
    try {
      const matchedArtifact = matchedArtifacts[item.id] ?? null
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
      patchLocal(item.id, normalizedItem)
      await saveItem(normalizedItem)
      patchLocal(item.id, { status: "submitting" })
      const res = await fetch(`${apiBaseUrl}/api/batch/pending/${item.id}/submit`, {
        method: "POST",
      })
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(detail.detail ?? `HTTP ${res.status}`)
      }
      const updated = (await res.json()) as PendingArtifact
      patchLocal(item.id, updated)
      setMessage(`「${updated.name}」已提交云端`)
      setSubmitNotice({ type: "success", text: `「${updated.name}」已提交云端` })
    } catch (err) {
      const submitError = err instanceof Error ? err.message : "提交失败"
      patchLocal(item.id, { status: "failed", error: submitError })
      setError(submitError)
      setSubmitNotice({ type: "error", text: submitError })
    }
  }

  async function handleDelete(id: number) {
    await fetch(`${apiBaseUrl}/api/batch/pending/${id}`, { method: "DELETE" })
    setItems((current) => current.filter((item) => item.id !== id))
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
      const dismissedIds = readDismissedBatchIds()
      items.forEach((item) => dismissedIds.add(item.id))
      writeDismissedBatchIds(dismissedIds)
      setItems([])
      setTagInputs({})
      setMuseumSuggestions({})
      setExhibitionSuggestions({})
      setMatchedArtifacts({})
      setSameArtifactDecisions({})
      setMatchIdentityKeys({})
      setProgress(null)
      setSelectedFolderLabel(null)
      setMessage("已从前端列表全部清除当前批量记录")
      setSubmitNotice({ type: "success", text: "已从前端列表全部清除当前批量记录" })
    } catch (err) {
      const clearError = err instanceof Error ? err.message : "全部清除失败"
      setError(clearError)
      setSubmitNotice({ type: "error", text: clearError })
    }
  }

  const pendingCount = items.filter((i) => i.status === "pending" || i.status === "failed").length

  return (
    <section className="panel form-wide">
      <div className="section-heading">
        <span className="step-badge">B</span>
        <div>
          <h2>批量识别入库</h2>
          <p className="muted">选择本地文件夹批量识图，逐条微调后提交到云端（图片入 OSS）。</p>
        </div>
      </div>

      <div className="scan-row">
        <div className="field scan-input">
          <span>本地文件夹</span>
          <button
            type="button"
            className="picker-button"
            onClick={() => folderInputRef.current?.click()}
            disabled={scanning}
          >
            {scanning ? "扫描中…" : "选择文件夹并扫描"}
          </button>
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="hidden-folder-input"
            onChange={(event) => void handleScan(event.target.files)}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
          <span className="field-help">
            {selectedFolderLabel ?? "点击按钮后直接选择本地文件夹，无需再手填路径。"}
          </span>
        </div>
        <button type="button" className="ghost" onClick={() => void loadPending()} disabled={identifying || scanning}>
          刷新列表
        </button>
      </div>

      <div className="upload-actions">
        <button
          type="button"
          className="primary"
          onClick={() => void handleIdentifyAll([])}
          disabled={identifying || pendingCount === 0}
        >
          {identifying ? "识别中…" : `开始识别（${pendingCount} 张待识别）`}
        </button>
        <button
          type="button"
          className="ghost danger"
          onClick={() => void handleClearAll()}
          disabled={identifying || scanning || items.length === 0}
        >
          全部清除
        </button>
        {progress ? (
          <span className="muted">
            进度 {progress.done}/{progress.total}
          </span>
        ) : null}
      </div>

      {message ? <p className="success-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">📁</span>
          <strong>暂无待处理图片</strong>
          <p className="muted">点击上方按钮选择一个本地文件夹后开始扫描。</p>
        </div>
      ) : null}

      <div className="batch-list">
        {items.map((item) => {
          const hasMuseumOptions = museumOptions.length > 0
          const hasEraOptions = eraOptions.length > 0
          const selectedMuseum =
            museumOptions.find((museum) => museum.name === (item.capture_museum_name ?? "").trim()) ??
            museumSuggestions[item.id]?.find((museum) => museum.name === (item.capture_museum_name ?? "").trim()) ??
            null
          const matchedArtifact = matchedArtifacts[item.id] ?? null
          const sameArtifactDecision = sameArtifactDecisions[item.id] ?? null

          return (
          <article key={item.id} className="batch-card">
            <div className="batch-thumb">
              <img
                src={`${apiBaseUrl}/api/batch/pending/${item.id}/image`}
                alt={item.file_name}
                loading="lazy"
              />
              <span className={`pulse ${statusClass(item.status)}`} />
            </div>

            <div className="batch-fields">
              <div className="batch-head">
                <span className="muted small">{item.file_name}</span>
                <span className={`badge ${item.status === "submitted" ? "best" : "conf"}`}>
                  {STATUS_LABEL[item.status] ?? item.status}
                  {item.confidence != null ? ` · ${Math.round(item.confidence * 100)}%` : ""}
                </span>
              </div>

              <div className="batch-core-card">
                <div className="batch-section-head">
                  <strong>核心信息</strong>
                  <span>先确认这 4 项，其他字段再补充。</span>
                </div>
                <div className="batch-core-grid">
                  <label className={`field ${isMissingValue(item.museum_name) ? "field-invalid" : ""}`}>
                    <span>博物馆 / 出土地</span>
                    <input
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
                    <input
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
                    <input
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
                    <input
                      value={item.exhibition_name ?? ""}
                      onChange={(e) => patchLocal(item.id, { exhibition_name: e.target.value })}
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
                    {(exhibitionSuggestions[item.id] ?? []).length > 0 ? (
                      <div className="suggestion-list">
                        {(exhibitionSuggestions[item.id] ?? []).map((exhibition) => (
                          <button
                            key={exhibition.id}
                            type="button"
                            className="suggestion-item"
                            onClick={() => {
                              setExhibitionSuggestions((current) => ({ ...current, [item.id]: [] }))
                              patchLocal(item.id, { exhibition_name: exhibition.name })
                            }}
                          >
                            <span>{exhibition.name}</span>
                            <em>{exhibition.museum_name}</em>
                          </button>
                        ))}
                      </div>
                    ) : null}
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
                    <span className="badge conf">{matchedArtifact.artifact.images.length} 张历史图片</span>
                  </div>
                  <div className="backend-match-meta">
                    <span>名称：{matchedArtifact.artifact.name}</span>
                    <span>时代：{matchedArtifact.artifact.era || "待确认"}</span>
                    <span>馆藏：{matchedArtifact.artifact.museum_name}</span>
                  </div>
                  {matchedArtifact.artifact.tags.length > 0 ? (
                    <div className="tag-row">
                      {matchedArtifact.artifact.tags.map((tag) => (
                        <span key={`batch-match-tag-${item.id}-${tag}`}>{tag}</span>
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
                    <button
                      type="button"
                      className={`primary small ${sameArtifactDecision === "yes" ? "selected-action" : ""}`}
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
                    </button>
                    <button
                      type="button"
                      className={`ghost ${sameArtifactDecision === "no" ? "selected-action" : ""}`}
                      onClick={() => {
                        patchLocal(item.id, { existing_artifact_id: null })
                        setSameArtifactDecisions((current) => ({ ...current, [item.id]: "no" }))
                        setMessage(`已标记「${item.file_name}」不是同一件，提交时会新建文物记录`)
                        setError(null)
                      }}
                    >
                      不是同一件
                    </button>
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
                          <span key={tag} className="tag-chip">
                            {tag}
                            <button
                              type="button"
                              onClick={() => removeTag(item.id, tag)}
                              aria-label={`删除标签 ${tag}`}
                            >
                              ×
                            </button>
                          </span>
                        ))
                      ) : (
                        <span className="tag-editor-placeholder">暂无标签</span>
                      )}
                    </div>
                    <input
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
                  <input
                    value={item.capture_museum_name ?? ""}
                    onChange={(e) => {
                      const value = e.target.value
                      patchLocal(item.id, {
                        capture_museum_name: value || null,
                        exhibition_name:
                          value && (!(item.exhibition_name ?? "").trim() || (item.exhibition_name ?? "").trim().startsWith("@"))
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
                  {(museumSuggestions[item.id] ?? []).length > 0 ? (
                    <div className="suggestion-list">
                      {(museumSuggestions[item.id] ?? []).map((museum) => (
                        <button
                          key={museum.id}
                          type="button"
                          className="suggestion-item"
                          onClick={() => {
                            setMuseumSuggestions((current) => ({ ...current, [item.id]: [] }))
                            patchLocal(item.id, {
                              capture_museum_name: museum.name,
                              exhibition_name:
                                (item.exhibition_name ?? "").trim().startsWith("@") || !(item.exhibition_name ?? "").trim()
                                  ? "常设"
                                  : item.exhibition_name,
                            })
                          }}
                        >
                          {museum.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </label>
              </div>

              <label className="field">
                <span>描述</span>
                <textarea
                  rows={4}
                  value={item.description ?? ""}
                  onChange={(e) => patchLocal(item.id, { description: e.target.value })}
                />
                <span className="field-help">描述里保留器型、工艺、用途和典型特征，不再重复标签列表。</span>
              </label>

              <div className="field-row">
                <label className="field">
                  <span>机型</span>
                  <input
                    value={item.camera_model ?? ""}
                    onChange={(e) => patchLocal(item.id, { camera_model: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>镜头</span>
                  <input
                    value={item.lens_model ?? ""}
                    onChange={(e) => patchLocal(item.id, { lens_model: e.target.value })}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>经度</span>
                  <input
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
                  <input
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
                  <input
                    value={item.captured_at ?? ""}
                    onChange={(e) => patchLocal(item.id, { captured_at: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>修图方式</span>
                  <select
                    value={item.edit_method ?? ""}
                    onChange={(e) => patchLocal(item.id, { edit_method: e.target.value || null })}
                  >
                    <option value="">未填写</option>
                    <option value="简单调整">简单调整</option>
                    <option value="堆栈合成">堆栈合成</option>
                  </select>
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>快门</span>
                  <input
                    value={item.shutter_speed ?? ""}
                    onChange={(e) => patchLocal(item.id, { shutter_speed: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>光圈</span>
                  <input
                    value={item.aperture ?? ""}
                    onChange={(e) => patchLocal(item.id, { aperture: e.target.value })}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>感光度</span>
                  <input
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
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    void saveItem(item)
                      .then((saved) => {
                        patchLocal(item.id, saved)
                        setMessage(`已保存「${saved.name ?? saved.file_name}」`)
                        setSubmitNotice({
                          type: "success",
                          text: `已保存「${saved.name ?? saved.file_name}」`,
                        })
                      })
                      .catch((err) => {
                        const saveError = err instanceof Error ? err.message : "保存失败"
                        setError(saveError)
                        setSubmitNotice({ type: "error", text: saveError })
                      })
                  }
                >
                  保存
                </button>
                <button
                  type="button"
                  className="primary small"
                  onClick={() => void handleSubmit(item)}
                  disabled={item.status === "submitting" || item.status === "submitted"}
                >
                  {item.status === "submitted"
                    ? "已入库"
                    : matchedArtifact && sameArtifactDecision !== "no"
                      ? "更新已有文物并上传图片"
                      : "提交云端"}
                </button>
                <button type="button" className="ghost danger" onClick={() => void handleDelete(item.id)}>
                  删除
                </button>
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
      {submitNotice ? (
        <div className={`submit-toast ${submitNotice.type}`}>
          <div className="submit-toast-body">
            <strong>{submitNotice.type === "error" ? "操作失败" : "操作成功"}</strong>
            <p>{submitNotice.text}</p>
          </div>
          <button type="button" className="submit-toast-close" onClick={() => setSubmitNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
    </section>
  )
}
