import { useEffect, useMemo, useRef, useState } from "react"
import { Button, Card, Dropdown, Modal, Space, Tag, Tooltip } from "antd"
import {
  Check,
  CloudUpload,
  FolderOpen,
  ImagePlus,
  Loader2,
  Trash2,
} from "lucide-react"
import { useOperationHistory } from "./OperationHistory"
import type { ArtifactFieldWarning } from "./components/exif/ReviewIndicators"
import { reverseGeocodeCoordinates } from "./components/exif/GpsMapPicker"
import { ExifQueueList } from "./components/exif/ExifQueueList"
import { SharedArtifactForm } from "./components/exif/SharedArtifactForm"
import { ExifFilePreview } from "./components/exif/ExifFilePreview"
import { ExifCaptureCard } from "./components/exif/ExifCaptureCard"
import { BasicArtifactInfoCard } from "./components/exif/BasicArtifactInfoCard"
import { ExifLocationCard } from "./components/exif/ExifLocationCard"
import { ExifMetadataEditor } from "./components/exif/ExifMetadataEditor"
import { ExifDescriptionCandidates } from "./components/exif/ExifDescriptionCandidates"
import { MetadataSyncSidebar } from "./components/exif/MetadataSyncSidebar"
import { BatchLocationPanel } from "./components/exif/BatchLocationPanel"
import { ExifWorkbenchFooter } from "./components/exif/ExifWorkbenchFooter"
import { ExifEmptyState } from "./components/exif/ExifEmptyState"
import { useExifMetadataSync } from "./hooks/useExifMetadataSync"
import { useExifBatchLocation } from "./hooks/useExifBatchLocation"
import { useExifFileIntake } from "./hooks/useExifFileIntake"
import { useExifDirectoryAuthorization } from "./hooks/useExifDirectoryAuthorization"
import { useExifDescriptionOperations } from "./hooks/useExifDescriptionOperations"
import { useExifBatchSubmission } from "./hooks/useExifBatchSubmission"
import { useExifArtifactMatchReview } from "./hooks/useExifArtifactMatchReview"
import { useExifFilenameActions } from "./hooks/useExifFilenameActions"
import { useExifSharedFormActions } from "./hooks/useExifSharedFormActions"
import { useExifLocationLookup } from "./hooks/useExifLocationLookup"
import { useExifDraftPersistence } from "./hooks/useExifDraftPersistence"
import { useExifEditorEffects } from "./hooks/useExifEditorEffects"
import { createExifSubmitOne } from "./lib/exifSubmission"
import { MetadataSyncPreview } from "./components/exif/MetadataSyncPreview"
import { formatCapturedAt, indexedFileName } from "./lib/exifDisplay"
import {
  buildItemId,
  changedParts,
  ensureCandidates,
  fileBaseName,
  fileExtension,
  hasValidGpsCoordinates,
  normalizedFileName,
  researchSourceUrl,
  toNullableNumber,
  uniqueTags,
} from "./lib/exifFormDomain"
import {
  buildBaseForm,
  cloneFormState,
  cloneHistoryItems,
  createExifHistorySnapshot,
  describeFormChange,
  FORM_HISTORY_LABELS,
  type ExifHistorySnapshot,
} from "./lib/exifWorkbenchFormState"
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
} from "./components/exif/types"

const EXIF_HISTORY_SCOPE = "exif"

const SHOW_DESCRIPTION_TOOLS_IN_QUICK_ENTRY = true

type ExifConsoleProps = {
  apiBaseUrl: string
}


function yieldToMainThread() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

 function revokePreviewUrl(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url)
}


const EXIF_FILE_INPUT_ID = "exif-workbench-file-input"

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response))
  }
  return (await response.json()) as T
}

async function responseErrorMessage(response: Response, prefix?: string) {
  let detail = `HTTP ${response.status}`
  try {
    const payload = (await response.json()) as { detail?: string }
    if (payload.detail) detail = payload.detail
  } catch {
    // Keep the HTTP fallback for non-JSON proxy/server errors.
  }
  return prefix ? `${prefix}：${detail}` : detail
}






