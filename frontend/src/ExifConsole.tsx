import { useEffect, useMemo, useRef, useState } from "react"
import AMapLoader from "@amap/amap-jsapi-loader"

type ParsedArtifactName = {
  original_name: string
  normalized_name: string
  era: string | null
  artifact_name: string | null
  museum_name: string | null
  Place_of_Excavation: string | null
  catalog_no: string | null
}

type DescriptionCandidate = {
  provider: string
  model: string
  description: string
  tags: string[]
  reasoning: string | null
  status: string
  error: string | null
}

type GeneratedDescription = {
  provider: string
  model: string
  description: string
  tags: string[]
  reasoning: string | null
  candidates: DescriptionCandidate[]
  unavailable_providers: string[]
}

type MuseumOption = {
  id: number
  name: string
  latitude: number | null
  longitude: number | null
}

type SubmitNotice = {
  type: "success" | "error"
  text: string
}

type ExifConsoleProps = {
  apiBaseUrl: string
}

type FormState = {
  museumName: string
  name: string
  era: string
  placeOfExcavation: string
  displayLocationName: string
  exhibitionName: string
  latitude: string
  longitude: string
  description: string
  tags: string[]
}

type ExifWorkbenchItem = {
  id: string
  fileName: string
  previewUrl: string
  localFile: File
  fileHandle: WritableFileHandle | null
  parsedName: ParsedArtifactName | null
  form: FormState
  candidates: DescriptionCandidate[]
  unavailableProviders: string[]
  descriptionMeta: string | null
  submitState: "idle" | "submitting" | "submitted" | "error"
  submitMessage: string | null
}

