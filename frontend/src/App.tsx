import { useEffect, useMemo, useRef, useState } from "react"
import "./App.css"
import BatchConsole from "./BatchConsole"
import Gallery from "./Gallery"

type HealthResponse = {
  status: string
  environment: string
  database: string
}

type Museum = {
  id: number
  name: string
  location: string | null
  description: string | null
}

type UploadedImage = {
  filename: string
  url: string
}

type SearchHit = {
  title: string
  url: string
  snippet: string
  source: string | null
}

type VisionCandidate = {
  provider: string
  model: string
  artifact_name: string
  era: string | null
  museum_name: string | null
  tags: string[]
  description: string
  confidence: number | null
  analysis: string | null
  reasoning: string | null
  search_hits: SearchHit[]
}

type PreviewCandidate = {
  name?: string
  confidence?: number
  evidence?: string
}

type Stage =
  | "pending"
  | "analyzing"
  | "analysis"
  | "searching"
  | "search"
  | "finalizing"
  | "result"
  | "done"
  | "error"

type ProviderStream = {
  provider: string
  model: string
  stage: Stage
  analysis: string
  previewCandidates: PreviewCandidate[]
  queries: string[]
  hits: SearchHit[]
  candidate: VisionCandidate | null
  error: string | null
  cached: boolean
}

type StreamEvent = {
  stage: string
  provider?: string
  model?: string
  providers?: string[]
  unavailable_providers?: string[]
  analysis?: string
  candidates?: PreviewCandidate[]
  queries?: string[]
  hits?: SearchHit[]
  candidate?: VisionCandidate
  message?: string
  cached?: boolean
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ??(import.meta.env.PROD ? "" : "http://localhost:8000")).replace(/\/$/, "")
// On the cloud deployment only the gallery/search view makes sense (no qwen bridge).
const cloudOnly = (import.meta.env.VITE_CLOUD_ONLY ?? "false") === "true"

type View = "single" | "batch" | "gallery"

const PIPELINE_STEPS = [
  { key: "analyze", label: "看图分析", hint: "多模态模型读取图像与展签文字" },
  { key: "search", label: "检索佐证", hint: "提炼关键词检索候选网页" },
  { key: "decide", label: "综合裁决", hint: "结合图像与证据给出结论" },
] as const

const STAGE_RANK: Record<Stage, number> = {
  pending: 0,
  analyzing: 1,
  analysis: 2,
  searching: 3,
  search: 4,
  finalizing: 5,
  result: 6,
  done: 6,
  error: -1,
}

const STAGE_LABEL: Record<Stage, string> = {
  pending: "排队中",
  analyzing: "正在看图分析…",
  analysis: "分析完成",
  searching: "正在检索佐证…",
  search: "检索完成",
  finalizing: "正在综合裁决…",
  result: "已生成结果",
  done: "已完成",
  error: "调用失败",
}

