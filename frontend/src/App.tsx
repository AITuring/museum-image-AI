import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import { createPortal } from "react-dom"
import { AutoComplete, Button, Input, Select, Tabs, Tag } from "antd"
import { Camera, Check, ChevronRight, CloudUpload, ImagePlus, RefreshCw, ScanSearch, Trash2 } from "lucide-react"
import "./App.css"

const BatchConsole = lazy(() => import("./BatchConsole"))
const ExifConsole = lazy(() => import("./ExifConsole"))
const Gallery = lazy(() => import("./Gallery"))
const MuseumBrowser = lazy(() => import("./MuseumBrowser"))
const ExhibitionCatalog = lazy(() => import("./ExhibitionCatalog"))

type FormSubmitHandler = NonNullable<ComponentProps<"form">["onSubmit"]>

const { TextArea } = Input

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
  preview_data_url: string | null
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

async function createUploadPlaceholder(file: File) {
  const canvas = document.createElement("canvas")
  canvas.width = 640
  canvas.height = 400
  const context = canvas.getContext("2d")
  if (!context) return null
  context.fillStyle = "#f5f5f4"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "#44403c"
  context.font = "600 30px system-ui, sans-serif"
  context.fillText(file.name.length > 32 ? `${file.name.slice(0, 29)}...` : file.name, 42, 188)
  context.fillStyle = "#78716c"
  context.font = "22px system-ui, sans-serif"
  const size = file.size >= 1024 ** 2
    ? `${(file.size / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.round(file.size / 1024))} KB`
  context.fillText(`正在生成缩略图 · ${size}`, 42, 232)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.75))
  return blob ? URL.createObjectURL(blob) : null
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
  duplicate_image_replaced?: boolean
  duplicate_image_detail?: string | null
}

type BackendTarget = "local" | "cloud"

type BackendOption = {
  value: BackendTarget
  label: string
  detail: string
  apiBaseUrl: string
}

const backendPreferenceStorageKey = "museum-backend-target"
const localApiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL
  ?? (import.meta.env.PROD ? "" : "http://localhost:8000")
).replace(/\/$/, "")
const cloudApiBaseUrl = import.meta.env.DEV ? "/cloud-api" : ""
const backendOptions: BackendOption[] = [
  {
    value: "local",
    label: "本地dev",
    detail: localApiBaseUrl || "当前站点",
    apiBaseUrl: localApiBaseUrl,
  },
  ...(import.meta.env.DEV
    ? [{
        value: "cloud" as const,
        label: "线上production",
        detail: "走前端代理",
        apiBaseUrl: cloudApiBaseUrl,
      }]
    : []),
]
// On the cloud deployment only the gallery/search view makes sense (no qwen bridge).
const cloudOnly = (import.meta.env.VITE_CLOUD_ONLY ?? "false") === "true"

type View = "single" | "batch" | "exif" | "gallery" | "museums" | "exhibitions"

const VIEW_PATHS: Record<View, string> = {
  single: "/single",
  batch: "/batch",
  exif: "/photo-exif",
  gallery: "/gallery",
  museums: "/museums",
  exhibitions: "/exhibitions",
}

const NAV_ITEMS: Array<{ view: View; label: string; cloudVisible: boolean }> = [
  { view: "exif", label: "快速录入", cloudVisible: false },
  { view: "single", label: "智能识别", cloudVisible: false },
  { view: "batch", label: "相册同步", cloudVisible: false },
  { view: "gallery", label: "图库", cloudVisible: true },
  { view: "museums", label: "场馆", cloudVisible: true },
  { view: "exhibitions", label: "展览", cloudVisible: true },
]

function isViewAvailable(view: View) {
  return !cloudOnly || view === "gallery" || view === "museums" || view === "exhibitions"
}

function getDefaultView(): View {
  return cloudOnly ? "gallery" : "exif"
}

