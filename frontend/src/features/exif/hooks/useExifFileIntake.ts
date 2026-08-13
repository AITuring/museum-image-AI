import { useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react"
import { formatCapturedAt } from "../lib/exifDisplay"
import { createFallbackPreviewUrl } from "../lib/exifPreview"
import { hasMeaningfulFormValue } from "../lib/exifFormDomain"
import { buildBaseForm, cloneFormState } from "../lib/exifWorkbenchFormState"
import {
  artifactReviewIdentityKey,
  lookupExistingArtifactCandidates,
  parseArtifactName,
  resolveMuseum,
} from "../lib/exifArtifactLookup"
import { writeReuploadHints } from "../lib/exifDraftRecovery"
import type {
  ExifWorkbenchItem,
  ExistingArtifactMatch,
  ImageExifMetadata,
  ParsedArtifactName,
  SubmitNotice,
  UploadActivity,
  WritableFileHandle,
} from "../components/types"
import type { FormState } from "../components/types"

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

const BACKGROUND_ENRICHMENT_CONCURRENCY = 2

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await task(values[index], index)
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(concurrency, 1), values.length) },
      () => worker(),
    ),
  )
  return results
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
  const backgroundBatchRef = useRef(0)

  function updateQueuedItem(
    itemId: string,
    updater: (item: ExifWorkbenchItem) => ExifWorkbenchItem,
  ) {
    const nextItems = itemsRef.current.map((item) => item.id === itemId ? updater(item) : item)
    itemsRef.current = nextItems
    setItems(nextItems)
  }
  async function createItem(
    file: File,
    index: number,
    fileHandle: WritableFileHandle | null = null,
  ): Promise<ExifWorkbenchItem> {
    let parsedName: ParsedArtifactName | null = null
    let form = buildBaseForm()
    let previewUrl = ""

    const metadataTask = (async () => {
      const exifForm = new FormData()
      exifForm.append("file", file)
      return fetchJson<ImageExifMetadata>(`${apiBaseUrl}/api/artifacts/extract-exif-file`, {
        method: "POST",
        body: exifForm,
      })
    })()
    const parsedNameTask = parseArtifactName(apiBaseUrl, file.name)
    const [metadataResult, parsedNameResult] = await Promise.allSettled([metadataTask, parsedNameTask])

    if (metadataResult.status === "fulfilled") {
      const metadata = metadataResult.value
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
      previewUrl = metadata.preview_data_url ?? ""
    }

    if (parsedNameResult.status === "fulfilled") {
      parsedName = parsedNameResult.value
      form = {
        ...form,
        museumName: parsedName.museum_name ?? form.museumName,
        name: parsedName.artifact_name ?? form.name,
        era: parsedName.era ?? form.era,
        placeOfExcavation: parsedName.Place_of_Excavation ?? form.placeOfExcavation,
        displayLocationName: parsedName.museum_name ?? form.displayLocationName,
      }
    }

    if (!previewUrl) {
      try {
        previewUrl = await createFallbackPreviewUrl(file)
      } catch {
        // The preview helper already has a placeholder fallback; keep the item
        // usable even if a browser-specific decoder fails unexpectedly.
      }
    }

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
      descriptionMeta: null,
      existingArtifactId: null,
      existingArtifactMatch: null,
      existingArtifactCandidates: [],
      existingArtifactReviewKey: artifactReviewIdentityKey(form) || null,
      submitState: "idle",
      submitMessage: null,
      uploadProgress: 0,
      uploadStage: null,
      sourceHash: null,
    }
  }

  async function enrichOptionalMetadata(item: ExifWorkbenchItem) {
    const locationTask = item.form.latitude && item.form.longitude
      ? reverseGeocodeCoordinates(Number(item.form.latitude), Number(item.form.longitude))
      : Promise.resolve("")
    const museumTask = item.parsedName?.museum_name
      ? resolveMuseum(apiBaseUrl, item.parsedName.museum_name)
      : Promise.resolve(null)

    const [locationResult, museumResult] = await Promise.allSettled([locationTask, museumTask])
    const locationName = locationResult.status === "fulfilled" ? locationResult.value : ""
    const museum = museumResult.status === "fulfilled" ? museumResult.value : null
    if (!locationName && !museum) return

    updateQueuedItem(item.id, (current) => {
      // A user can edit the form while these optional lookups are in flight.
      // Only fill fields that are still empty, and keep the automatic values in
      // the baseline so they do not become spurious manual changes.
      const nextForm = { ...current.form }
      const nextOriginalForm = { ...current.originalForm }
      if (!nextForm.displayLocationName && locationName) {
        nextForm.displayLocationName = locationName
        nextOriginalForm.displayLocationName = locationName
      }
      if (!nextForm.latitude && museum?.latitude != null) {
        const latitude = museum.latitude.toString()
        nextForm.latitude = latitude
        nextOriginalForm.latitude = latitude
      }
      if (!nextForm.longitude && museum?.longitude != null) {
        const longitude = museum.longitude.toString()
        nextForm.longitude = longitude
        nextOriginalForm.longitude = longitude
      }
      return { ...current, form: nextForm, originalForm: nextOriginalForm }
    })
  }

  async function enrichItem(item: ExifWorkbenchItem) {
    void enrichOptionalMetadata(item).catch(() => {
      // Optional location enrichment must never turn into an unhandled
      // rejection or affect the fast intake path.
    })

    const identity = artifactReviewIdentityKey(item.form)
    if (!identity) return { itemId: item.id, candidates: [] }

    let candidates: ExistingArtifactMatch[] = []
    try {
      candidates = await lookupExistingArtifactCandidates(apiBaseUrl, item.form)
    } catch {
      // Candidate matching is best-effort; a cloud timeout must not block
      // quick entry or surface as an unhandled background promise.
    }
    updateQueuedItem(item.id, (current) => {
      // If the operator changed the identity while the cloud lookup was in
      // flight, let the editor effect perform a fresh lookup for the new form.
      if (artifactReviewIdentityKey(current.form) !== identity) return current
      return {
        ...current,
        descriptionMeta: candidates.length > 0
          ? `发现 ${candidates.length} 件可能对应的已入库文物，请确认后填入。`
          : current.descriptionMeta,
        existingArtifactCandidates: candidates,
        submitMessage: candidates.length > 0
          ? "发现可能对应的已入库文物，请先选择是否复用。"
          : current.submitMessage,
      }
    })
    return { itemId: item.id, candidates }
  }

  async function startBackgroundEnrichment(
    items: ExifWorkbenchItem[],
    openPermissionAfterReview: boolean,
    completionLabel = "已读取",
  ) {
    const batchId = backgroundBatchRef.current + 1
    backgroundBatchRef.current = batchId
    await yieldToMainThread()

    const results = await mapWithConcurrency(
      items,
      BACKGROUND_ENRICHMENT_CONCURRENCY,
      enrichItem,
    )
    if (batchId !== backgroundBatchRef.current) return

    const currentItems = itemsRef.current.filter((item) => items.some((entry) => entry.id === item.id))
    const matchCount = results.filter((result) => result.candidates.length > 0).length
    setSubmitNotice({
      type: "success",
      text: `${completionLabel} ${items.length} 张图片${matchCount > 0 ? `，其中 ${matchCount} 张发现已有文物候选，请先确认选择` : "。"}`,
    })
    beginArtifactMatchReview(currentItems, openPermissionAfterReview)
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
      const baseIndex = itemsRef.current.length
      const builtItems = await mapWithConcurrency(
        nextFiles,
        BACKGROUND_ENRICHMENT_CONCURRENCY,
        async (file, index) => {
          setSubmitNotice({ type: "success", text: `正在解析 ${index + 1}/${nextFiles.length}：${file.name}` })
          const builtItem = await createItem(file, baseIndex + index)
          const nextItems = [...itemsRef.current, builtItem]
          itemsRef.current = nextItems
          setItems(nextItems)
          setSelectedId((current) => current ?? builtItem.id)
          await yieldToMainThread()
          return builtItem
        },
      )
      setSharedForm((current) => {
        if (hasMeaningfulFormValue(current)) return current
        const seedForm = builtItems.find((item) => hasMeaningfulFormValue(item.form))?.form
        return seedForm ? cloneFormState(seedForm) : current
      })
      if (builtItems.length > 0) clearHistory()
      setSubmitNotice({
        type: "success",
        text: `已读取 ${builtItems.length} 张图片，正在后台检查已有文物候选。`,
      })
      setRecentUploadedCount(builtItems.length)
      void startBackgroundEnrichment(builtItems, true)
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
    backgroundBatchRef.current += 1
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
    backgroundBatchRef.current += 1
    itemsRef.current = []
    setItems([])
    setSelectedId(null)
    setSharedForm(buildBaseForm())
    setSubmitNotice(null)
  }

  return {
    createItem,
    selectImages,
    uploadFiles,
    startBackgroundEnrichment,
    removeItem,
    clearAll,
  }
}
