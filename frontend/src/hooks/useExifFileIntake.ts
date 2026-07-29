import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react"
import { formatCapturedAt } from "../lib/exifDisplay"
import { createFallbackPreviewUrl } from "../lib/exifPreview"
import { hasMeaningfulFormValue } from "../lib/exifFormDomain"
import { buildBaseForm, cloneFormState } from "../lib/exifWorkbenchFormState"
import { artifactReviewIdentityKey, lookupExistingArtifactCandidates, resolveMuseum } from "../lib/exifArtifactLookup"
import { writeReuploadHints } from "../lib/exifDraftRecovery"
import type {
  ExifWorkbenchItem,
  ImageExifMetadata,
  ParsedArtifactName,
  SubmitNotice,
  UploadActivity,
  WritableFileHandle,
} from "../components/exif/types"
import type { FormState } from "../components/exif/types"

type FetchJson = <T>(input: string, init?: RequestInit) => Promise<T>

type UseExifFileIntakeOptions = {
  apiBaseUrl: string
  fileInputRef: RefObject<HTMLInputElement | null>
  itemsRef: MutableRefObject<ExifWorkbenchItem[]>
  setItems: Dispatch<SetStateAction<ExifWorkbenchItem[]>>
  setSelectedId: Dispatch<SetStateAction<string | null>>
  setSharedForm: Dispatch<SetStateAction<FormState>>
  setUploading: Dispatch<SetStateAction<boolean>>
  setUploadActivity: Dispatch<SetStateAction<UploadActivity>>
  setRecentUploadedCount: Dispatch<SetStateAction<number>>
  setSubmitNotice: Dispatch<SetStateAction<SubmitNotice | null>>
  clearHistory: () => void
  beginArtifactMatchReview: (items: ExifWorkbenchItem[], openPermissionAfterReview: boolean) => void
  fetchJson: FetchJson
  buildItemId: (file: File, index: number) => string
  reverseGeocodeCoordinates: (latitude: number, longitude: number) => Promise<string>
  revokePreviewUrl: (url: string) => void
  yieldToMainThread: () => Promise<void>
}

