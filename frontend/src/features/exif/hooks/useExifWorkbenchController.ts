import { useEffect, useMemo, useRef, useState } from "react"
import { useOperationHistory } from "../../../OperationHistory"
import type { ArtifactFieldWarning } from "../components/ReviewIndicators"
import { geocodeLocationName, reverseGeocodeCoordinates } from "../components/GpsMapPicker"
import { useExifMetadataSync } from "./useExifMetadataSync"
import { useExifFileIntake } from "./useExifFileIntake"
import { useExifDirectoryAuthorization } from "./useExifDirectoryAuthorization"
import { useExifDescriptionOperations } from "./useExifDescriptionOperations"
import { useExifBatchSubmission } from "./useExifBatchSubmission"
import { useExifArtifactMatchReview } from "./useExifArtifactMatchReview"
import { useExifDraftPersistence } from "./useExifDraftPersistence"
import { useExifEditorEffects } from "./useExifEditorEffects"
import { useExifSubmitOne } from "../lib/exifSubmission"
import {
  applySharedForm,
  buildItemId,
  changedParts,
  ensureCandidates,
  fileBaseName,
  hasExifMetadata,
  hasValidGpsCoordinates,
  normalizedFileName,
  toNullableNumber,
  uniqueTags,
} from "../lib/exifFormDomain"
import {
  applyFilenameParseWithoutOverwritingEdits,
  buildBaseForm,
  cloneFormState,
  cloneHistoryItems,
  createExifHistorySnapshot,
  describeFormChange,
  FORM_HISTORY_LABELS,
  type ExifHistorySnapshot,
} from "../lib/exifWorkbenchFormState"
import { parseArtifactName, resolveMuseum } from "../lib/exifArtifactLookup"
import type {
  ExistingArtifact,
  ExifWorkbenchItem,
  FormState,
  GeneratedDescription,
  LiveProviderState,
  MuseumOption,
  SubmitNotice,
  UploadActivity,
  WritableDirectoryHandle,
} from "../components/types"
import {
  patchWorkbenchItemForm,
  renameWorkbenchItem,
  replaceWorkbenchItemForm,
} from "../lib/exifWorkbenchItemMutations"

const EXIF_HISTORY_SCOPE = "exif"

function yieldToMainThread() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

function revokePreviewUrl(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url)
}

async function responseErrorMessage(response: Response, prefix?: string) {
  let detail = `HTTP ${response.status}`
  try {
    const payload = (await response.json()) as { detail?: string }
    if (payload.detail) detail = payload.detail
  } catch {
    // Keep the HTTP fallback for non-JSON proxy/server errors.
  }
  const requestId = response.headers.get("X-Request-ID")
  if (requestId) detail = `${detail}（请求编号 ${requestId.slice(0, 12)}）`
  return prefix ? `${prefix}：${detail}` : detail
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response))
  }
  return (await response.json()) as T
}

type UseExifWorkbenchControllerOptions = {
  apiBaseUrl: string
}

