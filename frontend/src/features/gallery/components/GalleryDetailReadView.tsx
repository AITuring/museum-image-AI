import { Tag } from "antd"
import {
  Aperture,
  Building2,
  CalendarRange,
  Camera,
  CircleDot,
  Clock3,
  FileText,
  Gauge,
  History,
  MapPin,
  SlidersHorizontal,
  Tag as TagIcon,
  Timer,
} from "lucide-react"
import type { GalleryArtifact, GalleryImage } from "../lib/galleryTypes"

type Props = {
  artifact: GalleryArtifact
  currentImage: GalleryImage | null
  capturedAt: string
  shutterSpeed: string
  aperture: string
  iso: string
  subjectTags: string[]
  saveNotice: string | null
  exhibitionLinks: Array<{ id: number; href: string; label: string }>
}

export function GalleryDetailReadView({
  artifact,
  currentImage,
  capturedAt,
  shutterSpeed,
  aperture,
  iso,
  subjectTags,
  saveNotice,
  exhibitionLinks,
}: Props) {
  return (
    <div className="gallery-detail-lines">
      {saveNotice ? <p className="success-text gallery-save-notice">{saveNotice}</p> : null}
      <section className="gallery-info-section">
        <div className="gallery-info-grid">
          <div className="gallery-info-item">
            <span className="gallery-info-label">
              <History size={14} className="gallery-detail-label-icon" aria-hidden="true" />
              <span>时代</span>
            </span>
            <span className="gallery-info-value">{artifact.era || "待确认"}</span>
          </div>
          <div className="gallery-info-item">
            <span className="gallery-info-label">
              <Building2 size={14} className="gallery-detail-label-icon" aria-hidden="true" />
              <span>馆藏</span>
            </span>
            <span className="gallery-info-value">{artifact.museum_name || "待识别"}</span>
          </div>
          {capturedAt ? (
            <div className="gallery-info-item gallery-info-item-wide">
              <span className="gallery-info-label">
                <Clock3 size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                <span>拍摄时间</span>
              </span>
              <span className="gallery-info-value">{capturedAt}</span>
            </div>
          ) : null}
          <div className="gallery-info-item gallery-info-item-wide">
            <span className="gallery-info-label">
              <MapPin size={14} className="gallery-detail-label-icon" aria-hidden="true" />
              <span>出土地点</span>
            </span>
            <span className="gallery-info-value">{artifact.Place_of_Excavation || "待补充"}</span>
          </div>
          {subjectTags.length > 0 ? (
            <div className="gallery-info-item gallery-info-item-wide">
              <span className="gallery-info-label">
                <TagIcon size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                <span>标签</span>
              </span>
              <div className="gallery-badge-row">
                {subjectTags.map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </div>
            </div>
          ) : null}
          {exhibitionLinks.length > 0 ? (
            <div className="gallery-info-item gallery-info-item-wide">
              <span className="gallery-info-label">
                <CalendarRange size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                <span>历史展出</span>
              </span>
              <div className="gallery-badge-row">
                {exhibitionLinks.map((exhibition) => (
                  <a key={exhibition.id} className="gallery-exhibition-link" href={exhibition.href}>
                    {exhibition.label}
                  </a>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>
      {(currentImage?.camera_model || currentImage?.lens_model || shutterSpeed || aperture || iso) ? (
        <section className="gallery-info-section gallery-camera-card">
          <header className="gallery-info-section-head">
            <div className="gallery-card-title">
              <SlidersHorizontal size={15} aria-hidden="true" />
              <span>相机参数</span>
            </div>
          </header>
          <div className="gallery-camera-grid">
            {currentImage?.camera_model ? (
              <div className="gallery-camera-item">
                <span className="gallery-info-label">
                  <Camera size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                  <span>相机</span>
                </span>
                <span className="gallery-info-value">{currentImage.camera_model}</span>
              </div>
            ) : null}
            {currentImage?.lens_model ? (
              <div className="gallery-camera-item gallery-camera-item-lens">
                <span className="gallery-info-label">
                  <CircleDot size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                  <span>镜头</span>
                </span>
                <span className="gallery-info-value">{currentImage.lens_model}</span>
              </div>
            ) : null}
            {shutterSpeed ? (
              <div className="gallery-camera-item">
                <span className="gallery-info-label">
                  <Timer size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                  <span>快门</span>
                </span>
                <span className="gallery-info-value">{shutterSpeed}</span>
              </div>
            ) : null}
            {aperture ? (
              <div className="gallery-camera-item">
                <span className="gallery-info-label">
                  <Aperture size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                  <span>光圈</span>
                </span>
                <span className="gallery-info-value">{aperture}</span>
              </div>
            ) : null}
            {iso ? (
              <div className="gallery-camera-item">
                <span className="gallery-info-label">
                  <Gauge size={14} className="gallery-detail-label-icon" aria-hidden="true" />
                  <span>ISO</span>
                </span>
                <span className="gallery-info-value">{iso}</span>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      <section className="gallery-info-section gallery-description-card">
        <header className="gallery-info-section-head">
          <div className="gallery-card-title">
            <FileText size={15} aria-hidden="true" />
            <span>描述</span>
          </div>
        </header>
        <div>
          <p className="gallery-description-copy">{artifact.description || "暂未补充，可在闲暇时使用 AI 生成后检查保存。"}</p>
        </div>
      </section>
    </div>
  )
}
