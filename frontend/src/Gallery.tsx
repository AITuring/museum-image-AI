import { useCallback, useEffect, useState } from "react"

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
  images: GalleryImage[]
}

function toAbsoluteUrl(apiBaseUrl: string, url: string) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : `${apiBaseUrl}${url}`
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
        setItems((await res.json()) as GalleryArtifact[])
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

  function handleSearch(event: React.FormEvent) {
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
                  <img src={toAbsoluteUrl(apiBaseUrl, cover.url)} alt={artifact.name} loading="lazy" />
                ) : (
                  <span className="gallery-noimg">无图</span>
                )}
              </div>
              <div className="gallery-meta">
                <strong>{artifact.name}</strong>
                <span className="muted small">
                  {artifact.museum_name}
                  {artifact.era ? ` · ${artifact.era}` : ""}
                </span>
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
            <div className="gallery-modal-images">
              {active.images.map((img) => (
                <img key={img.id} src={toAbsoluteUrl(apiBaseUrl, img.url)} alt={active.name} />
              ))}
            </div>
            <h3>{active.name}</h3>
            <div className="result-meta">
              <span>时代：{active.era || "—"}</span>
              <span>馆藏：{active.museum_name}</span>
            </div>
            {active.tags.length > 0 ? (
              <div className="tag-row">
                {active.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            ) : null}
            {active.description ? <p className="result-desc">{active.description}</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
