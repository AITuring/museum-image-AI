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

type ExhibitionOption = {
  id: number
  museum_id: number
  museum_name: string
  name: string
  start_at: string | null
  end_at: string | null
}

type SubmitNotice = {
  type: "success" | "error"
  text: string
}

type FileWithRelativePath = File & {
  webkitRelativePath?: string
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
  const [museumSuggestions, setMuseumSuggestions] = useState<Record<number, MuseumOption[]>>({})
  const [selectedCaptureMuseums, setSelectedCaptureMuseums] = useState<Record<number, MuseumOption | null>>({})
  const [exhibitionSuggestions, setExhibitionSuggestions] = useState<
    Record<number, ExhibitionOption[]>
  >({})
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
      setItems((await res.json()) as PendingArtifact[])
    }
  }, [apiBaseUrl])

  useEffect(() => {
    void loadPending()
  }, [loadPending])

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
      const selectedMuseum = selectedCaptureMuseums[item.id]
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
  }, [apiBaseUrl, items, selectedCaptureMuseums])

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
      setItems(data.items)
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
      if (!(item.museum_name ?? "").trim()) {
        throw new Error("请填写或确认博物馆名称")
      }
      if (!(item.name ?? "").trim()) {
        throw new Error("请填写或确认文物名称")
      }
      if (
        !(item.capture_museum_name ?? "").trim() ||
        (item.capture_museum_name ?? "").trim().startsWith("@")
      ) {
        throw new Error("请填写或选择拍摄时所在博物馆")
      }
      if (!(item.exhibition_name ?? "").trim() || (item.exhibition_name ?? "").trim().startsWith("@")) {
        throw new Error("请填写或选择展览名称")
      }
      await saveItem(item)
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
        {items.map((item) => (
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
                      value={item.museum_name ?? ""}
                      onChange={(e) => patchLocal(item.id, { museum_name: e.target.value })}
                      placeholder="例如：陕西考古博物馆"
                    />
                    {isMissingValue(item.museum_name) ? (
                      <span className="field-help error">请先确认文物所属博物馆或出土地。</span>
                    ) : (
                      <span className="field-help">单图同款主字段，提交前建议优先核对。</span>
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
                      value={item.era ?? ""}
                      onChange={(e) => patchLocal(item.id, { era: e.target.value })}
                      placeholder="例如：唐代"
                    />
                    <span className="field-help">
                      {isMissingValue(item.era) ? "建议补充时代，便于后续检索和筛选。" : "可填朝代、时期或具体纪年。"}
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
                        selectedCaptureMuseums[item.id]
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
                      patchLocal(item.id, { capture_museum_name: value })
                      if (selectedCaptureMuseums[item.id]?.name !== value) {
                        setSelectedCaptureMuseums((current) => ({ ...current, [item.id]: null }))
                      }
                    }}
                    placeholder="输入 @ 后联想检索，例如：@南博"
                  />
                  {needsSelection(item.capture_museum_name) ? (
                    <span className="field-help error">输入 `@关键词` 后，请从下方结果选择拍摄时所在博物馆。</span>
                  ) : isMissingValue(item.capture_museum_name) ? (
                    <span className="field-help error">提交前必须确认拍摄时所在博物馆。</span>
                  ) : (
                    <span className="field-help">建议从联想结果选择，减少馆名别名造成的不一致。</span>
                  )}
                  {(museumSuggestions[item.id] ?? []).length > 0 ? (
                    <div className="suggestion-list">
                      {(museumSuggestions[item.id] ?? []).map((museum) => (
                        <button
                          key={museum.id}
                          type="button"
                          className="suggestion-item"
                          onClick={() => {
                            setSelectedCaptureMuseums((current) => ({ ...current, [item.id]: museum }))
                            setMuseumSuggestions((current) => ({ ...current, [item.id]: [] }))
                            patchLocal(item.id, {
                              capture_museum_name: museum.name,
                              exhibition_name:
                                (item.exhibition_name ?? "").trim().startsWith("@") ||
                                !(item.exhibition_name ?? "").trim()
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
                  {item.status === "submitted" ? "已入库" : "提交云端"}
                </button>
                <button type="button" className="ghost danger" onClick={() => void handleDelete(item.id)}>
                  删除
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
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
