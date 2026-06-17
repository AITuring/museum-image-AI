import { useCallback, useEffect, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"

type GalleryImage = {
  id: number
  url: string
  camera_model?: string | null
  lens_model?: string | null
  capture_museum_name?: string | null
  exhibition_name?: string | null
  latitude?: number | null
  longitude?: number | null
  captured_at?: string | null
  uploaded_at?: string | null
  shutter_speed?: string | null
  aperture?: string | null
  iso?: number | null
  edit_method?: string | null
}

type GalleryArtifact = {
  id: number
  name: string
  era: string | null
  description: string | null
  museum_name: string
  tags: string[]
  exhibitions: Array<{
    id: number
    museum_name: string
    name: string
    start_at: string | null
    end_at: string | null
  }>
  images: GalleryImage[]
}

type RawGalleryArtifact = Omit<GalleryArtifact, "tags" | "images" | "exhibitions"> & {
  tags?: string[]
  images?: GalleryImage[]
  exhibitions?: GalleryArtifact["exhibitions"]
}

type GalleryEditFormState = {
  museumName: string
  name: string
  era: string
  description: string
  tags: string[]
  imageId: number | null
  cameraModel: string
  lensModel: string
  captureMuseumName: string
  exhibitionName: string
  latitude: string
  longitude: string
  capturedAt: string
  shutterSpeed: string
  aperture: string
  iso: string
  editMethod: string
}

function toAbsoluteUrl(apiBaseUrl: string, url: string) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${apiBaseUrl}${url}`
}

function isOssImageUrl(url: string) {
  return /^https:\/\/.+\.aliyuncs\.com\//.test(url)
}

function withOssImageProcess(url: string, process: string) {
  if (!isOssImageUrl(url)) {
    return url
  }
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}x-oss-process=${encodeURIComponent(process)}`
}

function getDisplayImageUrl(apiBaseUrl: string, url: string, mode: "thumb" | "preview" | "original") {
  const absoluteUrl = toAbsoluteUrl(apiBaseUrl, url)
  if (mode === "original") {
    return absoluteUrl
  }
  if (mode === "thumb") {
    return withOssImageProcess(absoluteUrl, "image/resize,m_lfit,w_480/quality,q_75/format,webp")
  }
  return withOssImageProcess(absoluteUrl, "image/resize,m_lfit,w_1280/quality,q_82/format,webp")
}

function normalizeArtifact(item: RawGalleryArtifact): GalleryArtifact {
  return {
    ...item,
    tags: Array.isArray(item.tags) ? item.tags : [],
    images: Array.isArray(item.images) ? item.images : [],
    exhibitions: Array.isArray(item.exhibitions) ? item.exhibitions : [],
  }
}

function formatMetaDate(value?: string | null) {
  if (!value) return ""
  const normalized = value.replace("T", " ")
  return normalized.length >= 19 ? normalized.slice(0, 19) : normalized
}

