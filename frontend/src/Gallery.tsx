import { useCallback, useEffect, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"

type GalleryImage = {
  id: number
  url: string
}

type GalleryArtifact = {
  id: number
  name: string
  era: string | null
  description: string | null
  museum_name: string
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

export default function Gallery({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [items, setItems] = useState<GalleryArtifact[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<GalleryArtifact | null>(null)
  const [activeImageIndex, setActiveImageIndex] = useState(0)

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
    if (!active) return
    setActiveImageIndex(0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(null)
    }
    document.addEventListener("keydown", onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [active])

  function handleSearch(event: FormEvent) {
    event.preventDefault()
    setSubmittedQuery(query)
    void load(query)
  }

  return (
    <section className="panel form-wide">
      <div className="section-heading">
        <span className="step-badge">🔍</span>
        <div>
          <h2>图库检索</h2>
          <p className="muted">按名称、年代、博物馆或描述检索已入库文物。</p>
        </div>
      </div>

      <form className="scan-row" onSubmit={handleSearch}>
        <label className="field scan-input">
          <span>关键词</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如：青铜 / 唐代 / 南京博物院"
          />
        </label>
        <button type="submit" className="primary" disabled={loading}>
          {loading ? "检索中…" : "检索"}
        </button>
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
            <div className="gallery-modal" onClick={() => setActive(null)}>
          <div className="gallery-modal-body" onClick={(e) => e.stopPropagation()}>
            {(() => {
              const equipmentTags = active.tags.filter((tag) => /^(机型|镜头)[:：]/.test(tag))
              const subjectTags = active.tags.filter((tag) => !/^(机型|镜头)[:：]/.test(tag))
              const equipmentMeta = [
                active.camera_model ? `机型:${active.camera_model}` : null,
                active.lens_model ? `镜头:${active.lens_model}` : null,
              ].filter((item): item is string => Boolean(item))
              const captureMuseumName = formatMetaValue(active.capture_museum_name)
              const exhibitionName = formatMetaValue(active.exhibition_name)
              const capturedAt = formatMetaDate(active.captured_at)
              const uploadedAt = formatMetaDate(active.uploaded_at)
              const coordinates =
                active.latitude !== null &&
                active.latitude !== undefined &&
                active.longitude !== null &&
                active.longitude !== undefined
                  ? `${active.latitude}, ${active.longitude}`
                  : ""
              const shutterSpeed = formatMetaValue(active.shutter_speed)
              const aperture = formatMetaValue(active.aperture)
              const iso = formatMetaValue(active.iso)

              return (
                <>
            <button type="button" className="gallery-close" onClick={() => setActive(null)}>
              ×
            </button>
            <div className="gallery-modal-media">
              {active.images.length > 0 ? (
                <>
                  <img
                    className="gallery-modal-main-img"
                    src={getDisplayImageUrl(
                      apiBaseUrl,
                      (active.images[activeImageIndex] ?? active.images[0]).url,
                      "original",
                    )}
                    alt={active.name}
                  />
                  {active.images.length > 1 ? (
                    <div className="gallery-modal-thumbs">
                      {active.images.map((image, index) => (
                        <button
                          type="button"
                          key={image.id}
                          className={`gallery-modal-thumb ${index === activeImageIndex ? "active" : ""}`}
                          onClick={() => setActiveImageIndex(index)}
                          aria-label={`查看第 ${index + 1} 张`}
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
                <h3 className="gallery-detail-title">{active.name}</h3>
                {active.images.length > 0 ? (
                  <div className="gallery-actions">
                    <a
                      href={getDisplayImageUrl(
                        apiBaseUrl,
                        (active.images[activeImageIndex] ?? active.images[0]).url,
                        "original",
                      )}
                      target="_blank"
                      rel="noreferrer"
                      className="primary small"
                    >
                      查看原图
                    </a>
                  </div>
                ) : null}
              </div>

              <div className="gallery-detail-lines">
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
                {equipmentTags.length > 0 ? (
                  <div className="gallery-detail-line">
                    <span className="gallery-detail-label">设备</span>
                    <div className="tag-row">
                      {equipmentTags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  </div>
                ) : equipmentMeta.length > 0 ? (
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
