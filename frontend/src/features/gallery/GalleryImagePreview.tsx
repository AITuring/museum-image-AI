import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button, Space } from "antd"
import {
  ChevronLeft,
  ChevronRight,
  FlipHorizontal2,
  FlipVertical2,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Undo2,
  X,
} from "lucide-react"

type Point = {
  x: number
  y: number
}

type Size = {
  width: number
  height: number
}

type GalleryImagePreviewProps = {
  open: boolean
  images: Array<{ src: string; alt: string; name: string }>
  initialIndex: number
  onClose: () => void
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function normalizeRotation(rotation: number) {
  return ((rotation % 360) + 360) % 360
}

function getPreviewLayout(imageSize: Size, viewportSize: Size, scale: number, rotation: number) {
  if (imageSize.width === 0 || imageSize.height === 0 || viewportSize.width === 0 || viewportSize.height === 0) {
    return {
      baseWidth: 0,
      baseHeight: 0,
      scaledWidth: 0,
      scaledHeight: 0,
      maxOffsetX: 0,
      maxOffsetY: 0,
    }
  }

  const quarterTurn = normalizeRotation(rotation) % 180 !== 0
  const naturalWidth = quarterTurn ? imageSize.height : imageSize.width
  const naturalHeight = quarterTurn ? imageSize.width : imageSize.height
  const viewportRatio = viewportSize.width / viewportSize.height
  const imageRatio = naturalWidth / naturalHeight

  let baseWidth = viewportSize.width
  let baseHeight = viewportSize.height

  if (imageRatio > viewportRatio) {
    baseHeight = viewportSize.width / imageRatio
  } else {
    baseWidth = viewportSize.height * imageRatio
  }

  const scaledWidth = baseWidth * scale
  const scaledHeight = baseHeight * scale

  return {
    baseWidth,
    baseHeight,
    scaledWidth,
    scaledHeight,
    maxOffsetX: Math.max(0, (scaledWidth - viewportSize.width) / 2),
    maxOffsetY: Math.max(0, (scaledHeight - viewportSize.height) / 2),
  }
}

function clampOffset(offset: Point, maxOffsetX: number, maxOffsetY: number) {
  return {
    x: clamp(offset.x, -maxOffsetX, maxOffsetX),
    y: clamp(offset.y, -maxOffsetY, maxOffsetY),
  }
}

export default function GalleryImagePreview({ open, images, initialIndex, onClose }: GalleryImagePreviewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [flipX, setFlipX] = useState(false)
  const [flipY, setFlipY] = useState(false)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const [imageSize, setImageSize] = useState<Size>({ width: 0, height: 0 })
  const [viewportSize, setViewportSize] = useState<Size>({ width: 0, height: 0 })
  const [dragging, setDragging] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  const currentImage = images[currentIndex] ?? images[0]
  const src = currentImage?.src ?? ""
  const alt = currentImage?.alt ?? ""

  useEffect(() => {
    if (!open) {
      return
    }
    setScale(1)
    setRotation(0)
    setFlipX(false)
    setFlipY(false)
    setOffset({ x: 0, y: 0 })
    setImageSize({ width: 0, height: 0 })
  }, [open, src])

  useEffect(() => {
    if (open) setCurrentIndex(initialIndex)
  }, [initialIndex, open])

  const selectRelativeImage = useCallback((direction: -1 | 1) => {
    if (images.length < 2) return
    setCurrentIndex((current) => (current + direction + images.length) % images.length)
  }, [images.length])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      } else if (event.key === "ArrowLeft") {
        event.preventDefault()
        selectRelativeImage(-1)
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        selectRelativeImage(1)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose, open, selectRelativeImage])

  useEffect(() => {
    if (!open || !viewportRef.current) {
      return
    }

    const node = viewportRef.current
    const updateViewportSize = () => {
      setViewportSize({
        width: node.clientWidth,
        height: node.clientHeight,
      })
    }

    updateViewportSize()
    const observer = new ResizeObserver(updateViewportSize)
    observer.observe(node)

    return () => observer.disconnect()
  }, [open, src])

  const layout = useMemo(
    () => getPreviewLayout(imageSize, viewportSize, scale, rotation),
    [imageSize, viewportSize, scale, rotation],
  )

  useEffect(() => {
    setOffset((current) => clampOffset(current, layout.maxOffsetX, layout.maxOffsetY))
  }, [layout.maxOffsetX, layout.maxOffsetY])

  const minimap = useMemo(() => {
    if (imageSize.width === 0 || imageSize.height === 0 || viewportSize.width === 0 || viewportSize.height === 0) {
      return null
    }

    const shellWidth = 168
    const shellHeight = 112
    const quarterTurn = normalizeRotation(rotation) % 180 !== 0
    const mapWidth = quarterTurn ? imageSize.height : imageSize.width
    const mapHeight = quarterTurn ? imageSize.width : imageSize.height
    const fit = Math.min(shellWidth / mapWidth, shellHeight / mapHeight)
    const contentWidth = mapWidth * fit
    const contentHeight = mapHeight * fit
    const contentLeft = (shellWidth - contentWidth) / 2
    const contentTop = (shellHeight - contentHeight) / 2
    const viewportRectWidth =
      layout.scaledWidth > 0 ? contentWidth * Math.min(1, viewportSize.width / layout.scaledWidth) : contentWidth
    const viewportRectHeight =
      layout.scaledHeight > 0 ? contentHeight * Math.min(1, viewportSize.height / layout.scaledHeight) : contentHeight
    const leftCrop = clamp(layout.maxOffsetX - offset.x, 0, Math.max(0, layout.scaledWidth - viewportSize.width))
    const topCrop = clamp(layout.maxOffsetY - offset.y, 0, Math.max(0, layout.scaledHeight - viewportSize.height))
    const viewportLeft =
      layout.scaledWidth > 0 ? contentLeft + (contentWidth * leftCrop) / layout.scaledWidth : contentLeft
    const viewportTop =
      layout.scaledHeight > 0 ? contentTop + (contentHeight * topCrop) / layout.scaledHeight : contentTop

    return {
      shellWidth,
      shellHeight,
      contentWidth,
      contentHeight,
      contentLeft,
      contentTop,
      viewportRectWidth,
      viewportRectHeight,
      viewportLeft,
      viewportTop,
    }
  }, [imageSize, layout, offset.x, offset.y, rotation, viewportSize.height, viewportSize.width])

  const previewTransform = useMemo(
    () =>
      [
        `translate(${offset.x}px, ${offset.y}px)`,
        `rotate(${rotation}deg)`,
        `scale(${flipX ? -scale : scale}, ${flipY ? -scale : scale})`,
      ].join(" "),
    [flipX, flipY, offset.x, offset.y, rotation, scale],
  )

  const previewCanvasStyle = useMemo(
    () => ({
      width: layout.baseWidth > 0 ? `${layout.baseWidth}px` : "100%",
      height: layout.baseHeight > 0 ? `${layout.baseHeight}px` : "100%",
      transform: previewTransform,
    }),
    [layout.baseHeight, layout.baseWidth, previewTransform],
  )

  const updateOffset = useCallback(
    (nextOffset: Point) => {
      setOffset(clampOffset(nextOffset, layout.maxOffsetX, layout.maxOffsetY))
    },
    [layout.maxOffsetX, layout.maxOffsetY],
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (scale <= 1 || (layout.maxOffsetX === 0 && layout.maxOffsetY === 0)) {
        return
      }

      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: offset.x,
        originY: offset.y,
      }
      setDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [layout.maxOffsetX, layout.maxOffsetY, offset.x, offset.y, scale],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
        return
      }

      const deltaX = event.clientX - dragRef.current.startX
      const deltaY = event.clientY - dragRef.current.startY
      updateOffset({
        x: dragRef.current.originX + deltaX,
        y: dragRef.current.originY + deltaY,
      })
    },
    [updateOffset],
  )

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      return
    }

    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const handleMinimapPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!minimap || layout.scaledWidth === 0 || layout.scaledHeight === 0) {
        return
      }

      const rect = event.currentTarget.getBoundingClientRect()
      const localX = clamp(event.clientX - rect.left - minimap.contentLeft, 0, minimap.contentWidth)
      const localY = clamp(event.clientY - rect.top - minimap.contentTop, 0, minimap.contentHeight)
      const targetCenterX = (localX / minimap.contentWidth) * layout.scaledWidth
      const targetCenterY = (localY / minimap.contentHeight) * layout.scaledHeight
      const nextOffset = {
        x: layout.maxOffsetX - (targetCenterX - viewportSize.width / 2),
        y: layout.maxOffsetY - (targetCenterY - viewportSize.height / 2),
      }

      updateOffset(nextOffset)
    },
    [layout.maxOffsetX, layout.maxOffsetY, layout.scaledHeight, layout.scaledWidth, minimap, updateOffset, viewportSize.height, viewportSize.width],
  )

  if (!open) {
    return null
  }

  return (
    <div className="gallery-modal-preview" onClick={onClose}>
      <div className="gallery-image-preview-stage" onClick={(event) => event.stopPropagation()}>
        <div
          ref={viewportRef}
          className={`gallery-image-preview-viewport ${scale > 1 ? "is-zoomed" : ""} ${dragging ? "is-dragging" : ""}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onDoubleClick={() => {
            setScale((current) => current > 1 ? 1 : 2)
            setOffset({ x: 0, y: 0 })
          }}
          onWheel={(event) => {
            event.preventDefault()
            const delta = event.deltaY > 0 ? -0.2 : 0.2
            setScale((current) => clamp(Number((current + delta).toFixed(2)), 1, 8))
          }}
        >
          <div className="gallery-image-preview-canvas" style={previewCanvasStyle}>
            <img
              className="gallery-image-preview-img"
              src={src}
              alt={alt}
              onLoad={(event) =>
                setImageSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              draggable={false}
            />
          </div>
        </div>

        <div
          key={src}
          className="gallery-image-preview-meta"
          role="status"
          aria-live="polite"
        >
          <strong>{currentImage?.name || alt}</strong>
          <span>{currentIndex + 1} / {images.length}</span>
        </div>

        {images.length > 1 ? (
          <>
            <button
              type="button"
              className="gallery-image-preview-nav is-previous"
              onClick={() => selectRelativeImage(-1)}
              aria-label="查看上一张图片"
            >
              <ChevronLeft size={22} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="gallery-image-preview-nav is-next"
              onClick={() => selectRelativeImage(1)}
              aria-label="查看下一张图片"
            >
              <ChevronRight size={22} aria-hidden="true" />
            </button>
          </>
        ) : null}

        {minimap && scale > 1 ? (
          <div className="gallery-image-preview-minimap">
            <div className="gallery-image-preview-minimap-head">
              <span>Minimap</span>
              <span>{Math.round(scale * 100)}%</span>
            </div>
            <button data-ui="interactive-surface"
              type="button"
              className="gallery-image-preview-minimap-shell"
              onPointerDown={handleMinimapPointerDown}
              aria-label="通过 minimap 调整预览视口"
            >
              <img className="gallery-image-preview-minimap-img" src={src} alt="" aria-hidden="true" />
              <span
                className="gallery-image-preview-minimap-window"
                style={{
                  left: `${minimap.viewportLeft}px`,
                  top: `${minimap.viewportTop}px`,
                  width: `${minimap.viewportRectWidth}px`,
                  height: `${minimap.viewportRectHeight}px`,
                }}
              />
            </button>
          </div>
        ) : null}

        <Space.Compact className="gallery-image-preview-toolbar">
          <Button
            htmlType="button"
            ghost
            shape="circle"
            onClick={() => setScale((current) => Math.max(1, Number((current - 0.2).toFixed(2))))}
            aria-label="缩小"
            data-tooltip="缩小"
          >
            <Minus size={16} aria-hidden="true" />
          </Button>
          <Button
            htmlType="button"
            ghost
            shape="circle"
            onClick={() => setScale((current) => Math.min(8, Number((current + 0.2).toFixed(2))))}
            aria-label="放大"
            data-tooltip="放大"
          >
            <Plus size={16} aria-hidden="true" />
          </Button>
          <Button
            htmlType="button"
            ghost
            shape="circle"
            onClick={() => setRotation((current) => current - 90)}
            aria-label="左转"
            data-tooltip="左转"
          >
            <RotateCcw size={16} aria-hidden="true" />
          </Button>
          <Button
            htmlType="button"
            ghost
            shape="circle"
            onClick={() => setRotation((current) => current + 90)}
            aria-label="右转"
            data-tooltip="右转"
          >
            <RotateCw size={16} aria-hidden="true" />
          </Button>
          <Button
            htmlType="button"
            ghost
            shape="circle"
            onClick={() => setFlipX((current) => !current)}
            aria-label="水平翻转"
            data-tooltip="水平翻转"
          >
            <FlipHorizontal2 size={16} aria-hidden="true" />
          </Button>
          <Button
            htmlType="button"
            ghost
            shape="circle"
            onClick={() => setFlipY((current) => !current)}
            aria-label="垂直翻转"
            data-tooltip="垂直翻转"
          >
            <FlipVertical2 size={16} aria-hidden="true" />
          </Button>
          <Button
            htmlType="button"
            ghost
            shape="circle"
            onClick={() => {
              setScale(1)
              setRotation(0)
              setFlipX(false)
              setFlipY(false)
              setOffset({ x: 0, y: 0 })
            }}
            aria-label="重置"
            data-tooltip="重置"
          >
            <Undo2 size={16} aria-hidden="true" />
          </Button>
          <Button
            htmlType="button"
            ghost
            danger
            shape="circle"
            onClick={onClose}
            aria-label="关闭原比例预览"
            data-tooltip="关闭"
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </Space.Compact>
      </div>
    </div>
  )
}
