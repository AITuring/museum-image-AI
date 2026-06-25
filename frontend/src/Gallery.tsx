import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import {
  Aperture,
  Building2,
  Camera,
  Clock3,
  Sparkles,
  Tag,
} from "lucide-react"
import GalleryImagePreview from "./GalleryImagePreview"

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

type MuseumOption = {
  id: number
  name: string
}

type EraOption = {
  id: number
  name: string
  sort_order: number
}

type MediaMetaItem = {
  icon: "camera" | "lens" | "museum" | "exhibition" | "capturedAt" | "editMethod"
  value: string
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
  const [museumOptions, setMuseumOptions] = useState<MuseumOption[]>([])
  const [eraOptions, setEraOptions] = useState<EraOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<GalleryArtifact | null>(null)
  const [activeImageIndex, setActiveImageIndex] = useState(0)
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<GalleryEditFormState | null>(null)
  const [tagInput, setTagInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

  const fetchJson = useCallback(async <T,>(input: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(input, init)
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
    return (await response.json()) as T
  }, [])

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
    void (async () => {
      try {
        const [museums, eras] = await Promise.all([
          fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?limit=200`),
          fetchJson<EraOption[]>(`${apiBaseUrl}/api/era-options`),
        ])
        setMuseumOptions(museums)
        setEraOptions(eras)
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载联想选项失败")
      }
    })()
  }, [apiBaseUrl, fetchJson])

  useEffect(() => {
    setEditing(false)
    setEditForm(null)
    setTagInput("")
    setSaveError(null)
    setSaveNotice(null)
    setImagePreviewOpen(false)
    if (!active) return
    setActiveImageIndex(0)
  }, [active?.id])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")

      if (isEditableTarget) return
      if (event.key === "Escape") {
        if (imagePreviewOpen) {
          setImagePreviewOpen(false)
          return
        }
        if (!editing) setActive(null)
        return
      }
      if (editing || active.images.length < 2) return
      if (event.key === "ArrowRight") {
        event.preventDefault()
        setActiveImageIndex((current) => (current + 1) % active.images.length)
        return
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        setActiveImageIndex((current) => (current - 1 + active.images.length) % active.images.length)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [active, editing, imagePreviewOpen])

  function handleSearch(event: { preventDefault(): void }) {
    event.preventDefault()
    setSubmittedQuery(query)
    void load(query)
  }

  function handleStartEdit(event?: { preventDefault?: () => void; stopPropagation?: () => void }) {
    event?.preventDefault?.()
    event?.stopPropagation?.()
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

  async function handleSave(event: { preventDefault(): void }) {
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
      const nextIndex =
        updated.images.findIndex((image) => image.id === editForm.imageId) >= 0
          ? updated.images.findIndex((image) => image.id === editForm.imageId)
          : 0
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setActive(updated)
      setActiveImageIndex(nextIndex)
      setEditing(false)
      setEditForm(null)
      setTagInput("")
      setSaveNotice("已保存修改")
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
                  const editFormId = `gallery-edit-form-${active.id}`
                  const subjectTags = getSubjectTags(active.tags)
                  const equipmentMeta: MediaMetaItem[] = [
                    currentImage?.camera_model ? { icon: "camera", value: currentImage.camera_model } : null,
                    currentImage?.lens_model ? { icon: "lens", value: currentImage.lens_model } : null,
                  ].filter((item): item is MediaMetaItem => Boolean(item))
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
                  const mediaMeta: MediaMetaItem[] = [
                    ...equipmentMeta,
                    captureMuseumName ? { icon: "museum", value: captureMuseumName } : null,
                    exhibitionName ? { icon: "exhibition", value: exhibitionName } : null,
                    capturedAt ? { icon: "capturedAt", value: capturedAt } : null,
                    currentImage?.edit_method ? { icon: "editMethod", value: currentImage.edit_method } : null,
                  ].filter((item): item is MediaMetaItem => Boolean(item))
                  const stackedImages = active.images
                    .map((image, index) => ({
                      image,
                      index,
                      depth: (index - activeImageIndex + active.images.length) % active.images.length,
                    }))
                    .sort((a, b) => a.depth - b.depth)
                  const stackedPreviewImages = stackedImages
                    .filter(({ depth }) => depth < 4)
                    .sort((a, b) => b.depth - a.depth)
                  const mediaMetaIconMap = {
                    camera: Camera,
                    lens: Aperture,
                    museum: Building2,
                    exhibition: Tag,
                    capturedAt: Clock3,
                    editMethod: Sparkles,
                  } as const
                  return (
                    <>
                      <div className={`gallery-modal-media ${currentImage ? "has-image" : ""}`}>
                        {currentImage ? (
                          <>
                            <button
                              type="button"
                              className="gallery-modal-main-stage"
                              onClick={() => setImagePreviewOpen(true)}
                              aria-label={`查看第 ${activeImageIndex + 1} 张原比例大图`}
                            >
                              <img
                                className="gallery-modal-main-img"
                                src={getDisplayImageUrl(apiBaseUrl, currentImage.url, "original")}
                                alt={active.name}
                              />
                            </button>
                            <div className="gallery-media-foot">
                              {active.images.length > 1 || mediaMeta.length > 0 ? (
                                <>
                                  {active.images.length > 1 ? (
                                    <div className={`gallery-modal-thumbs ${editing ? "edit-lock" : ""}`}>
                                      {stackedPreviewImages.map(({ image, index, depth }) => (
                                        <button
                                          type="button"
                                          key={image.id}
                                          className={`gallery-modal-thumb stack-depth-${Math.min(depth, 3)} ${index === activeImageIndex ? "active" : ""}`}
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
                                  ) : (
                                    <div />
                                  )}
                                  <div className="gallery-media-aside">
                                    {currentImage ? (
                                      <span className="gallery-media-page-indicator">
                                        {activeImageIndex + 1} / {active.images.length}
                                      </span>
                                    ) : null}
                                    {mediaMeta.length > 0 ? (
                                      <div className="gallery-media-meta">
                                        {mediaMeta.map((item) => (
                                          <span key={`${item.icon}-${item.value}`}>
                                            {(() => {
                                              const Icon = mediaMetaIconMap[item.icon]
                                              return <Icon className="gallery-media-meta-icon" size={12} aria-hidden="true" />
                                            })()}
                                            <span>{item.value}</span>
                                          </span>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                </>
                              ) : null}
                            </div>
                          </>
                        ) : (
                          <div className="gallery-modal-empty">暂无图片</div>
                        )}
                      </div>

                      <div className="gallery-modal-info">
                        <div className="gallery-detail-head">
                          <div className="gallery-detail-heading">
                            <h3 className="gallery-detail-title">{active.name}</h3>
                            {currentImage ? (
                              <p className="muted small gallery-detail-meta">
                                第 {activeImageIndex + 1} 张图片
                                {editing ? "，正在整理资料" : ""}
                              </p>
                            ) : null}
                          </div>
                          <div className="gallery-actions" onClick={(event) => event.stopPropagation()}>
                            {editing ? (
                              <>
                                <button
                                  type="button"
                                  className="ghost gallery-secondary-button"
                                  onClick={handleCancelEdit}
                                  disabled={saving}
                                >
                                  取消
                                </button>
                                <button
                                  type="submit"
                                  form={editFormId}
                                  className="primary gallery-primary-button"
                                  disabled={saving}
                                >
                                  {saving ? "保存中..." : "保存"}
                                </button>
                                <button
                                  type="button"
                                  className="gallery-close"
                                  onClick={() => !editing && setActive(null)}
                                  disabled={editing}
                                  aria-label={editing ? "编辑中不可关闭弹窗" : "关闭弹窗"}
                                >
                                  ×
                                </button>
                              </>
                            ) : (
                              <>
                                <button type="button" className="gallery-toolbar-button" onClick={handleStartEdit}>
                                  编辑资料
                                </button>
                                <button
                                  type="button"
                                  className="gallery-close"
                                  onClick={() => !editing && setActive(null)}
                                  disabled={editing}
                                  aria-label={editing ? "编辑中不可关闭弹窗" : "关闭弹窗"}
                                >
                                  ×
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {editing && editForm ? (
                          <form id={editFormId} className="gallery-edit-form" onSubmit={handleSave}>
                            <p className="muted small gallery-edit-note">
                              文物名称、时代、馆藏与描述会同步到整条记录。拍摄参数只更新当前图片。
                            </p>
                            <div className="gallery-edit-scroll">
                              <div className="form-fields">
                                <section className="form-section">
                                  <div className="form-section-head">
                                    <span className="form-section-kicker">文物记录</span>
                                    <h3>基本信息</h3>
                                  </div>
                                  <div className="form-section-body">
                                    <div className="field-row">
                                      <label className="field">
                                        <span>博物馆名称</span>
                                        <input
                                          list="gallery-museum-options"
                                          value={editForm.museumName}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, museumName: event.target.value } : current,
                                            )
                                          }
                                          placeholder={
                                            museumOptions.length > 0 ? "输入或选择博物馆名称" : "加载博物馆选项中..."
                                          }
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
                                          list="gallery-era-options"
                                          value={editForm.era}
                                          onChange={(event) =>
                                            setEditForm((current) =>
                                              current ? { ...current, era: event.target.value } : current,
                                            )
                                          }
                                          placeholder={eraOptions.length > 0 ? "输入或选择时代" : "加载时代选项中..."}
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
                                    <span className="form-section-kicker">当前图片</span>
                                    <h3>拍摄信息</h3>
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
                                        <span>拍摄馆</span>
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
                                    <details className="gallery-advanced-details">
                                      <summary className="gallery-advanced-summary">
                                        <span>高级信息</span>
                                        <span className="gallery-advanced-hint">坐标与曝光参数</span>
                                      </summary>
                                      <div className="gallery-advanced-body">
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
                                    </details>
                                  </div>
                                </section>
                              </div>
                            </div>
                            {saveError ? (
                              <div className="form-footer gallery-form-footer">
                                <div className="gallery-form-status">
                                  <p className="error-text">{saveError}</p>
                                </div>
                              </div>
                            ) : null}
                          </form>
                        ) : (
                          <div className="gallery-detail-lines">
                            {saveNotice ? <p className="success-text gallery-save-notice">{saveNotice}</p> : null}
                            <section className="gallery-detail-section gallery-detail-section-primary">
                              <div className="gallery-detail-intro">
                                <div className="gallery-detail-line">
                                  <span className="gallery-detail-label">时代</span>
                                  <span className="gallery-detail-value">{active.era || "待确认"}</span>
                                </div>
                                <div className="gallery-detail-line">
                                  <span className="gallery-detail-label">馆藏</span>
                                  <span className="gallery-detail-value">{active.museum_name || "待识别"}</span>
                                </div>
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
                            </section>
                            {(coordinates || shutterSpeed || aperture || iso || uploadedAt) ? (
                              <details className="gallery-advanced-details gallery-view-advanced-details">
                                <summary className="gallery-advanced-summary">
                                  <span>高级参数</span>
                                  <span className="gallery-advanced-hint">坐标、曝光与上传时间</span>
                                </summary>
                                <div className="gallery-advanced-body">
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
                                </div>
                              </details>
                            ) : null}
                            {active.description ? (
                              <section className="gallery-detail-section gallery-detail-desc-section">
                                <div className="gallery-detail-section-head">
                                  <span className="gallery-detail-kicker">文物记录</span>
                                  <h4>描述</h4>
                                </div>
                                <div className="gallery-detail-line gallery-detail-desc">
                                  <div className="gallery-detail-value">
                                    <p className="result-desc">{active.description}</p>
                                  </div>
                                </div>
                              </section>
                            ) : null}
                          </div>
                        )}
                      </div>

                      {imagePreviewOpen && currentImage ? (
                        <GalleryImagePreview
                          open={imagePreviewOpen}
                          src={getDisplayImageUrl(apiBaseUrl, currentImage.url, "original")}
                          alt={active.name}
                          onClose={() => setImagePreviewOpen(false)}
                        />
                      ) : null}
                    </>
                  )
                })()}
              </div>
            </div>,
            document.body,
          )
        : null}
      <datalist id="gallery-museum-options">
        {museumOptions.map((museum) => (
          <option key={museum.id} value={museum.name} />
        ))}
      </datalist>
      <datalist id="gallery-era-options">
        {eraOptions.map((era) => (
          <option key={era.id} value={era.name} />
        ))}
      </datalist>
    </section>
  )
}
