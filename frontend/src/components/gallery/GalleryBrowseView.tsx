import { Input } from "antd"
import { Images, Search } from "lucide-react"
import { getBackendImageVariantUrl, toAbsoluteUrl } from "../../lib/galleryArtifactIdentity"
import type { GalleryArtifact } from "../../lib/galleryTypes"
import { FallbackImage } from "./FallbackImage"

type Props = {
  apiBaseUrl: string
  items: GalleryArtifact[]
  loading: boolean
  error: string | null
  query: string
  submittedQuery: string
  onQueryChange: (value: string) => void
  onSearch: (event: { preventDefault(): void }) => void
  onSelectArtifact: (artifact: GalleryArtifact) => void
}

export function GalleryBrowseView({
  apiBaseUrl,
  items,
  loading,
  error,
  query,
  submittedQuery,
  onQueryChange,
  onSearch,
  onSelectArtifact,
}: Props) {
  return (
    <>
      <header className="gallery-page-head">
        <div className="gallery-page-copy">
          <h2 id="gallery-page-title">图库</h2>
          {!loading ? <span className="gallery-result-count">{items.length} 件</span> : null}
        </div>
        <form className="gallery-search" role="search" onSubmit={onSearch}>
          <Input
            prefix={<Search size={16} aria-hidden="true" />}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索名称、时代、馆藏或出土地点…"
            aria-label="图库搜索"
            name="gallery-search"
            autoComplete="off"
          />
        </form>
      </header>

      {error ? <p className="error-text">{error}</p> : null}

      {!loading && items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">🏺</span>
          <strong>{submittedQuery ? "没有匹配的文物" : "图库为空"}</strong>
          <p className="muted">{submittedQuery ? "换个关键词试试。" : "提交入库后，文物会显示在这里。"}</p>
        </div>
      ) : null}

      {loading ? (
        <div className="gallery-grid gallery-skeleton-grid" aria-label="正在加载图库" aria-busy="true">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="gallery-card gallery-skeleton-card" key={index} aria-hidden="true">
              <div className="gallery-thumb gallery-skeleton-media" />
              <div className="gallery-meta">
                <span className="gallery-skeleton-line gallery-skeleton-title" />
                <span className="gallery-skeleton-line gallery-skeleton-caption" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="gallery-grid">
          {items.map((artifact) => {
            const cover = artifact.images[0]
            return (
              <button
                data-ui="interactive-surface"
                type="button"
                key={artifact.id}
                className="gallery-card"
                onClick={() => onSelectArtifact(artifact)}
              >
                <div className="gallery-thumb">
                  {cover ? (
                    <FallbackImage
                      src={getBackendImageVariantUrl(apiBaseUrl, cover.url, 480)}
                      fallbackSrc={toAbsoluteUrl(apiBaseUrl, cover.url)}
                      alt={artifact.name}
                      width={480}
                      height={360}
                      loading="lazy"
                      onLoad={(event) => {
                        const ratio = event.currentTarget.naturalWidth / event.currentTarget.naturalHeight
                        event.currentTarget
                          .closest<HTMLElement>(".gallery-card")
                          ?.style.setProperty("--gallery-ratio", String(ratio))
                      }}
                    />
                  ) : (
                    <span className="gallery-noimg">无图</span>
                  )}
                </div>
                <div className="gallery-meta">
                  <strong className="gallery-title">{artifact.name}</strong>
                  <div className="gallery-card-meta-row">
                    <span className="gallery-card-context">
                      {artifact.era || "待确认"} · {artifact.museum_name || "待识别"}
                    </span>
                    <span className="gallery-card-image-count">
                      <Images size={13} aria-hidden="true" />
                      <span>{artifact.images.length} 张</span>
                    </span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