function formatMetaValue(value?: string | number | null) {
  if (value === null || value === undefined) return ""
  return String(value)
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

function getSubjectTags(tags: string[]) {
  return tags.filter((tag) => !/^(机型|镜头)[:：]/.test(tag))
}

function buildEditForm(artifact: GalleryArtifact, image?: GalleryImage | null): GalleryEditFormState {
  return {
    museumName: artifact.museum_name ?? "",
    name: artifact.name ?? "",
    era: artifact.era ?? "",
    description: artifact.description ?? "",
    tags: getSubjectTags(artifact.tags),
    imageId: image?.id ?? null,
    cameraModel: image?.camera_model ?? "",
    lensModel: image?.lens_model ?? "",
    captureMuseumName: image?.capture_museum_name ?? "",
    exhibitionName: image?.exhibition_name ?? "常设",
    latitude: image?.latitude?.toString() ?? "",
    longitude: image?.longitude?.toString() ?? "",
    capturedAt: image?.captured_at ?? "",
    shutterSpeed: image?.shutter_speed ?? "",
    aperture: image?.aperture ?? "",
    iso: image?.iso?.toString() ?? "",
    editMethod: image?.edit_method ?? "",
  }
}

function parseOptionalNumber(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label}格式不正确`)
  }
  return parsed
}

export default function Gallery({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [items, setItems] = useState<GalleryArtifact[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<GalleryArtifact | null>(null)
  const [activeImageIndex, setActiveImageIndex] = useState(0)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<GalleryEditFormState | null>(null)
  const [tagInput, setTagInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

  const load = useCallback(
    async (q: string) => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (q.trim()) params.set("q", q.trim())
        const res = await fetch(`${apiBaseUrl}/api/artifacts?${params.toString()}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const payload = (await res.json()) as RawGalleryArtifact[]
        setItems(payload.map(normalizeArtifact))
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载失败")
      } finally {
        setLoading(false)
      }
    },
    [apiBaseUrl],
  )

  useEffect(() => {
    void load("")
  }, [load])

  useEffect(() => {
    setEditing(false)
    setEditForm(null)
    setTagInput("")
    setSaveError(null)
    setSaveNotice(null)
    if (!active) return
    setActiveImageIndex(0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editing) setActive(null)
    }
    document.addEventListener("keydown", onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [active?.id, editing])

  function handleSearch(event: FormEvent) {
    event.preventDefault()
    setSubmittedQuery(query)
    void load(query)
  }

  function handleStartEdit() {
    if (!active) {
      return
    }
    const image = active.images[activeImageIndex] ?? active.images[0] ?? null
    setEditForm(buildEditForm(active, image))
    setTagInput("")
    setSaveError(null)
    setSaveNotice(null)
    setEditing(true)
  }

  function handleCancelEdit() {
    setEditing(false)
    setEditForm(null)
    setTagInput("")
    setSaveError(null)
    setActive(null)
  }

  function addTags(rawValue: string) {
    if (!editForm) {
      return
    }
    const nextTags = normalizeTags(rawValue.split(/[,\n，、；;]/).map((tag) => tag.trim()))
    if (nextTags.length === 0) {
      return
    }
    setEditForm((current) =>
      current
        ? {
            ...current,
            tags: normalizeTags([...current.tags, ...nextTags]),
          }
        : current,
    )
    setTagInput("")
  }

  function removeTag(tagToRemove: string) {
    setEditForm((current) =>
      current
        ? {
            ...current,
            tags: current.tags.filter((tag) => tag !== tagToRemove),
          }
        : current,
    )
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!active || !editForm) {
      return
    }

    setSaving(true)
    setSaveError(null)
    setSaveNotice(null)

    try {
      if (!editForm.museumName.trim()) {
        throw new Error("请填写或确认博物馆名称")
      }
      if (!editForm.name.trim()) {
        throw new Error("请填写或确认文物名称")
      }

      const response = await fetch(`${apiBaseUrl}/api/artifacts/${active.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          museum_name: editForm.museumName.trim(),
          name: editForm.name.trim(),
          era: editForm.era.trim() || null,
          description: editForm.description.trim() || null,
          tags: editForm.tags,
          image_id: editForm.imageId,
          camera_model: editForm.cameraModel.trim() || null,
          lens_model: editForm.lensModel.trim() || null,
          capture_museum_name: editForm.captureMuseumName.trim() || null,
          exhibition_name: editForm.exhibitionName.trim() || "常设",
          latitude: parseOptionalNumber(editForm.latitude, "纬度"),
          longitude: parseOptionalNumber(editForm.longitude, "经度"),
          captured_at: editForm.capturedAt.trim() || null,
          shutter_speed: editForm.shutterSpeed.trim() || null,
          aperture: editForm.aperture.trim() || null,
          iso: parseOptionalNumber(editForm.iso, "ISO"),
          edit_method: editForm.editMethod || null,
        }),
      })

      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const payload = (await response.json()) as { detail?: string }
          if (payload.detail) {
            message = payload.detail
          }
        } catch {
          // Ignore non-JSON error bodies.
        }
        throw new Error(message)
      }

      const updated = normalizeArtifact((await response.json()) as RawGalleryArtifact)
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setEditing(false)
      setEditForm(null)
      setTagInput("")
      setActive(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="panel form-wide">
      <form className="gallery-search" onSubmit={handleSearch}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称、时代、馆藏或描述，按回车检索"
          aria-label="图库搜索"
        />
      </form>

      {error ? <p className="error-text">{error}</p> : null}

      {!loading && items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">🏺</span>
          <strong>{submittedQuery ? "没有匹配的文物" : "图库为空"}</strong>
          <p className="muted">
            {submittedQuery ? "换个关键词试试。" : "提交入库后，文物会显示在这里。"}
          </p>
        </div>
      ) : null}

      <div className="gallery-grid">
        {items.map((artifact) => {
          const cover = artifact.images[0]
          return (
            <button
              type="button"
              key={artifact.id}
              className="gallery-card"
              onClick={() => setActive(artifact)}
            >
              <div className="gallery-thumb">
                {cover ? (
                  <img
                    src={getDisplayImageUrl(apiBaseUrl, cover.url, "thumb")}
                    alt={artifact.name}
                    loading="lazy"
                  />
                ) : (
                  <span className="gallery-noimg">无图</span>
                )}
              </div>
              <div className="gallery-meta">
                <strong className="gallery-title">{artifact.name}</strong>
                <span className="gallery-line">时代：{artifact.era || "待确认"}</span>
                <span className="gallery-line">馆藏：{artifact.museum_name || "待识别"}</span>
                <span className="gallery-line">图片：{artifact.images.length} 张</span>
              </div>
            </button>
          )
        })}
      </div>

      {active
        ? createPortal(
            <div className="gallery-modal" onClick={() => !editing && setActive(null)}>
              <div className="gallery-modal-body" onClick={(e) => e.stopPropagation()}>
                {(() => {
                  const currentImage = active.images[activeImageIndex] ?? active.images[0] ?? null
                  const subjectTags = getSubjectTags(active.tags)
                  const equipmentMeta = [
                    currentImage?.camera_model ? `机型:${currentImage.camera_model}` : null,
                    currentImage?.lens_model ? `镜头:${currentImage.lens_model}` : null,
                  ].filter((item): item is string => Boolean(item))
                  const captureMuseumName = formatMetaValue(currentImage?.capture_museum_name)
                  const exhibitionName = formatMetaValue(currentImage?.exhibition_name)
                  const capturedAt = formatMetaDate(currentImage?.captured_at)
                  const uploadedAt = formatMetaDate(currentImage?.uploaded_at)
                  const coordinates =
                    currentImage?.latitude !== null &&
                    currentImage?.latitude !== undefined &&
                    currentImage?.longitude !== null &&
                    currentImage?.longitude !== undefined
                      ? `${currentImage.latitude}, ${currentImage.longitude}`
                      : ""
                  const shutterSpeed = formatMetaValue(currentImage?.shutter_speed)
                  const aperture = formatMetaValue(currentImage?.aperture)
                  const iso = formatMetaValue(currentImage?.iso)

                  return (
                    <>
                      <div className="gallery-modal-media">
                        {currentImage ? (
                          <>
                            <img
                              className="gallery-modal-main-img"
                              src={getDisplayImageUrl(apiBaseUrl, currentImage.url, "original")}
                              alt={active.name}
                            />
                            {active.images.length > 1 ? (
                              <div className={`gallery-modal-thumbs ${editing ? "edit-lock" : ""}`}>
                                {active.images.map((image, index) => (
                                  <button
                                    type="button"
                                    key={image.id}
                                    className={`gallery-modal-thumb ${index === activeImageIndex ? "active" : ""}`}
                                    onClick={() => setActiveImageIndex(index)}
                                    aria-label={`查看第 ${index + 1} 张`}
                                    disabled={editing || saving}
                                  >
                                    <img
                                      src={getDisplayImageUrl(apiBaseUrl, image.url, "thumb")}
                                      alt={active.name}
                                      loading="lazy"
                                    />
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="gallery-modal-empty">暂无图片</div>
                        )}
                      </div>

                      <div className="gallery-modal-info">
                        <div className="gallery-detail-head">
                          <div className="gallery-title-block">
                            <h3 className="gallery-detail-title">{active.name}</h3>
                            {currentImage ? (
                              <p className="muted small">
                                当前查看第 {activeImageIndex + 1} 张图
                                {editing ? "，正在编辑这张图的拍摄信息" : ""}
                              </p>
                            ) : null}
                          </div>
                          <div className="gallery-actions">
                            {!editing ? (
                              <button type="button" className="ghost" onClick={handleStartEdit}>
                                编辑资料
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="ghost"
                                  onClick={handleCancelEdit}
                                  disabled={saving}
                                >
                                  取消编辑
                                </button>
                                <button
                                  type="submit"
                                  form="gallery-edit-form"
                                  className="primary"
                                  disabled={saving}
                                >
                                  {saving ? "保存中..." : "保存修改"}
                                </button>
                              </>
                            )}
                            {currentImage && !editing ? (
                              <a
                                href={getDisplayImageUrl(apiBaseUrl, currentImage.url, "original")}
                                target="_blank"
                                rel="noreferrer"
                                className="gallery-link-button"
                              >
                                查看原图
                              </a>
                            ) : null}
                          </div>
                        </div>

                        {editing && editForm ? (
                          <form id="gallery-edit-form" className="gallery-edit-form" onSubmit={handleSave}>
                            <p className="muted small gallery-edit-note">
                              名称、时代、馆藏、描述会更新整条文物记录；下方拍摄参数仅更新当前这张图片。
                            </p>
                            <div className="gallery-edit-scroll">
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
                                          value={editForm.museumName}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, museumName: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：南京博物院"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>文物名称</span>
                                        <input
                                          value={editForm.name}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, name: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：如意云纹金盘"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>时代</span>
                                        <input
                                          value={editForm.era}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, era: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：元代"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>标签</span>
                                        <div className="tag-editor">
                                          <div className="tag-editor-chips">
                                            {editForm.tags.length > 0 ? (
                                              editForm.tags.map((tag) => (
                                                <span key={tag} className="tag-chip">
                                                  {tag}
                                                  <button
                                                    type="button"
                                                    onClick={() => removeTag(tag)}
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
                                            value={tagInput}
                                            onChange={(event) => setTagInput(event.target.value)}
                                            onKeyDown={(event) => {
                                              if (event.key === "Enter" || event.key === "," || event.key === "，") {
                                                event.preventDefault()
                                                addTags(tagInput)
                                              }
                                              if (
                                                event.key === "Backspace" &&
                                                !tagInput &&
                                                editForm.tags.length > 0
                                              ) {
                                                removeTag(editForm.tags[editForm.tags.length - 1])
                                              }
                                            }}
                                            onBlur={() => addTags(tagInput)}
                                            placeholder="输入后回车或逗号添加"
                                          />
                                        </div>
                                      </label>
                                    </div>
                                    <label className="field">
                                      <span>描述</span>
                                      <textarea
                                        rows={4}
                                        value={editForm.description}
                                        onChange={(event) =>
                                          setEditForm((current) =>
                                            current ? { ...current, description: event.target.value } : current,
                                          )
                                        }
                                        placeholder="文物简介，可补充或修正"
                                      />
                                    </label>
                                  </div>
                                </section>

                                <section className="form-section">
                                  <div className="form-section-head">
                                    <span className="form-section-kicker">CAPTURE</span>
                                    <h3>当前图片信息</h3>
                                  </div>
                                  <div className="form-section-body">
                                    <div className="field-row">
                                      <label className="field">
                                        <span>机型</span>
                                        <input
                                          value={editForm.cameraModel}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, cameraModel: event.target.value } : current,
                                            )
                                          }
                                          placeholder="自动读取后可补充修正"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>镜头</span>
                                        <input
                                          value={editForm.lensModel}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, lensModel: event.target.value } : current,
                                            )
                                          }
                                          placeholder="自动读取后可补充修正"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>拍摄时博物馆</span>
                                        <input
                                          value={editForm.captureMuseumName}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, captureMuseumName: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：南京博物院"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>展览</span>
                                        <input
                                          value={editForm.exhibitionName}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, exhibitionName: event.target.value } : current,
                                            )
                                          }
                                          placeholder="默认常设，可直接修改"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>纬度</span>
                                        <input
                                          value={editForm.latitude}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, latitude: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：32.060255"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>经度</span>
                                        <input
                                          value={editForm.longitude}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, longitude: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：118.796877"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>拍摄时间</span>
                                        <input
                                          value={editForm.capturedAt}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, capturedAt: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：2024-05-01T14:30:00"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>修图方式</span>
                                        <select
                                          value={editForm.editMethod}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, editMethod: event.target.value } : current,
                                            )
                                          }
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
                                          value={editForm.shutterSpeed}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, shutterSpeed: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：1/125s"
                                        />
                                      </label>
                                      <label className="field">
                                        <span>光圈</span>
                                        <input
                                          value={editForm.aperture}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, aperture: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：f/2.8"
                                        />
                                      </label>
                                    </div>
                                    <div className="field-row">
                                      <label className="field">
                                        <span>ISO</span>
                                        <input
                                          value={editForm.iso}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, iso: event.target.value } : current,
                                            )
                                          }
                                          placeholder="例如：400"
                                        />
                                      </label>
                                      <div className="field">
                                        <span>上传时间</span>
                                        <input value={uploadedAt} readOnly placeholder="暂无记录" />
                                      </div>
                                    </div>
                                  </div>
                                </section>
                              </div>
                            </div>
                            <div className="form-footer gallery-form-footer">
                              {saveError ? (
                                <p className="error-text">{saveError}</p>
                              ) : saveNotice ? (
                                <p className="success-text">{saveNotice}</p>
                              ) : (
                                <span />
                              )}
                              <button type="submit" className="primary gallery-bottom-save" disabled={saving}>
                                {saving ? "保存中..." : "保存修改"}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <div className="gallery-detail-lines">
                            {saveNotice ? <p className="success-text gallery-save-notice">{saveNotice}</p> : null}
                            <div className="gallery-detail-line">
                              <span className="gallery-detail-label">时代</span>
                              <span className="gallery-detail-value">{active.era || "待确认"}</span>
                            </div>
                            <div className="gallery-detail-line">
                              <span className="gallery-detail-label">馆藏</span>
                              <span className="gallery-detail-value">{active.museum_name || "待识别"}</span>
                            </div>
                            {subjectTags.length > 0 ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">标签</span>
                                <div className="tag-row">
                                  {subjectTags.map((tag) => (
                                    <span key={tag}>{tag}</span>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {equipmentMeta.length > 0 ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">设备</span>
                                <div className="tag-row">
                                  {equipmentMeta.map((tag) => (
                                    <span key={tag}>{tag}</span>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {captureMuseumName ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">拍摄馆</span>
                                <span className="gallery-detail-value">{captureMuseumName}</span>
                              </div>
                            ) : null}
                            {exhibitionName ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">展览</span>
                                <span className="gallery-detail-value">{exhibitionName}</span>
                              </div>
                            ) : null}
                            {capturedAt ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">拍摄时间</span>
                                <span className="gallery-detail-value">{capturedAt}</span>
                              </div>
                            ) : null}
                            {uploadedAt ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">上传时间</span>
                                <span className="gallery-detail-value">{uploadedAt}</span>
                              </div>
                            ) : null}
                            {coordinates ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">经纬度</span>
                                <span className="gallery-detail-value">{coordinates}</span>
                              </div>
                            ) : null}
                            {shutterSpeed ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">快门</span>
                                <span className="gallery-detail-value">{shutterSpeed}</span>
                              </div>
                            ) : null}
                            {aperture ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">光圈</span>
                                <span className="gallery-detail-value">{aperture}</span>
                              </div>
                            ) : null}
                            {iso ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">ISO</span>
                                <span className="gallery-detail-value">{iso}</span>
                              </div>
                            ) : null}
                            {currentImage?.edit_method ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">修图方式</span>
                                <span className="gallery-detail-value">{currentImage.edit_method}</span>
                              </div>
                            ) : null}
                            {active.exhibitions.length > 0 ? (
                              <div className="gallery-detail-line">
                                <span className="gallery-detail-label">历史展出</span>
                                <div className="tag-row">
                                  {active.exhibitions.map((exhibition) => (
                                    <span key={exhibition.id}>
                                      {exhibition.museum_name} · {exhibition.name}
                                      {exhibition.start_at || exhibition.end_at
                                        ? ` (${exhibition.start_at?.slice(0, 10) ?? "未知"} - ${exhibition.end_at?.slice(0, 10) ?? "至今"})`
                                        : ""}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {active.description ? (
                              <div className="gallery-detail-line gallery-detail-desc">
                                <span className="gallery-detail-label">描述</span>
                                <div className="gallery-detail-value">
                                  <p className="result-desc">{active.description}</p>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </>
                  )
                })()}
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  )
}
