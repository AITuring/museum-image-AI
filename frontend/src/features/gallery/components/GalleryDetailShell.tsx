import { Button } from "antd"
import { ArrowLeft, ChevronLeft, ChevronRight, Maximize2 } from "lucide-react"
import { type ReactNode } from "react"
import { getBackendImageVariantUrl, toAbsoluteUrl } from "../lib/galleryArtifactIdentity"
import type { GalleryArtifact, GalleryImage } from "../lib/galleryTypes"
import { FallbackImage } from "./FallbackImage"

type Props = {
  apiBaseUrl: string
  artifact: GalleryArtifact
  currentImage: GalleryImage | null
  currentImageName: string
  activeImageIndex: number
  editing: boolean
  saving: boolean
  generatingDescription: boolean
  editFormId: string
  returnLabel: string
  thumbnailStripRef: React.RefObject<HTMLDivElement | null>
  onBack: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onOpenPreview: (index: number) => void
  onSelectImage: (index: number) => void
  children: ReactNode
}

export function GalleryDetailShell({
  apiBaseUrl,
  artifact,
  currentImage,
  currentImageName,
  activeImageIndex,
  editing,
  saving,
  generatingDescription,
  editFormId,
  returnLabel,
  thumbnailStripRef,
  onBack,
  onStartEdit,
  onCancelEdit,
  onOpenPreview,
  onSelectImage,
  children,
}: Props) {
  return (
    <article
      className={`gallery-detail-page gallery-modal-body ${editing ? "is-editing" : "is-reading"}`}
      aria-labelledby={`gallery-detail-title-${artifact.id}`}
    >
      <header className="gallery-detail-head gallery-route-detail-head">
        <Button
          htmlType="button"
          type="text"
          className="gallery-back-button"
          onClick={onBack}
          aria-label={`返回${returnLabel}`}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span className="sr-only">返回{returnLabel}</span>
        </Button>
        <div className="gallery-detail-heading">
          {editing ? <span className="gallery-edit-kicker">编辑文物资料</span> : null}
          <h3 id={`gallery-detail-title-${artifact.id}`} className="gallery-detail-title">
            {artifact.name}
          </h3>
        </div>
        <div className="gallery-actions" onClick={(event) => event.stopPropagation()}>
          {editing ? (
            <>
              <Button
                htmlType="button"
                type="default"
                onClick={onCancelEdit}
                disabled={saving || generatingDescription}
              >
                取消编辑
              </Button>
              <Button
                htmlType="submit"
                type="primary"
                form={editFormId}
                disabled={saving || generatingDescription}
              >
                {saving ? "正在保存…" : generatingDescription ? "正在生成描述…" : "保存修改"}
              </Button>
            </>
          ) : (
            <Button htmlType="button" type="default" onClick={onStartEdit}>
              编辑资料
            </Button>
          )}
        </div>
      </header>
      <div className={`gallery-modal-media ${currentImage ? "has-image" : ""}`}>
        {currentImage ? (
          <>
            <div className="gallery-modal-main-stage">
              <button
                data-ui="interactive-surface"
                type="button"
                className="gallery-modal-image-hitarea"
                onClick={() => onOpenPreview(activeImageIndex)}
                aria-label={`放大查看第 ${activeImageIndex + 1} 张图片`}
              >
                <FallbackImage
                  key={currentImage.id}
                  className="gallery-modal-main-img"
                  src={getBackendImageVariantUrl(apiBaseUrl, currentImage.url, 1280)}
                  fallbackSrc={toAbsoluteUrl(apiBaseUrl, currentImage.url)}
                  alt={artifact.name}
                  width={1280}
                  height={960}
                />
              </button>
              <span className="gallery-media-image-name">{currentImageName}</span>
              <div className="gallery-media-stage-meta">
                <span className="gallery-media-stage-counter">
                  {activeImageIndex + 1} / {artifact.images.length}
                </span>
                <button
                  type="button"
                  className="gallery-media-expand-button"
                  onClick={() => onOpenPreview(activeImageIndex)}
                  aria-label="进入沉浸式大图查看"
                >
                  <Maximize2 size={15} aria-hidden="true" />
                </button>
              </div>
              {artifact.images.length > 1 && !editing ? (
                <>
                  <button
                    type="button"
                    className="gallery-media-nav is-previous"
                    onClick={() => onSelectImage((activeImageIndex - 1 + artifact.images.length) % artifact.images.length)}
                    aria-label="查看上一张图片"
                  >
                    <ChevronLeft size={20} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="gallery-media-nav is-next"
                    onClick={() => onSelectImage((activeImageIndex + 1) % artifact.images.length)}
                    aria-label="查看下一张图片"
                  >
                    <ChevronRight size={20} aria-hidden="true" />
                  </button>
                </>
              ) : null}
            </div>
            <div className="gallery-media-foot">
              {artifact.images.length > 1 ? (
                <>
                  <div ref={thumbnailStripRef} className={`gallery-modal-thumbs ${editing ? "preview-mode" : ""}`}>
                    {artifact.images.map((image, index) => (
                      <button
                        data-ui="interactive-surface"
                        type="button"
                        key={image.id}
                        className={`gallery-modal-thumb ${index === activeImageIndex ? "active" : ""}`}
                        data-image-index={index}
                        onClick={() => {
                          if (editing) {
                            onOpenPreview(index)
                            return
                          }
                          onSelectImage(index)
                        }}
                        aria-label={editing ? `放大查看第 ${index + 1} 张` : `查看第 ${index + 1} 张`}
                        title={editing ? "在大图查看器中打开" : undefined}
                        disabled={saving}
                      >
                        <FallbackImage
                          src={getBackendImageVariantUrl(apiBaseUrl, image.url, 160)}
                          alt={artifact.name}
                          width={160}
                          height={160}
                          loading={artifact.images.length > 20 ? "lazy" : "eager"}
                        />
                      </button>
                    ))}
                  </div>
                  <div className="gallery-media-aside">
                    <span className="gallery-media-page-indicator">
                      {activeImageIndex + 1} / {artifact.images.length}
                    </span>
                  </div>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <div className="gallery-modal-empty">暂无图片</div>
        )}
      </div>

      <div className={`gallery-modal-info ${editing ? "is-editing" : "is-reading"}`}>{children}</div>
    </article>
  )
}