export function useExifWorkbenchController({ apiBaseUrl }: UseExifWorkbenchControllerOptions) {
  const {
    record: recordOperation,
    updateAfter: updateOperationAfter,
    registerScope: registerHistoryScope,
    clear: clearOperationHistory,
    setScopeDirty: setHistoryScopeDirty,
  } = useOperationHistory()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const itemsRef = useRef<ExifWorkbenchItem[]>([])
  const locatingDisplayLocationRef = useRef(false)
  const artifactMatchLookupRef = useRef(new Set<string>())
  const batchRenameRevisionRef = useRef(0)
  const filenameHistoryOperationRef = useRef(new Map<string, string>())
  const [items, setItems] = useState<ExifWorkbenchItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [directoryHandle, setDirectoryHandle] = useState<WritableDirectoryHandle | null>(null)
  const [sharedForm, setSharedForm] = useState<FormState>(buildBaseForm())
  const [uploading, setUploading] = useState(false)
  const [uploadActivity, setUploadActivity] = useState<UploadActivity>(null)
  const [bindingDirectory, setBindingDirectory] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [descriptionGeneratingItemIds, setDescriptionGeneratingItemIds] = useState<string[]>([])
  const [descriptionProgress, setDescriptionProgress] = useState<string[]>([])
  const [liveResearchSummary, setLiveResearchSummary] = useState("")
  const [liveProviders, setLiveProviders] = useState<Record<string, LiveProviderState>>({})
  const [uploadPermissionOpen, setUploadPermissionOpen] = useState(false)
  const [artifactMatchReviewIds, setArtifactMatchReviewIds] = useState<string[]>([])
  const [openUploadPermissionAfterArtifactReview, setOpenUploadPermissionAfterArtifactReview] = useState(false)
  const [recentUploadedCount, setRecentUploadedCount] = useState(0)
  const [parsingFileName, setParsingFileName] = useState(false)
  const [submittingAll, setSubmittingAll] = useState(false)
  const [submitNotice, setSubmitNotice] = useState<SubmitNotice | null>(null)

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  )

  function replaceWorkbenchItems(nextItems: ExifWorkbenchItem[]) {
    itemsRef.current = nextItems
    setItems(nextItems)
  }

  function recordItemsChange({
    label,
    detail,
    nextItems,
    affected,
    mergeKey,
  }: {
    label: string
    detail: string
    nextItems: ExifWorkbenchItem[]
    affected: string[]
    mergeKey?: string
  }) {
    const before = createExifHistorySnapshot(itemsRef.current, selectedId, sharedForm)
    const after = createExifHistorySnapshot(nextItems, selectedId, sharedForm)
    replaceWorkbenchItems(nextItems)
    return recordOperation({
      scope: EXIF_HISTORY_SCOPE,
      scopeLabel: "快速录入",
      label,
      detail,
      affected,
      before,
      after,
      mergeKey,
    })
  }

  function recordSharedFormChange({
    label,
    detail,
    nextSharedForm,
    mergeKey,
  }: {
    label: string
    detail: string
    nextSharedForm: FormState
    mergeKey?: string
  }) {
    const before = createExifHistorySnapshot(itemsRef.current, selectedId, sharedForm)
    const after = createExifHistorySnapshot(itemsRef.current, selectedId, nextSharedForm)
    setSharedForm(nextSharedForm)
    return recordOperation({
      scope: EXIF_HISTORY_SCOPE,
      scopeLabel: "快速录入",
      label,
      detail,
      affected: ["共享文物信息"],
      before,
      after,
      mergeKey,
    })
  }

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    setHistoryScopeDirty(
      EXIF_HISTORY_SCOPE,
      items.some((item) => item.submitState !== "submitted" || changedParts(item).length > 0),
    )
  }, [items, setHistoryScopeDirty])

  useEffect(() => () => setHistoryScopeDirty(EXIF_HISTORY_SCOPE, false), [setHistoryScopeDirty])

  useEffect(
    () =>
      registerHistoryScope(EXIF_HISTORY_SCOPE, (snapshot, direction, entry) => {
        const restored = snapshot as ExifHistorySnapshot
        batchRenameRevisionRef.current += 1
        const restoredItems = cloneHistoryItems(restored.items)
        itemsRef.current = restoredItems
        setItems(restoredItems)
        setSelectedId(restored.selectedId)
        setSharedForm(cloneFormState(restored.sharedForm))
        filenameHistoryOperationRef.current.clear()
        setSubmitNotice({
          type: "success",
          text:
            direction === "restore"
              ? `已替换为「${entry.label}」完成后的内容。`
              : `已${direction === "undo" ? "撤销" : "重做"}：${entry.label}`,
        })
      }),
    [registerHistoryScope],
  )

  const draftStorageReady = useExifDraftPersistence({
    apiBaseUrl,
    items,
    selectedId,
    sharedForm,
    setItems,
    setSelectedId,
    setSharedForm,
    setNotice: setSubmitNotice,
    fetchJson,
    revokePreviewUrl,
  })

  function updateItem(itemId: string, updater: (item: ExifWorkbenchItem) => ExifWorkbenchItem) {
    replaceWorkbenchItems(itemsRef.current.map((item) => (item.id === itemId ? updater(item) : item)))
  }

  const {
    source: metadataSyncSource,
    sourceId: metadataSyncSourceId,
    setSourceId: setMetadataSyncSourceId,
    targetMode: metadataSyncTargetMode,
    setTargetMode: setMetadataSyncTargetMode,
    targetIds: metadataSyncTargetIds,
    setTargetIds: setMetadataSyncTargetIds,
    selection: metadataSyncSelection,
    setSelection: setMetadataSyncSelection,
    previewOpen: metadataSyncPreviewOpen,
    setPreviewOpen: setMetadataSyncPreviewOpen,
    availableTargets: metadataSyncAvailableTargets,
    targets: metadataSyncTargets,
    diffs: metadataSyncDiffs,
    selectedFieldCount: metadataSyncSelectedCount,
    changedCount: metadataSyncChangedCount,
    selectPreset: selectMetadataSyncPreset,
    openPreview: openMetadataSyncPreview,
    openSelectedItemSync: syncSelectedMetadataToOthers,
    apply: applyMetadataSync,
  } = useExifMetadataSync({
    items,
    selectedItem,
    itemsRef,
    onItemsChange: recordItemsChange,
    onNotice: setSubmitNotice,
  })

  const artifactMatchReviewItem = useMemo(
    () => items.find((item) => item.id === artifactMatchReviewIds[0]) ?? null,
    [artifactMatchReviewIds, items],
  )

  const activeFieldWarnings = useMemo(() => {
    if (!selectedItem) return []
    const activeCandidate = ensureCandidates(selectedItem.candidates).find(
      (candidate) =>
        candidate.status === "success" && candidate.description === selectedItem.form.description,
    )
    return activeCandidate?.field_warnings ?? []
  }, [selectedItem])

  function warningForField(field: ArtifactFieldWarning["field"]) {
    return activeFieldWarnings.find((warning) => warning.field === field)
  }

  const stats = useMemo(() => {
    const submittedCount = items.filter((item) => item.submitState === "submitted").length
    const gpsCount = items.filter((item) =>
      hasValidGpsCoordinates(String(item.form.latitude ?? ""), String(item.form.longitude ?? "")),
    ).length
    const missingExifCount = items.filter((item) => !hasExifMetadata(item.form)).length
    return {
      itemCount: items.length,
      submittedCount,
      gpsCount,
      missingExifCount,
    }
  }, [items])

  const needsDirectoryAuthorization = useMemo(
    () =>
      items.some((item) => !item.fileHandle || (item.fileName !== item.originalFileName && !directoryHandle)),
    [directoryHandle, items],
  )

  const allItemsSubmitted = useMemo(
    () =>
      items.length > 0
      && items.every((item) => item.submitState === "submitted" && changedParts(item).length === 0),
    [items],
  )

  useExifEditorEffects({
    apiBaseUrl,
    ready: draftStorageReady,
    items,
    itemsRef,
    selectedItem,
    selectedId,
    sharedForm,
    sourceId: metadataSyncSourceId,
    availableTargets: metadataSyncAvailableTargets,
    lookupRef: artifactMatchLookupRef,
    filenameHistory: filenameHistoryOperationRef,
    setItems,
    setSourceId: setMetadataSyncSourceId,
    setTargetIds: setMetadataSyncTargetIds,
    setReviewIds: setArtifactMatchReviewIds,
    setParsing: setParsingFileName,
    updateItem,
    updateAfter: updateOperationAfter,
    revokePreview: revokePreviewUrl,
  })

  const {
    beginReview: beginArtifactMatchReview,
    selectMatch: selectExistingArtifactMatch,
    rejectMatches: rejectExistingArtifactMatches,
    selectSearchResult,
  } = useExifArtifactMatchReview({
    itemsRef,
    reviewIds: artifactMatchReviewIds,
    reviewItem: artifactMatchReviewItem,
    openPermissionAfterReview: openUploadPermissionAfterArtifactReview,
    setReviewIds: setArtifactMatchReviewIds,
    setOpenPermissionAfterReview: setOpenUploadPermissionAfterArtifactReview,
    setUploadPermissionOpen,
    setSelectedId,
    recordItemsChange,
  })

  const formActions = {
    updateSelected(patch: Partial<FormState>) {
      if (!selectedItem) {
        return
      }
      const currentItem = itemsRef.current.find((item) => item.id === selectedItem.id)
      if (!currentItem) return
      const changedKeys = (Object.keys(patch) as Array<keyof FormState>).filter(
        (key) => JSON.stringify(currentItem.form[key]) !== JSON.stringify(patch[key]),
      )
      if (changedKeys.length === 0) return
      const nextItems = itemsRef.current.map((item) =>
        item.id === selectedItem.id ? { ...patchWorkbenchItemForm(item, patch) } : item,
      )
      const fieldLabels = changedKeys.map((key) => FORM_HISTORY_LABELS[key] ?? String(key))
      recordItemsChange({
        label: `编辑${fieldLabels.join("、")}`,
        detail: `${currentItem.fileName} · ${describeFormChange(currentItem.form, patch, changedKeys)}`,
        nextItems,
        affected: [currentItem.fileName],
        mergeKey: `form:${currentItem.id}:${changedKeys.sort().join(",")}`,
      })
    },
    updateShared(patch: Partial<FormState>) {
      const changed = (Object.keys(patch) as Array<keyof FormState>).filter(
        (key) => JSON.stringify(sharedForm[key]) !== JSON.stringify(patch[key]),
      )
      if (changed.length === 0) return

      const nextSharedForm = { ...sharedForm, ...patch }
      const labels = changed.map((key) => FORM_HISTORY_LABELS[key] ?? String(key))
      recordSharedFormChange({
        label: `编辑共享${labels.join("、")}`,
        detail: `共享文物信息 · ${describeFormChange(sharedForm, patch, changed)}`,
        nextSharedForm,
        mergeKey: `shared:${changed.sort().join(",")}`,
      })
    },
    fillSharedFromSelected() {
      if (!selectedItem) return
      recordSharedFormChange({
        label: "采用当前照片的共享信息",
        detail: selectedItem.fileName,
        nextSharedForm: cloneFormState(selectedItem.form),
      })
      setSubmitNotice({ type: "success", text: "已用当前图片内容刷新共享文物信息" })
    },
    applySharedToAll() {
      if (items.length === 0) return
      const nextShared = cloneFormState(sharedForm)
      const nextItems = itemsRef.current.map((item) =>
        replaceWorkbenchItemForm(item, applySharedForm(item.form, nextShared)),
      )
      recordItemsChange({
        label: "应用共享文物信息",
        detail: `应用到 ${nextItems.length} 张照片`,
        nextItems,
        affected: nextItems.map((item) => item.fileName),
      })
      setSubmitNotice({ type: "success", text: `已将共享字段应用到 ${nextItems.length} 张图片` })
    },
    selectArtifactFromNameSearch(artifact: ExistingArtifact) {
      selectSearchResult(artifact, selectedItem)
    },
  }

  const locationActions = {
    applyBatch(payload: {
      locationName: string
      exhibitionName: string
      latitude: string
      longitude: string
      catalogExhibitionId: number | null
      catalogExhibitionSourceId: string
    }) {
      const nextLatitude = toNullableNumber(payload.latitude)
      const nextLongitude = toNullableNumber(payload.longitude)
      if ((nextLatitude === null) !== (nextLongitude === null)) {
        setSubmitNotice({ type: "error", text: "批量 GPS 需要同时填写纬度和经度" })
        return
      }
      const nextItems = itemsRef.current.map((item) => ({
        ...patchWorkbenchItemForm(item, {
          displayLocationName: payload.locationName.trim() || item.form.displayLocationName,
          exhibitionName: payload.exhibitionName.trim() || item.form.exhibitionName,
          catalogExhibitionId: payload.catalogExhibitionId,
          catalogExhibitionSourceId: payload.catalogExhibitionSourceId,
          latitude: nextLatitude === null ? item.form.latitude : String(nextLatitude),
          longitude: nextLongitude === null ? item.form.longitude : String(nextLongitude),
        }),
      }))
      recordItemsChange({
        label: "统一展出地点与 GPS",
        detail: `${payload.locationName.trim() || "保留地点"} · ${itemsRef.current.length} 张照片`,
        nextItems,
        affected: itemsRef.current.map((item) => item.fileName),
      })
      setSubmitNotice({ type: "success", text: `已更新 ${nextItems.length} 张图片的展出地点与 GPS` })
    },
    async locateDisplayLocation(locationName: string, preferredMuseum?: MuseumOption) {
      if (!selectedItem || locatingDisplayLocationRef.current) return
      const normalizedName = locationName.trim()
      if (!normalizedName) {
        setSubmitNotice({ type: "error", text: "请先输入展出地点名称" })
        return
      }

      const itemId = selectedItem.id
      locatingDisplayLocationRef.current = true
      setSubmitNotice(null)
      try {
        let museum = preferredMuseum ?? null
        if (!museum) {
          try {
            museum = await resolveMuseum(apiBaseUrl, normalizedName)
          } catch {
            museum = null
          }
        }

        let coordinates =
          museum?.latitude != null && museum.longitude != null
            ? { latitude: museum.latitude, longitude: museum.longitude }
            : null
        if (!coordinates) {
          coordinates = await geocodeLocationName(normalizedName)
        }
        if (!coordinates) {
          throw new Error("未找到可用坐标")
        }

        const current = itemsRef.current.find((item) => item.id === itemId)
        if (!current) return
        const nextItems = itemsRef.current.map((item) =>
          item.id === itemId
            ? patchWorkbenchItemForm(item, {
                displayLocationName: museum?.name || normalizedName,
                latitude: coordinates.latitude.toFixed(6),
                longitude: coordinates.longitude.toFixed(6),
              })
            : item,
        )
        recordItemsChange({
          label: "定位展出地点",
          detail: `${current.fileName} · ${museum?.name || normalizedName}`,
          nextItems,
          affected: [current.fileName],
        })
        setSubmitNotice({ type: "success", text: `已定位“${museum?.name || normalizedName}”并补充 GPS` })
      } catch {
        setSubmitNotice({ type: "error", text: `未能定位“${normalizedName}”，请从候选地点中选择或在地图上取点` })
      } finally {
        locatingDisplayLocationRef.current = false
      }
    },
  }

  const filenameActions = {
    renameSelected(baseName: string) {
      if (!selectedItem) return
      const current = itemsRef.current.find((item) => item.id === selectedItem.id)
      if (!current) return

      const fileName = normalizedFileName(baseName, current.fileName)
      if (fileName === current.fileName) return

      const nextItems = itemsRef.current.map((item) =>
        item.id === selectedItem.id ? renameWorkbenchItem(item, fileName) : item,
      )
      const operationId = recordItemsChange({
        label: "修改目标文件名",
        detail: `${current.fileName} → ${fileName}`,
        nextItems,
        affected: [current.fileName],
        mergeKey: `filename:${current.id}`,
      })
      filenameHistoryOperationRef.current.set(current.id, operationId)
    },
    applyBatchRename(payload: { batchPrefix: string; batchSuffix: string; batchRemove: string }) {
      if (!payload.batchPrefix && !payload.batchSuffix && !payload.batchRemove) return

      const revision = ++batchRenameRevisionRef.current
      const currentItems = itemsRef.current
      const renamed = currentItems.map((item) => ({
        id: item.id,
        fileName: normalizedFileName(
          `${payload.batchPrefix}${fileBaseName(item.fileName).split(payload.batchRemove).join("")}${payload.batchSuffix}`,
          item.fileName,
        ),
      }))
      const nextItems = currentItems.map((item) =>
        renameWorkbenchItem(
          item,
          renamed.find((entry) => entry.id === item.id)?.fileName ?? item.fileName,
        ),
      )
      const changedItems = nextItems.filter((item, index) => item.fileName !== currentItems[index]?.fileName)
      if (changedItems.length === 0) return

      const operationId = recordItemsChange({
        label: "批量修改目标文件名",
        detail: `前缀“${payload.batchPrefix || "无"}” · 后缀“${payload.batchSuffix || "无"}” · 影响 ${changedItems.length} 张`,
        nextItems,
        affected: changedItems.map((item) => item.fileName),
      })
      void Promise.all(
        renamed.map(async (entry) => {
          try {
            const parsed = await parseArtifactName(apiBaseUrl, entry.fileName)
            updateItem(entry.id, (item) =>
              batchRenameRevisionRef.current === revision && item.fileName === entry.fileName
                ? {
                    ...item,
                    parsedName: parsed,
                    form: applyFilenameParseWithoutOverwritingEdits(item.form, item.parsedName, parsed),
                  }
                : item,
            )
          } catch {
            // Keep filename and current metadata when parsing fails.
          }
        }),
      ).then(() => {
        if (batchRenameRevisionRef.current === revision) {
          updateOperationAfter(
            operationId,
            createExifHistorySnapshot(itemsRef.current, selectedId, sharedForm),
          )
        }
      })
      setSubmitNotice({ type: "success", text: `已按规则更新 ${changedItems.length} 个目标文件名，入库时将使用新名称` })
    },
  }

  const {
    createItem: createWorkbenchItem,
    selectImages: handleSelectImages,
    uploadFiles: handleUpload,
    startBackgroundEnrichment,
    removeItem,
    clearAll: clearQueue,
  } = useExifFileIntake({
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
    clearHistory: () => clearOperationHistory(EXIF_HISTORY_SCOPE),
    beginArtifactMatchReview,
    fetchJson,
    buildItemId,
    reverseGeocodeCoordinates,
    revokePreviewUrl,
    yieldToMainThread,
  })

  const {
    selectDirectory: handleSelectDirectory,
    bindDirectory: handleBindDirectory,
    retryQueueItem,
  } = useExifDirectoryAuthorization({
    fileInputRef,
    itemsRef,
    setItems,
    setSelectedId,
    setDirectoryHandle,
    setBindingDirectory,
    setUploading,
    setUploadActivity,
    setSubmitNotice,
    clearHistory: () => clearOperationHistory(EXIF_HISTORY_SCOPE),
    createItem: createWorkbenchItem,
    startBackgroundEnrichment,
    submitOne: (itemId) => submitOne(itemId),
    yieldToMainThread,
  })

  async function clearAll() {
    await clearQueue()
    setDirectoryHandle(null)
  }

  function recordSharedDescription(
    nextItems: ExifWorkbenchItem[],
    nextSharedForm: FormState,
    generated: GeneratedDescription,
  ) {
    const before = createExifHistorySnapshot(itemsRef.current, selectedId, sharedForm)
    const after = createExifHistorySnapshot(nextItems, selectedId, nextSharedForm)
    replaceWorkbenchItems(nextItems)
    setSharedForm(nextSharedForm)
    recordOperation({
      scope: EXIF_HISTORY_SCOPE,
      scopeLabel: "快速录入",
      label: "生成并应用共享描述",
      detail: `${generated.provider} / ${generated.model} · ${nextItems.length} 张照片`,
      affected: nextItems.map((item) => item.fileName),
      before,
      after,
    })
  }

  const {
    generateDescription: handleGenerateDescription,
    applyCandidate,
    toggleCandidateTag,
    reviewVerifiedClaim,
  } = useExifDescriptionOperations({
    apiBaseUrl,
    items,
    itemsRef,
    selectedItem,
    sharedForm,
    setSharedForm,
    setGenerating,
    setGeneratingIds: setDescriptionGeneratingItemIds,
    setProgress: setDescriptionProgress,
    setResearchSummary: setLiveResearchSummary,
    setProviders: setLiveProviders,
    setNotice: setSubmitNotice,
    updateSelectedForm: formActions.updateSelected,
    recordItemsChange,
    recordSharedDescription,
  })

  const submitOne = useExifSubmitOne({
    apiBaseUrl,
    directoryHandle,
    itemsRef,
    updateItem,
    setNotice: setSubmitNotice,
    clearHistory: () => clearOperationHistory(EXIF_HISTORY_SCOPE),
    fetchJson,
    responseErrorMessage,
  })

  const { submitAll: handleSubmitAll } = useExifBatchSubmission({
    apiBaseUrl,
    items,
    directoryHandle,
    setItems,
    setSelectedId,
    setSubmittingAll,
    setNotice: setSubmitNotice,
    clearHistory: () => clearOperationHistory(EXIF_HISTORY_SCOPE),
    submitOne,
  })

  function addTags(rawValue: string) {
    if (!selectedItem) {
      return false
    }
    const nextTags = rawValue
      .split(/[,\n，、；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (nextTags.length === 0) {
      return false
    }
    formActions.updateSelected({ tags: uniqueTags([...selectedItem.form.tags, ...nextTags]) })
    return true
  }

  function selectQueueItem(itemId: string) {
    setSelectedId(itemId)
  }

  function closeUploadPermissionPrompt() {
    setUploadPermissionOpen(false)
    setSubmitNotice({
      type: "success",
      text: `已读取 ${recentUploadedCount} 张图片；尚未授权原文件，稍后可点击图片列表上方的文件夹按钮继续。`,
    })
  }

  async function authorizeUploadPermission() {
    setUploadPermissionOpen(false)
    await handleBindDirectory()
  }

  return {
    fileInputRef,
    queue: {
      items,
      selectedId,
      stats,
      needsDirectoryAuthorization,
      allItemsSubmitted,
      uploading,
      uploadActivity,
      bindingDirectory,
      descriptionGeneratingItemIds,
      submittingAll,
      selectItem: selectQueueItem,
      selectImages: handleSelectImages,
      uploadFiles: handleUpload,
      selectDirectory: handleSelectDirectory,
      bindDirectory: handleBindDirectory,
      retryItem: retryQueueItem,
      removeItem,
      clearAll,
      submitAll: handleSubmitAll,
    },
    editor: {
      selectedItem,
      sharedForm,
      generating,
      descriptionProgress,
      liveResearchSummary,
      liveProviders,
      parsingFileName,
      submitNotice,
      warningForField,
      updateSharedForm: formActions.updateShared,
      fillSharedFromSelected: formActions.fillSharedFromSelected,
      applySharedToAll: formActions.applySharedToAll,
      updateSelectedForm: formActions.updateSelected,
      selectArtifactFromNameSearch: formActions.selectArtifactFromNameSearch,
      locateDisplayLocation: locationActions.locateDisplayLocation,
      renameSelected: filenameActions.renameSelected,
      applyBatchRename: filenameActions.applyBatchRename,
      generateDescription: handleGenerateDescription,
      applyCandidate,
      toggleCandidateTag,
      reviewVerifiedClaim,
      submitOne,
      addTags,
    },
    batchLocation: {
      apply: locationActions.applyBatch,
    },
    metadataSync: {
      source: metadataSyncSource,
      sourceId: metadataSyncSourceId,
      targetMode: metadataSyncTargetMode,
      targetIds: metadataSyncTargetIds,
      selection: metadataSyncSelection,
      previewOpen: metadataSyncPreviewOpen,
      availableTargets: metadataSyncAvailableTargets,
      targets: metadataSyncTargets,
      diffs: metadataSyncDiffs,
      selectedFieldCount: metadataSyncSelectedCount,
      changedCount: metadataSyncChangedCount,
      setSourceId: setMetadataSyncSourceId,
      setTargetMode: setMetadataSyncTargetMode,
      setTargetIds: setMetadataSyncTargetIds,
      setSelection: setMetadataSyncSelection,
      setPreviewOpen: setMetadataSyncPreviewOpen,
      selectPreset: selectMetadataSyncPreset,
      openPreview: openMetadataSyncPreview,
      syncSelectedItem: syncSelectedMetadataToOthers,
      apply: applyMetadataSync,
    },
    artifactReview: {
      item: artifactMatchReviewItem,
      pendingCount: artifactMatchReviewIds.length,
      rejectMatches: rejectExistingArtifactMatches,
      selectMatch: selectExistingArtifactMatch,
    },
    uploadPermission: {
      open: uploadPermissionOpen,
      recentUploadedCount,
      bindingDirectory,
      close: closeUploadPermissionPrompt,
      authorize: authorizeUploadPermission,
    },
  }
}
