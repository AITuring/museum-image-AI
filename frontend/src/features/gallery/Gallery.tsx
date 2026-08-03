import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { App as AntApp } from "antd"
import "./gallery.css"
import {
  buildGalleryDetailState,
  getGalleryReturnTarget,
} from "./lib/galleryPageHelpers"
import GalleryImagePreview from "./GalleryImagePreview"
import { GalleryBrowseView } from "./components/GalleryBrowseView"
import { GalleryDetailReadView } from "./components/GalleryDetailReadView"
import { GalleryEditForm } from "./components/GalleryEditForm"
import { GalleryDetailShell } from "./components/GalleryDetailShell"
import { useGalleryEditingActions } from "./hooks/useGalleryEditingActions"
import { useGalleryPageState } from "./hooks/useGalleryPageState"
import { useGallerySaveArtifact } from "./hooks/useGallerySaveArtifact"

export type { GalleryArtifact, GalleryImage } from "./lib/galleryTypes"

export default function Gallery({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { message, modal } = AntApp.useApp()
  const editingRef = useRef(false)
  const routeExitRef = useRef<(() => void) | null>(null)

  const pageState = useGalleryPageState({ apiBaseUrl, editingRef, routeExitRef })
  const editingActions = useGalleryEditingActions({
    apiBaseUrl,
    active: pageState.active,
    activeImageIndex: pageState.activeImageIndex,
    noticeApi: message,
  })
  useLayoutEffect(() => {
    editingRef.current = editingActions.editing
  }, [editingActions.editing])

  const { editing, handleCancelEdit, hasUnsavedChanges } = editingActions

  const requestExitEditing = useCallback(
    (afterExit?: () => void) => {
      if (!editing) {
        afterExit?.()
        return
      }
      const discard = () => {
        handleCancelEdit()
        afterExit?.()
      }
      if (!hasUnsavedChanges) {
        discard()
        return
      }
      modal.confirm({
        title: "放弃未保存的修改？",
        content: "当前编辑内容尚未保存，离开后这些修改会丢失。",
        okText: "放弃修改",
        cancelText: "继续编辑",
        okButtonProps: { danger: true },
        onOk: discard,
      })
    },
    [editing, handleCancelEdit, hasUnsavedChanges, modal],
  )

  useLayoutEffect(() => {
    routeExitRef.current = () => requestExitEditing(pageState.navigateToGallery)
    return () => {
      routeExitRef.current = null
    }
  }, [pageState.navigateToGallery, requestExitEditing])

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [hasUnsavedChanges])

  const saveArtifact = useGallerySaveArtifact({
    apiBaseUrl,
    active: pageState.active,
    editForm: editingActions.editForm,
    historicalExhibitions: editingActions.historicalExhibitions,
    setSaveError: editingActions.setSaveError,
    setSaveNotice: editingActions.setSaveNotice,
    setEditing: editingActions.setEditing,
    setEditForm: editingActions.setEditForm,
    setTagInput: editingActions.setTagInput,
    setItems: pageState.setItems,
    setActive: pageState.setActive,
    setActiveImageIndex: pageState.setActiveImageIndex,
    noticeApi: message,
  })

  const active = pageState.active
  const editFormId = active ? `gallery-edit-form-${active.id}` : ""
  const detailState = active ? buildGalleryDetailState(active, pageState.activeImageIndex, apiBaseUrl) : null

  return (
    <section
      className={`gallery-workbench${active ? " has-detail-route" : ""}`}
      aria-labelledby={active ? `gallery-detail-title-${active.id}` : "gallery-page-title"}
    >
      {!active && pageState.artifactRouteId === null ? (
        <GalleryBrowseView
          apiBaseUrl={apiBaseUrl}
          items={pageState.items}
          loading={pageState.loading}
          error={pageState.error}
          query={pageState.query}
          submittedQuery={pageState.submittedQuery}
          onQueryChange={pageState.setQuery}
          onSearch={pageState.handleSearch}
          onSelectArtifact={pageState.navigateToArtifact}
        />
      ) : null}

      {!active && pageState.artifactRouteId !== null ? (
        <div className="gallery-route-loading-state" role="status" aria-live="polite" aria-busy="true">
          {pageState.routeLoading ? "正在打开文物资料…" : pageState.error ?? "文物资料暂时无法打开。"}
        </div>
      ) : null}

      {active ? (
        <>
          <GalleryDetailShell
            apiBaseUrl={apiBaseUrl}
            artifact={active}
            currentImage={detailState?.currentImage ?? null}
            currentImageName={detailState?.currentImageName ?? ""}
            activeImageIndex={pageState.activeImageIndex}
            editing={editingActions.editing}
            saving={saveArtifact.saving}
            generatingDescription={editingActions.generatingDescription}
            editFormId={editFormId}
            returnLabel={getGalleryReturnTarget().label}
            thumbnailStripRef={pageState.thumbnailStripRef}
            onBack={() => requestExitEditing(pageState.navigateToGallery)}
            onStartEdit={editingActions.handleStartEdit}
            onCancelEdit={() => requestExitEditing()}
            onOpenPreview={(index) => {
              pageState.setPreviewImageIndex(index)
              pageState.setImagePreviewOpen(true)
            }}
            onSelectImage={pageState.setActiveImageIndex}
          >
            {editingActions.editing && editingActions.editForm ? (
              <GalleryEditForm
                id={editFormId}
                apiBaseUrl={apiBaseUrl}
                active={active}
                activeImageIndex={pageState.activeImageIndex}
                activeImageIndexById={detailState?.activeImageIndexById ?? new Map()}
                museumOptions={pageState.museumOptions}
                eraOptions={pageState.eraOptions}
                editForm={editingActions.editForm}
                historicalExhibitions={editingActions.historicalExhibitions}
                draggedImageId={editingActions.draggedImageId}
                advancedEditingOpen={editingActions.advancedEditingOpen}
                tagInput={editingActions.tagInput}
                saving={saveArtifact.saving}
                generatingDescription={editingActions.generatingDescription}
                descriptionProgress={editingActions.descriptionProgress}
                saveError={editingActions.saveError}
                onSubmit={saveArtifact.handleSave}
                onFormPatch={editingActions.updateEditForm}
                onChangeHistoricalExhibitions={editingActions.setHistoricalExhibitions}
                onSetDraggedImage={editingActions.setDraggedImageId}
                onAdvancedEditingOpenChange={editingActions.setAdvancedEditingOpen}
                onTagInputChange={editingActions.setTagInput}
                onAddTags={editingActions.addTags}
                onRemoveTag={editingActions.removeTag}
                onGenerateDescription={editingActions.handleGenerateDescription}
                onAddHistoricalExhibition={editingActions.handleAddHistoricalExhibition}
                onCoordinateChange={editingActions.handleCoordinateChange}
                onLocationTextChange={editingActions.handleLocationTextChange}
                onSetActiveImageIndex={pageState.setActiveImageIndex}
                onNotice={editingActions.setSaveNotice}
                uploadedAt={detailState?.uploadedAt ?? ""}
              />
            ) : (
              <GalleryDetailReadView
                artifact={active}
                currentImage={detailState?.currentImage ?? null}
                capturedAt={detailState?.capturedAt ?? ""}
                shutterSpeed={detailState?.shutterSpeed ?? ""}
                aperture={detailState?.aperture ?? ""}
                iso={detailState?.iso ?? ""}
                subjectTags={detailState?.subjectTags ?? []}
                saveNotice={editingActions.saveNotice}
                exhibitionLinks={detailState?.exhibitionLinks ?? []}
              />
            )}
          </GalleryDetailShell>

          {pageState.imagePreviewOpen && detailState?.currentImage ? (
            <GalleryImagePreview
              open={pageState.imagePreviewOpen}
              images={detailState.previewImages}
              initialIndex={pageState.previewImageIndex}
              onClose={() => pageState.setImagePreviewOpen(false)}
            />
          ) : null}
        </>
      ) : null}
      <datalist id="gallery-museum-options">
        {pageState.museumOptions.map((museum) => (
          <option key={museum.id} value={museum.name} />
        ))}
      </datalist>
    </section>
  )
}