function normalizeViewFromPath(pathname: string): View {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/"
  if (
    /^\/exhibitions\/\d+$/.test(normalizedPath)
    || /^\/exhibitions\/source\/[A-Za-z0-9_-]+$/.test(normalizedPath)
    || /^\/exhibitions\/history\/[^/]+$/.test(normalizedPath)
  ) {
    return "exhibitions"
  }
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
  const [backendTarget, setBackendTarget] = useState<BackendTarget>(() => {
    if (!import.meta.env.DEV) {
      return "local"
    }
    const initialView = normalizeViewFromPath(window.location.pathname)
    if (!NAV_ITEMS.find((item) => item.view === initialView)?.cloudVisible) {
      return "local"
    }
    const storedValue = window.localStorage.getItem(backendPreferenceStorageKey)
    return storedValue === "cloud" ? "cloud" : "local"
  })
  const apiBaseUrl = useMemo(
    () => backendOptions.find((option) => option.value === backendTarget)?.apiBaseUrl ?? localApiBaseUrl,
    [backendTarget],
  )
  const activeBackend = useMemo(
    () => backendOptions.find((option) => option.value === backendTarget) ?? backendOptions[0],
    [backendTarget],
  )
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loadingHealth, setLoadingHealth] = useState(true)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const previewFileRef = useRef<File | null>(null)
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
  const backendSelectOptions = useMemo(
    () => backendOptions.map((option) => ({
      value: option.value,
      label: option.label,
    })),
    [],
  )

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
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
  }, [])

  const handleViewChange = useCallback((nextView: View) => {
    const nextItem = NAV_ITEMS.find((item) => item.view === nextView)
    if (import.meta.env.DEV && backendTarget === "cloud" && nextItem && !nextItem.cloudVisible) {
      setBackendTarget("local")
    }
    setView(nextView)
  }, [backendTarget, setView])

  const handleBackendTargetChange = useCallback((nextTarget: BackendTarget) => {
    setBackendTarget(nextTarget)
    if (nextTarget === "cloud" && !NAV_ITEMS.find((item) => item.view === view)?.cloudVisible) {
      setView("gallery", { replace: true })
    }
  }, [setView, view])

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
    setLoadingHealth(true)
    try {
      // Vercel's rewrite can occasionally be cold while the cloud backend is
      // healthy. Avoid presenting a transient proxy timeout as an offline API.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const data = await fetchJson<HealthResponse>(`${apiBaseUrl}/api/health?check=${Date.now()}`, {
            cache: "no-store",
          })
          setHealth(data)
          return
        } catch (error) {
          if (attempt === 1) throw error
          await new Promise<void>((resolve) => window.setTimeout(resolve, 500))
        }
      }
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
  }, [apiBaseUrl])

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }
    window.localStorage.setItem(backendPreferenceStorageKey, backendTarget)
  }, [backendTarget])

  useEffect(() => {
    const normalizedView = normalizeViewFromPath(window.location.pathname)
    const targetPath = getPathForView(normalizedView)
    const isExhibitionDetailPath =
      normalizedView === "exhibitions"
      && (
        /^\/exhibitions\/\d+\/?$/.test(window.location.pathname)
        || /^\/exhibitions\/source\/[A-Za-z0-9_-]+\/?$/.test(window.location.pathname)
        || /^\/exhibitions\/history\/[^/]+\/?$/.test(window.location.pathname)
      )
    if (window.location.pathname !== targetPath && !isExhibitionDetailPath) {
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
      const timer = window.setTimeout(() => setMuseumSuggestions([]), 0)
      return () => window.clearTimeout(timer)
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
    const timer = window.setTimeout(() => setEraSuggestions(nextSuggestions), 0)
    return () => window.clearTimeout(timer)
  }, [artifactForm.era, eraOptions, showEraSuggestions])

  useEffect(() => {
    const rawQuery = artifactForm.exhibitionName.trim()
    if (!selectedCaptureMuseum || !rawQuery.startsWith("@")) {
      const timer = window.setTimeout(() => setExhibitionSuggestions([]), 0)
      return () => window.clearTimeout(timer)
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
      const timer = window.setTimeout(() => {
        setMatchedArtifact(null)
        setSameArtifactDecision(null)
      }, 0)
      return () => window.clearTimeout(timer)
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
    previewFileRef.current = file
    setSelectedFile(file)
    setPreviewUrl((current) => {
      if (current?.startsWith("blob:")) {
        URL.revokeObjectURL(current)
      }
      return null
    })
    if (file) {
      void createUploadPlaceholder(file).then((placeholderUrl) => {
        if (!placeholderUrl) return
        if (previewFileRef.current !== file) {
          URL.revokeObjectURL(placeholderUrl)
          return
        }
        setPreviewUrl((current) => {
          if (current?.startsWith("blob:")) URL.revokeObjectURL(current)
          return placeholderUrl
        })
      })
    }
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
      if (image.preview_data_url && previewFileRef.current === file) {
        setPreviewUrl((current) => {
          if (current?.startsWith("blob:")) URL.revokeObjectURL(current)
          return image.preview_data_url
        })
      }
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

  const handleCreateArtifact: FormSubmitHandler = async (event) => {
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
        text: result.duplicate_image_replaced
          ? (result.duplicate_image_detail ?? `「${result.name}」的已有图片已被本次校正覆盖`)
          : result.duplicate_image_skipped
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

  const lazyViewFallback = (
    <section className="panel empty-state">
      <h2>页面加载中</h2>
      <p className="muted">正在按需加载当前模块…</p>
    </section>
  )

  const hasResult = orderedStreams.some((stream) => stream.candidate)
  const displayPreview = previewUrl
  const streamError = orderedStreams.length === 0 && !streaming && uploadedImage ? artifactError : null
  const selectedStream = selectedCandidateKey ? providerStreams[selectedCandidateKey] : null
  const selectedCandidate = selectedStream?.candidate ?? null
  const bestStream = bestCandidateKey ? providerStreams[bestCandidateKey] : null
  const bestCandidate = bestStream?.candidate ?? null
  const primaryCandidate = selectedCandidate ?? bestCandidate
  const requiredFields = [
    Boolean(uploadedImage),
    Boolean(artifactForm.museumName.trim()),
    Boolean(artifactForm.name.trim()),
    Boolean(artifactForm.captureMuseumName.trim()) && !artifactForm.captureMuseumName.trim().startsWith("@"),
    Boolean(artifactForm.exhibitionName.trim()) && !artifactForm.exhibitionName.trim().startsWith("@"),
  ]
  const readyCount = requiredFields.filter(Boolean).length
  const archiveReady = readyCount === requiredFields.length
  const singleStatusLabel = artifactSubmitting
    ? "提交中"
    : archiveReady
      ? "可提交"
      : hasResult
        ? "待校对"
        : uploadedImage
          ? streaming
            ? "识别中"
            : "待识别"
          : "待上传"

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/logo.png" alt="文物数据库" />
          <div className="brand-copy">
            <h1>Museum · 藏影录</h1>
            <p className="brand-lead">文物图像采集与归档</p>
          </div>
        </div>
        <div className="topbar-actions">
          <nav className="topbar-nav" aria-label="顶部导航">
            <Tabs
              activeKey={view}
              className="app-tabs"
              items={NAV_ITEMS.filter((item) => item.cloudVisible || !cloudOnly).map((item) => ({
                key: item.view,
                label: item.label,
              }))}
              size="small"
              onChange={(value) => handleViewChange(value as View)}
            />
          </nav>
          {import.meta.env.DEV ? (
            <label className={`backend-target-select-wrap ${health ? "online" : "offline"}`}>
              <select
                className="backend-target-select"
                value={backendTarget}
                onChange={(event) => handleBackendTargetChange(event.target.value as BackendTarget)}
                title={
                  loadingHealth
                    ? "检查后端中"
                    : health
                      ? `${activeBackend.label} · ${health.environment}`
                      : `${activeBackend.label} · 未连通`
                }
              >
                {backendSelectOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="backend-target-caret" aria-hidden="true">▾</span>
            </label>
          ) : (
            <div className={`health-pill ${health ? "online" : "offline"}`}>
              <span className="status-dot" />
              <span className="health-pill-text">
                {loadingHealth
                  ? "检查中"
                  : health
                    ? `${activeBackend.label} · ${health.environment}`
                    : `${activeBackend.label} · 未连通`}
              </span>
            </div>
          )}
        </div>
      </header>

      <Suspense fallback={lazyViewFallback}>
        {view === "gallery" ? <Gallery apiBaseUrl={apiBaseUrl} /> : null}

        {view === "museums" ? <MuseumBrowser apiBaseUrl={apiBaseUrl} /> : null}

        {view === "exhibitions" ? <ExhibitionCatalog apiBaseUrl={apiBaseUrl} /> : null}

        {view === "batch" && !cloudOnly ? <BatchConsole apiBaseUrl={apiBaseUrl} /> : null}

        {view === "exif" && !cloudOnly ? <ExifConsole apiBaseUrl={apiBaseUrl} /> : null}
      </Suspense>

      {view === "single" && !cloudOnly ? (
      <>
      <section className="single-workbench">
        <aside className="single-rail" aria-label="图片与候选结果">
          <section className="single-panel single-upload-panel">
            <div className="single-panel-head">
              <div>
                <h2>图片</h2>
              </div>
              <span className={`single-status ${uploadedImage ? "ok" : uploading ? "busy" : ""}`}>
                {uploading ? "上传中" : uploadedImage ? "已上传" : "待上传"}
              </span>
            </div>
            <label
              className={`single-dropzone ${dragging ? "dragging" : ""} ${displayPreview ? "has-image" : ""}`}
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
                <img src={displayPreview} alt={uploadedImage?.filename ?? "预览"} decoding="async" />
              ) : (
                <span>
                  <ImagePlus size={20} aria-hidden="true" />
                  <strong>添加图片</strong>
                  <em>点击或拖拽 JPG / PNG</em>
                </span>
              )}
            </label>
            <div className="single-actions">
              <Button
                htmlType="button"
                onClick={() => uploadedImage && void analyzeImageStream(uploadedImage)}
                disabled={!uploadedImage || streaming}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {streaming ? "识别中..." : "重新识别"}
              </Button>
              <Button htmlType="button" type="default" onClick={resetCurrentImage} disabled={!selectedFile && !uploadedImage}>
                <Trash2 size={14} aria-hidden="true" />
                清空
              </Button>
            </div>
            {uploadedImage ? (
              <div className="single-meta-list">
                <span title={uploadedImage.filename}>文件：{uploadedImage.filename}</span>
                <span>机型：{uploadedImage.camera_model || "未读取"}</span>
                <span>镜头：{uploadedImage.lens_model || "未读取"}</span>
              </div>
            ) : null}
            {unavailableProviders.length > 0 ? (
              <p className="muted">未配置模型：{unavailableProviders.join("、")}</p>
            ) : null}
            {artifactError ? <p className="error-text">{artifactError}</p> : null}
          </section>

          <section className="single-panel">
            <div className="single-panel-head">
              <div>
                <h2>候选结论</h2>
              </div>
              <span className="single-count">{orderedStreams.filter((stream) => stream.candidate).length}</span>
            </div>
            <div className="single-candidate-list">
              {orderedStreams.some((stream) => stream.candidate) ? orderedStreams.map((stream) => {
                const candidate = stream.candidate
                if (!candidate) return null
                return (
                  <button
                    key={`candidate-${stream.provider}`}
                    type="button"
                    data-ui="interactive-surface"
                    className={`single-candidate ${selectedCandidateKey === stream.provider ? "is-selected" : ""}`}
                    onClick={() => handleApplyCandidate(candidate)}
                  >
                    <span>
                      <strong>{candidate.artifact_name}</strong>
                      <em>{stream.provider} · {formatConfidence(candidate.confidence) ?? "可信度待估"}</em>
                    </span>
                    {stream.provider === bestCandidateKey ? <Tag color="success">推荐</Tag> : null}
                  </button>
                )
              }) : (
                <p className="muted">识别完成后，候选会在这里集中展示；点一次即可填入右侧表单。</p>
              )}
            </div>
          </section>

          {matchedArtifact ? (
            <section className="single-panel backend-match-card">
              <div className="backend-match-head">
                <div>
                  <h3>疑似同一件</h3>
                  <p className="muted">{matchedArtifact.match_reason} · {Math.round(matchedArtifact.match_score * 100)}%</p>
                </div>
                <span className="backend-match-count">{matchedArtifact.artifact.images.length} 张历史图片</span>
              </div>
              <div className="backend-match-meta">
                <span>{matchedArtifact.artifact.name}</span>
                <span>{matchedArtifact.artifact.era || "时代待确认"}</span>
                <span>{matchedArtifact.artifact.museum_name}</span>
              </div>
              <div className="backend-match-actions">
                <Button
                  htmlType="button"
                  size="small"
                  type={sameArtifactDecision === "yes" ? "primary" : "default"}
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
                    setArtifactMessage(`已合并到「${matchedArtifact.artifact.name}」`)
                    setArtifactError(null)
                  }}
                >
                  合并
                </Button>
                <Button
                  htmlType="button"
                  size="small"
                  type={sameArtifactDecision === "no" ? "primary" : "default"}
                  onClick={() => {
                    setSameArtifactDecision("no")
                    setArtifactMessage("已标记为新建文物")
                    setArtifactError(null)
                  }}
                >
                  新建
                </Button>
              </div>
            </section>
          ) : null}
        </aside>

        <section className="single-stream-panel" aria-label="模型识别过程">
          <div className="single-workbench-head">
            <div>
              <h2>模型识别与证据</h2>
            </div>
            <div className="single-head-metrics">
              <span>{orderedStreams.length || 0} 个模型</span>
              <span>{orderedStreams.reduce((sum, stream) => sum + stream.hits.length, 0)} 条证据</span>
            </div>
          </div>
          {orderedStreams.length === 0 ? (
            <div className={`single-empty ${streamError ? "error" : ""}`}>
              <span className="single-empty-icon" aria-hidden="true">
                <ScanSearch size={18} />
              </span>
              <strong>{streamError ? "识图失败" : streaming ? "正在连接模型..." : "等待图片"}</strong>
              <p>
                {streamError
                  ? streamError
                  : streaming
                    ? "上传完成后正在建立实时识别连接。"
                    : "左侧添加图片后，这里显示每个模型的分析、检索和裁决。"}
              </p>
              {streamError && uploadedImage ? (
                <Button htmlType="button" size="small" onClick={() => void analyzeImageStream(uploadedImage)}>
                  重试
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="single-stream-list">
              {orderedStreams.map((stream) => {
                const candidate = stream.candidate
                const isBusy = !["done", "result", "error"].includes(stream.stage)
                return (
                  <article key={stream.provider} className={`single-stream-card ${selectedCandidateKey === stream.provider ? "selected" : ""}`}>
                    <div className="single-stream-row">
                      <div className="provider-id">
                        <span className={`pulse ${isBusy ? "busy" : stream.stage === "error" ? "failed" : "ok"}`} />
                        <div>
                          <strong>{stream.provider}</strong>
                          {stream.model ? <span className="muted">{stream.model}</span> : null}
                        </div>
                      </div>
                      <div className="stream-tags">
                        <span className={`stage-status ${stream.stage}`}>{STAGE_LABEL[stream.stage]}</span>
                        {stream.provider === bestCandidateKey && candidate ? <span className="badge best">推荐</span> : null}
                        {candidate ? <span className="badge conf">{formatConfidence(candidate.confidence) ?? "—"}</span> : null}
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
                    {stream.error ? <p className="error-text">{stream.error}</p> : null}
                    {candidate ? (
                      <div className="single-result-grid">
                        <div>
                          <strong>{candidate.artifact_name}</strong>
                          <p className="result-desc">{candidate.description || "暂无描述"}</p>
                        </div>
                        <Button htmlType="button" size="small" onClick={() => handleApplyCandidate(candidate)}>
                          <Check size={13} aria-hidden="true" />
                          采用
                        </Button>
                      </div>
                    ) : null}
                    {stream.analysis ? (
                      <details className="single-details" open={!candidate}>
                        <summary>分析过程</summary>
                        <p className="reasoning-text">{stream.analysis}</p>
                      </details>
                    ) : null}
                    {stream.hits.length > 0 ? (
                      <details className="single-details">
                        <summary>检索证据（{stream.hits.length}）</summary>
                        <div className="evidence-list">
                          {stream.hits.map((hit) => (
                            <a key={`${stream.provider}-${hit.url}`} className="evidence-card" href={hit.url} target="_blank" rel="noreferrer">
                              <strong>{hit.title}</strong>
                              {hit.source ? <span className="evidence-source">{hit.source}</span> : null}
                              <p>{hit.snippet || hit.url}</p>
                            </a>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <form className="single-archive" onSubmit={handleCreateArtifact} aria-label="归档表单">
          <div className="single-workbench-head">
            <div>
              <h2>归档信息</h2>
            </div>
            <span className={`single-status ${archiveReady ? "ok" : ""}`}>{singleStatusLabel}</span>
          </div>
          <div className="single-readiness">
            <span className={uploadedImage ? "done" : ""}>图片</span>
            <span className={uploadedImage && artifactForm.museumName.trim() ? "done" : ""}>馆藏</span>
            <span className={uploadedImage && artifactForm.museumName.trim() && artifactForm.name.trim() ? "done" : ""}>名称</span>
            <span className={uploadedImage && artifactForm.museumName.trim() && artifactForm.name.trim() && artifactForm.captureMuseumName.trim() && !artifactForm.captureMuseumName.trim().startsWith("@") ? "done" : ""}>拍摄馆</span>
            <span className={archiveReady ? "done" : ""}>展览</span>
          </div>
          {primaryCandidate ? (
            <div className="single-current-candidate">
              <span>当前候选</span>
              <strong>{primaryCandidate.artifact_name}</strong>
              <em>{primaryCandidate.era || "时代待确认"} · {primaryCandidate.museum_name || "馆藏待确认"}</em>
            </div>
          ) : null}

          <div className="single-archive-scroll">
            <section className="form-section">
              <div className="form-section-head">
                <h3>文物</h3>
              </div>
              <div className="form-section-body">
                <label className="field">
                  <span>馆藏单位</span>
                  <AutoComplete
                    value={artifactForm.museumName}
                    options={artifactMuseumSuggestions.map((museum) => ({
                      key: museum.id,
                      value: museum.name,
                      label: museum.name,
                    }))}
                    filterOption={false}
                    open={showArtifactMuseumSuggestions && artifactMuseumSuggestions.length > 0}
                    onFocus={() => setShowArtifactMuseumSuggestions(true)}
                    onOpenChange={setShowArtifactMuseumSuggestions}
                    onChange={(value) => {
                      setArtifactForm((current) => ({ ...current, museumName: value }))
                      setShowArtifactMuseumSuggestions(true)
                    }}
                    onSelect={(value) => {
                      setArtifactForm((current) => ({ ...current, museumName: value }))
                      setArtifactMuseumSuggestions([])
                      setShowArtifactMuseumSuggestions(false)
                    }}
                    placeholder="例如：南京博物院"
                  />
                </label>
                <label className="field">
                  <span>文物名称</span>
                  <Input
                    required
                    value={artifactForm.name}
                    onChange={(event) => setArtifactForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="例如：如意云纹金盘"
                  />
                </label>
                <label className="field">
                  <span>时代</span>
                  <AutoComplete
                    value={artifactForm.era}
                    options={eraSuggestions.map((era) => ({
                      key: era.id,
                      value: era.name,
                      label: era.name,
                    }))}
                    filterOption={false}
                    open={showEraSuggestions && eraSuggestions.length > 0}
                    onFocus={() => setShowEraSuggestions(true)}
                    onOpenChange={setShowEraSuggestions}
                    onChange={(value) => {
                      setArtifactForm((current) => ({ ...current, era: value }))
                      setShowEraSuggestions(true)
                    }}
                    onSelect={(value) => {
                      setArtifactForm((current) => ({ ...current, era: value }))
                      setEraSuggestions([])
                      setShowEraSuggestions(false)
                    }}
                    placeholder="例如：元代"
                  />
                </label>
              </div>
            </section>

            <section className="form-section">
              <div className="form-section-head">
                <h3>拍摄地点</h3>
              </div>
              <div className="form-section-body">
                <label className="field">
                  <span>拍摄时博物馆</span>
                  <AutoComplete
                    value={artifactForm.captureMuseumName}
                    options={museumSuggestions.map((museum) => ({
                      key: museum.id,
                      value: museum.name,
                      label: museum.name,
                    }))}
                    filterOption={false}
                    onChange={(value) => {
                      setArtifactForm((current) => ({ ...current, captureMuseumName: value }))
                      if (selectedCaptureMuseum?.name !== value) setSelectedCaptureMuseum(null)
                    }}
                    onSelect={(value) => {
                      const museum = museumSuggestions.find((option) => option.name === value)
                      if (!museum) return
                      setSelectedCaptureMuseum(museum)
                      setMuseumSuggestions([])
                      setArtifactForm((current) => ({
                        ...current,
                        captureMuseumName: museum.name,
                        exhibitionName: current.exhibitionName.trim().startsWith("@") || !current.exhibitionName.trim()
                          ? "常设"
                          : current.exhibitionName,
                      }))
                    }}
                    placeholder="输入 @ 后联想检索，例如：@南博"
                  />
                </label>
                <label className="field">
                  <span>展览</span>
                  <AutoComplete
                    value={artifactForm.exhibitionName}
                    options={exhibitionSuggestions.map((exhibition) => ({
                      key: exhibition.id,
                      value: exhibition.name,
                      label: (
                        <span className="autocomplete-option">
                          <span>{exhibition.name}</span>
                          {exhibition.start_at || exhibition.end_at ? (
                            <span className="autocomplete-option-meta">
                              {exhibition.start_at?.slice(0, 10) ?? "未知"} - {exhibition.end_at?.slice(0, 10) ?? "至今"}
                            </span>
                          ) : null}
                        </span>
                      ),
                    }))}
                    filterOption={false}
                    onChange={(value) => setArtifactForm((current) => ({ ...current, exhibitionName: value }))}
                    onSelect={(value) => {
                      setExhibitionSuggestions([])
                      setArtifactForm((current) => ({ ...current, exhibitionName: value }))
                    }}
                    placeholder={selectedCaptureMuseum ? "默认常设，输入 @ 检索该馆展览" : "默认常设，可直接填写"}
                  />
                </label>
                <div className="field-row">
                  <label className="field">
                    <span>纬度</span>
                    <Input value={artifactForm.latitude} onChange={(event) => setArtifactForm((current) => ({ ...current, latitude: event.target.value }))} />
                  </label>
                  <label className="field">
                    <span>经度</span>
                    <Input value={artifactForm.longitude} onChange={(event) => setArtifactForm((current) => ({ ...current, longitude: event.target.value }))} />
                  </label>
                </div>
              </div>
            </section>

            <section className="form-section">
              <div className="form-section-head">
                <h3>描述与标签</h3>
              </div>
              <div className="form-section-body">
                <label className="field">
                  <span>描述</span>
                  <TextArea
                    rows={5}
                    value={artifactForm.description}
                    onChange={(event) => setArtifactForm((current) => ({ ...current, description: event.target.value }))}
                    placeholder="文物简介，可选"
                  />
                </label>
                <label className="field">
                  <span>标签</span>
                  <div className="tag-editor">
                    <div className="tag-editor-chips">
                      {artifactForm.tags.length > 0 ? artifactForm.tags.map((tag) => (
                        <Tag key={tag} closable onClose={() => removeTag(tag)}>
                          {tag}
                        </Tag>
                      )) : <span className="tag-editor-placeholder">暂无标签</span>}
                    </div>
                    <Input
                      className="tag-editor-input"
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
            </section>

            <details className="single-advanced">
              <summary>
                <span><Camera size={14} aria-hidden="true" />相机参数</span>
                <span className="single-advanced-affordance">可选<ChevronRight size={14} aria-hidden="true" /></span>
              </summary>
              <div className="single-advanced-grid">
                <label className="field"><span>机型</span><Input value={artifactForm.cameraModel} onChange={(event) => setArtifactForm((current) => ({ ...current, cameraModel: event.target.value }))} /></label>
                <label className="field"><span>镜头</span><Input value={artifactForm.lensModel} onChange={(event) => setArtifactForm((current) => ({ ...current, lensModel: event.target.value }))} /></label>
                <label className="field"><span>拍摄时间</span><Input value={artifactForm.capturedAt} onChange={(event) => setArtifactForm((current) => ({ ...current, capturedAt: event.target.value }))} /></label>
                <label className="field"><span>上传时间</span><Input value={artifactForm.uploadedAt} readOnly /></label>
                <label className="field"><span>快门</span><Input value={artifactForm.shutterSpeed} onChange={(event) => setArtifactForm((current) => ({ ...current, shutterSpeed: event.target.value }))} /></label>
                <label className="field"><span>光圈</span><Input value={artifactForm.aperture} onChange={(event) => setArtifactForm((current) => ({ ...current, aperture: event.target.value }))} /></label>
                <label className="field"><span>感光度</span><Input value={artifactForm.iso} onChange={(event) => setArtifactForm((current) => ({ ...current, iso: event.target.value }))} /></label>
                <label className="field">
                  <span>修图方式</span>
                  <Select
                    allowClear
                    placeholder="未填写"
                    value={artifactForm.editMethod || undefined}
                    options={[
                      { value: "简单调整", label: "简单调整" },
                      { value: "堆栈合成", label: "堆栈合成" },
                    ]}
                    onChange={(value) => setArtifactForm((current) => ({ ...current, editMethod: value ?? "" }))}
                  />
                </label>
              </div>
            </details>
          </div>

          <div className="single-submit-bar">
            <div>
              {submitNotice ? (
                <p className={submitNotice.type === "error" ? "error-text" : "success-text"}>{submitNotice.text}</p>
              ) : artifactMessage ? (
                <p className="success-text">{artifactMessage}</p>
              ) : (
                <p className="muted">已完成 {readyCount}/{requiredFields.length} 项必填信息</p>
              )}
            </div>
            <Button htmlType="submit" disabled={artifactSubmitting || !uploadedImage}>
              <CloudUpload size={14} aria-hidden="true" />
              {artifactSubmitting
                ? "提交中..."
                : matchedArtifact && sameArtifactDecision !== "no"
                  ? "更新并上传"
                  : "提交云端"}
            </Button>
          </div>
        </form>
      </section>
      {submitNotice ? (
        <div className={`submit-toast ${submitNotice.type}`}>
          <div className="submit-toast-body">
            <strong>{submitNotice.type === "error" ? "提交失败" : "提交成功"}</strong>
            <p>{submitNotice.text}</p>
          </div>
          <Button htmlType="button" type="text" shape="circle" aria-label="关闭提交提示" onClick={() => setSubmitNotice(null)}>
            ×
          </Button>
        </div>
      ) : null}
      {showWebBridgeLoginModal
        ? createPortal(
            <div className="gallery-modal" onClick={() => setShowWebBridgeLoginModal(false)}>
              <div className="gallery-modal-body bridge-login-modal" onClick={(event) => event.stopPropagation()}>
                <div className="gallery-detail-head">
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
                <div className="gallery-form-footer bridge-login-actions">
                  <Button
                    htmlType="button"
                    disabled={launchingWebBridgeLogin}
                    onClick={() => void ensureWebBridgeLoginReady(true)}
                  >
                    {launchingWebBridgeLogin ? "正在尝试启动..." : "重新尝试打开登录窗口"}
                  </Button>
                  {webBridgeStatus?.login_command ? (
                    <Button htmlType="button" type="default" onClick={() => void copyWebBridgeLoginCommand()}>
                      复制登录命令
                    </Button>
                  ) : null}
                  <Button
                    htmlType="button"
                    type="default"
                    onClick={() => {
                      void loadWebBridgeStatus()
                      setShowWebBridgeLoginModal(false)
                    }}
                  >
                    我已登录，稍后重试
                  </Button>
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