function toAbsoluteUrl(url: string) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${apiBaseUrl}${url}`
}

function normalizeName(value: string) {
  return value.trim().toLowerCase()
}

function stepStatus(stage: Stage, stepIndex: number): "done" | "active" | "pending" {
  const rank = STAGE_RANK[stage]
  const activeRanks = [1, 3, 5]
  const doneRanks = [2, 4, 6]
  if (rank >= doneRanks[stepIndex]) {
    return "done"
  }
  if (rank === activeRanks[stepIndex]) {
    return "active"
  }
  return "pending"
}

function formatConfidence(confidence: number | null | undefined) {
  if (confidence === null || confidence === undefined) {
    return null
  }
  return `${Math.round(confidence * 100)}%`
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loadingHealth, setLoadingHealth] = useState(true)
  const [museums, setMuseums] = useState<Museum[]>([])
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploadedImage, setUploadedImage] = useState<UploadedImage | null>(null)
  const [dragging, setDragging] = useState(false)
  const [artifactForm, setArtifactForm] = useState({
    museumName: "",
    name: "",
    era: "",
    description: "",
    tags: "",
  })
  const [uploading, setUploading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [artifactSubmitting, setArtifactSubmitting] = useState(false)
  const [artifactMessage, setArtifactMessage] = useState<string | null>(null)
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const [view, setView] = useState<View>(cloudOnly ? "gallery" : "single")
  const [providerOrder, setProviderOrder] = useState<string[]>([])
  const [providerStreams, setProviderStreams] = useState<Record<string, ProviderStream>>({})
  const [unavailableProviders, setUnavailableProviders] = useState<string[]>([])
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)

  const orderedStreams = useMemo(
    () => providerOrder.map((name) => providerStreams[name]).filter(Boolean) as ProviderStream[],
    [providerOrder, providerStreams],
  )

  const bestCandidateKey = useMemo(() => {
    let bestKey: string | null = null
    let bestScore = -Infinity
    for (const stream of orderedStreams) {
      if (!stream.candidate) {
        continue
      }
      const score = stream.candidate.confidence ?? 0
      if (score > bestScore) {
        bestScore = score
        bestKey = stream.provider
      }
    }
    return bestKey
  }, [orderedStreams])

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

  async function loadHealth() {
    try {
      setLoadingHealth(true)
      const data = await fetchJson<HealthResponse>(`${apiBaseUrl}/api/health`)
      setHealth(data)
    } catch {
      setHealth(null)
    } finally {
      setLoadingHealth(false)
    }
  }

  async function loadMuseums() {
    const data = await fetchJson<Museum[]>(`${apiBaseUrl}/api/museums`)
    setMuseums(data)
  }

  async function ensureMuseumId(museumName: string) {
    const normalized = normalizeName(museumName)
    const matched = museums.find((museum) => normalizeName(museum.name) === normalized)
    if (matched) {
      return matched.id
    }

    const created = await fetchJson<Museum>(`${apiBaseUrl}/api/museums`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: museumName.trim(),
        location: null,
        description: "AI 识图候选自动创建",
      }),
    })
    await loadMuseums()
    return created.id
  }

  function updateStream(provider: string, patch: Partial<ProviderStream>) {
    setProviderStreams((current) => {
      const existing =
        current[provider] ??
        ({
          provider,
          model: "",
          stage: "pending",
          analysis: "",
          previewCandidates: [],
          queries: [],
          hits: [],
          candidate: null,
          error: null,
          cached: false,
        } satisfies ProviderStream)
      return { ...current, [provider]: { ...existing, ...patch } }
    })
  }

  function handleStreamEvent(event: StreamEvent) {
    if (event.stage === "meta") {
      const providers = event.providers ?? []
      setProviderOrder(providers)
      setUnavailableProviders(event.unavailable_providers ?? [])
      const initial: Record<string, ProviderStream> = {}
      for (const name of providers) {
        initial[name] = {
          provider: name,
          model: "",
          stage: "pending",
          analysis: "",
          previewCandidates: [],
          queries: [],
          hits: [],
          candidate: null,
          error: null,
          cached: false,
        }
      }
      setProviderStreams(initial)
      return
    }

    const provider = event.provider
    if (!provider) {
      return
    }

    switch (event.stage) {
      case "analyzing":
        updateStream(provider, { stage: "analyzing", model: event.model ?? "" })
        break
      case "analysis":
        updateStream(provider, {
          stage: "analysis",
          model: event.model ?? "",
          analysis: event.analysis ?? "",
          previewCandidates: event.candidates ?? [],
          cached: Boolean(event.cached),
        })
        break
      case "searching":
        updateStream(provider, { stage: "searching", queries: event.queries ?? [] })
        break
      case "search":
        updateStream(provider, { stage: "search", hits: event.hits ?? [] })
        break
      case "finalizing":
        updateStream(provider, { stage: "finalizing" })
        break
      case "result":
        updateStream(provider, {
          stage: "result",
          candidate: event.candidate ?? null,
          cached: Boolean(event.cached),
        })
        break
      case "done":
        updateStream(provider, { stage: "done" })
        break
      case "error":
        updateStream(provider, { stage: "error", error: event.message ?? "识图失败" })
        break
      default:
        break
    }
  }

  async function analyzeImageStream(image: UploadedImage) {
    streamAbortRef.current?.abort()
    const controller = new AbortController()
    streamAbortRef.current = controller

    setStreaming(true)
    setArtifactError(null)
    setSelectedCandidateKey(null)
    setProviderOrder([])
    setProviderStreams({})

    try {
      const response = await fetch(`${apiBaseUrl}/api/vision/analyze/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_urls: [image.url], image_name: image.filename }),
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() ?? ""
        for (const chunk of chunks) {
          const line = chunk.trim()
          if (!line.startsWith("data:")) {
            continue
          }
          const payload = line.replace(/^data:\s*/, "")
          try {
            handleStreamEvent(JSON.parse(payload) as StreamEvent)
          } catch {
            // Ignore malformed chunks.
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setArtifactError(err instanceof Error ? err.message : "AI 识图失败")
      }
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null
      }
      setStreaming(false)
    }
  }

  function handleApplyCandidate(candidate: VisionCandidate) {
    setArtifactForm({
      museumName: candidate.museum_name ?? "",
      name: candidate.artifact_name,
      era: candidate.era ?? "",
      description: candidate.description,
      tags: candidate.tags.join(", "),
    })
    setSelectedCandidateKey(candidate.provider)
    setArtifactMessage(`已采用 ${candidate.provider} 的识图结果，可在下方微调后入库`)
    setArtifactError(null)
  }

  useEffect(() => {
    async function loadInitialData() {
      try {
        await Promise.all([loadHealth(), loadMuseums()])
      } catch (err) {
        setArtifactError(err instanceof Error ? err.message : "初始化失败")
      }
    }
    void loadInitialData()
  }, [])

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort()
    }
  }, [])

  function selectFile(file: File | null) {
    setSelectedFile(file)
    setPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current)
      }
      return file ? URL.createObjectURL(file) : null
    })
  }

  async function handleUploadFiles(file = selectedFile) {
    if (!file) {
      setArtifactError("请先选择一张图片")
      return
    }

    setUploading(true)
    setArtifactError(null)
    setArtifactMessage(null)

    try {
      const formData = new FormData()
      formData.append("files", file)

      const data = await fetchJson<UploadedImage[]>(`${apiBaseUrl}/api/uploads/images`, {
        method: "POST",
        body: formData,
      })

      const image = data[0]
      setUploadedImage(image)
      await analyzeImageStream(image)
    } catch (err) {
      setArtifactError(err instanceof Error ? err.message : "上传图片失败")
    } finally {
      setUploading(false)
    }
  }

  function resetCurrentImage() {
    streamAbortRef.current?.abort()
    selectFile(null)
    setUploadedImage(null)
    setProviderOrder([])
    setProviderStreams({})
    setUnavailableProviders([])
    setSelectedCandidateKey(null)
    setArtifactMessage(null)
  }

  async function handleCreateArtifact(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setArtifactSubmitting(true)
    setArtifactMessage(null)
    setArtifactError(null)

    try {
      if (!artifactForm.museumName.trim()) {
        throw new Error("请填写或确认博物馆名称")
      }
      if (!artifactForm.name.trim()) {
        throw new Error("请填写或确认文物名称")
      }
      if (!uploadedImage) {
        throw new Error("请先上传并识别图片")
      }

      const museumId = await ensureMuseumId(artifactForm.museumName)

      await fetchJson<unknown>(`${apiBaseUrl}/api/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          museum_id: museumId,
          name: artifactForm.name,
          era: artifactForm.era || null,
          description: artifactForm.description || null,
          tags: artifactForm.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          images: [{ url: uploadedImage.url }],
        }),
      })

      setArtifactForm({ museumName: "", name: "", era: "", description: "", tags: "" })
      setArtifactMessage("文物已入库")
      resetCurrentImage()
    } catch (err) {
      setArtifactError(err instanceof Error ? err.message : "创建文物失败")
    } finally {
      setArtifactSubmitting(false)
    }
  }

  const hasResult = orderedStreams.some((stream) => stream.candidate)
  const displayPreview = previewUrl ?? (uploadedImage ? toAbsoluteUrl(uploadedImage.url) : null)
  const streamError = orderedStreams.length === 0 && !streaming && uploadedImage ? artifactError : null

  const flowSteps = [
    { label: "上传图片", done: Boolean(uploadedImage), active: !uploadedImage },
    {
      label: "实时识别",
      done: hasResult,
      active: Boolean(uploadedImage) && !hasResult,
    },
    {
      label: "修改确认",
      done: Boolean(selectedCandidateKey),
      active: hasResult && !selectedCandidateKey,
    },
    { label: "提交入库", done: false, active: Boolean(selectedCandidateKey) },
  ]

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">博</span>
          <div>
            <p className="eyebrow">Museum Image DB</p>
            <h1>文物识图工作台</h1>
          </div>
        </div>
        <div className={`health-pill ${health ? "online" : "offline"}`}>
          <span className="status-dot" />
          <span>
            {loadingHealth ? "检查后端…" : health ? `后端在线 · ${health.environment}` : "后端未连通"}
          </span>
        </div>
      </header>

      <nav className="view-tabs">
        {!cloudOnly ? (
          <>
            <button
              type="button"
              className={view === "single" ? "active" : ""}
              onClick={() => setView("single")}
            >
              单图识别
            </button>
            <button
              type="button"
              className={view === "batch" ? "active" : ""}
              onClick={() => setView("batch")}
            >
              批量入库
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={view === "gallery" ? "active" : ""}
          onClick={() => setView("gallery")}
        >
          图库检索
        </button>
      </nav>

      {view === "gallery" ? <Gallery apiBaseUrl={apiBaseUrl} /> : null}

      {view === "batch" && !cloudOnly ? <BatchConsole apiBaseUrl={apiBaseUrl} /> : null}

      {view === "single" && !cloudOnly ? (
      <>
      <ol className="flow-bar">
        {flowSteps.map((step, index) => (
          <li
            key={step.label}
            className={`flow-step ${step.done ? "done" : ""} ${step.active ? "active" : ""}`}
          >
            <span className="flow-index">{step.done ? "✓" : index + 1}</span>
            <span className="flow-label">{step.label}</span>
          </li>
        ))}
      </ol>

      <div className="layout">
        <section className="column column-left">
          <div className="panel">
            <div className="section-heading">
              <span className="step-badge">1</span>
              <div>
                <h2>上传文物图片</h2>
                <p className="muted">上传后将自动并行调用多模型，实时显示分析与结果。</p>
              </div>
            </div>

            <label
              className={`dropzone ${dragging ? "dragging" : ""} ${displayPreview ? "has-image" : ""}`}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                const file = event.dataTransfer.files?.[0]
                if (file) {
                  selectFile(file)
                  void handleUploadFiles(file)
                }
              }}
            >
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null
                  selectFile(file)
                  if (file) {
                    void handleUploadFiles(file)
                  }
                }}
              />
              {displayPreview ? (
                <img src={displayPreview} alt={uploadedImage?.filename ?? "预览"} />
              ) : (
                <div className="dropzone-empty">
                  <span className="dropzone-icon">＋</span>
                  <strong>点击或拖拽图片到此处</strong>
                  <span className="muted">支持 JPG / PNG，单张</span>
                </div>
              )}
            </label>

            <div className="upload-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => uploadedImage && void analyzeImageStream(uploadedImage)}
                disabled={!uploadedImage || streaming}
              >
                {streaming ? "识图中…" : "重新识图"}
              </button>
              {(selectedFile || uploadedImage) && (
                <button type="button" className="ghost danger" onClick={resetCurrentImage}>
                  清空
                </button>
              )}
            </div>

            {uploading ? <p className="muted">图片上传中…</p> : null}
            {unavailableProviders.length > 0 ? (
              <p className="muted">未配置模型：{unavailableProviders.join("、")}</p>
            ) : null}
            {artifactError ? <p className="error-text">{artifactError}</p> : null}
          </div>
        </section>

        <section className="column column-right">
          <div className="section-heading floating">
            <span className="step-badge">2</span>
            <div>
              <h2>模型实时识别</h2>
              <p className="muted">每个模型独立展示思维链、检索证据与最终结论。</p>
            </div>
          </div>

          {orderedStreams.length === 0 ? (
            <div className={`empty-state ${streamError ? "error" : ""}`}>
              <span className="empty-icon">{streamError ? "⚠️" : streaming ? "⏳" : "🔍"}</span>
              <strong>{streamError ? "识图失败" : streaming ? "正在连接模型…" : "等待识图"}</strong>
              <p className="muted">
                {streamError
                  ? streamError
                  : streaming
                    ? "已上传图片，正在建立实时识别连接。"
                    : "上传一张文物图片后，这里会实时滚动显示模型的分析过程。"}
              </p>
              {streamError && uploadedImage ? (
                <button
                  type="button"
                  className="primary small"
                  onClick={() => void analyzeImageStream(uploadedImage)}
                >
                  重试识图
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="stream-list">
            {orderedStreams.map((stream) => {
              const candidate = stream.candidate
              const isBusy = !["done", "result", "error"].includes(stream.stage)
              return (
                <article
                  key={stream.provider}
                  className={`stream-card ${selectedCandidateKey === stream.provider ? "selected" : ""}`}
                >
                  <div className="stream-card-head">
                    <div className="provider-id">
                      <span className={`pulse ${isBusy ? "busy" : stream.stage === "error" ? "failed" : "ok"}`} />
                      <div>
                        <strong>{stream.provider}</strong>
                        {stream.model ? <span className="muted">{stream.model}</span> : null}
                      </div>
                    </div>
                    <div className="stream-tags">
                      {stream.provider === bestCandidateKey && candidate ? (
                        <span className="badge best">推荐</span>
                      ) : null}
                      {stream.cached ? <span className="badge cache">缓存</span> : null}
                      {candidate ? (
                        <span className="badge conf">
                          可信度 {formatConfidence(candidate.confidence) ?? "—"}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="stepper">
                    {PIPELINE_STEPS.map((step, index) => {
                      const status = stream.stage === "error" ? "pending" : stepStatus(stream.stage, index)
                      return (
                        <div key={step.key} className={`stepper-item ${status}`}>
                          <span className="stepper-dot">{status === "done" ? "✓" : index + 1}</span>
                          <span className="stepper-label">{step.label}</span>
                        </div>
                      )
                    })}
                  </div>

                  <p className={`stage-status ${stream.stage}`}>{STAGE_LABEL[stream.stage]}</p>

                  {stream.error ? <p className="error-text">{stream.error}</p> : null}

                  {stream.analysis ? (
                    <div className="reasoning-block">
                      <div className="reasoning-head">
                        <span className="reasoning-title">思维链 · 看图分析</span>
                        {stream.stage === "analyzing" ? <span className="typing">输出中…</span> : null}
                      </div>
                      <p className="reasoning-text">{stream.analysis}</p>
                    </div>
                  ) : stream.stage === "analyzing" ? (
                    <div className="skeleton-lines">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : null}

                  {stream.previewCandidates.length > 0 ? (
                    <div className="chip-row">
                      {stream.previewCandidates.map((item, index) => (
                        <span className="guess-chip" key={`${stream.provider}-guess-${index}`}>
                          {item.name ?? "候选"}
                          {item.confidence !== undefined ? (
                            <em>{Math.round((item.confidence ?? 0) * 100)}%</em>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {stream.queries.length > 0 ? (
                    <div className="query-row">
                      <span className="muted small">检索词：</span>
                      {stream.queries.map((query, index) => (
                        <span className="query-chip" key={`${stream.provider}-q-${index}`}>
                          {query}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {stream.hits.length > 0 ? (
                    <details className="evidence">
                      <summary>检索证据（{stream.hits.length}）</summary>
                      <div className="evidence-list">
                        {stream.hits.map((hit) => (
                          <a
                            key={`${stream.provider}-${hit.url}`}
                            className="evidence-card"
                            href={hit.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <strong>{hit.title}</strong>
                            {hit.source ? <span className="evidence-source">{hit.source}</span> : null}
                            <p>{hit.snippet || hit.url}</p>
                          </a>
                        ))}
                      </div>
                    </details>
                  ) : null}

                  {candidate ? (
                    <div className="result-block">
                      <div className="result-head">
                        <h3>{candidate.artifact_name}</h3>
                        <button
                          type="button"
                          className="primary small"
                          onClick={() => handleApplyCandidate(candidate)}
                        >
                          采用
                        </button>
                      </div>
                      <div className="result-meta">
                        <span>时代：{candidate.era || "待确认"}</span>
                        <span>馆藏：{candidate.museum_name || "待识别"}</span>
                      </div>
                      {candidate.description ? <p className="result-desc">{candidate.description}</p> : null}
                      {candidate.tags.length > 0 ? (
                        <div className="tag-row">
                          {candidate.tags.map((tag) => (
                            <span key={`${stream.provider}-tag-${tag}`}>{tag}</span>
                          ))}
                        </div>
                      ) : null}
                      {candidate.reasoning && candidate.reasoning !== stream.analysis ? (
                        <details className="evidence">
                          <summary>裁决依据</summary>
                          <p className="reasoning-text">{candidate.reasoning}</p>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>

          {hasResult ? (
            <p className="muted small center">提示：可对比多模型结论，点击「采用」自动填入下方入库表单。</p>
          ) : null}
        </section>
      </div>

      <form className="panel form-wide" onSubmit={handleCreateArtifact}>
        <div className="section-heading">
          <span className="step-badge">3</span>
          <div>
            <h2>确认并入库</h2>
            <p className="muted">采用上方某个候选后会自动填入，可手动微调后提交。</p>
          </div>
        </div>

        <div className="form-fields">
          <div className="field-row">
            <label className="field">
              <span>博物馆名称</span>
              <input
                value={artifactForm.museumName}
                onChange={(event) =>
                  setArtifactForm((current) => ({ ...current, museumName: event.target.value }))
                }
                placeholder="例如：南京博物院"
              />
            </label>
            <label className="field">
              <span>文物名称</span>
              <input
                required
                value={artifactForm.name}
                onChange={(event) =>
                  setArtifactForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="例如：如意云纹金盘"
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>时代</span>
              <input
                value={artifactForm.era}
                onChange={(event) =>
                  setArtifactForm((current) => ({ ...current, era: event.target.value }))
                }
                placeholder="例如：元代"
              />
            </label>
            <label className="field">
              <span>标签</span>
              <input
                value={artifactForm.tags}
                onChange={(event) =>
                  setArtifactForm((current) => ({ ...current, tags: event.target.value }))
                }
                placeholder="逗号分隔"
              />
            </label>
          </div>
          <label className="field">
            <span>描述</span>
            <textarea
              rows={3}
              value={artifactForm.description}
              onChange={(event) =>
                setArtifactForm((current) => ({ ...current, description: event.target.value }))
              }
              placeholder="文物简介，可选"
            />
          </label>
        </div>

        <div className="form-footer">
          {artifactMessage ? <p className="success-text">{artifactMessage}</p> : <span />}
          <button type="submit" className="primary" disabled={artifactSubmitting || !uploadedImage}>
            {artifactSubmitting ? "入库中…" : "提交入库"}
          </button>
        </div>
      </form>
      </>
      ) : null}
    </main>
  )
}

export default App