type WritableFileStream = { write(data: Blob): Promise<void>; close(): Promise<void> }
type WritableFileHandle = {
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<WritableFileStream>
}
type FilePickerWindow = Window & {
  showOpenFilePicker?: (options: {
    multiple: boolean
    types: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<WritableFileHandle[]>
}

const EMPTY_FORM: FormState = {
  museumName: "",
  name: "",
  era: "",
  placeOfExcavation: "",
  displayLocationName: "",
  exhibitionName: "常设",
  latitude: "",
  longitude: "",
  description: "",
  tags: [],
}

const EXIF_FILE_INPUT_ID = "exif-workbench-file-input"

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const payload = (await response.json()) as { detail?: string }
      if (payload.detail) {
        message = payload.detail
      }
    } catch {
      // ignore non-json errors
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

async function loadMuseumSuggestions(
  apiBaseUrl: string,
  keyword: string,
  setter: (items: MuseumOption[]) => void,
) {
  try {
    const params = new URLSearchParams({ limit: "8" })
    if (keyword) {
      params.set("q", keyword)
    }
    const items = await fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?${params.toString()}`)
    setter(items)
  } catch {
    setter([])
  }
}

async function resolveMuseum(apiBaseUrl: string, name: string): Promise<MuseumOption | null> {
  const items = await fetchJson<MuseumOption[]>(
    `${apiBaseUrl}/api/museums?${new URLSearchParams({ q: name, limit: "8" }).toString()}`,
  )
  const exact = items.find((item) => item.name === name)
  return exact ?? items[0] ?? null
}

function buildBaseForm(): FormState {
  return {
    ...EMPTY_FORM,
  }
}

function cloneFormState(form: FormState): FormState {
  return {
    ...form,
    tags: [...form.tags],
  }
}

function hasMeaningfulFormValue(form: FormState) {
  return Boolean(
    form.museumName.trim() ||
      form.name.trim() ||
      form.era.trim() ||
      form.placeOfExcavation.trim() ||
      form.displayLocationName.trim() ||
      form.exhibitionName.trim() ||
      form.latitude.trim() ||
      form.longitude.trim() ||
      form.description.trim() ||
      form.tags.length > 0,
  )
}

function applySharedForm(current: FormState, shared: FormState): FormState {
  return {
    ...current,
    museumName: shared.museumName,
    name: shared.name,
    era: shared.era,
    placeOfExcavation: shared.placeOfExcavation,
    displayLocationName: shared.displayLocationName,
    exhibitionName: shared.exhibitionName,
    latitude: shared.latitude,
    longitude: shared.longitude,
    description: shared.description,
    tags: [...shared.tags],
  }
}

function buildItemId(file: File, index: number) {
  return `${file.name}-${file.lastModified}-${index}`
}

function uniqueTags(tags: string[]) {
  return Array.from(new Set(tags.map((item) => item.trim()).filter(Boolean)))
}

function ensureCandidates(value: DescriptionCandidate[] | undefined | null): DescriptionCandidate[] {
  return Array.isArray(value) ? value : []
}

function ensureStringList(value: string[] | undefined | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function toNullableNumber(value: string) {
  const text = value.trim()
  if (!text) {
    return null
  }
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

function fileExtension(name: string) {
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index) : ""
}

function fileBaseName(name: string) {
  const extension = fileExtension(name)
  return extension ? name.slice(0, -extension.length) : name
}

function normalizedFileName(baseName: string, referenceName: string) {
  const normalized = baseName.trim().replace(/[\\/:*?"<>|]/g, "")
  return normalized ? `${normalized}${fileExtension(referenceName)}` : referenceName
}

type AMapEvent = { lnglat?: { getLng: () => number; getLat: () => number } }
type AMapInstance = {
  on: (event: string, handler: (event: AMapEvent) => void) => void
  clearMap: () => void
  setZoomAndCenter: (zoom: number, center: [number, number]) => void
  add: (marker: unknown) => void
}
type AMapSdk = {
  Map: new (element: HTMLDivElement, options: Record<string, unknown>) => AMapInstance
  Marker: new (options: Record<string, unknown>) => { on: (event: string, handler: (event: AMapEvent) => void) => void }
  Geocoder: new (options: Record<string, unknown>) => {
    getAddress: (position: [number, number], callback: (status: string, result: { regeocode?: { formattedAddress?: string } }) => void) => void
  }
}

declare global {
  interface Window {
    AMap?: AMapSdk
    _AMapSecurityConfig?: Record<string, string>
  }
}

const AMAP_SECURITY_CODE = import.meta.env.VITE_AMAP_SECURITY_CODE as string | undefined
const AMAP_SCRIPT_SRC = import.meta.env.VITE_AMAP_SCRIPT_SRC as string | undefined

function loadAmap(): Promise<AMapSdk> {
  if (window.AMap) return Promise.resolve(window.AMap)
  if (!AMAP_SCRIPT_SRC) return Promise.reject(new Error("未配置高德地图脚本"))
  const key = new URL(AMAP_SCRIPT_SRC).searchParams.get("key")
  if (!key) return Promise.reject(new Error("高德地图 Key 不完整"))
  if (AMAP_SECURITY_CODE) window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE }
  return AMapLoader.load({
    key,
    version: "2.0",
    plugins: ["AMap.Geocoder", "AMap.PlaceSearch"],
  }) as Promise<AMapSdk>
}

function GpsMapPicker({ latitude, longitude, onPick }: {
  latitude: string
  longitude: string
  onPick: (latitude: string, longitude: string, locationName?: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<AMapInstance | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading")

  async function applyPoint(event: AMapEvent) {
    if (!event.lnglat) return
    const nextLatitude = event.lnglat.getLat().toFixed(6)
    const nextLongitude = event.lnglat.getLng().toFixed(6)
    let locationName = ""
    try {
      const AMap = await loadAmap()
      locationName = await new Promise<string>((resolve) => {
        new AMap.Geocoder({}).getAddress([Number(nextLongitude), Number(nextLatitude)], (status, result) => {
          resolve(status === "complete" ? result.regeocode?.formattedAddress?.trim() ?? "" : "")
        })
      })
    } catch {
      // Coordinates remain usable even if reverse geocoding is unavailable.
    }
    onPick(nextLatitude, nextLongitude, locationName || undefined)
  }

  useEffect(() => {
    if (!containerRef.current || !AMAP_SCRIPT_SRC) { setState("missing"); return }
    let disposed = false
    const mount = async () => {
      try {
      const AMap = await loadAmap()
      if (disposed || !containerRef.current) return
      const latitudeValue = Number(latitude) || 39.90923
      const longitudeValue = Number(longitude) || 116.397428
      const map = new AMap.Map(containerRef.current, { zoom: 15, center: [longitudeValue, latitudeValue] })
      map.on("click", (event) => {
        void applyPoint(event)
      })
      if (Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
        const marker = new AMap.Marker({ position: [longitudeValue, latitudeValue], draggable: true })
        marker.on("dragend", (event) => { void applyPoint(event) })
        map.add(marker)
      }
      mapRef.current = map
      setState("ready")
      } catch {
        if (!disposed) setState("error")
      }
    }
    void mount()
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    const latitudeValue = Number(latitude)
    const longitudeValue = Number(longitude)
    const map = mapRef.current
    if (!map || !window.AMap || !Number.isFinite(latitudeValue) || !Number.isFinite(longitudeValue)) return
    map.clearMap()
    map.setZoomAndCenter(15, [longitudeValue, latitudeValue])
    const marker = new window.AMap.Marker({ position: [longitudeValue, latitudeValue], draggable: true })
    marker.on("dragend", (event) => {
      void applyPoint(event)
    })
    map.add(marker)
  }, [latitude, longitude, onPick])

  if (state === "missing") return <p className="muted gps-map-hint">高德地图配置未载入，请检查前端重启后是否读取项目 .env。</p>
  if (state === "error") return <p className="error-text">地图加载失败，请直接填写坐标。</p>
  return <div className="gps-map-wrap"><div ref={containerRef} className="gps-map" />{state === "loading" ? <span>正在加载地图…</span> : null}</div>
}

function ExifConsole({ apiBaseUrl }: ExifConsoleProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [items, setItems] = useState<ExifWorkbenchItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState("")
  const [sharedForm, setSharedForm] = useState<FormState>(buildBaseForm())
  const [museumSuggestions, setMuseumSuggestions] = useState<MuseumOption[]>([])
  const [locationSuggestions, setLocationSuggestions] = useState<MuseumOption[]>([])
  const [showMuseumSuggestions, setShowMuseumSuggestions] = useState(false)
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [descriptionProgress, setDescriptionProgress] = useState<string[]>([])
  const [batchPrefix, setBatchPrefix] = useState("")
  const [batchSuffix, setBatchSuffix] = useState("")
  const [submittingAll, setSubmittingAll] = useState(false)
  const [submitNotice, setSubmitNotice] = useState<SubmitNotice | null>(null)

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  )

  const stats = useMemo(() => {
    const describedCount = items.filter((item) =>
      ensureCandidates(item.candidates).some((candidate) => candidate.status === "success"),
    ).length
    const submittedCount = items.filter((item) => item.submitState === "submitted").length
    const gpsCount = items.filter((item) => item.form.latitude.trim() && item.form.longitude.trim()).length
    return {
      itemCount: items.length,
      describedCount,
      submittedCount,
      gpsCount,
    }
  }, [items])

  useEffect(() => {
    return () => {
      items.forEach((item) => URL.revokeObjectURL(item.previewUrl))
    }
  }, [items])

  useEffect(() => {
    if (!selectedItem || !showMuseumSuggestions) {
      return
    }
    const timer = window.setTimeout(() => {
      void loadMuseumSuggestions(apiBaseUrl, selectedItem.form.museumName.trim(), setMuseumSuggestions)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [apiBaseUrl, selectedItem, showMuseumSuggestions])

  useEffect(() => {
    if (!selectedItem || !showLocationSuggestions) {
      return
    }
    const timer = window.setTimeout(() => {
      void loadMuseumSuggestions(apiBaseUrl, selectedItem.form.displayLocationName.trim(), setLocationSuggestions)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [apiBaseUrl, selectedItem, showLocationSuggestions])

  function updateItem(itemId: string, updater: (item: ExifWorkbenchItem) => ExifWorkbenchItem) {
    setItems((current) => current.map((item) => (item.id === itemId ? updater(item) : item)))
  }

  function updateSelectedForm(patch: Partial<FormState>) {
    if (!selectedItem) {
      return
    }
    updateItem(selectedItem.id, (item) => ({
      ...item,
      form: { ...item.form, ...patch },
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    }))
  }

  function renameSelected(baseName: string) {
    if (!selectedItem) return
    updateItem(selectedItem.id, (item) => ({ ...item, fileName: normalizedFileName(baseName, item.fileName) }))
  }

  function applyBatchRename() {
    if (!batchPrefix && !batchSuffix) return
    setItems((current) => current.map((item) => ({
      ...item,
      fileName: normalizedFileName(`${batchPrefix}${fileBaseName(item.fileName)}${batchSuffix}`, item.fileName),
    })))
    setSubmitNotice({ type: "success", text: `已按规则更新 ${items.length} 个目标文件名，入库时将使用新名称` })
  }

  function updateSharedForm(patch: Partial<FormState>) {
    setSharedForm((current) => ({ ...current, ...patch }))
  }

  function fillSharedFromSelected() {
    if (!selectedItem) {
      return
    }
    setSharedForm(cloneFormState(selectedItem.form))
    setSubmitNotice({ type: "success", text: "已用当前图片内容刷新共享文物信息" })
  }

  function applySharedToAll() {
    if (items.length === 0) {
      return
    }
    const nextShared = cloneFormState(sharedForm)
    setItems((current) => current.map((item) => ({
      ...item,
      form: applySharedForm(item.form, nextShared),
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    })))
    setSubmitNotice({ type: "success", text: `已将共享字段应用到 ${items.length} 张图片` })
  }

  async function createWorkbenchItem(
    file: File,
    index: number,
    fileHandle: WritableFileHandle | null = null,
  ): Promise<ExifWorkbenchItem> {
    let parsedName: ParsedArtifactName | null = null
    let form = buildBaseForm()

    try {
      parsedName = await fetchJson<ParsedArtifactName>(
        `${apiBaseUrl}/api/artifacts/parse-name?${new URLSearchParams({ name: file.name }).toString()}`,
      )
      form = {
        ...form,
        museumName: parsedName.museum_name ?? form.museumName,
        name: parsedName.artifact_name ?? form.name,
        era: parsedName.era ?? form.era,
        placeOfExcavation: parsedName.Place_of_Excavation ?? form.placeOfExcavation,
        displayLocationName: parsedName.museum_name ?? form.displayLocationName,
      }

      if (parsedName.museum_name) {
        const museum = await resolveMuseum(apiBaseUrl, parsedName.museum_name)
        if (museum) {
          form = {
            ...form,
            museumName: form.museumName || museum.name,
            displayLocationName: form.displayLocationName || museum.name,
            latitude: form.latitude || museum.latitude?.toString() || "",
            longitude: form.longitude || museum.longitude?.toString() || "",
          }
        }
      }
    } catch {
      // keep default form
    }

    return {
      id: buildItemId(file, index),
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      localFile: file,
      fileHandle,
      parsedName,
      form,
      candidates: [],
      unavailableProviders: [],
      descriptionMeta: null,
      submitState: "idle",
      submitMessage: null,
    }
  }

  async function handleOpenWritableFiles() {
    const picker = (window as FilePickerWindow).showOpenFilePicker
    if (!picker) {
      fileInputRef.current?.click()
      setSubmitNotice({ type: "error", text: "当前浏览器不支持原地写入；可继续云端入库，原地覆盖请使用最新版 Chrome。" })
      return
    }
    try {
      const handles = await picker({
        multiple: true,
        types: [{ description: "文物图片", accept: { "image/*": [".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"] } }],
      })
      setUploading(true)
      const builtItems = await Promise.all(handles.map(async (handle, index) =>
        createWorkbenchItem(await handle.getFile(), index, handle)))
      setItems((current) => [...current, ...builtItems])
      setSelectedId((current) => current ?? builtItems[0]?.id ?? null)
      setSubmitNotice({ type: "success", text: `已载入 ${builtItems.length} 张图片，并获得原地回写授权` })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setSubmitNotice({ type: "error", text: error instanceof Error ? error.message : "读取本地图片失败" })
    } finally {
      setUploading(false)
    }
  }

  async function handleUpload(nextFiles: File[]) {
    if (nextFiles.length === 0) {
      setSubmitNotice({ type: "error", text: "请先选择至少一张图片" })
      return
    }

    setUploading(true)
    setSubmitNotice(null)
    try {
      const builtItems = await Promise.all(
        nextFiles.map((file, index) => createWorkbenchItem(file, index)),
      )
      setItems((current) => [...current, ...builtItems])
      setSelectedId((current) => current ?? builtItems[0]?.id ?? null)
      setSharedForm((current) => {
        if (hasMeaningfulFormValue(current)) {
          return current
        }
        const seedForm = builtItems.find((item) => hasMeaningfulFormValue(item.form))?.form
        return seedForm ? cloneFormState(seedForm) : current
      })
      setSubmitNotice({ type: "success", text: `已载入 ${builtItems.length} 张图片到当前页面，尚未上传 OSS` })
    } catch (error) {
      setSubmitNotice({
        type: "error",
        text: error instanceof Error ? error.message : "载入图片失败",
      })
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  async function removeItem(itemId: string) {
    const target = items.find((item) => item.id === itemId)
    if (!target) {
      return
    }
    URL.revokeObjectURL(target.previewUrl)
    const remaining = items.filter((item) => item.id !== itemId)
    setItems(remaining)
    setSelectedId((current) => (current === itemId ? remaining[0]?.id ?? null : current))
  }

  async function clearAll() {
    const currentItems = [...items]
    currentItems.forEach((item) => URL.revokeObjectURL(item.previewUrl))
    setItems([])
    setSelectedId(null)
    setTagInput("")
    setSharedForm(buildBaseForm())
    setSubmitNotice(null)
  }

  async function handleGenerateDescription() {
    if (!selectedItem) {
      return
    }
    const fallbackName = selectedItem.parsedName?.artifact_name || fileBaseName(selectedItem.fileName)
    const targetForm = items.length > 1 ? sharedForm : selectedItem.form
    const resolvedForm = targetForm.name.trim() ? targetForm : { ...targetForm, name: fallbackName }
    if (!resolvedForm.name.trim()) return
    if (!targetForm.name.trim()) {
      if (items.length > 1) setSharedForm((current) => ({ ...current, name: resolvedForm.name }))
      else updateSelectedForm({ name: resolvedForm.name })
    }

    setGenerating(true)
    setDescriptionProgress(["准备研究线索…"])
    setSubmitNotice(null)
    try {
      const descriptionForm = new FormData()
      descriptionForm.append("file", selectedItem.localFile)
      descriptionForm.append("museum_name", resolvedForm.museumName.trim())
      descriptionForm.append("name", resolvedForm.name.trim())
      descriptionForm.append("era", resolvedForm.era.trim())
      descriptionForm.append("Place_of_Excavation", resolvedForm.placeOfExcavation.trim())
      const response = await fetch(`${apiBaseUrl}/api/artifacts/generate-description-stream-file`, {
        method: "POST",
        body: descriptionForm,
      })
      if (!response.ok || !response.body) throw new Error(`生成描述失败（HTTP ${response.status}）`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ""
      let generated: GeneratedDescription | null = null
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const event = JSON.parse(line.slice(5).trim()) as { type: string; message?: string; result?: GeneratedDescription }
          if (event.type === "progress" && event.message) {
            const message = event.message
            setDescriptionProgress((current) => current[current.length - 1] === message ? current : [...current, message].slice(-4))
          }
          if (event.type === "result" && event.result) generated = event.result
        }
      }
      if (!generated) throw new Error("模型未返回可用结果")

      const nextSharedForm: FormState = {
        ...cloneFormState(resolvedForm),
        description: generated.description,
        tags: uniqueTags([...resolvedForm.tags, ...ensureStringList(generated.tags)]),
      }
      const nextCandidates = ensureCandidates(generated.candidates)
      const nextUnavailableProviders = ensureStringList(generated.unavailable_providers)
      const nextMeta = items.length > 1
        ? `共享描述采用：${generated.provider} / ${generated.model}`
        : `默认采用：${generated.provider} / ${generated.model}`

      if (items.length > 1) {
        setSharedForm(nextSharedForm)
        setItems((current) => current.map((item) => ({
          ...item,
          form: applySharedForm(item.form, nextSharedForm),
          candidates: nextCandidates,
          unavailableProviders: nextUnavailableProviders,
          descriptionMeta: nextMeta,
          submitState: item.submitState === "submitted" ? "idle" : item.submitState,
          submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
        })))
        setSubmitNotice({
          type: "success",
          text: `已按同一文物多图模式并行请求千问和豆包，并把共享描述应用到 ${items.length} 张图片`,
        })
      } else {
        updateItem(selectedItem.id, (item) => ({
          ...item,
          form: {
            ...item.form,
            description: generated.description,
            tags: uniqueTags([...item.form.tags, ...ensureStringList(generated.tags)]),
          },
          candidates: nextCandidates,
          unavailableProviders: nextUnavailableProviders,
          descriptionMeta: nextMeta,
        }))
        setSubmitNotice({ type: "success", text: "已基于文件名解析字段并行请求千问和豆包，并回填默认描述" })
      }
    } catch (error) {
      setSubmitNotice({
        type: "error",
        text: error instanceof Error ? error.message : "生成描述失败",
      })
    } finally {
      setGenerating(false)
    }
  }

  function applyCandidate(candidate: DescriptionCandidate) {
    if (!selectedItem || candidate.status !== "success") {
      return
    }
    updateItem(selectedItem.id, (item) => ({
      ...item,
      form: {
        ...item.form,
        description: candidate.description,
        tags: uniqueTags([...item.form.tags, ...candidate.tags]),
      },
      descriptionMeta: `当前采用：${candidate.provider} / ${candidate.model}`,
    }))
    setSubmitNotice({ type: "success", text: `已采用 ${candidate.provider} 的运行结果` })
  }

  async function submitOne(itemId: string) {
    const target = items.find((item) => item.id === itemId)
    if (!target) {
      return
    }
    if (!target.form.name.trim() || !target.form.museumName.trim()) {
      updateItem(itemId, (item) => ({
        ...item,
        submitState: "error",
        submitMessage: "请先确认名称和馆藏信息",
      }))
      return
    }

    updateItem(itemId, (item) => ({ ...item, submitState: "submitting", submitMessage: null }))
    try {
      const latitude = toNullableNumber(target.form.latitude)
      const longitude = toNullableNumber(target.form.longitude)
      const appendMetadata = (data: FormData) => {
        data.append("museum_name", target.form.museumName.trim())
        data.append("name", target.form.name.trim())
        data.append("era", target.form.era.trim() || "")
        data.append("Place_of_Excavation", target.form.placeOfExcavation.trim() || "")
        data.append("description", target.form.description.trim() || "")
        data.append("display_location_name", target.form.displayLocationName.trim() || "")
        data.append("exhibition_name", target.form.exhibitionName.trim() || "常设")
        if (latitude !== null) data.append("latitude", String(latitude))
        if (longitude !== null) data.append("longitude", String(longitude))
      }

      let uploadFile = new File([target.localFile], target.fileName, {
        type: target.localFile.type,
        lastModified: target.localFile.lastModified,
      })
      if (target.fileHandle) {
        const exifForm = new FormData()
        exifForm.append("file", target.localFile)
        appendMetadata(exifForm)
        const response = await fetch(`${apiBaseUrl}/api/artifacts/prepare-exif-file`, {
          method: "POST",
          body: exifForm,
        })
        if (!response.ok) throw new Error(`本地 EXIF 回写准备失败（HTTP ${response.status}）`)
        const editedBlob = await response.blob()
        const writable = await target.fileHandle.createWritable()
        await writable.write(editedBlob)
        await writable.close()
        uploadFile = new File([editedBlob], target.fileName, {
          type: editedBlob.type || target.localFile.type,
          lastModified: Date.now(),
        })
      }

      const formData = new FormData()
      formData.append("file", uploadFile)
      appendMetadata(formData)
      formData.append("tags", JSON.stringify(target.form.tags))
      await fetchJson(`${apiBaseUrl}/api/artifacts/exif-submit-file`, {
        method: "POST",
        body: formData,
      })
      updateItem(itemId, (item) => ({
        ...item,
        localFile: uploadFile,
        submitState: "submitted",
        submitMessage: target.fileHandle
          ? "已覆盖本地原图，并同步上传 OSS 与云端数据库"
          : "已写入云端图片 EXIF 并完成入库；本地原图未覆盖",
      }))
    } catch (error) {
      updateItem(itemId, (item) => ({
        ...item,
        submitState: "error",
        submitMessage: error instanceof Error ? error.message : "提交失败",
      }))
    }
  }

  async function handleSubmitAll() {
    if (items.length === 0) {
      return
    }
    setSubmittingAll(true)
    setSubmitNotice(null)
    for (const item of items) {
      await submitOne(item.id)
    }
    setSubmittingAll(false)
    setSubmitNotice({ type: "success", text: "已完成批量提交，请检查每张图片状态" })
  }

  function addTags(rawValue: string) {
    if (!selectedItem) {
      return
    }
    const nextTags = rawValue
      .split(/[,\n，、；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (nextTags.length === 0) {
      return
    }
    updateItem(selectedItem.id, (item) => ({
      ...item,
      form: { ...item.form, tags: uniqueTags([...item.form.tags, ...nextTags]) },
    }))
    setTagInput("")
  }

  return (
    <section className="exif-console">
      <section className="panel workbench-head exif-workbench-head">
        <div>
          <p className="eyebrow">Photo EXIF</p>
          <h2>文物图片入库工作台</h2>
          <p className="muted">解析文件名、校对展出地点、补全描述，一次完成本地 EXIF、OSS 和云数据库。</p>
        </div>
        <div className="upload-actions exif-toolbar">
          <button type="button" className="primary" onClick={() => void handleOpenWritableFiles()} disabled={uploading}>
            {uploading ? "正在读取…" : "添加图片"}
          </button>
        </div>
        <input
          id={EXIF_FILE_INPUT_ID}
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="exif-file-input"
          onChange={(event) => void handleUpload(Array.from(event.target.files ?? []))}
        />
      </section>

      <div className="layout exif-layout exif-layout-wide">
        <section className="column column-left exif-sidebar">
          <div className="panel exif-queue-panel">
            <div className="section-heading compact">
              <div>
                <h2>图片列表</h2>
                <p className="muted">{stats.submittedCount}/{stats.itemCount} 已完成</p>
              </div>
              <div className="exif-queue-actions">
                <button type="button" className="ghost" onClick={() => void clearAll()} disabled={items.length === 0}>清空</button>
                <button type="button" className="primary" onClick={() => void handleSubmitAll()} disabled={submittingAll || items.length === 0}>
                  {submittingAll ? "提交中..." : "全部入库"}
                </button>
              </div>
            </div>
            <details className="batch-rename-panel">
              <summary>批量修改目标文件名</summary>
              <div>
                <input value={batchPrefix} placeholder="统一前缀" onChange={(event) => setBatchPrefix(event.target.value)} />
                <input value={batchSuffix} placeholder="统一后缀" onChange={(event) => setBatchSuffix(event.target.value)} />
                <button type="button" className="ghost" onClick={applyBatchRename} disabled={items.length === 0}>应用</button>
              </div>
              <p className="muted">只修改入库与导出文件名；原地改名需通过文件夹授权。</p>
            </details>
            <div className="exif-queue-list">
              {items.length > 0 ? items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`exif-queue-item ${selectedId === item.id ? "active" : ""}`}
                  onClick={() => {
                    setSelectedId(item.id)
                    setTagInput("")
                  }}
                >
                  <img src={item.previewUrl} alt={item.fileName} className="exif-queue-thumb" />
                  <div className="exif-queue-copy">
                    <strong title={item.fileName}>{item.fileName}</strong>
                    <span>{item.form.name || item.parsedName?.artifact_name || "待确认名称"}</span>
                    <em>
                      {item.submitState === "submitted"
                        ? "已提交"
                        : item.submitState === "submitting"
                          ? "提交中"
                          : item.submitState === "error"
                            ? "提交失败"
                            : "待处理"}
                    </em>
                  </div>
                  <span
                    className="exif-remove"
                    onClick={(event) => {
                      event.stopPropagation()
                      void removeItem(item.id)
                    }}
                  >
                    ×
                  </span>
                </button>
              )) : <p className="muted">还没有图片，先上传一批图片开始处理。</p>}
            </div>
          </div>
        </section>

        <section className="column column-right exif-main">
          {selectedItem ? (
            <form
              className="panel form-wide exif-editor-form"
              onSubmit={(event) => {
                event.preventDefault()
                void submitOne(selectedItem.id)
              }}
            >
              <div className="section-heading exif-editor-heading">
                <div>
                  <h2>{selectedItem.form.name || "校对文物信息"}</h2>
                  <p className="muted">自动解析结果已填入表单，只需修正有误字段</p>
                </div>
              </div>

              <div className="exif-editor-scroll">
                <details className="form-section exif-shared-section">
                  <summary>批量套用同一件文物的信息 <span>可选</span></summary>
                  <div className="form-section-body">
                    <p className="muted">这些图片指向同一件文物时，在这里统一填写基础字段和描述，再一键应用到全部图片。</p>
                    <div className="field-row">
                      <label className="field">
                        <span>馆藏单位</span>
                        <input
                          value={sharedForm.museumName}
                          placeholder="例如：山东省博物馆"
                          onChange={(event) => updateSharedForm({ museumName: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>文物名称</span>
                        <input
                          value={sharedForm.name}
                          placeholder="例如：夫妇宴享行乐图"
                          onChange={(event) => updateSharedForm({ name: event.target.value })}
                        />
                      </label>
                    </div>
                    <div className="field-row">
                      <label className="field">
                        <span>时代</span>
                        <input
                          value={sharedForm.era}
                          placeholder="例如：隋代"
                          onChange={(event) => updateSharedForm({ era: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>出土地</span>
                        <input
                          value={sharedForm.placeOfExcavation}
                          placeholder="例如：1976年嘉祥英山一号隋墓出土"
                          onChange={(event) => updateSharedForm({ placeOfExcavation: event.target.value })}
                        />
                      </label>
                    </div>
                    <div className="field-row">
                      <label className="field">
                        <span>展出地点名称</span>
                        <input
                          value={sharedForm.displayLocationName}
                          placeholder="例如：山东省博物馆"
                          onChange={(event) => updateSharedForm({ displayLocationName: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>对应展览</span>
                        <input
                          value={sharedForm.exhibitionName}
                          placeholder="例如：常设展 / 汉唐文明展"
                          onChange={(event) => updateSharedForm({ exhibitionName: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>纬度 / 经度</span>
                        <div className="field-row">
                          <input
                            value={sharedForm.latitude}
                            placeholder="纬度"
                            onChange={(event) => updateSharedForm({ latitude: event.target.value })}
                          />
                          <input
                            value={sharedForm.longitude}
                            placeholder="经度"
                            onChange={(event) => updateSharedForm({ longitude: event.target.value })}
                          />
                        </div>
                      </label>
                    </div>
                    <label className="field">
                      <span>共享描述</span>
                      <textarea
                        rows={4}
                        value={sharedForm.description}
                        placeholder="这里的描述会作为同一文物的默认描述应用到全部图片"
                        onChange={(event) => updateSharedForm({ description: event.target.value })}
                      />
                    </label>
                    <div className="upload-actions exif-shared-actions">
                      <button type="button" className="ghost" onClick={fillSharedFromSelected}>
                        从当前图片带入
                      </button>
                      <button type="button" className="ghost" onClick={applySharedToAll} disabled={items.length === 0}>
                        应用到全部图片
                      </button>
                      <button type="button" className="primary" onClick={() => void handleGenerateDescription()} disabled={generating}>
                        {generating ? "并行生成中..." : "并行生成共享描述"}
                      </button>
                      <p className="muted">当前会同步到 {items.length || 0} 张图片</p>
                    </div>
                  </div>
                </details>

                <div className="exif-selected-head">
                  <img src={selectedItem.previewUrl} alt={selectedItem.fileName} className="exif-selected-preview" />
                  <div className="result-block exif-file-block">
                    <div className="result-head">
                      <h3>文件名</h3>
                    </div>
                    <p className="result-desc exif-file-name">{selectedItem.fileName}</p>
                    <label className="exif-file-rename">
                      <span>目标文件名</span>
                      <input
                        value={fileBaseName(selectedItem.fileName)}
                        onChange={(event) => renameSelected(event.target.value)}
                      />
                      <em>{fileExtension(selectedItem.fileName)}</em>
                    </label>
                    {selectedItem.parsedName ? (
                      <div className="result-meta">
                        {selectedItem.parsedName.era ? <span>时代：{selectedItem.parsedName.era}</span> : null}
                        {selectedItem.parsedName.museum_name ? <span>馆藏：{selectedItem.parsedName.museum_name}</span> : null}
                        {selectedItem.parsedName.Place_of_Excavation ? <span>出土地：{selectedItem.parsedName.Place_of_Excavation}</span> : null}
                      </div>
                    ) : <p className="muted">当前文件名暂无解析结果，可手动填写。</p>}
                  </div>
                </div>

                <div className="form-fields">
                  <section className="form-section">
                    <div className="form-section-head">
                      <span className="form-section-kicker">BASIC</span>
                      <h3>基础信息</h3>
                    </div>
                    <div className="form-section-body">
                      <div className="field-row">
                        <label className="field">
                          <span>馆藏单位</span>
                          <input
                            value={selectedItem.form.museumName}
                            placeholder="例如：山东省博物馆"
                            onFocus={() => setShowMuseumSuggestions(true)}
                            onBlur={() => window.setTimeout(() => setShowMuseumSuggestions(false), 100)}
                            onChange={(event) => {
                              updateSelectedForm({ museumName: event.target.value })
                              setShowMuseumSuggestions(true)
                            }}
                          />
                          {showMuseumSuggestions && museumSuggestions.length > 0 ? (
                            <div className="suggestion-list">
                              {museumSuggestions.map((museum) => (
                                <button
                                  key={`museum-${museum.id}`}
                                  type="button"
                                  className="suggestion-item"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    updateSelectedForm({ museumName: museum.name })
                                    setShowMuseumSuggestions(false)
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
                            value={selectedItem.form.name}
                            placeholder="例如：夫妇宴享行乐图"
                            onChange={(event) => updateSelectedForm({ name: event.target.value })}
                          />
                        </label>
                      </div>

                      <div className="field-row">
                        <label className="field">
                          <span>时代</span>
                          <input
                            value={selectedItem.form.era}
                            placeholder="例如：隋代"
                            onChange={(event) => updateSelectedForm({ era: event.target.value })}
                          />
                        </label>

                        <label className="field">
                          <span>出土地</span>
                          <input
                            value={selectedItem.form.placeOfExcavation}
                            placeholder="例如：1976年嘉祥英山一号隋墓出土"
                            onChange={(event) => updateSelectedForm({ placeOfExcavation: event.target.value })}
                          />
                        </label>
                      </div>
                    </div>
                  </section>

                  <section className="form-section">
                    <div className="form-section-head">
                      <span className="form-section-kicker">GPS</span>
                      <h3>展出地点</h3>
                    </div>
                    <div className="form-section-body">
                      <label className="field">
                        <span>展出地点名称</span>
                        <input
                          value={selectedItem.form.displayLocationName}
                          placeholder="例如：山东省博物馆"
                          onFocus={() => setShowLocationSuggestions(true)}
                          onBlur={() => window.setTimeout(() => setShowLocationSuggestions(false), 100)}
                          onChange={(event) => {
                            updateSelectedForm({ displayLocationName: event.target.value })
                            setShowLocationSuggestions(true)
                          }}
                        />
                        {showLocationSuggestions && locationSuggestions.length > 0 ? (
                          <div className="suggestion-list">
                            {locationSuggestions.map((museum) => (
                              <button
                                key={`location-${museum.id}`}
                                type="button"
                                className="suggestion-item"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  updateSelectedForm({
                                    displayLocationName: museum.name,
                                    latitude: museum.latitude?.toString() ?? "",
                                    longitude: museum.longitude?.toString() ?? "",
                                  })
                                  setShowLocationSuggestions(false)
                                }}
                              >
                                <span>{museum.name}</span>
                                {(museum.latitude !== null && museum.longitude !== null) ? (
                                  <em>{museum.latitude}, {museum.longitude}</em>
                                ) : null}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </label>

                      <label className="field">
                        <span>对应展览</span>
                        <input
                          value={selectedItem.form.exhibitionName}
                          placeholder="例如：常设展 / 汉唐文明展"
                          onChange={(event) => updateSelectedForm({ exhibitionName: event.target.value })}
                        />
                      </label>

                      <div className="field-row">
                        <label className="field">
                          <span>纬度</span>
                          <input
                            value={selectedItem.form.latitude}
                            placeholder="例如：35.117"
                            onChange={(event) => updateSelectedForm({ latitude: event.target.value })}
                          />
                        </label>
                        <label className="field">
                          <span>经度</span>
                          <input
                            value={selectedItem.form.longitude}
                            placeholder="例如：117.188"
                            onChange={(event) => updateSelectedForm({ longitude: event.target.value })}
                          />
                        </label>
                      </div>
                      <GpsMapPicker
                        latitude={selectedItem.form.latitude}
                        longitude={selectedItem.form.longitude}
                        onPick={(latitude, longitude, displayLocationName) => updateSelectedForm({
                          latitude,
                          longitude,
                          ...(displayLocationName ? { displayLocationName } : {}),
                        })}
                      />
                    </div>
                  </section>

                  <section className="form-section">
                    <div className="form-section-head">
                      <span className="form-section-kicker">MODEL</span>
                      <h3>AI 补充描述</h3>
                    </div>
                    <div className="form-section-body">
                      <div className="upload-actions exif-model-actions">
                        <button type="button" className="primary" onClick={() => void handleGenerateDescription()} disabled={generating}>
                          {generating ? "正在生成…" : "生成描述"}
                        </button>
                        {selectedItem.descriptionMeta ? <p className="muted">{selectedItem.descriptionMeta}</p> : null}
                      </div>
                      {generating ? (
                        <ol className="research-trace" aria-live="polite">
                          {descriptionProgress.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
                        </ol>
                      ) : null}
                      <div className="exif-model-grid">
                        {selectedItem.candidates.length > 0 ? selectedItem.candidates.map((candidate) => (
                          <article key={`${candidate.provider}-${candidate.model}`} className={`result-block exif-model-card ${candidate.status !== "success" ? "is-error" : ""}`}>
                            <div className="result-head">
                              <h3>{candidate.provider}</h3>
                              <span>{candidate.model}</span>
                            </div>
                            <details className="exif-model-details">
                              <summary>查看模型依据</summary>
                              <pre className="exif-model-reasoning">{candidate.reasoning || candidate.error || "暂无依据返回"}</pre>
                            </details>
                            {candidate.status === "success" ? (
                              <>
                                <p className="result-desc">{candidate.description || "暂无描述"}</p>
                                <div className="result-meta">
                                  {candidate.tags.length > 0 ? candidate.tags.map((tag) => <span key={tag}>{tag}</span>) : <span>暂无标签</span>}
                                </div>
                                <button type="button" className="ghost" onClick={() => applyCandidate(candidate)}>
                                  使用这版
                                </button>
                              </>
                            ) : <p className="error-text">{candidate.error || "模型调用失败"}</p>}
                          </article>
                        )) : <p className="muted">点击上方按钮生成两份结果。</p>}
                      </div>
                      {selectedItem.unavailableProviders.length > 0 ? (
                        <p className="muted">未配置模型：{selectedItem.unavailableProviders.join(" / ")}</p>
                      ) : null}
                    </div>
                  </section>

                  <section className="form-section">
                    <div className="form-section-head">
                      <span className="form-section-kicker">TEXT</span>
                      <h3>最终写入内容</h3>
                    </div>
                    <div className="form-section-body">
                      <label className="field">
                        <span>描述</span>
                        <textarea
                          rows={5}
                          value={selectedItem.form.description}
                          placeholder="文物描述会写入 EXIF 与云端数据库中"
                          onChange={(event) => updateSelectedForm({ description: event.target.value })}
                        />
                      </label>

                      <label className="field">
                        <span>标签</span>
                        <div className="tag-editor">
                          <div className="tag-editor-chips">
                            {selectedItem.form.tags.length > 0 ? selectedItem.form.tags.map((tag) => (
                              <span key={tag} className="tag-chip">
                                {tag}
                                <button
                                  type="button"
                                  onClick={() => updateItem(selectedItem.id, (item) => ({
                                    ...item,
                                    form: { ...item.form, tags: item.form.tags.filter((entry) => entry !== tag) },
                                  }))}
                                >
                                  ×
                                </button>
                              </span>
                            )) : <span className="tag-editor-placeholder">暂无标签</span>}
                          </div>
                          <input
                            value={tagInput}
                            placeholder="输入后回车或逗号添加"
                            onChange={(event) => setTagInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === ",") {
                                event.preventDefault()
                                addTags(tagInput)
                              }
                            }}
                            onBlur={() => addTags(tagInput)}
                          />
                        </div>
                      </label>
                    </div>
                  </section>
                </div>
              </div>

              <div className="form-footer">
                <div>
                  {selectedItem.submitMessage ? (
                    <p className={selectedItem.submitState === "error" ? "error-text" : "success-text"}>{selectedItem.submitMessage}</p>
                  ) : submitNotice ? (
                    <p className={submitNotice.type === "error" ? "error-text" : "success-text"}>{submitNotice.text}</p>
                  ) : <span />}
                </div>
                <button type="submit" className="primary" disabled={selectedItem.submitState === "submitting"}>
                  {selectedItem.submitState === "submitting" ? "正在入库…" : "保存并入库"}
                </button>
              </div>
            </form>
          ) : (
            <div className="panel empty-state">
              <p className="eyebrow">COLLECTION ENTRY</p>
              <h2>从一张文物照片开始</h2>
              <p className="muted">点击右上角“添加图片”，系统会从文件名提取基础信息；只需校对后保存入库。</p>
            </div>
          )}
        </section>
      </div>
    </section>
  )
}

export default ExifConsole
