import { useCallback, useEffect, useState, type FormEvent } from "react"

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

export default function Gallery({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [items, setItems] = useState<GalleryArtifact[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<GalleryArtifact | null>(null)

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

      {active ? (
        <div className="gallery-modal" onClick={() => setActive(null)}>
          <div className="gallery-modal-body" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="gallery-close" onClick={() => setActive(null)}>
              ×
            </button>
            <div className="gallery-modal-hero">
              <div className="gallery-modal-images">
                {active.images.length > 0 ? (
                  active.images.map((img) => (
                    <img
                      key={img.id}
                      src={getDisplayImageUrl(apiBaseUrl, img.url, "preview")}
                      alt={active.name}
                    />
                  ))
                ) : (
                  <div className="gallery-modal-empty">暂无图片</div>
                )}
              </div>
            </div>
            <div className="gallery-detail">
              <div className="gallery-detail-head">
                <h3 className="gallery-detail-title">{active.name}</h3>
                {active.images[0] ? (
                  <div className="gallery-actions">
                    <a
                      href={getDisplayImageUrl(apiBaseUrl, active.images[0].url, "original")}
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
                <div className="gallery-detail-line">
                  <span className="gallery-detail-label">标签</span>
                  <div className="tag-row">
                    {active.tags.length > 0 ? (
                      active.tags.map((tag) => <span key={tag}>{tag}</span>)
                    ) : (
                      <span className="gallery-detail-empty">暂无标签</span>
                    )}
                  </div>
                </div>
                <div className="gallery-detail-line gallery-detail-line-block">
                  <span className="gallery-detail-label">描述</span>
                  <div className="gallery-detail-value">
                    {active.description ? (
                      <p className="result-desc">{active.description}</p>
                    ) : (
                      <span className="gallery-detail-empty">暂无描述</span>
                    )}
                  </div>
                </div>
                <div className="gallery-detail-line gallery-detail-line-block">
                  <span className="gallery-detail-label">图片</span>
                  <div className="gallery-thumb-list">
                    {active.images.length > 0 ? (
                      active.images.map((image) => (
                        <a
                          key={image.id}
                          href={getDisplayImageUrl(apiBaseUrl, image.url, "original")}
                          target="_blank"
                          rel="noreferrer"
                          className="gallery-thumb-link"
                        >
                          <img
                            src={getDisplayImageUrl(apiBaseUrl, image.url, "thumb")}
                            alt={active.name}
                            loading="lazy"
                          />
                        </a>
                      ))
                    ) : (
                      <span className="gallery-detail-empty">暂无图片</span>
                    )}
                  </div>
                </div>
                {active.exhibitions.length > 0 ? (
                  <div className="gallery-detail-line gallery-detail-line-block">
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
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
