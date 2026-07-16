import { useEffect, useMemo, useRef, useState } from "react"

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
  parsedName: ParsedArtifactName | null
  form: FormState
  candidates: DescriptionCandidate[]
  unavailableProviders: string[]
  descriptionMeta: string | null
  submitState: "idle" | "submitting" | "submitted" | "error"
  submitMessage: string | null
}

const EMPTY_FORM: FormState = {
  museumName: "",
  name: "",
  era: "",
  placeOfExcavation: "",
  displayLocationName: "",
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

function ExifConsole({ apiBaseUrl }: ExifConsoleProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [items, setItems] = useState<ExifWorkbenchItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState("")
  const [museumSuggestions, setMuseumSuggestions] = useState<MuseumOption[]>([])
  const [locationSuggestions, setLocationSuggestions] = useState<MuseumOption[]>([])
  const [showMuseumSuggestions, setShowMuseumSuggestions] = useState(false)
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
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

  async function createWorkbenchItem(file: File, index: number): Promise<ExifWorkbenchItem> {
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
      parsedName,
      form,
      candidates: [],
      unavailableProviders: [],
      descriptionMeta: null,
      submitState: "idle",
      submitMessage: null,
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
    setSubmitNotice(null)
  }

  async function handleGenerateDescription() {
    if (!selectedItem) {
      return
    }
    if (!selectedItem.form.name.trim()) {
      setSubmitNotice({ type: "error", text: "请先填写或确认文物名称" })
      return
    }

    setGenerating(true)
    setSubmitNotice(null)
    try {
      const generated = await fetchJson<GeneratedDescription>(`${apiBaseUrl}/api/artifacts/generate-description`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: null,
          museum_name: selectedItem.form.museumName.trim() || null,
          name: selectedItem.form.name.trim(),
          era: selectedItem.form.era.trim() || null,
          Place_of_Excavation: selectedItem.form.placeOfExcavation.trim() || null,
        }),
      })

      updateItem(selectedItem.id, (item) => ({
        ...item,
        form: {
          ...item.form,
          description: generated.description,
          tags: uniqueTags([...item.form.tags, ...ensureStringList(generated.tags)]),
        },
        candidates: ensureCandidates(generated.candidates),
        unavailableProviders: ensureStringList(generated.unavailable_providers),
        descriptionMeta: `默认采用：${generated.provider} / ${generated.model}`,
      }))
      setSubmitNotice({ type: "success", text: "已基于文件名解析字段并行请求千问和豆包，并回填默认描述" })
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
      const formData = new FormData()
      formData.append("file", target.localFile)
      formData.append("museum_name", target.form.museumName.trim())
      formData.append("name", target.form.name.trim())
      formData.append("era", target.form.era.trim() || "")
      formData.append("Place_of_Excavation", target.form.placeOfExcavation.trim() || "")
      formData.append("description", target.form.description.trim() || "")
      formData.append("tags", JSON.stringify(target.form.tags))
      formData.append("display_location_name", target.form.displayLocationName.trim() || "")
      if (latitude !== null) {
        formData.append("latitude", String(latitude))
      }
      if (longitude !== null) {
        formData.append("longitude", String(longitude))
      }
      await fetchJson(`${apiBaseUrl}/api/artifacts/exif-submit-file`, {
        method: "POST",
        body: formData,
      })
      updateItem(itemId, (item) => ({
        ...item,
        submitState: "submitted",
        submitMessage: "已回写 EXIF，并同步上传 OSS 与云端数据库",
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
      // eslint-disable-next-line no-await-in-loop
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
          <h2>照片 EXIF 工作台</h2>
          <p className="muted">批量上传，左侧选图，右侧逐张确认并入库。</p>
        </div>
        <div className="upload-actions exif-toolbar">
          <label htmlFor={EXIF_FILE_INPUT_ID} className="ghost exif-picker-button">
            选择图片
          </label>
          <button type="button" className="ghost danger" onClick={() => void clearAll()} disabled={items.length === 0}>
            清空全部
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

      <section className="exif-stats-grid">
        <article className="panel exif-stat-card">
          <span className="eyebrow">图片</span>
          <strong>{stats.itemCount}</strong>
          <p className="muted">已加载</p>
        </article>
        <article className="panel exif-stat-card">
          <span className="eyebrow">描述</span>
          <strong>{stats.describedCount}</strong>
          <p className="muted">已生成</p>
        </article>
        <article className="panel exif-stat-card">
          <span className="eyebrow">GPS</span>
          <strong>{stats.gpsCount}</strong>
          <p className="muted">已填写</p>
        </article>
        <article className="panel exif-stat-card">
          <span className="eyebrow">提交</span>
          <strong>{stats.submittedCount}</strong>
          <p className="muted">已完成</p>
        </article>
      </section>

      <div className="layout exif-layout exif-layout-wide">
        <section className="column column-left exif-sidebar">
          <div className="panel exif-import-panel">
            <div className="section-heading">
              <div>
                <h2>导入</h2>
                <p className="muted">支持批量拖拽上传</p>
              </div>
            </div>
            <label
              htmlFor={EXIF_FILE_INPUT_ID}
              className={`dropzone exif-dropzone ${dragging ? "dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                void handleUpload(Array.from(event.dataTransfer.files ?? []))
              }}
            >
              <div className="dropzone-empty">
                <span className="dropzone-icon">＋</span>
                <strong>{uploading ? "上传中..." : "拖拽图片到这里，或点击上方按钮选择"}</strong>
                <span className="muted">JPG / PNG / WEBP</span>
              </div>
            </label>
          </div>

          <div className="panel exif-queue-panel">
            <div className="section-heading compact">
              <div>
                <h2>图片列表</h2>
                <p className="muted">点击切换当前图片</p>
              </div>
              <button type="button" className="ghost" onClick={() => void handleSubmitAll()} disabled={submittingAll || items.length === 0}>
                {submittingAll ? "批量提交中..." : "提交全部"}
              </button>
            </div>
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
              <div className="section-heading">
                <div>
                  <h2>当前图片编辑</h2>
                  <p className="muted">文件名、字段、模型结果与最终入库内容</p>
                </div>
              </div>

              <div className="exif-editor-scroll">
                <div className="exif-selected-head">
                  <img src={selectedItem.previewUrl} alt={selectedItem.fileName} className="exif-selected-preview" />
                  <div className="result-block exif-file-block">
                    <div className="result-head">
                      <h3>文件名</h3>
                    </div>
                    <p className="result-desc exif-file-name">{selectedItem.fileName}</p>
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
                    </div>
                  </section>

                  <section className="form-section">
                    <div className="form-section-head">
                      <span className="form-section-kicker">MODEL</span>
                      <h3>千问 / 豆包</h3>
                    </div>
                    <div className="form-section-body">
                      <div className="upload-actions exif-model-actions">
                        <button type="button" className="primary" onClick={() => void handleGenerateDescription()} disabled={generating}>
                          {generating ? "并行生成中..." : "并行请求千问与豆包"}
                        </button>
                        {selectedItem.descriptionMeta ? <p className="muted">{selectedItem.descriptionMeta}</p> : null}
                      </div>
                      <div className="exif-model-grid">
                        {selectedItem.candidates.length > 0 ? selectedItem.candidates.map((candidate) => (
                          <article key={`${candidate.provider}-${candidate.model}`} className={`result-block exif-model-card ${candidate.status !== "success" ? "is-error" : ""}`}>
                            <div className="result-head">
                              <h3>{candidate.provider}</h3>
                              <span>{candidate.model}</span>
                            </div>
                            <p className="muted exif-model-label">思路</p>
                            <pre className="exif-model-reasoning">{candidate.reasoning || candidate.error || "暂无思路返回"}</pre>
                            <p className="muted exif-model-label">结果</p>
                            {candidate.status === "success" ? (
                              <>
                                <p className="result-desc">{candidate.description || "暂无描述"}</p>
                                <div className="result-meta">
                                  {candidate.tags.length > 0 ? candidate.tags.map((tag) => <span key={tag}>{tag}</span>) : <span>暂无标签</span>}
                                </div>
                                <button type="button" className="ghost" onClick={() => applyCandidate(candidate)}>
                                  采用此结果
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
                  {selectedItem.submitState === "submitting" ? "提交中..." : "回写 EXIF 并提交当前图片"}
                </button>
              </div>
            </form>
          ) : (
            <div className="panel empty-state">
              <h2>先上传图片</h2>
              <p className="muted">导入后从左侧列表开始逐张处理。</p>
            </div>
          )}
        </section>
      </div>
    </section>
  )
}

export default ExifConsole
