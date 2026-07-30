import { useRef } from "react"
import { App as AntApp } from "antd"
import "./styles/gallery.css"
import {
  buildGalleryDetailState,
  getGalleryReturnTarget,
} from "./lib/galleryPageHelpers"
import GalleryImagePreview from "./GalleryImagePreview"
import { GalleryBrowseView } from "./components/gallery/GalleryBrowseView"
import { GalleryDetailReadView } from "./components/gallery/GalleryDetailReadView"
import { GalleryEditForm } from "./components/gallery/GalleryEditForm"
import { GalleryDetailShell } from "./components/gallery/GalleryDetailShell"
import { useGalleryEditingActions } from "./hooks/useGalleryEditingActions"
import { useGalleryPageState } from "./hooks/useGalleryPageState"
import { useGallerySaveArtifact } from "./hooks/useGallerySaveArtifact"

export type { GalleryArtifact, GalleryImage } from "./lib/galleryTypes"

export default function Gallery({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { message } = AntApp.useApp()
  const editingRef = useRef(false)

  const pageState = useGalleryPageState({ apiBaseUrl, editingRef })
  const editingActions = useGalleryEditingActions({
    apiBaseUrl,
    active: pageState.active,
    activeImageIndex: pageState.activeImageIndex,
    noticeApi: message,
  })
  editingRef.current = editingActions.editing

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
      aria-labelledby="gallery-page-title"
    >
      {!active ? (
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
            onBack={pageState.navigateToGallery}
            onStartEdit={editingActions.handleStartEdit}
            onCancelEdit={editingActions.handleCancelEdit}
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
