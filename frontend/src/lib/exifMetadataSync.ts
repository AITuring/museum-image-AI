import type { MetadataSyncDiffRow } from "../components/exif/MetadataSyncPreview"
import type { MetadataSyncFieldKey, MetadataSyncSelection } from "../components/exif/MetadataSyncFieldControls"
import type { FormState } from "../components/exif/types"
import { formatCapturedAt } from "./exifDisplay"

function displayValue(value: string | string[]) {
  return Array.isArray(value) ? (value.length > 0 ? value.join("、") : "未填写") : value.trim() || "未填写"
}

export function buildMetadataSyncDiffRows(target: FormState, source: FormState, field: MetadataSyncFieldKey): MetadataSyncDiffRow[] {
  const fields: Array<{ label: string; target: string | string[]; source: string | string[] }> = field === "displayLocation"
    ? [{ label: "展出地点", target: target.displayLocationName, source: source.displayLocationName }]
    : field === "exhibition"
      ? [{ label: "对应展览", target: target.exhibitionName, source: source.exhibitionName }, { label: "展览目录关联", target: target.catalogExhibitionSourceId, source: source.catalogExhibitionSourceId }]
      : field === "gps"
        ? [{ label: "纬度", target: target.latitude, source: source.latitude }, { label: "经度", target: target.longitude, source: source.longitude }]
        : field === "cameraModel"
          ? [{ label: "相机型号", target: target.cameraModel, source: source.cameraModel }]
          : field === "lensModel"
            ? [{ label: "镜头型号", target: target.lensModel, source: source.lensModel }]
            : field === "shutterSpeed"
              ? [{ label: "快门", target: target.shutterSpeed, source: source.shutterSpeed }]
              : field === "aperture"
                ? [{ label: "光圈", target: target.aperture, source: source.aperture }]
                : field === "iso"
                  ? [{ label: "ISO", target: target.iso, source: source.iso }]
                  : field === "capturedAt"
                    ? [{ label: "拍摄时间", target: formatCapturedAt(target.capturedAt), source: formatCapturedAt(source.capturedAt) }]
                    : field === "description"
                      ? [{ label: "描述", target: target.description, source: source.description }]
                      : [{ label: "标签", target: target.tags, source: source.tags }]
  return fields.map((entry) => {
    const targetValue = displayValue(entry.target)
    const sourceValue = displayValue(entry.source)
    return { label: entry.label, targetValue, sourceValue, changed: targetValue !== sourceValue, willClearTarget: sourceValue === "未填写" && targetValue !== "未填写" }
  })
}

export function applySourceMetadata(target: FormState, source: FormState, selection: MetadataSyncSelection): FormState {
  return {
    ...target,
    ...(selection.displayLocation ? { displayLocationName: source.displayLocationName } : {}),
    ...(selection.exhibition ? { exhibitionName: source.exhibitionName, catalogExhibitionId: source.catalogExhibitionId, catalogExhibitionSourceId: source.catalogExhibitionSourceId } : {}),
    ...(selection.gps ? { latitude: source.latitude, longitude: source.longitude } : {}),
    ...(selection.cameraModel ? { cameraModel: source.cameraModel } : {}),
    ...(selection.lensModel ? { lensModel: source.lensModel } : {}),
    ...(selection.shutterSpeed ? { shutterSpeed: source.shutterSpeed } : {}),
    ...(selection.aperture ? { aperture: source.aperture } : {}),
    ...(selection.iso ? { iso: source.iso } : {}),
    ...(selection.capturedAt ? { capturedAt: source.capturedAt } : {}),
    ...(selection.description ? { description: source.description } : {}),
    ...(selection.tags ? { tags: [...source.tags] } : {}),
  }
}