function ExifConsole({ apiBaseUrl }: ExifConsoleProps) {
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
  const [tagInput, setTagInput] = useState("")
  const [sharedForm, setSharedForm] = useState<FormState>(buildBaseForm())
  const [museumSuggestions, setMuseumSuggestions] = useState<MuseumOption[]>([])
  const [locationSuggestions, setLocationSuggestions] = useState<MuseumOption[]>([])
  const [artifactSearchResults, setArtifactSearchResults] = useState<ExistingArtifact[]>([])
  const [showMuseumSuggestions, setShowMuseumSuggestions] = useState(false)
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const [showArtifactSearch, setShowArtifactSearch] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadActivity, setUploadActivity] = useState<UploadActivity>(null)
  const [bindingDirectory, setBindingDirectory] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [descriptionGeneratingItemIds, setDescriptionGeneratingItemIds] = useState<string[]>([])
  const [descriptionProgress, setDescriptionProgress] = useState<string[]>([])
  const [liveResearchSummary, setLiveResearchSummary] = useState("")
  const [liveProviders, setLiveProviders] = useState<Record<string, LiveProviderState>>({})
  const [batchPrefix, setBatchPrefix] = useState("")
  const [batchSuffix, setBatchSuffix] = useState("")
  const [batchRemove, setBatchRemove] = useState("")
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
  const {
    open: batchLocationOpen,
    setOpen: setBatchLocationOpen,
    locationName: batchLocationName,
    setLocationName: setBatchLocationName,
    exhibitionName: batchExhibitionName,
    updateExhibitionName: setBatchExhibitionName,
    latitude: batchLatitude,
    setLatitude: setBatchLatitude,
    longitude: batchLongitude,
    setLongitude: setBatchLongitude,
    useSelectedLocation: useSelectedLocationForBatch,
    apply: applyBatchLocation,
  } = useExifBatchLocation({
    itemsRef,
    selectedItem,
    onItemsChange: recordItemsChange,
    onNotice: setSubmitNotice,
    toNullableNumber,
  })
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
      (candidate) => candidate.status === "success"
        && candidate.description === selectedItem.form.description,
    )
    return activeCandidate?.field_warnings ?? []
  }, [selectedItem])

  function warningForField(field: ArtifactFieldWarning["field"]) {
    return activeFieldWarnings.find((warning) => warning.field === field)
  }

  const stats = useMemo(() => {
    const submittedCount = items.filter((item) => item.submitState === "submitted").length
    const gpsCount = items.filter((item) => hasValidGpsCoordinates(
      String(item.form.latitude ?? ""),
      String(item.form.longitude ?? ""),
    )).length
    return {
      itemCount: items.length,
      submittedCount,
      gpsCount,
    }
  }, [items])

  const needsDirectoryAuthorization = useMemo(
    () => items.some((item) => !item.fileHandle || (item.fileName !== item.originalFileName && !directoryHandle)),
    [directoryHandle, items],
  )

  const allItemsSubmitted = useMemo(
    () => items.length > 0 && items.every((item) => item.submitState === "submitted" && changedParts(item).length === 0),
    [items],
  )

  const batchRenameCount = useMemo(() => items.filter((item) => (
    normalizedFileName(`${batchPrefix}${fileBaseName(item.fileName).split(batchRemove).join("")}${batchSuffix}`, item.fileName) !== item.fileName
  )).length, [items, batchPrefix, batchRemove, batchSuffix])

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

  useEffect(() => { itemsRef.current = items }, [items])

  useEffect(() => {
    setHistoryScopeDirty(
      EXIF_HISTORY_SCOPE,
      items.some((item) => item.submitState !== "submitted" || changedParts(item).length > 0),
    )
  }, [items, setHistoryScopeDirty])

  useEffect(() => () => setHistoryScopeDirty(EXIF_HISTORY_SCOPE, false), [setHistoryScopeDirty])

  useEffect(() => registerHistoryScope(EXIF_HISTORY_SCOPE, (snapshot, direction, entry) => {
    const restored = snapshot as ExifHistorySnapshot
    batchRenameRevisionRef.current += 1
    const restoredItems = cloneHistoryItems(restored.items)
    itemsRef.current = restoredItems
    setItems(restoredItems)
    setSelectedId(restored.selectedId)
    setSharedForm(cloneFormState(restored.sharedForm))
    setBatchPrefix("")
    setBatchSuffix("")
    setBatchRemove("")
    filenameHistoryOperationRef.current.clear()
    setSubmitNotice({
      type: "success",
      text: direction === "restore"
        ? `已替换为「${entry.label}」完成后的内容。`
        : `已${direction === "undo" ? "撤销" : "重做"}：${entry.label}`,
    })
  }), [registerHistoryScope])

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
    replaceWorkbenchItems(itemsRef.current.map((item) => item.id === itemId ? updater(item) : item))
  }

  useExifEditorEffects({
    apiBaseUrl, ready: draftStorageReady, items, itemsRef, selectedItem, selectedId, sharedForm,
    showMuseum: showMuseumSuggestions, showLocation: showLocationSuggestions, showArtifact: showArtifactSearch,
    sourceId: metadataSyncSourceId, availableTargets: metadataSyncAvailableTargets,
    lookupRef: artifactMatchLookupRef, filenameHistory: filenameHistoryOperationRef,
    setItems, setSourceId: setMetadataSyncSourceId, setTargetIds: setMetadataSyncTargetIds,
    setMuseumSuggestions, setLocationSuggestions, setArtifactResults: setArtifactSearchResults,
    setReviewIds: setArtifactMatchReviewIds, setParsing: setParsingFileName,
    updateItem, updateAfter: updateOperationAfter, revokePreview: revokePreviewUrl, fetchJson,
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
    artifactSearchResults,
    setReviewIds: setArtifactMatchReviewIds,
    setOpenPermissionAfterReview: setOpenUploadPermissionAfterArtifactReview,
    setUploadPermissionOpen,
    setSelectedId,
    setShowArtifactSearch,
    setArtifactSearchResults,
    recordItemsChange,
  })

  function updateSelectedForm(patch: Partial<FormState>) {
    if (!selectedItem) {
      return
    }
    const currentItem = itemsRef.current.find((item) => item.id === selectedItem.id)
    if (!currentItem) return
    const changedKeys = (Object.keys(patch) as Array<keyof FormState>).filter((key) => (
      JSON.stringify(currentItem.form[key]) !== JSON.stringify(patch[key])
    ))
    if (changedKeys.length === 0) return
    const nextItems = itemsRef.current.map((item) => item.id === selectedItem.id ? {
      ...item,
      form: { ...item.form, ...patch },
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    } : item)
    const fieldLabels = changedKeys.map((key) => FORM_HISTORY_LABELS[key] ?? String(key))
    recordItemsChange({
      label: `编辑${fieldLabels.join("、")}`,
      detail: `${currentItem.fileName} · ${describeFormChange(currentItem.form, patch, changedKeys)}`,
      nextItems,
      affected: [currentItem.fileName],
      mergeKey: `form:${currentItem.id}:${changedKeys.sort().join(",")}`,
    })
  }

  function selectArtifactFromNameSearch(artifactId: number) {
    selectSearchResult(artifactId, selectedItem)
  }

  const { locateDisplayLocation } = useExifLocationLookup({
    apiBaseUrl,
    itemsRef,
    selectedItem,
    locationSuggestions,
    locatingRef: locatingDisplayLocationRef,
    recordItemsChange,
    setShowSuggestions: setShowLocationSuggestions,
    setNotice: setSubmitNotice,
  })
  const { renameSelected, applyBatchRename } = useExifFilenameActions({
    apiBaseUrl,
    itemsRef,
    selectedItem,
    selectedId,
    sharedForm,
    prefix: batchPrefix,
    suffix: batchSuffix,
    remove: batchRemove,
    revisionRef: batchRenameRevisionRef,
    historyOperationRef: filenameHistoryOperationRef,
    recordItemsChange,
    updateItem,
    updateOperationAfter,
    setNotice: setSubmitNotice,
    fetchJson,
  })
  const { updateSharedForm, fillSharedFromSelected, applySharedToAll } = useExifSharedFormActions({
    items,
    itemsRef,
    selectedItem,
    sharedForm,
    recordItemsChange,
    recordSharedChange: recordSharedFormChange,
    setNotice: setSubmitNotice,
  })
  const {
    createItem: createWorkbenchItem,
    selectImages: handleSelectImages,
    uploadFiles: handleUpload,
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
    beginArtifactMatchReview,
    submitOne: (itemId) => submitOne(itemId),
    yieldToMainThread,
  })
  async function clearAll() {
    await clearQueue()
    setDirectoryHandle(null)
    setTagInput("")
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
    updateSelectedForm,
    recordItemsChange,
    recordSharedDescription,
  })
  const submitOne = createExifSubmitOne({
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
      return
    }
    const nextTags = rawValue
      .split(/[,\n，、；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (nextTags.length === 0) {
      return
    }
    updateSelectedForm({ tags: uniqueTags([...selectedItem.form.tags, ...nextTags]) })
    setTagInput("")
  }

  return (
    <section className="exif-console">
      <input
        aria-label="选择图片"
        id={EXIF_FILE_INPUT_ID}
        ref={fileInputRef}
        type="file"
        accept="image/*,.tif,.tiff"
        multiple
        className="exif-file-input"
        onChange={(event) => void handleUpload(Array.from(event.target.files ?? []))}
      />

      <div className="layout exif-layout exif-layout-wide">
        <section className="column column-left exif-sidebar">
          <div className="panel exif-queue-panel">
            <div className="section-heading compact">
              <div className="exif-sidebar-head">
                <h2>图片列表</h2>
              </div>
              {items.length > 0 ? <Space className="exif-queue-actions" size={6} role="toolbar" aria-label="图片列表操作">
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "images", icon: <ImagePlus size={14} strokeWidth={1.8} aria-hidden="true" />, label: "添加图片" },
                      { key: "folder", icon: <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" />, label: needsDirectoryAuthorization ? "授权原文件" : "载入文件夹" },
                    ],
                    onClick: ({ key }) => {
                      if (key === "images") handleSelectImages()
                      if (key === "folder") void (needsDirectoryAuthorization ? handleBindDirectory() : handleSelectDirectory())
                    },
                  }}
                >
                  <Button
                    htmlType="button"
                    size="small"
                    icon={<ImagePlus size={15} strokeWidth={1.8} aria-hidden="true" />}
                    disabled={uploading || bindingDirectory}
                    aria-label="添加图片或载入文件夹"
                  />
                </Dropdown>
                <Tooltip title="清空图片列表" mouseEnterDelay={0.45}>
                  <Button
                    htmlType="button"
                    danger
                    size="small"
                    icon={<Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />}
                    onClick={() => void clearAll()}
                    disabled={items.length === 0}
                    aria-label="清空图片列表"
                  />
                </Tooltip>
                <Tooltip title={submittingAll ? "正在全部入库" : allItemsSubmitted ? "当前批次已全部入库" : "全部入库"} mouseEnterDelay={0.45}>
                  <Button
                    htmlType="button"
                    type="primary"
                    size="small"
                    icon={submittingAll
                      ? <Loader2 size={15} strokeWidth={1.8} className="animate-spin" aria-hidden="true" />
                      : allItemsSubmitted
                        ? <Check size={15} strokeWidth={2.1} aria-hidden="true" />
                        : <CloudUpload size={15} strokeWidth={1.8} aria-hidden="true" />}
                    onClick={() => void handleSubmitAll()}
                    disabled={submittingAll || items.length === 0 || allItemsSubmitted}
                    aria-label={submittingAll ? "正在全部入库" : allItemsSubmitted ? "当前批次已全部入库" : "全部入库"}
                  />
                </Tooltip>
              </Space> : null}
            </div>
            {items.length > 0 ? (
              <p className="exif-sidebar-summary" aria-label="当前批次统计">
                <strong>{stats.itemCount}</strong> 张
                <span>·</span>
                {stats.submittedCount} 已入库
                <span>·</span>
                {stats.gpsCount} 带坐标
              </p>
            ) : null}
            <div className="exif-sidebar-scroll">
              <div className="exif-sidebar-tools">
              <MetadataSyncSidebar
                items={items}
                selectedItem={selectedItem}
                source={metadataSyncSource}
                sourceId={metadataSyncSourceId}
                targetMode={metadataSyncTargetMode}
                selection={metadataSyncSelection}
                selectedFieldCount={metadataSyncSelectedCount}
                changedCount={metadataSyncChangedCount}
                indexedFileName={indexedFileName}
                onSourceChange={setMetadataSyncSourceId}
                onTargetModeChange={setMetadataSyncTargetMode}
                onSelectionChange={setMetadataSyncSelection}
                onPreview={openMetadataSyncPreview}
              />
              <BatchLocationPanel
                open={batchLocationOpen}
                selectedItem={selectedItem}
                itemCount={items.length}
                locationName={batchLocationName}
                exhibitionName={batchExhibitionName}
                latitude={batchLatitude}
                longitude={batchLongitude}
                onOpenChange={setBatchLocationOpen}
                onUseSelected={useSelectedLocationForBatch}
                onLocationNameChange={setBatchLocationName}
                onExhibitionNameChange={setBatchExhibitionName}
                onLatitudeChange={setBatchLatitude}
                onLongitudeChange={setBatchLongitude}
                onApply={applyBatchLocation}
              />
              <ExifQueueList
                items={items}
                selectedId={selectedId}
                descriptionGeneratingItemIds={descriptionGeneratingItemIds}
                showDescriptionTools={SHOW_DESCRIPTION_TOOLS_IN_QUICK_ENTRY}
                changedParts={changedParts}
                hasGeneratedDescription={(item) => ensureCandidates(item.candidates).some((candidate) => candidate.status === "success")}
                onSelect={(id) => {
                  setSelectedId(id)
                  setTagInput("")
                }}
                onRetry={retryQueueItem}
                onRemove={(id) => void removeItem(id)}
              />
              </div>
            </div>
          </div>
        </section>

        <section className="column column-right exif-main">
          {selectedItem ? (
            <form
              className="panel form-wide exif-editor-form"
              onSubmit={(event) => {
                event.preventDefault()
              }}
            >
              <div className="section-heading exif-editor-heading">
                <div>
                  <h2>{selectedItem.form.name || "校对文物信息"}</h2>
                </div>
              </div>

              <div className="exif-editor-scroll">
                <SharedArtifactForm
                  form={sharedForm}
                  itemCount={items.length}
                  showDescriptionTools={SHOW_DESCRIPTION_TOOLS_IN_QUICK_ENTRY}
                  generating={generating}
                  onChange={updateSharedForm}
                  onFillFromSelected={fillSharedFromSelected}
                  onApplyToAll={applySharedToAll}
                  onGenerateDescription={() => void handleGenerateDescription("shared")}
                />

                <Card className="exif-preview-card">
                  <ExifFilePreview
                    item={selectedItem}
                    fileBaseName={fileBaseName(selectedItem.fileName)}
                    fileExtension={fileExtension(selectedItem.fileName)}
                    parsingFileName={parsingFileName}
                    batchRemove={batchRemove}
                    batchPrefix={batchPrefix}
                    batchSuffix={batchSuffix}
                    batchRenameCount={batchRenameCount}
                    itemCount={items.length}
                    onRename={renameSelected}
                    onBatchRemoveChange={setBatchRemove}
                    onBatchPrefixChange={setBatchPrefix}
                    onBatchSuffixChange={setBatchSuffix}
                    onApplyBatchRename={applyBatchRename}
                  />
                </Card>

                <div className="form-fields exif-form-card-grid">
                  <BasicArtifactInfoCard
                    form={selectedItem.form}
                    museumSuggestions={museumSuggestions}
                    artifactSearchResults={artifactSearchResults}
                    showMuseumSuggestions={showMuseumSuggestions}
                    showArtifactSearch={showArtifactSearch}
                    warningForField={warningForField}
                    onChange={updateSelectedForm}
                    onMuseumSuggestionsOpenChange={setShowMuseumSuggestions}
                    onArtifactSearchOpenChange={setShowArtifactSearch}
                    onSelectExistingArtifact={selectArtifactFromNameSearch}
                  />

                  <ExifCaptureCard
                    form={selectedItem.form}
                    onChange={updateSelectedForm}
                    formatCapturedAt={formatCapturedAt}
                  />

                  <ExifLocationCard
                    apiBaseUrl={apiBaseUrl}
                    form={selectedItem.form}
                    locationSuggestions={locationSuggestions}
                    showLocationSuggestions={showLocationSuggestions}
                    onChange={updateSelectedForm}
                    onLocationSuggestionsOpenChange={setShowLocationSuggestions}
                    onLocate={(value, museum) => void locateDisplayLocation(value, museum)}
                  />

                  {SHOW_DESCRIPTION_TOOLS_IN_QUICK_ENTRY ? <ExifDescriptionCandidates
                    item={selectedItem}
                    generating={generating}
                    progress={descriptionProgress}
                    researchSummary={liveResearchSummary}
                    liveProviders={liveProviders}
                    onGenerate={() => void handleGenerateDescription()}
                    onReviewClaim={reviewVerifiedClaim}
                    onToggleTag={toggleCandidateTag}
                    onApplyCandidate={applyCandidate}
                    toResearchUrl={(url) => researchSourceUrl(apiBaseUrl, url)}
                  /> : null}

                  {SHOW_DESCRIPTION_TOOLS_IN_QUICK_ENTRY ? <ExifMetadataEditor
                    form={selectedItem.form}
                    tagInput={tagInput}
                    onChange={updateSelectedForm}
                    onTagInputChange={setTagInput}
                    onAddTags={addTags}
                  /> : null}
                </div>
              </div>

              <ExifWorkbenchFooter
                item={selectedItem}
                itemCount={items.length}
                submitNotice={submitNotice}
                changedPartCount={changedParts(selectedItem).length}
                onSync={syncSelectedMetadataToOthers}
                onSubmit={() => void submitOne(selectedItem.id)}
              />
            </form>
          ) : (
            <ExifEmptyState
              uploading={uploading}
              activity={uploadActivity}
              onSelectImages={handleSelectImages}
              onSelectDirectory={() => void handleSelectDirectory()}
            />
          )}
        </section>
      </div>
      <Modal
        title="发现可能对应的已入库文物"
        open={artifactMatchReviewItem !== null}
        centered
        width={780}
        closable={false}
        maskClosable={false}
        keyboard={false}
        destroyOnHidden
        footer={[
          <Button key="new" htmlType="button" onClick={rejectExistingArtifactMatches}>
            都不是，按新文物填写
          </Button>,
        ]}
      >
        {artifactMatchReviewItem ? (
          <div className="artifact-match-review">
            <div className="artifact-match-review-intro">
              <div>
                <span>当前上传</span>
                <strong>{artifactMatchReviewItem.fileName}</strong>
              </div>
              <Tag color="processing">
                {artifactMatchReviewIds.length > 1 ? `还有 ${artifactMatchReviewIds.length} 张待确认` : "请选择对应文物"}
              </Tag>
            </div>
            <p className="muted">
              选择后会填入已有文物的名称、馆藏、时代、描述和标签，并把这张新照片追加到该文物；新照片自己的相机参数和拍摄时间不会被覆盖。
            </p>
            <div className="artifact-match-candidates">
              {(artifactMatchReviewItem.existingArtifactCandidates ?? []).map((match) => {
                const cover = match.artifact.images[0]
                const previewUrl = cover
                  ? `${apiBaseUrl}/api/image-variant?${new URLSearchParams({ url: cover.url, size: "360" }).toString()}`
                  : ""
                return (
                  <button
                    key={match.artifact.id}
                    type="button"
                    className="artifact-match-candidate"
                    onClick={() => selectExistingArtifactMatch(match)}
                  >
                    <span className="artifact-match-thumb">
                      {cover ? (
                        <img
                          src={previewUrl}
                          alt={match.artifact.name}
                          onError={(event) => {
                            event.currentTarget.onerror = null
                            event.currentTarget.src = cover.url
                          }}
                        />
                      ) : <span>无图</span>}
                    </span>
                    <span className="artifact-match-copy">
                      <strong>{match.artifact.name}</strong>
                      <span>{match.artifact.era || "时代未填写"} · {match.artifact.museum_name}</span>
                      <small>{match.match_reason}</small>
                      {match.artifact.description ? <p>{match.artifact.description}</p> : null}
                      <span className="artifact-match-tags">
                        {match.artifact.tags
                          .filter((tag) => !/^(机型|镜头)\s*[:：]/.test(tag))
                          .slice(0, 6)
                          .map((tag) => <Tag key={tag}>{tag}</Tag>)}
                      </span>
                      <b>选择并填入这件文物</b>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </Modal>
      <Modal
        title="图片已读取，继续授权原文件"
        open={uploadPermissionOpen}
        centered
        width={520}
        destroyOnHidden
        onCancel={() => {
          setUploadPermissionOpen(false)
          setSubmitNotice({
            type: "success",
            text: `已读取 ${recentUploadedCount} 张图片；尚未授权原文件，稍后可点击图片列表上方的文件夹按钮继续。`,
          })
        }}
        footer={[
          <Button
            key="later"
            htmlType="button"
            onClick={() => {
              setUploadPermissionOpen(false)
              setSubmitNotice({
                type: "success",
                text: `已读取 ${recentUploadedCount} 张图片；尚未授权原文件，稍后可点击图片列表上方的文件夹按钮继续。`,
              })
            }}
          >
            稍后授权
          </Button>,
          <Button
            key="authorize"
            htmlType="button"
            type="primary"
            loading={bindingDirectory}
            onClick={() => {
              setUploadPermissionOpen(false)
              void handleBindDirectory()
            }}
          >
            选择原文件夹并授权
          </Button>,
        ]}
      >
        <div className="exif-upload-permission">
          <p>
            已读取 {recentUploadedCount} 张图片。为了在保存入库时同时修改本地文件名和 EXIF，
            请继续选择这些照片所在的文件夹，并允许浏览器读写。
          </p>
          <div className="exif-upload-permission-note">
            刚才选择图片只授予了读取权限，这是浏览器要求的原文件写入确认。系统只会绑定当前队列里的同名照片，不会把文件夹中的其他图片加入队列。
          </div>
        </div>
      </Modal>
      <MetadataSyncPreview
        open={metadataSyncPreviewOpen}
        source={metadataSyncSource}
        targetMode={metadataSyncTargetMode}
        availableTargets={metadataSyncAvailableTargets}
        targets={metadataSyncTargets}
        targetIds={metadataSyncTargetIds}
        selection={metadataSyncSelection}
        selectedFieldCount={metadataSyncSelectedCount}
        changedCount={metadataSyncChangedCount}
        diffs={metadataSyncDiffs}
        itemIndex={(id) => items.findIndex((item) => item.id === id)}
        onCancel={() => setMetadataSyncPreviewOpen(false)}
        onApply={applyMetadataSync}
        onTargetIdsChange={setMetadataSyncTargetIds}
        onSelectionChange={(field, checked) => setMetadataSyncSelection((current) => ({ ...current, [field]: checked }))}
        onPreset={selectMetadataSyncPreset}
      />
    </section>
  )
}

export default ExifConsole
