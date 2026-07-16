import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import "./App.css"
import BatchConsole from "./BatchConsole"
import ExifConsole from "./ExifConsole"
import Gallery from "./Gallery"
import MuseumBrowser from "./MuseumBrowser"

type HealthResponse = {
  status: string
  environment: string
  database: string
}

type WebBridgeStatus = {
  enabled: boolean
  site_key: string | null
  site_label: string | null
  login_required: boolean
  auto_login_supported: boolean
  login_command: string | null
  detail: string | null
}

type WebBridgeLoginStart = {
  started: boolean
  detail: string
  login_command: string | null
}

type UploadedImage = {
  filename: string
  url: string
  uploaded_at: string
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
}

type ArtifactFormState = {
  museumName: string
  name: string
  era: string
  description: string
  tags: string[]
  cameraModel: string
  lensModel: string
  captureMuseumName: string
  exhibitionName: string
  latitude: string
  longitude: string
  capturedAt: string
  uploadedAt: string
  shutterSpeed: string
  aperture: string
  iso: string
  editMethod: string
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

type MuseumOption = {
  id: number
  name: string
}

type EraOption = {
  id: number
  name: string
  sort_order: number
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

type ArtifactSubmitResult = {
  id: number
  name: string
  duplicate_image_skipped?: boolean
  duplicate_image_detail?: string | null
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ??(import.meta.env.PROD ? "" : "http://localhost:8000")).replace(/\/$/, "")
// On the cloud deployment only the gallery/search view makes sense (no qwen bridge).
const cloudOnly = (import.meta.env.VITE_CLOUD_ONLY ?? "false") === "true"

type View = "single" | "batch" | "exif" | "gallery" | "museums"

const VIEW_PATHS: Record<View, string> = {
  single: "/single",
  batch: "/batch",
  exif: "/photo-exif",
  gallery: "/gallery",
  museums: "/museums",
}

const NAV_ITEMS: Array<{ view: View; label: string; cloudVisible: boolean }> = [
  { view: "single", label: "单图识别", cloudVisible: false },
  { view: "batch", label: "批量入库", cloudVisible: false },
  { view: "exif", label: "EXIF 入库", cloudVisible: false },
  { view: "gallery", label: "图库", cloudVisible: true },
  { view: "museums", label: "博物馆", cloudVisible: true },
]

function isViewAvailable(view: View) {
  return !cloudOnly || view === "gallery" || view === "museums"
}

function getDefaultView(): View {
  return cloudOnly ? "gallery" : "single"
}

function normalizeViewFromPath(pathname: string): View {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/"
  const matched = (Object.entries(VIEW_PATHS) as Array<[View, string]>).find(
    ([, path]) => path === normalizedPath,
  )?.[0]

  if (!matched) {
    return getDefaultView()
  }
  return isViewAvailable(matched) ? matched : getDefaultView()
}

function getPathForView(view: View) {
  return VIEW_PATHS[isViewAvailable(view) ? view : getDefaultView()]
}

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

// function normalizeName(value: string) {
//   return value.trim().toLowerCase()
// }

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

function normalizeTags(tags: string[]) {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const rawTag of tags) {
    const tag = rawTag.trim()
    if (!tag || seen.has(tag)) {
      continue
    }
    seen.add(tag)
    normalized.push(tag)
  }
  return normalized
}

const EMPTY_ARTIFACT_FORM: ArtifactFormState = {
  museumName: "",
  name: "",
  era: "",
  description: "",
  tags: [],
  cameraModel: "",
  lensModel: "",
  captureMuseumName: "",
  exhibitionName: "常设",
  latitude: "",
  longitude: "",
  capturedAt: "",
  uploadedAt: "",
  shutterSpeed: "",
  aperture: "",
  iso: "",
  editMethod: "",
}

function buildArtifactFormFromImage(image?: UploadedImage | null): ArtifactFormState {
  if (!image) {
    return { ...EMPTY_ARTIFACT_FORM }
  }
  return {
    ...EMPTY_ARTIFACT_FORM,
    cameraModel: image.camera_model ?? "",
    lensModel: image.lens_model ?? "",
    captureMuseumName: image.capture_museum_name ?? "",
    exhibitionName: image.exhibition_name ?? "常设",
    latitude: image.latitude?.toString() ?? "",
    longitude: image.longitude?.toString() ?? "",
    capturedAt: image.captured_at ?? "",
    uploadedAt: image.uploaded_at ?? "",
    shutterSpeed: image.shutter_speed ?? "",
    aperture: image.aperture ?? "",
    iso: image.iso?.toString() ?? "",
    editMethod: image.edit_method ?? "",
  }
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loadingHealth, setLoadingHealth] = useState(true)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploadedImage, setUploadedImage] = useState<UploadedImage | null>(null)
  const [dragging, setDragging] = useState(false)
  const [artifactForm, setArtifactForm] = useState<ArtifactFormState>({ ...EMPTY_ARTIFACT_FORM })
  const [uploading, setUploading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [artifactSubmitting, setArtifactSubmitting] = useState(false)
  const [artifactMessage, setArtifactMessage] = useState<string | null>(null)
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const [view, setViewState] = useState<View>(() => normalizeViewFromPath(window.location.pathname))
  const [providerOrder, setProviderOrder] = useState<string[]>([])
  const [providerStreams, setProviderStreams] = useState<Record<string, ProviderStream>>({})
  const [unavailableProviders, setUnavailableProviders] = useState<string[]>([])
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string | null>(null)
  const [artifactMuseumSuggestions, setArtifactMuseumSuggestions] = useState<MuseumOption[]>([])
  const [showArtifactMuseumSuggestions, setShowArtifactMuseumSuggestions] = useState(false)
  const [museumSuggestions, setMuseumSuggestions] = useState<MuseumOption[]>([])
  const [eraOptions, setEraOptions] = useState<EraOption[]>([])
  const [eraSuggestions, setEraSuggestions] = useState<EraOption[]>([])
  const [showEraSuggestions, setShowEraSuggestions] = useState(false)
  const [selectedCaptureMuseum, setSelectedCaptureMuseum] = useState<MuseumOption | null>(null)
  const [exhibitionSuggestions, setExhibitionSuggestions] = useState<ExhibitionOption[]>([])
  const [tagInput, setTagInput] = useState("")
  const [submitNotice, setSubmitNotice] = useState<SubmitNotice | null>(null)
  const [matchedArtifact, setMatchedArtifact] = useState<ExistingArtifactMatch | null>(null)
  const [sameArtifactDecision, setSameArtifactDecision] = useState<"yes" | "no" | null>(null)
  const [webBridgeStatus, setWebBridgeStatus] = useState<WebBridgeStatus | null>(null)
  const [webBridgeLoginMessage, setWebBridgeLoginMessage] = useState<string | null>(null)
  const [showWebBridgeLoginModal, setShowWebBridgeLoginModal] = useState(false)
  const [launchingWebBridgeLogin, setLaunchingWebBridgeLogin] = useState(false)
  const streamAbortRef = useRef<AbortController | null>(null)

  const orderedStreams = useMemo(
    () => providerOrder.map((name) => providerStreams[name]).filter(Boolean) as ProviderStream[],
    [providerOrder, providerStreams],
  )

  const setView = useCallback((nextView: View, options?: { replace?: boolean }) => {
    const resolvedView = isViewAvailable(nextView) ? nextView : getDefaultView()
    setViewState(resolvedView)
    const targetPath = getPathForView(resolvedView)
    if (window.location.pathname !== targetPath) {
      const method = options?.replace ? "replaceState" : "pushState"
      window.history[method]({}, "", targetPath)
    }
  }, [])

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

  async function loadWebBridgeStatus(): Promise<WebBridgeStatus | null> {
    try {
      const data = await fetchJson<WebBridgeStatus>(`${apiBaseUrl}/api/web-bridge/status`)
      setWebBridgeStatus(data)
      return data
    } catch {
      setWebBridgeStatus(null)
      return null
    }
  }

  async function loadEraOptions() {
    try {
      const data = await fetchJson<EraOption[]>(`${apiBaseUrl}/api/era-options`)
      setEraOptions(data)
    } catch {
      setEraOptions([])
    }
  }

  async function ensureWebBridgeLoginReady(autoStart = true): Promise<boolean> {
    const status = await loadWebBridgeStatus()
    if (!status?.enabled || !status.login_required) {
      setShowWebBridgeLoginModal(false)
      setWebBridgeLoginMessage(null)
      return true
    }

    setShowWebBridgeLoginModal(true)
    setWebBridgeLoginMessage(status.detail ?? "通义网页桥当前未登录。")
    if (!autoStart) {
      return false
    }

    setLaunchingWebBridgeLogin(true)
    try {
      const result = await fetchJson<WebBridgeLoginStart>(`${apiBaseUrl}/api/web-bridge/login/start`, {
        method: "POST",
      })
      setWebBridgeLoginMessage(result.detail)
    } catch (err) {
      setWebBridgeLoginMessage(err instanceof Error ? err.message : "无法自动启动登录，请手动执行登录命令。")
    } finally {
      setLaunchingWebBridgeLogin(false)
    }
    return false
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
    const ready = await ensureWebBridgeLoginReady(true)
    if (!ready) {
      setArtifactError("通义网页桥尚未登录，请先完成扫码登录。")
      return
    }

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
    setArtifactForm((current) => ({
      ...current,
      museumName: candidate.museum_name ?? "",
      name: candidate.artifact_name,
      era: candidate.era ?? "",
      description: candidate.description,
      tags: normalizeTags(candidate.tags),
    }))
    setTagInput("")
    setSelectedCandidateKey(candidate.provider)
    setArtifactMessage(`已采用 ${candidate.provider} 的识图结果，可在下方微调后入库`)
    setArtifactError(null)
  }

  function addTags(rawValue: string) {
    const nextTags = normalizeTags(rawValue.split(/[,\n，、；;]/).map((tag) => tag.trim()))
    if (nextTags.length === 0) {
      return
    }
    setArtifactForm((current) => ({
      ...current,
      tags: normalizeTags([...current.tags, ...nextTags]),
    }))
    setTagInput("")
  }

  function removeTag(tagToRemove: string) {
    setArtifactForm((current) => ({
      ...current,
      tags: current.tags.filter((tag) => tag !== tagToRemove),
    }))
  }

  useEffect(() => {
    async function loadInitialData() {
      try {
        await loadHealth()
        await loadWebBridgeStatus()
        await loadEraOptions()
      } catch (err) {
        setArtifactError(err instanceof Error ? err.message : "初始化失败")
      }
    }
    void loadInitialData()
  }, [])

  useEffect(() => {
    const normalizedView = normalizeViewFromPath(window.location.pathname)
    const targetPath = getPathForView(normalizedView)
    setViewState(normalizedView)
    if (window.location.pathname !== targetPath) {
      window.history.replaceState({}, "", targetPath)
    }

    const handlePopState = () => {
      setViewState(normalizeViewFromPath(window.location.pathname))
    }
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort()
    }
  }, [])

  const copyWebBridgeLoginCommand = useCallback(async () => {
    if (!webBridgeStatus?.login_command) {
      return
    }
    try {
      await navigator.clipboard.writeText(webBridgeStatus.login_command)
      setWebBridgeLoginMessage("登录命令已复制到剪贴板，请在宿主机终端执行。")
    } catch {
      setWebBridgeLoginMessage("复制失败，请手动复制下方登录命令。")
    }
  }, [webBridgeStatus])

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
    if (!showArtifactMuseumSuggestions) {
      return
    }
    const q = artifactForm.museumName.trim()
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: "8" })
        if (q) params.set("q", q)
        const data = await fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?${params.toString()}`, {
          signal: controller.signal,
        })
        setArtifactMuseumSuggestions(data)
      } catch {
        if (!controller.signal.aborted) {
          setArtifactMuseumSuggestions([])
        }
      }
    }, 160)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [apiBaseUrl, artifactForm.museumName, showArtifactMuseumSuggestions])

  useEffect(() => {
    const rawQuery = artifactForm.captureMuseumName.trim()
    if (!rawQuery.startsWith("@")) {
      setMuseumSuggestions([])
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
        setMuseumSuggestions(data)
      } catch {
        if (!controller.signal.aborted) {
          setMuseumSuggestions([])
        }
      }
    }, 180)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [artifactForm.captureMuseumName])

  useEffect(() => {
    if (!showEraSuggestions) {
      return
    }
    const query = artifactForm.era.trim().toLowerCase()
    const nextSuggestions = eraOptions
      .filter((option) => !query || option.name.toLowerCase().includes(query))
      .slice(0, 8)
    setEraSuggestions(nextSuggestions)
  }, [artifactForm.era, eraOptions, showEraSuggestions])

  useEffect(() => {
    const rawQuery = artifactForm.exhibitionName.trim()
    if (!selectedCaptureMuseum || !rawQuery.startsWith("@")) {
      setExhibitionSuggestions([])
      return
    }
    const q = rawQuery.slice(1).trim()
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          museum_id: String(selectedCaptureMuseum.id),
          limit: "8",
        })
        if (q) params.set("q", q)
        const data = await fetchJson<ExhibitionOption[]>(
          `${apiBaseUrl}/api/exhibitions?${params.toString()}`,
          { signal: controller.signal },
        )
        setExhibitionSuggestions(data)
      } catch {
        if (!controller.signal.aborted) {
          setExhibitionSuggestions([])
        }
      }
    }, 180)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [apiBaseUrl, artifactForm.exhibitionName, selectedCaptureMuseum])

  useEffect(() => {
    const name = artifactForm.name.trim()
    const museumName = artifactForm.museumName.trim()
    const era = artifactForm.era.trim()
    if (!name || !museumName || !era) {
      setMatchedArtifact(null)
      setSameArtifactDecision(null)
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
        setMatchedArtifact(matched)
        setSameArtifactDecision(null)
      } catch {
        if (!controller.signal.aborted) {
          setMatchedArtifact(null)
          setSameArtifactDecision(null)
        }
      }
    }, 220)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [apiBaseUrl, artifactForm.era, artifactForm.museumName, artifactForm.name])

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
      setArtifactForm(buildArtifactFormFromImage(image))
      setSelectedCaptureMuseum(null)
      setMuseumSuggestions([])
      setExhibitionSuggestions([])
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
    setArtifactForm({ ...EMPTY_ARTIFACT_FORM })
    setTagInput("")
    setProviderOrder([])
    setProviderStreams({})
    setUnavailableProviders([])
    setSelectedCandidateKey(null)
    setSelectedCaptureMuseum(null)
    setArtifactMuseumSuggestions([])
    setShowArtifactMuseumSuggestions(false)
    setMuseumSuggestions([])
    setEraSuggestions([])
    setShowEraSuggestions(false)
    setExhibitionSuggestions([])
    setMatchedArtifact(null)
    setSameArtifactDecision(null)
    setArtifactMessage(null)
    setSubmitNotice(null)
  }

  async function handleCreateArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setArtifactSubmitting(true)
    setArtifactMessage(null)
    setArtifactError(null)
    setSubmitNotice(null)

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
      if (!artifactForm.captureMuseumName.trim() || artifactForm.captureMuseumName.trim().startsWith("@")) {
        throw new Error("请填写或选择拍摄时所在博物馆")
      }
      if (!artifactForm.exhibitionName.trim() || artifactForm.exhibitionName.trim().startsWith("@")) {
        throw new Error("请填写或选择展览名称")
      }
      const result = await fetchJson<ArtifactSubmitResult>(`${apiBaseUrl}/api/artifacts/submit-cloud`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: uploadedImage.url,
          museum_name: artifactForm.museumName.trim(),
          name: artifactForm.name,
          era: artifactForm.era || null,
          description: artifactForm.description || null,
          existing_artifact_id:
            sameArtifactDecision === "no" ? null : matchedArtifact?.artifact.id ?? null,
          tags: artifactForm.tags,
          camera_model: artifactForm.cameraModel.trim() || null,
          lens_model: artifactForm.lensModel.trim() || null,
          capture_museum_name: artifactForm.captureMuseumName.trim(),
          exhibition_name: artifactForm.exhibitionName.trim() || "常设",
          latitude: artifactForm.latitude.trim() ? Number(artifactForm.latitude) : null,
          longitude: artifactForm.longitude.trim() ? Number(artifactForm.longitude) : null,
          captured_at: artifactForm.capturedAt.trim() || null,
          shutter_speed: artifactForm.shutterSpeed.trim() || null,
          aperture: artifactForm.aperture.trim() || null,
          iso: artifactForm.iso.trim() ? Number(artifactForm.iso) : null,
          edit_method: artifactForm.editMethod || null,
        }),
      })

      resetCurrentImage()
      setSubmitNotice({
        type: "success",
        text: result.duplicate_image_skipped
          ? (result.duplicate_image_detail ?? `「${result.name}」已有相同图片，已跳过重复上传`)
          : "已提交云端，图片已上传 OSS",
      })
    } catch (err) {
      setSubmitNotice({
        type: "error",
        text: err instanceof Error ? err.message : "提交云端失败",
      })
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
    { label: "提交云端", done: false, active: Boolean(selectedCandidateKey) },
  ]

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/logo.png" alt="文物数据库" />
          <div className="brand-copy">
            <p className="eyebrow">Museum Image Archive</p>
            <h1>文物数据库</h1>
            <p className="brand-lead">书卷式整理文物图像、展览信息与识别证据，让入库流程清楚、端正、可追溯。</p>
          </div>
        </div>
        <div className="topbar-actions">
          <nav className="topbar-nav" aria-label="顶部导航">
            {NAV_ITEMS.filter((item) => item.cloudVisible || !cloudOnly)
              .filter((item) => item.view === "gallery" || item.view === "museums")
              .map((item) => (
              <button
                type="button"
                key={`top-${item.view}`}
                className={view === item.view ? "active" : ""}
                onClick={() => setView(item.view)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className={`health-pill ${health ? "online" : "offline"}`}>
            <span className="status-dot" />
            <span>
              {loadingHealth ? "检查后端…" : health ? `后端在线 · ${health.environment}` : "后端未连通"}
            </span>
          </div>
        </div>
      </header>

      {!cloudOnly ? (
        <div className="view-tabs-shell">
          <nav className="view-tabs">
            {NAV_ITEMS.filter((item) => item.cloudVisible || !cloudOnly).map((item) => (
              <button
                type="button"
                key={item.view}
                className={view === item.view ? "active" : ""}
                onClick={() => setView(item.view)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      ) : null}

      {view === "gallery" ? <Gallery apiBaseUrl={apiBaseUrl} /> : null}

      {view === "museums" ? <MuseumBrowser apiBaseUrl={apiBaseUrl} /> : null}

      {view === "batch" && !cloudOnly ? <BatchConsole apiBaseUrl={apiBaseUrl} /> : null}

      {view === "exif" && !cloudOnly ? <ExifConsole apiBaseUrl={apiBaseUrl} /> : null}

      {view === "single" && !cloudOnly ? (
      <>
      <section className="hero-banner">
        <div className="hero-copy">
          <p className="eyebrow">Single Image Workflow</p>
          <h2>从一张照片，到一条端正可信的文物记录</h2>
          <p className="muted">
            上传图片后自动调用多模型识别、检索佐证与结果裁决；你只需在统一表单里校订后提交。
          </p>
        </div>
        <div className="hero-metrics" aria-label="流程说明">
          <div className="hero-metric">
            <span className="hero-metric-label">流程</span>
            <strong>上传 / 识别 / 校订 / 入库</strong>
          </div>
          <div className="hero-metric">
            <span className="hero-metric-label">风格</span>
            <strong>书卷气 · 温润 · 清晰对齐</strong>
          </div>
          <div className="hero-metric">
            <span className="hero-metric-label">结果</span>
            <strong>图像、证据、元数据一处完成</strong>
          </div>
        </div>
      </section>

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
                    <span key={`backend-match-tag-${tag}`}>{tag}</span>
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
                      href={toAbsoluteUrl(image.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="existing-artifact-thumb"
                    >
                      <img src={toAbsoluteUrl(image.url)} alt={matchedArtifact.artifact.name} loading="lazy" />
                    </a>
                  ))}
                </div>
              ) : null}
              <div className="backend-match-actions">
                <button
                  type="button"
                  className={`primary small ${sameArtifactDecision === "yes" ? "selected-action" : ""}`}
                  onClick={() => {
                    setArtifactForm((current) => ({
                      ...current,
                      museumName: matchedArtifact.artifact.museum_name,
                      name: matchedArtifact.artifact.name,
                      era: matchedArtifact.artifact.era ?? "",
                      description: matchedArtifact.artifact.description ?? "",
                      tags: normalizeTags(matchedArtifact.artifact.tags),
                    }))
                    setTagInput("")
                    setSameArtifactDecision("yes")
                    setArtifactMessage(
                      `已确认与「${matchedArtifact.artifact.name}」是同一件，并已将库内名称、时代、描述、标签同步到表单`,
                    )
                    setArtifactError(null)
                  }}
                >
                  是同一件
                </button>
                <button
                  type="button"
                  className={`ghost ${sameArtifactDecision === "no" ? "selected-action" : ""}`}
                  onClick={() => {
                    setSameArtifactDecision("no")
                    setArtifactMessage("已标记为不是同一件，提交时会新建文物记录")
                    setArtifactError(null)
                  }}
                >
                  不是同一件
                </button>
              </div>
              {sameArtifactDecision === "yes" ? (
                <p className="success-text">后续你在表单里改名称、时代、描述，提交时会直接更新这条已有文物。</p>
              ) : sameArtifactDecision === "no" ? (
                <p className="muted small">如名称、时代、馆藏仍匹配，云端入库时仍会自动合并到这条已有文物。</p>
              ) : (
                <p className="muted small">如不手动处理，提交时也会优先合并到这条已有文物，避免生成重复卡片。</p>
              )}
            </section>
          ) : null}

          {hasResult ? (
            <p className="muted small center">提示：可对比多模型结论，点击「采用」自动填入下方入库表单。</p>
          ) : null}
        </section>
      </div>

      <form className="panel form-wide" onSubmit={handleCreateArtifact}>
        <div className="section-heading">
          <span className="step-badge">3</span>
          <div>
            <h2>确认并提交云端</h2>
            <p className="muted">采用上方候选后可微调，提交时会写线上数据库并上传图片到 OSS。</p>
          </div>
        </div>

        <div className="form-fields">
          <section className="form-section">
            <div className="form-section-head">
              <span className="form-section-kicker">BASIC</span>
              <h3>基本信息</h3>
            </div>
            <div className="form-section-body">
              <div className="field-row">
                <label className="field">
                  <span>博物馆名称</span>
                  <input
                    value={artifactForm.museumName}
                    onFocus={() => setShowArtifactMuseumSuggestions(true)}
                    onBlur={() => {
                      window.setTimeout(() => setShowArtifactMuseumSuggestions(false), 120)
                    }}
                    onChange={(event) => {
                      setArtifactForm((current) => ({ ...current, museumName: event.target.value }))
                      setShowArtifactMuseumSuggestions(true)
                    }}
                    placeholder="例如：南京博物院"
                  />
                  {showArtifactMuseumSuggestions && artifactMuseumSuggestions.length > 0 ? (
                    <div className="suggestion-list">
                      {artifactMuseumSuggestions.map((museum) => (
                        <button
                          key={`artifact-museum-${museum.id}`}
                          type="button"
                          className="suggestion-item"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setArtifactForm((current) => ({ ...current, museumName: museum.name }))
                            setArtifactMuseumSuggestions([])
                            setShowArtifactMuseumSuggestions(false)
                          }}
                        >
                          {museum.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
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
                    onFocus={() => setShowEraSuggestions(true)}
                    onBlur={() => {
                      window.setTimeout(() => setShowEraSuggestions(false), 120)
                    }}
                    onChange={(event) => {
                      setArtifactForm((current) => ({ ...current, era: event.target.value }))
                      setShowEraSuggestions(true)
                    }}
                    placeholder="例如：元代"
                  />
                  {showEraSuggestions && eraSuggestions.length > 0 ? (
                    <div className="suggestion-list">
                      {eraSuggestions.map((era) => (
                        <button
                          key={`artifact-era-${era.id}`}
                          type="button"
                          className="suggestion-item"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setArtifactForm((current) => ({ ...current, era: era.name }))
                            setEraSuggestions([])
                            setShowEraSuggestions(false)
                          }}
                        >
                          {era.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </label>
                <label className="field">
                  <span>标签</span>
                  <div className="tag-editor">
                    <div className="tag-editor-chips">
                      {artifactForm.tags.length > 0 ? (
                        artifactForm.tags.map((tag) => (
                          <span key={tag} className="tag-chip">
                            {tag}
                            <button type="button" onClick={() => removeTag(tag)} aria-label={`删除标签 ${tag}`}>
                              ×
                            </button>
                          </span>
                        ))
                      ) : (
                        <span className="tag-editor-placeholder">暂无标签</span>
                      )}
                    </div>
                    <input
                      value={tagInput}
                      onChange={(event) => setTagInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === "," || event.key === "\uFF0C") {
                          event.preventDefault()
                          addTags(tagInput)
                        }
                        if (event.key === "Backspace" && !tagInput && artifactForm.tags.length > 0) {
                          removeTag(artifactForm.tags[artifactForm.tags.length - 1])
                        }
                      }}
                      onBlur={() => addTags(tagInput)}
                      placeholder="输入后回车或逗号添加"
                    />
                  </div>
                </label>
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <span className="form-section-kicker">CAPTURE</span>
              <h3>拍摄与展览</h3>
            </div>
            <div className="form-section-body">
              <div className="field-row">
                <label className="field">
                  <span>机型</span>
                  <input
                    value={artifactForm.cameraModel}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, cameraModel: event.target.value }))
                    }
                    placeholder="自动读取，可手动补充"
                  />
                </label>
                <label className="field">
                  <span>镜头</span>
                  <input
                    value={artifactForm.lensModel}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, lensModel: event.target.value }))
                    }
                    placeholder="自动读取，可手动补充"
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>拍摄时博物馆</span>
                  <input
                    value={artifactForm.captureMuseumName}
                    onChange={(event) => {
                      const value = event.target.value
                      setArtifactForm((current) => ({ ...current, captureMuseumName: value }))
                      if (selectedCaptureMuseum?.name !== value) {
                        setSelectedCaptureMuseum(null)
                      }
                    }}
                    placeholder="输入 @ 后联想检索，例如：@南博"
                  />
                  {artifactForm.captureMuseumName.trim().startsWith("@") ? (
                    <span className="field-help">输入 `@关键词` 后，从下方结果选择拍摄时所在博物馆。</span>
                  ) : null}
                  {museumSuggestions.length > 0 ? (
                    <div className="suggestion-list">
                      {museumSuggestions.map((museum) => (
                        <button
                          key={museum.id}
                          type="button"
                          className="suggestion-item"
                          onClick={() => {
                            setSelectedCaptureMuseum(museum)
                            setMuseumSuggestions([])
                            setArtifactForm((current) => ({
                              ...current,
                              captureMuseumName: museum.name,
                              exhibitionName:
                                current.exhibitionName.trim().startsWith("@") || !current.exhibitionName.trim()
                                  ? "常设"
                                  : current.exhibitionName,
                            }))
                          }}
                        >
                          {museum.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </label>
                <label className="field">
                  <span>展览</span>
                  <input
                    value={artifactForm.exhibitionName}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, exhibitionName: event.target.value }))
                    }
                    placeholder={
                      selectedCaptureMuseum
                        ? "默认常设，输入 @ 后联想检索该馆展览"
                        : "默认常设，可直接填写"
                    }
                  />
                  {artifactForm.exhibitionName.trim().startsWith("@") && selectedCaptureMuseum ? (
                    <span className="field-help">当前按 `{selectedCaptureMuseum.name}` 的展览库联想检索。</span>
                  ) : null}
                  {exhibitionSuggestions.length > 0 ? (
                    <div className="suggestion-list">
                      {exhibitionSuggestions.map((exhibition) => (
                        <button
                          key={exhibition.id}
                          type="button"
                          className="suggestion-item"
                          onClick={() => {
                            setExhibitionSuggestions([])
                            setArtifactForm((current) => ({
                              ...current,
                              exhibitionName: exhibition.name,
                            }))
                          }}
                        >
                          <span>{exhibition.name}</span>
                          {exhibition.start_at || exhibition.end_at ? (
                            <em>
                              {exhibition.start_at?.slice(0, 10) ?? "未知"} - {exhibition.end_at?.slice(0, 10) ?? "至今"}
                            </em>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </label>
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <span className="form-section-kicker">META</span>
              <h3>时间、坐标与参数</h3>
            </div>
            <div className="form-section-body">
              <div className="field-row">
                <label className="field">
                  <span>纬度</span>
                  <input
                    value={artifactForm.latitude}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, latitude: event.target.value }))
                    }
                    placeholder="例如：32.060255"
                  />
                </label>
                <label className="field">
                  <span>经度</span>
                  <input
                    value={artifactForm.longitude}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, longitude: event.target.value }))
                    }
                    placeholder="例如：118.796877"
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>拍摄时间</span>
                  <input
                    value={artifactForm.capturedAt}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, capturedAt: event.target.value }))
                    }
                    placeholder="例如：2024-05-01T14:30:00"
                  />
                </label>
                <label className="field">
                  <span>上传时间</span>
                  <input value={artifactForm.uploadedAt} readOnly placeholder="上传后自动生成" />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>快门</span>
                  <input
                    value={artifactForm.shutterSpeed}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, shutterSpeed: event.target.value }))
                    }
                    placeholder="例如：1/125s"
                  />
                </label>
                <label className="field">
                  <span>光圈</span>
                  <input
                    value={artifactForm.aperture}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, aperture: event.target.value }))
                    }
                    placeholder="例如：f/2.8"
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>感光度</span>
                  <input
                    value={artifactForm.iso}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, iso: event.target.value }))
                    }
                    placeholder="例如：400"
                  />
                </label>
                <label className="field">
                  <span>修图方式</span>
                  <select
                    value={artifactForm.editMethod}
                    onChange={(event) =>
                      setArtifactForm((current) => ({ ...current, editMethod: event.target.value }))
                    }
                  >
                    <option value="">未填写</option>
                    <option value="简单调整">简单调整</option>
                    <option value="堆栈合成">堆栈合成</option>
                  </select>
                </label>
              </div>
            </div>
          </section>

          <section className="form-section form-section-compact">
            <div className="form-section-head">
              <span className="form-section-kicker">TEXT</span>
              <h3>补充描述</h3>
            </div>
            <div className="form-section-body">
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
          </section>
        </div>

        <div className="form-footer">
          {submitNotice ? (
            <p className={submitNotice.type === "error" ? "error-text" : "success-text"}>
              {submitNotice.text}
            </p>
          ) : artifactMessage ? (
            <p className="success-text">{artifactMessage}</p>
          ) : (
            <span />
          )}
          <button type="submit" className="primary" disabled={artifactSubmitting || !uploadedImage}>
            {artifactSubmitting
              ? "提交中..."
              : matchedArtifact && sameArtifactDecision !== "no"
                ? "更新已有文物并上传图片"
                : "提交云端"}
          </button>
        </div>
      </form>
      {submitNotice ? (
        <div className={`submit-toast ${submitNotice.type}`}>
          <div className="submit-toast-body">
            <strong>{submitNotice.type === "error" ? "提交失败" : "提交成功"}</strong>
            <p>{submitNotice.text}</p>
          </div>
          <button type="button" className="submit-toast-close" onClick={() => setSubmitNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
      {showWebBridgeLoginModal
        ? createPortal(
            <div className="gallery-modal" onClick={() => setShowWebBridgeLoginModal(false)}>
              <div className="gallery-modal-body bridge-login-modal" onClick={(event) => event.stopPropagation()}>
                <div className="section-heading">
                  <div>
                    <h2>通义扫码登录</h2>
                    <p className="muted">
                      {webBridgeStatus?.site_label || "通义网页桥"} 当前未登录，识图前需要先完成扫码。
                    </p>
                  </div>
                </div>
                <div className="bridge-login-content">
                  <p className="result-desc">
                    {webBridgeLoginMessage ||
                      webBridgeStatus?.detail ||
                      "检测到网页桥登录态缺失，请先完成通义扫码登录。"}
                  </p>
                  {webBridgeStatus?.auto_login_supported ? (
                    <p className="muted small">
                      当前环境支持自动拉起登录窗口；如果没有弹出，请点击下方“重新尝试打开登录窗口”。
                    </p>
                  ) : (
                    <p className="muted small">
                      当前是 Docker 容器环境，后端无法直接弹出你宿主机上的 Chrome 窗口，所以需要你在宿主机手动执行登录命令。
                    </p>
                  )}
                  {webBridgeStatus?.login_command ? (
                    <pre className="bridge-login-command">{webBridgeStatus.login_command}</pre>
                  ) : null}
                </div>
                <div className="backend-match-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={launchingWebBridgeLogin}
                    onClick={() => void ensureWebBridgeLoginReady(true)}
                  >
                    {launchingWebBridgeLogin ? "正在尝试启动..." : "重新尝试打开登录窗口"}
                  </button>
                  {webBridgeStatus?.login_command ? (
                    <button type="button" className="ghost" onClick={() => void copyWebBridgeLoginCommand()}>
                      复制登录命令
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      void loadWebBridgeStatus()
                      setShowWebBridgeLoginModal(false)
                    }}
                  >
                    我已登录，稍后重试
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      </>
      ) : null}
    </main>
  )
}

export default App