export function useExifFileIntake({
  apiBaseUrl,
  fileInputRef,
  itemsRef,
  setItems,
  setSelectedId,
  setSharedForm,
  setUploading,
  setUploadActivity,
  setRecentUploadedCount,
  setSubmitNotice,
  clearHistory,
  beginArtifactMatchReview,
  fetchJson,
  buildItemId,
  reverseGeocodeCoordinates,
  revokePreviewUrl,
  yieldToMainThread,
}: UseExifFileIntakeOptions) {
  async function createItem(
    file: File,
    index: number,
    fileHandle: WritableFileHandle | null = null,
  ): Promise<ExifWorkbenchItem> {
    let parsedName: ParsedArtifactName | null = null
    let form = buildBaseForm()
    let previewUrl = ""

    try {
      const exifForm = new FormData()
      exifForm.append("file", file)
      const metadata = await fetchJson<ImageExifMetadata>(`${apiBaseUrl}/api/artifacts/extract-exif-file`, {
        method: "POST",
        body: exifForm,
      })
      form = {
        ...form,
        cameraModel: metadata.camera_model ?? "",
        lensModel: metadata.lens_model ?? "",
        capturedAt: formatCapturedAt(metadata.captured_at),
        shutterSpeed: metadata.shutter_speed ?? "",
        aperture: metadata.aperture ?? "",
        iso: metadata.iso?.toString() ?? "",
        latitude: metadata.latitude?.toString() ?? "",
        longitude: metadata.longitude?.toString() ?? "",
      }
      if (metadata.latitude !== null && metadata.longitude !== null) {
        try {
          form = {
            ...form,
            displayLocationName: await reverseGeocodeCoordinates(metadata.latitude, metadata.longitude),
          }
        } catch {
          // GPS remains usable for nearby-museum recommendations.
        }
      }
      previewUrl = metadata.preview_data_url ?? ""
    } catch {
      // Images without readable EXIF remain fully editable.
    }

    if (!previewUrl) previewUrl = await createFallbackPreviewUrl(file)

    try {
      parsedName = await fetchJson<ParsedArtifactName>(
        `${apiBaseUrl}/api/artifacts/parse-name?${new URLSearchParams({ name: file.name }).toString()}`,
      )
      form = {
        ...form,
        museumName: parsedName.museum_name ?? form.museumName,
        name: parsedName.artifact_name ?? form.name,
        era: parsedName.era ?? form.era,
        placeOfExcavation: parsedName.Place_of_Excavation ?? form.placeOfExcavation,
        displayLocationName: parsedName.museum_name ?? form.displayLocationName,
      }
      if (parsedName.museum_name) {
        const museum = await resolveMuseum(apiBaseUrl, parsedName.museum_name)
        if (museum) {
          form = {
            ...form,
            museumName: form.museumName || museum.name,
            displayLocationName: form.displayLocationName || museum.name,
            latitude: form.latitude || museum.latitude?.toString() || "",
            longitude: form.longitude || museum.longitude?.toString() || "",
          }
        }
      }
    } catch {
      // Keep the EXIF/default form if filename parsing is unavailable.
    }

    const existingArtifactCandidates = await lookupExistingArtifactCandidates(apiBaseUrl, form)
    return {
      id: buildItemId(file, index),
      fileName: file.name,
      originalFileName: file.name,
      previewUrl,
      localFile: file,
      fileHandle,
      parsedName,
      form,
      originalForm: cloneFormState(form),
      candidates: [],
      unavailableProviders: [],
      descriptionMeta: existingArtifactCandidates.length > 0
        ? `发现 ${existingArtifactCandidates.length} 件可能对应的已入库文物，请确认后填入。`
        : null,
      existingArtifactId: null,
      existingArtifactMatch: null,
      existingArtifactCandidates,
      existingArtifactReviewKey: artifactReviewIdentityKey(form) || null,
      submitState: "idle",
      submitMessage: existingArtifactCandidates.length > 0
        ? "发现可能对应的已入库文物，请先选择是否复用。"
        : null,
      uploadProgress: 0,
      uploadStage: null,
      sourceHash: null,
    }
  }

  function selectImages() {
    fileInputRef.current?.click()
  }

  async function uploadFiles(nextFiles: File[]) {
    if (nextFiles.length === 0) {
      setSubmitNotice({ type: "error", text: "请先选择至少一张图片" })
      return
    }
    setUploadActivity("files")
    setUploading(true)
    setSubmitNotice(null)
    try {
      const builtItems: ExifWorkbenchItem[] = []
      const baseIndex = itemsRef.current.length
      for (let index = 0; index < nextFiles.length; index += 1) {
        const file = nextFiles[index]
        setSubmitNotice({ type: "success", text: `正在解析 ${index + 1}/${nextFiles.length}：${file.name}` })
        const builtItem = await createItem(file, baseIndex + index)
        builtItems.push(builtItem)
        setItems((current) => [...current, builtItem])
        setSelectedId((current) => current ?? builtItem.id)
        await yieldToMainThread()
      }
      setSharedForm((current) => {
        if (hasMeaningfulFormValue(current)) return current
        const seedForm = builtItems.find((item) => hasMeaningfulFormValue(item.form))?.form
        return seedForm ? cloneFormState(seedForm) : current
      })
      if (builtItems.length > 0) clearHistory()
      const matchCount = builtItems.filter((item) => item.existingArtifactCandidates.length > 0).length
      setSubmitNotice({
        type: "success",
        text: `已读取 ${builtItems.length} 张图片${matchCount > 0 ? `，其中 ${matchCount} 张发现已有文物候选，请先确认选择` : ""}。`,
      })
      setRecentUploadedCount(builtItems.length)
      beginArtifactMatchReview(builtItems, true)
    } catch (error) {
      setSubmitNotice({ type: "error", text: error instanceof Error ? error.message : "载入图片失败" })
    } finally {
      setUploading(false)
      setUploadActivity(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function removeItem(itemId: string) {
    const target = itemsRef.current.find((item) => item.id === itemId)
    if (!target) return
    try {
      await writeReuploadHints([target])
    } catch {
      // Removing a queue item should still work without browser storage.
    }
    revokePreviewUrl(target.previewUrl)
    clearHistory()
    const remaining = itemsRef.current.filter((item) => item.id !== itemId)
    itemsRef.current = remaining
    setItems(remaining)
    setSelectedId((current) => (current === itemId ? remaining[0]?.id ?? null : current))
  }

  async function clearAll() {
    const currentItems = [...itemsRef.current]
    try {
      await writeReuploadHints(currentItems)
    } catch {
      // Clearing the queue should still work without browser storage.
    }
    currentItems.forEach((item) => revokePreviewUrl(item.previewUrl))
    clearHistory()
    itemsRef.current = []
    setItems([])
    setSelectedId(null)
    setSharedForm(buildBaseForm())
    setSubmitNotice(null)
  }

  return { createItem, selectImages, uploadFiles, removeItem, clearAll }
}
