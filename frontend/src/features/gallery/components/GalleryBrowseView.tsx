import { Input } from "antd"
import { Images, Search } from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import { getBackendImageVariantUrl, toAbsoluteUrl } from "../lib/galleryArtifactIdentity"
import type { GalleryArtifact } from "../lib/galleryTypes"
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
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [imageRatios, setImageRatios] = useState<Record<number, number>>({})
  const handleImageRatio = useCallback((artifactId: number, ratio: number) => {
    setImageRatios((current) => (current[artifactId] === ratio ? current : { ...current, [artifactId]: ratio }))
  }, [])

  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return

    const layout = () => {
      const cards = [...grid.querySelectorAll<HTMLElement>('.gallery-card:not(.gallery-skeleton-card)')]
      if (window.matchMedia("(max-width: 680px)").matches) {
        cards.forEach((card) => {
          card.style.removeProperty("flex")
          card.style.removeProperty("width")
          card.style.removeProperty("height")
        })
        return
      }

      const availableWidth = grid.clientWidth
      if (availableWidth <= 0 || cards.length === 0) return
      const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 6
      const targetHeight = Math.min(280, Math.max(190, availableWidth * 0.15))
      const rows: Array<{ cards: HTMLElement[]; ratioSum: number }> = []
      let currentRow: HTMLElement[] = []
      let ratioSum = 0

      cards.forEach((card, index) => {
        const artifactId = Number(card.dataset.galleryCardId)
        const ratio = imageRatios[artifactId] ?? 1.333
        const nextWidth = (ratioSum + ratio) * targetHeight + gap * currentRow.length
        if (currentRow.length > 0 && nextWidth > availableWidth) {
          rows.push({ cards: currentRow, ratioSum })
          currentRow = []
          ratioSum = 0
        }
        currentRow.push(card)
        ratioSum += ratio
        if (index === cards.length - 1) rows.push({ cards: currentRow, ratioSum })
      })

      rows.forEach((row, rowIndex) => {
        const isLastRow = rowIndex === rows.length - 1
        const rowGap = gap * Math.max(0, row.cards.length - 1)
        const naturalHeight = (availableWidth - rowGap) / row.ratioSum
        const rowHeight = isLastRow ? Math.min(targetHeight, naturalHeight) : naturalHeight
        row.cards.forEach((card) => {
          const artifactId = Number(card.dataset.galleryCardId)
          const ratio = imageRatios[artifactId] ?? 1.333
          const width = ratio * rowHeight
          card.style.flex = "0 0 auto"
          card.style.width = `${width}px`
          card.style.height = `${rowHeight}px`
        })
      })
    }

    layout()
    const observer = new ResizeObserver(layout)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [imageRatios, items])

  return (
    <>
      <header className="gallery-page-head">
        <div className="gallery-page-copy">
          <h2 id="gallery-page-title">图库</h2>
          {!loading ? (
            <span className="gallery-result-count" role="status" aria-live="polite" aria-atomic="true">
              {items.length} 件
            </span>
          ) : null}
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
            allowClear
            onPressEnter={onSearch}
          />
        </form>
      </header>

      {error ? <p className="error-text" role="alert" aria-live="assertive">{error}</p> : null}

      {!loading && items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">🏺</span>
          <strong>{submittedQuery ? "没有匹配的文物" : "图库为空"}</strong>
          <p className="muted">{submittedQuery ? "换个关键词试试。" : "提交入库后，文物会显示在这里。"}</p>
        </div>
      ) : null}

      {loading ? (
        <div ref={gridRef} className="gallery-grid gallery-skeleton-grid" aria-label="正在加载图库" aria-busy="true">
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
        <div ref={gridRef} className="gallery-grid">
          {items.map((artifact, index) => (
            <GalleryCard
              key={artifact.id}
              apiBaseUrl={apiBaseUrl}
              artifact={artifact}
              index={index}
              onImageRatio={handleImageRatio}
              onSelectArtifact={onSelectArtifact}
            />
          ))}
        </div>
      )}
    </>
  )
}

type GalleryCardProps = {
  apiBaseUrl: string
  artifact: GalleryArtifact
  index: number
  onImageRatio: (artifactId: number, ratio: number) => void
  onSelectArtifact: (artifact: GalleryArtifact) => void
}

const GalleryCard = memo(function GalleryCard({
  apiBaseUrl,
  artifact,
  index,
  onImageRatio,
  onSelectArtifact,
}: GalleryCardProps) {
  const cover = artifact.images[0]
  const variant480 = cover ? getBackendImageVariantUrl(apiBaseUrl, cover.url, 480) : ""
  const variant800 = cover ? getBackendImageVariantUrl(apiBaseUrl, cover.url, 800) : ""
  const variant1200 = cover ? getBackendImageVariantUrl(apiBaseUrl, cover.url, 1200) : ""
  const search = window.location.search

  return (
    <a
      data-ui="interactive-surface"
      data-gallery-card-id={artifact.id}
      href={`/gallery/${artifact.id}${search}`}
      className="gallery-card"
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return
        }
        event.preventDefault()
        onSelectArtifact(artifact)
      }}
    >
      <div className="gallery-thumb">
        {cover ? (
          <FallbackImage
            src={variant480}
            srcSet={`${variant480} 480w, ${variant800} 800w, ${variant1200} 1200w`}
            sizes="(max-width: 680px) 50vw, (max-width: 1440px) 25vw, 18vw"
            fallbackSrc={toAbsoluteUrl(apiBaseUrl, cover.url)}
            alt=""
            width={480}
            height={360}
            loading={index < 12 ? "eager" : "lazy"}
            fetchPriority={index < 4 ? "high" : "auto"}
            decoding="async"
            onLoad={(event) => {
              const naturalWidth = event.currentTarget.naturalWidth
              const naturalHeight = event.currentTarget.naturalHeight
              if (naturalWidth > 0 && naturalHeight > 0) {
                onImageRatio(artifact.id, naturalWidth / naturalHeight)
              }
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
    </a>
  )
})
