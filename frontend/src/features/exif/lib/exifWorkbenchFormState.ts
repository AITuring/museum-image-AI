import type {
  ExifWorkbenchItem,
  ExistingArtifact,
  FormState,
  ParsedArtifactName,
} from "../components/types"
import { ensureCandidates, fileBaseName, uniqueTags } from "./exifFormDomain"

export const EMPTY_FORM: FormState = {
  museumName: "",
  name: "",
  era: "",
  placeOfExcavation: "",
  displayLocationName: "",
  exhibitionName: "常设",
  catalogExhibitionId: null,
  catalogExhibitionSourceId: "",
  latitude: "",
  longitude: "",
  cameraModel: "",
  lensModel: "",
  capturedAt: "",
  shutterSpeed: "",
  aperture: "",
  iso: "",
  description: "",
  tags: [],
}

export function buildBaseForm(): FormState {
  return {
    ...EMPTY_FORM,
  }
}

export function cloneFormState(form: FormState): FormState {
  return {
    ...form,
    catalogExhibitionId: form.catalogExhibitionId ?? null,
    catalogExhibitionSourceId: form.catalogExhibitionSourceId ?? "",
    tags: [...form.tags],
  }
}

export type ExifHistorySnapshot = {
  items: ExifWorkbenchItem[]
  selectedId: string | null
  sharedForm: FormState
}

export function cloneHistoryItems(items: ExifWorkbenchItem[]) {
  return items.map((item) => ({
    ...item,
    form: cloneFormState(item.form),
    originalForm: cloneFormState(item.originalForm),
    parsedName: item.parsedName ? { ...item.parsedName } : null,
    candidates: ensureCandidates(item.candidates),
    unavailableProviders: [...item.unavailableProviders],
    existingArtifactCandidates: [...item.existingArtifactCandidates],
    verificationDecisions: item.verificationDecisions ? { ...item.verificationDecisions } : undefined,
  }))
}

export function createExifHistorySnapshot(
  items: ExifWorkbenchItem[],
  selectedId: string | null,
  sharedForm: FormState,
): ExifHistorySnapshot {
  return {
    items: cloneHistoryItems(items),
    selectedId,
    sharedForm: cloneFormState(sharedForm),
  }
}

export const FORM_HISTORY_LABELS: Partial<Record<keyof FormState, string>> = {
  museumName: "馆藏单位",
  name: "文物名称",
  era: "时代",
  placeOfExcavation: "出土地",
  cameraModel: "相机型号",
  lensModel: "镜头型号",
  capturedAt: "拍摄时间",
  shutterSpeed: "快门",
  aperture: "光圈",
  iso: "ISO",
  displayLocationName: "展出地点",
  exhibitionName: "对应展览",
  latitude: "纬度",
  longitude: "经度",
  description: "描述",
  tags: "标签",
}

export function historyFieldValue(key: keyof FormState, value: FormState[keyof FormState]) {
  if (key === "tags") {
    const tags = value as string[]
    return tags.length > 0 ? tags.join("、").slice(0, 32) : "空"
  }
  const text = String(value ?? "").trim()
  if (key === "description") return text ? `${text.length} 字` : "空"
  return text ? (text.length > 28 ? `${text.slice(0, 28)}…` : text) : "空"
}

export function describeFormChange(
  current: FormState,
  patch: Partial<FormState>,
  changedKeys: Array<keyof FormState>,
) {
  if (changedKeys.length !== 1) {
    return changedKeys.map((key) => FORM_HISTORY_LABELS[key] ?? String(key)).join("、")
  }
  const key = changedKeys[0]
  return `${FORM_HISTORY_LABELS[key] ?? String(key)}：${historyFieldValue(key, current[key])} → ${historyFieldValue(key, patch[key] as FormState[keyof FormState])}`
}

export function shouldReplaceParsedField(currentValue: string, previousParsedValue: string | null | undefined) {
  const current = currentValue.trim()
  const previous = previousParsedValue?.trim() ?? ""
  return !current || Boolean(previous && current === previous)
}

export function applyFilenameParseWithoutOverwritingEdits(
  form: FormState,
  previous: ParsedArtifactName | null,
  next: ParsedArtifactName,
): FormState {
  return {
    ...form,
    name: next.artifact_name && shouldReplaceParsedField(form.name, previous?.artifact_name)
      ? next.artifact_name
      : form.name,
    era: next.era && shouldReplaceParsedField(form.era, previous?.era)
      ? next.era
      : form.era,
    museumName: next.museum_name && shouldReplaceParsedField(form.museumName, previous?.museum_name)
      ? next.museum_name
      : form.museumName,
    placeOfExcavation: next.Place_of_Excavation
      && shouldReplaceParsedField(form.placeOfExcavation, previous?.Place_of_Excavation)
      ? next.Place_of_Excavation
      : form.placeOfExcavation,
    displayLocationName: next.museum_name
      && shouldReplaceParsedField(form.displayLocationName, previous?.museum_name)
      ? next.museum_name
      : form.displayLocationName,
  }
}

export function normalizedReuploadHintKeys(fileName: string) {
  const normalized = fileName.trim().toLocaleLowerCase("zh-CN")
  const base = fileBaseName(normalized)
  return Array.from(new Set([normalized, base].filter(Boolean)))
}

export function applyExistingArtifactToForm(form: FormState, artifact: ExistingArtifact): FormState {
  const capture = artifact.images.find((image) => (
    image.capture_location
    || image.capture_museum_name
    || image.exhibition_name
    || image.latitude !== null
    || image.longitude !== null
  ))
  return {
    ...form,
    museumName: artifact.museum_name || form.museumName,
    name: artifact.name || form.name,
    era: artifact.era ?? form.era,
    placeOfExcavation: artifact.Place_of_Excavation ?? form.placeOfExcavation,
    displayLocationName: form.displayLocationName
      || capture?.capture_location
      || capture?.capture_museum_name
      || artifact.museum_name,
    exhibitionName: capture?.exhibition_name || form.exhibitionName,
    catalogExhibitionId: capture?.catalog_exhibition_id ?? form.catalogExhibitionId,
    catalogExhibitionSourceId: capture?.catalog_exhibition_source_id || form.catalogExhibitionSourceId,
    latitude: form.latitude || capture?.latitude?.toString() || "",
    longitude: form.longitude || capture?.longitude?.toString() || "",
    description: artifact.description ?? form.description,
    // Camera and lens tags describe individual source photos, so do not copy
    // them onto a newly uploaded image. Its own EXIF fields remain authoritative.
    tags: uniqueTags(artifact.tags.filter((tag) => !/^(机型|镜头)\s*[:：]/.test(tag))),
  }
}

export function resetFormForNewArtifact(
  form: FormState,
  parsedName: ParsedArtifactName | null,
): FormState {
  // A declined match must never leave copied artifact fields in the editor.
  // Rebuild the identity from this photo's own filename parse while keeping
  // its EXIF-derived camera and GPS values intact.
  if (!parsedName) return form
  return {
    ...form,
    museumName: parsedName.museum_name ?? "",
    name: parsedName.artifact_name ?? "",
    era: parsedName.era ?? "",
    placeOfExcavation: parsedName.Place_of_Excavation ?? "",
    displayLocationName: parsedName.museum_name ?? form.displayLocationName,
    exhibitionName: "",
    catalogExhibitionId: null,
    catalogExhibitionSourceId: "",
    description: "",
    tags: [],
  }
}
