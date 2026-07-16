import { useEffect, useMemo, useState } from "react"

type UploadedImage = {
  filename: string
  url: string
  uploaded_at: string
  latitude: number | null
  longitude: number | null
}

type ParsedArtifactName = {
  original_name: string
  normalized_name: string
  era: string | null
  artifact_name: string | null
  museum_name: string | null
  unearthed_at: string | null
  catalog_no: string | null
}

type GeneratedDescription = {
  provider: string
  model: string
  description: string
  tags: string[]
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
  unearthedAt: string
  displayLocationName: string
  latitude: string
  longitude: string
  description: string
  tags: string[]
}

const EMPTY_FORM: FormState = {
  museumName: "",
  name: "",
  era: "",
  unearthedAt: "",
  displayLocationName: "",
  latitude: "",
  longitude: "",
  description: "",
  tags: [],
}

function toAbsoluteUrl(baseUrl: string, url: string) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${baseUrl}${url}`
}

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

function ExifConsole({ apiBaseUrl }: ExifConsoleProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploadedImage, setUploadedImage] = useState<UploadedImage | null>(null)
  const [parsedName, setParsedName] = useState<ParsedArtifactName | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [tagInput, setTagInput] = useState("")
  const [museumSuggestions, setMuseumSuggestions] = useState<MuseumOption[]>([])
  const [locationSuggestions, setLocationSuggestions] = useState<MuseumOption[]>([])
  const [showMuseumSuggestions, setShowMuseumSuggestions] = useState(false)
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitNotice, setSubmitNotice] = useState<SubmitNotice | null>(null)
  const [descriptionMeta, setDescriptionMeta] = useState<string | null>(null)

  const displayPreview = useMemo(() => {
    if (previewUrl) {
      return previewUrl
    }
    if (uploadedImage) {
      return toAbsoluteUrl(apiBaseUrl, uploadedImage.url)
    }
    return null
  }, [apiBaseUrl, previewUrl, uploadedImage])

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
      }
    }
  }, [previewUrl])

  useEffect(() => {
    if (!showMuseumSuggestions) {
      return
    }
    const keyword = form.museumName.trim()
    const timer = window.setTimeout(() => {
      void loadMuseumSuggestions(apiBaseUrl, keyword, setMuseumSuggestions)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [apiBaseUrl, form.museumName, showMuseumSuggestions])

  useEffect(() => {
    if (!showLocationSuggestions) {
      return
    }
    const keyword = form.displayLocationName.trim()
    const timer = window.setTimeout(() => {
      void loadMuseumSuggestions(apiBaseUrl, keyword, setLocationSuggestions)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [apiBaseUrl, form.displayLocationName, showLocationSuggestions])

  function selectFile(file: File | null) {
    setSelectedFile(file)
    setUploadedImage(null)
    setParsedName(null)
    setDescriptionMeta(null)
    setSubmitNotice(null)
    setForm(EMPTY_FORM)
    setTagInput("")
    setPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current)
      }
      return file ? URL.createObjectURL(file) : null
    })
  }

  function resetAll() {
    selectFile(null)
  }

  async function applyParsedName(fileName: string) {
    const parsed = await fetchJson<ParsedArtifactName>(
      `${apiBaseUrl}/api/artifacts/parse-name?${new URLSearchParams({ name: fileName }).toString()}`,
    )
    setParsedName(parsed)
    setForm((current) => ({
      ...current,
      museumName: parsed.museum_name ?? current.museumName,
      name: parsed.artifact_name ?? current.name,
      era: parsed.era ?? current.era,
      unearthedAt: parsed.unearthed_at ?? current.unearthedAt,
      displayLocationName: current.displayLocationName || parsed.museum_name || "",
    }))

    const locationSeed = parsed.museum_name ?? ""
    if (locationSeed) {
      try {
        const museum = await resolveMuseum(apiBaseUrl, locationSeed)
        if (museum) {
          setForm((current) => ({
            ...current,
            museumName: current.museumName || museum.name,
            displayLocationName: current.displayLocationName || museum.name,
            latitude: museum.latitude?.toString() ?? current.latitude,
            longitude: museum.longitude?.toString() ?? current.longitude,
          }))
        }
      } catch {
        // ignore suggestion failures
      }
    }
  }

  async function handleUpload(file = selectedFile) {
    if (!file) {
      setSubmitNotice({ type: "error", text: "请先选择一张图片" })
      return
    }

    setUploading(true)
    setSubmitNotice(null)
    try {
      const formData = new FormData()
      formData.append("files", file)
      const uploaded = await fetchJson<UploadedImage[]>(`${apiBaseUrl}/api/uploads/images`, {
        method: "POST",
        body: formData,
      })
      const image = uploaded[0]
      setUploadedImage(image)
      setForm((current) => ({
        ...current,
        latitude: image.latitude?.toString() ?? current.latitude,
        longitude: image.longitude?.toString() ?? current.longitude,
      }))
      await applyParsedName(file.name)
      setSubmitNotice({ type: "success", text: "图片已上传，已尝试解析名称结构" })
    } catch (error) {
      setSubmitNotice({
        type: "error",
        text: error instanceof Error ? error.message : "上传失败",
      })
    } finally {
      setUploading(false)
    }
  }

  async function handleGenerateDescription() {
    if (!form.name.trim()) {
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
          image_url: uploadedImage?.url ?? null,
          museum_name: form.museumName.trim() || null,
          name: form.name.trim(),
          era: form.era.trim() || null,
          unearthed_at: form.unearthedAt.trim() || null,
        }),
      })
      setForm((current) => ({
        ...current,
        description: generated.description,
        tags: uniqueTags([...current.tags, ...generated.tags]),
      }))
      setDescriptionMeta(`描述来源：${generated.provider} / ${generated.model}`)
      setSubmitNotice({ type: "success", text: "已根据图片和结构化字段补全文物描述" })
    } catch (error) {
      setSubmitNotice({
        type: "error",
        text: error instanceof Error ? error.message : "生成描述失败",
      })
    } finally {
      setGenerating(false)
    }
  }

  async function handleSubmit() {
    if (!uploadedImage) {
      setSubmitNotice({ type: "error", text: "请先上传图片" })
      return
    }
    if (!form.name.trim() || !form.museumName.trim()) {
      setSubmitNotice({ type: "error", text: "请先确认名称和馆藏信息" })
      return
    }

    setSubmitting(true)
    setSubmitNotice(null)
    try {
      await fetchJson(`${apiBaseUrl}/api/artifacts/exif-submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: uploadedImage.url,
          museum_name: form.museumName.trim(),
          name: form.name.trim(),
          era: form.era.trim() || null,
          unearthed_at: form.unearthedAt.trim() || null,
          description: form.description.trim() || null,
          tags: form.tags,
          display_location_name: form.displayLocationName.trim() || null,
          latitude: toNullableNumber(form.latitude),
          longitude: toNullableNumber(form.longitude),
        }),
      })
      setSubmitNotice({ type: "success", text: "已回写 EXIF，并同步上传 OSS 与云端数据库" })
    } catch (error) {
      setSubmitNotice({
        type: "error",
        text: error instanceof Error ? error.message : "提交失败",
      })
    } finally {
      setSubmitting(false)
    }
  }

  function addTags(rawValue: string) {
    const nextTags = rawValue
      .split(/[,\n，、；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (nextTags.length === 0) {
      return
    }
    setForm((current) => ({ ...current, tags: uniqueTags([...current.tags, ...nextTags]) }))
    setTagInput("")
  }

  return (
    <section className="exif-console">
      <section className="hero-banner">
        <div className="hero-copy">
          <p className="eyebrow">Exif Workflow</p>
          <h2>上传图片后，先改名称与展出地点，再回写 EXIF 并直接入库</h2>
          <p className="muted">
            适用于你已经知道文物名称结构，只需要修正 GPS、解析时代/馆藏/出土，并用大模型补全描述的场景。
          </p>
        </div>
        <div className="hero-metrics" aria-label="流程说明">
          <div className="hero-metric">
            <span className="hero-metric-label">流程</span>
            <strong>上传 / 解析名称 / 补全文字 / 回写 EXIF / 入库</strong>
          </div>
          <div className="hero-metric">
            <span className="hero-metric-label">GPS</span>
            <strong>这里的 GPS 代表展出地点</strong>
          </div>
          <div className="hero-metric">
            <span className="hero-metric-label">结果</span>
            <strong>本地上传文件、OSS 和云端数据库保持一致</strong>
          </div>
        </div>
      </section>

      <div className="layout exif-layout">
        <section className="column column-left">
          <div className="panel exif-preview-panel">
            <div className="section-heading">
              <span className="step-badge">1</span>
              <div>
                <h2>上传图片</h2>
                <p className="muted">支持点击或拖拽上传，上传后自动解析你当前文件名里的结构化信息。</p>
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
                const file = event.dataTransfer.files?.[0] ?? null
                selectFile(file)
                if (file) {
                  void handleUpload(file)
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
                    void handleUpload(file)
                  }
                }}
              />
              {displayPreview ? (
                <img src={displayPreview} alt={selectedFile?.name ?? uploadedImage?.filename ?? "预览"} />
              ) : (
                <div className="dropzone-empty">
                  <span className="dropzone-icon">＋</span>
                  <strong>点击或拖拽图片到这里</strong>
                  <span className="muted">推荐 JPG / PNG，单图逐张确认</span>
                </div>
              )}
            </label>

            <div className="upload-actions">
              <button type="button" className="ghost" onClick={() => void handleUpload()} disabled={!selectedFile || uploading}>
                {uploading ? "上传中..." : "重新上传"}
              </button>
              {(selectedFile || uploadedImage) ? (
                <button type="button" className="ghost danger" onClick={resetAll}>
                  清空
                </button>
              ) : null}
            </div>

            {parsedName ? (
              <div className="result-block">
                <div className="result-head">
                  <h3>名称解析结果</h3>
                </div>
                <div className="result-meta">
                  {parsedName.era ? <span>时代：{parsedName.era}</span> : null}
                  {parsedName.museum_name ? <span>馆藏：{parsedName.museum_name}</span> : null}
                  {parsedName.catalog_no ? <span>编号：{parsedName.catalog_no}</span> : null}
                </div>
                {parsedName.artifact_name ? <p className="result-desc">名称：{parsedName.artifact_name}</p> : null}
                {parsedName.unearthed_at ? <p className="result-desc">出土：{parsedName.unearthed_at}</p> : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="column column-right">
          <form
            className="panel form-wide"
            onSubmit={(event) => {
              event.preventDefault()
              void handleSubmit()
            }}
          >
            <div className="section-heading">
              <span className="step-badge">2</span>
              <div>
                <h2>确认字段并入库</h2>
                <p className="muted">可手动修正名称、馆藏、出土信息和展出地点坐标，再调用模型补足描述。</p>
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
                        value={form.museumName}
                        placeholder="例如：山东省博物馆"
                        onFocus={() => setShowMuseumSuggestions(true)}
                        onBlur={() => window.setTimeout(() => setShowMuseumSuggestions(false), 100)}
                        onChange={(event) => {
                          setForm((current) => ({ ...current, museumName: event.target.value }))
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
                                setForm((current) => ({ ...current, museumName: museum.name }))
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
                        value={form.name}
                        placeholder="例如：夫妇宴享行乐图"
                        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                      />
                    </label>
                  </div>

                  <div className="field-row">
                    <label className="field">
                      <span>时代</span>
                      <input
                        value={form.era}
                        placeholder="例如：隋代"
                        onChange={(event) => setForm((current) => ({ ...current, era: event.target.value }))}
                      />
                    </label>

                    <label className="field">
                      <span>出土信息</span>
                      <input
                        value={form.unearthedAt}
                        placeholder="例如：1976年嘉祥英山一号隋墓出土"
                        onChange={(event) => setForm((current) => ({ ...current, unearthedAt: event.target.value }))}
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
                      value={form.displayLocationName}
                      placeholder="例如：山东省博物馆"
                      onFocus={() => setShowLocationSuggestions(true)}
                      onBlur={() => window.setTimeout(() => setShowLocationSuggestions(false), 100)}
                      onChange={(event) => {
                        setForm((current) => ({ ...current, displayLocationName: event.target.value }))
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
                              setForm((current) => ({
                                ...current,
                                displayLocationName: museum.name,
                                latitude: museum.latitude?.toString() ?? "",
                                longitude: museum.longitude?.toString() ?? "",
                              }))
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
                        value={form.latitude}
                        placeholder="例如：35.117"
                        onChange={(event) => setForm((current) => ({ ...current, latitude: event.target.value }))}
                      />
                    </label>
                    <label className="field">
                      <span>经度</span>
                      <input
                        value={form.longitude}
                        placeholder="例如：117.188"
                        onChange={(event) => setForm((current) => ({ ...current, longitude: event.target.value }))}
                      />
                    </label>
                  </div>
                </div>
              </section>

              <section className="form-section">
                <div className="form-section-head">
                  <span className="form-section-kicker">TEXT</span>
                  <h3>描述与标签</h3>
                </div>
                <div className="form-section-body">
                  <div className="upload-actions">
                    <button type="button" className="primary" onClick={() => void handleGenerateDescription()} disabled={generating || !uploadedImage}>
                      {generating ? "生成中..." : "根据图片和字段生成描述"}
                    </button>
                    {descriptionMeta ? <p className="muted">{descriptionMeta}</p> : null}
                  </div>

                  <label className="field">
                    <span>描述</span>
                    <textarea
                      rows={4}
                      value={form.description}
                      placeholder="文物描述会出现在 EXIF 与云端数据库中"
                      onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                    />
                  </label>

                  <label className="field">
                    <span>标签</span>
                    <div className="tag-editor">
                      <div className="tag-editor-chips">
                        {form.tags.length > 0 ? form.tags.map((tag) => (
                          <span key={tag} className="tag-chip">
                            {tag}
                            <button
                              type="button"
                              onClick={() => setForm((current) => ({ ...current, tags: current.tags.filter((item) => item !== tag) }))}
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
                          if (event.key === "Enter" || event.key === "," || event.key === "，") {
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

            <div className="form-footer">
              {submitNotice ? (
                <p className={submitNotice.type === "error" ? "error-text" : "success-text"}>
                  {submitNotice.text}
                </p>
              ) : (
                <span />
              )}
              <button type="submit" className="primary" disabled={submitting || !uploadedImage}>
                {submitting ? "提交中..." : "回写 EXIF 并提交云端"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </section>
  )
}

function uniqueTags(tags: string[]) {
  return Array.from(new Set(tags.map((item) => item.trim()).filter(Boolean)))
}

function toNullableNumber(value: string) {
  const text = value.trim()
  if (!text) {
    return null
  }
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

export default ExifConsole
