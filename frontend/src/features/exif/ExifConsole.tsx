import "./ExifConsole.css"
import { ExifArtifactReviewModal } from "./components/ExifArtifactReviewModal"
import { ExifEditorSection } from "./components/ExifEditorSection"
import { ExifMetadataSyncModal } from "./components/ExifMetadataSyncModal"
import { ExifSidebarSection } from "./components/ExifSidebarSection"
import { ExifUploadPermissionModal } from "./components/ExifUploadPermissionModal"
import { useExifWorkbenchController } from "./hooks/useExifWorkbenchController"

const SHOW_DESCRIPTION_TOOLS_IN_QUICK_ENTRY = true
const EXIF_FILE_INPUT_ID = "exif-workbench-file-input"

type ExifConsoleProps = {
  apiBaseUrl: string
}

function ExifConsole({ apiBaseUrl }: ExifConsoleProps) {
  const {
    fileInputRef,
    queue,
    editor,
    batchLocation,
    metadataSync,
    artifactReview,
    uploadPermission,
  } = useExifWorkbenchController({
    apiBaseUrl,
    enableAutomaticFilenameParsing: false,
  })

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
        onChange={(event) => void queue.uploadFiles(Array.from(event.target.files ?? []))}
      />

      <div className="layout exif-layout exif-layout-wide">
        <ExifSidebarSection
          queueState={{
            items: queue.items,
            selectedId: queue.selectedId,
            stats: queue.stats,
            needsDirectoryAuthorization: queue.needsDirectoryAuthorization,
            allItemsSubmitted: queue.allItemsSubmitted,
            uploading: queue.uploading,
            bindingDirectory: queue.bindingDirectory,
            descriptionGeneratingItemIds: queue.descriptionGeneratingItemIds,
            submittingAll: queue.submittingAll,
          }}
          queueActions={{
            selectItem: queue.selectItem,
            selectImages: queue.selectImages,
            selectDirectory: queue.selectDirectory,
            bindDirectory: queue.bindDirectory,
            retryItem: queue.retryItem,
            removeItem: queue.removeItem,
            clearAll: queue.clearAll,
            submitAll: queue.submitAll,
          }}
          selectedItem={editor.selectedItem}
          batchLocationApply={batchLocation.apply}
          syncPanel={{
            source: metadataSync.source,
            sourceId: metadataSync.sourceId,
            targetMode: metadataSync.targetMode,
            selection: metadataSync.selection,
            selectedFieldCount: metadataSync.selectedFieldCount,
            changedCount: metadataSync.changedCount,
            setSourceId: metadataSync.setSourceId,
            setTargetMode: metadataSync.setTargetMode,
            setSelection: metadataSync.setSelection,
            openPreview: metadataSync.openPreview,
          }}
          showDescriptionTools={SHOW_DESCRIPTION_TOOLS_IN_QUICK_ENTRY}
        />
        <ExifEditorSection
          apiBaseUrl={apiBaseUrl}
          items={queue.items}
          itemCount={queue.items.length}
          selectedItem={editor.selectedItem}
          sharedForm={editor.sharedForm}
          status={{
            generating: editor.generating,
            descriptionProgress: editor.descriptionProgress,
            liveResearchSummary: editor.liveResearchSummary,
            liveProviders: editor.liveProviders,
            parsingFileName: editor.parsingFileName,
            submitNotice: editor.submitNotice,
          }}
          actions={{
            warningForField: editor.warningForField,
            updateSharedForm: editor.updateSharedForm,
            fillSharedFromSelected: editor.fillSharedFromSelected,
            applySharedToAll: editor.applySharedToAll,
            updateSelectedForm: editor.updateSelectedForm,
            selectArtifactFromNameSearch: editor.selectArtifactFromNameSearch,
            locateDisplayLocation: editor.locateDisplayLocation,
            renameSelected: editor.renameSelected,
            applyBatchRename: editor.applyBatchRename,
            generateDescription: editor.generateDescription,
            applyCandidate: editor.applyCandidate,
            toggleCandidateTag: editor.toggleCandidateTag,
            reviewVerifiedClaim: editor.reviewVerifiedClaim,
            submitOne: editor.submitOne,
            addTags: editor.addTags,
            syncSelectedItem: metadataSync.syncSelectedItem,
          }}
          emptyState={{
            uploading: queue.uploading,
            uploadActivity: queue.uploadActivity,
            onSelectImages: queue.selectImages,
            onSelectDirectory: queue.selectDirectory,
          }}
          showDescriptionTools={SHOW_DESCRIPTION_TOOLS_IN_QUICK_ENTRY}
        />
      </div>
      <ExifArtifactReviewModal
        apiBaseUrl={apiBaseUrl}
        item={artifactReview.item}
        pendingCount={artifactReview.pendingCount}
        onRejectMatches={artifactReview.rejectMatches}
        onSelectMatch={artifactReview.selectMatch}
      />
      <ExifUploadPermissionModal
        open={uploadPermission.open}
        recentUploadedCount={uploadPermission.recentUploadedCount}
        bindingDirectory={uploadPermission.bindingDirectory}
        onClose={uploadPermission.close}
        onAuthorize={uploadPermission.authorize}
      />
      <ExifMetadataSyncModal
        metadataSync={metadataSync}
      />
    </section>
  )
}

export default ExifConsole
