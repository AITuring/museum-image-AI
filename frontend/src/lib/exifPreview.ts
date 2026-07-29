import { formatFileSize } from "./fileFormat"

export type ExtractedPreview = { preview_data_url: string | null }
export type PreviewExtractor = (input: string, init: RequestInit) => Promise<ExtractedPreview>

const IMAGE_LIMIT = 24 * 1024 * 1024
const TIFF_PIXEL_LIMIT = 24_000_000

function isTiffFile(file: File) {
  return /\.(?:tif|tiff)$/i.test(file.name) || ["image/tif", "image/tiff", "application/tiff", "application/x-tiff"].includes(file.type.toLowerCase())
}

function tiffDimension(value: unknown) {
  if (typeof value === "number") return value
  if (Array.isArray(value) && typeof value[0] === "number") return value[0]
  return 0
}

async function canvasToPreviewUrl(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8))
  if (!blob) throw new Error("缩略图生成失败")
  return URL.createObjectURL(blob)
}

async function createTiffPreviewUrl(file: File) {
  if (file.size > IMAGE_LIMIT) throw new Error("TIFF 文件过大，使用轻量占位预览")
  const UTIF = await import("utif"); const buffer = await file.arrayBuffer(); const ifds = UTIF.decode(buffer)
  const mainIfd = ifds.filter((ifd) => tiffDimension(ifd.width ?? ifd.t256) > 0 && tiffDimension(ifd.height ?? ifd.t257) > 0).reduce((best, current) => !best || tiffDimension(current.width ?? current.t256) * tiffDimension(current.height ?? current.t257) > tiffDimension(best.width ?? best.t256) * tiffDimension(best.height ?? best.t257) ? current : best, undefined as (typeof ifds)[number] | undefined)
  if (!mainIfd) throw new Error("TIFF 中没有可预览的图像页")
  UTIF.decodeImage(buffer, mainIfd, ifds); const width = tiffDimension(mainIfd.width ?? mainIfd.t256); const height = tiffDimension(mainIfd.height ?? mainIfd.t257)
  if (width * height > TIFF_PIXEL_LIMIT) throw new Error("TIFF 解码尺寸过大，使用轻量占位预览")
  const source = document.createElement("canvas"); source.width = width; source.height = height; const sourceContext = source.getContext("2d")
  if (!sourceContext) throw new Error("浏览器无法生成 TIFF 预览")
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(mainIfd)), width, height), 0, 0)
  const preview = document.createElement("canvas"); const scale = Math.min(1, 640 / Math.max(width, height)); preview.width = Math.max(1, Math.round(width * scale)); preview.height = Math.max(1, Math.round(height * scale)); const context = preview.getContext("2d")
  if (!context) throw new Error("浏览器无法缩放 TIFF 预览")
  context.drawImage(source, 0, 0, preview.width, preview.height); return canvasToPreviewUrl(preview)
}

async function createRasterPreviewUrl(file: File) {
  if (file.size > IMAGE_LIMIT || !("createImageBitmap" in window)) return URL.createObjectURL(file)
  let bitmap: ImageBitmap; try { bitmap = await createImageBitmap(file, { resizeWidth: 640, resizeQuality: "high" }) } catch { return URL.createObjectURL(file) }
  try { const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale)); const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器无法生成缩略图"); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); return await canvasToPreviewUrl(canvas) } finally { bitmap.close() }
}

async function createPlaceholder(file: File) {
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 400; const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器无法生成文件占位图")
  context.fillStyle = "#f5f5f4"; context.fillRect(0, 0, 640, 400); context.fillStyle = "#d6d3d1"; context.fillRect(48, 48, 104, 128); context.fillStyle = "#44403c"; context.font = "600 34px system-ui, sans-serif"; context.fillText((file.name.split(".").pop() || "IMG").toUpperCase(), 48, 232); context.font = "500 24px system-ui, sans-serif"; context.fillText(file.name.length > 34 ? `${file.name.slice(0, 31)}...` : file.name, 48, 286); context.fillStyle = "#78716c"; context.font = "22px system-ui, sans-serif"; context.fillText(formatFileSize(file.size), 48, 326); return canvasToPreviewUrl(canvas)
}

export async function createFallbackPreviewUrl(file: File) { try { return isTiffFile(file) ? await createTiffPreviewUrl(file) : await createRasterPreviewUrl(file) } catch { return createPlaceholder(file) } }
export async function createRestoredPreviewUrl(file: File, apiBaseUrl: string, extract: PreviewExtractor) { if (file.size <= IMAGE_LIMIT || isTiffFile(file)) return createFallbackPreviewUrl(file); try { const data = new FormData(); data.append("file", file); const metadata = await extract(`${apiBaseUrl}/api/artifacts/extract-exif-file`, { method: "POST", body: data }); if (metadata.preview_data_url) return metadata.preview_data_url } catch { /* use browser fallback */ } return createFallbackPreviewUrl(file) }
