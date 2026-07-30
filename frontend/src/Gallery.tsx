import { useRef } from "react"
import { App as AntApp } from "antd"
import "./styles/gallery.css"
import { toAbsoluteUrl } from "./lib/galleryArtifactIdentity"
import { formatExhibitionPeriod, isFloorLabel } from "./lib/galleryEditorHelpers"
import {
  formatMetaDate,
  formatMetaValue,
  getGalleryImageFilename,
  getGalleryReturnTarget,
  getSubjectTags,
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

  const activeImageIndexById = new Map((pageState.active?.images ?? []).map((image, index) => [image.id, index]))

  const active = pageState.active
  const currentImage = active?.images[pageState.activeImageIndex] ?? active?.images[0] ?? null
  const editFormId = active ? `gallery-edit-form-${active.id}` : ""
  const subjectTags = active ? getSubjectTags(active.tags) : []
  const capturedAt = formatMetaDate(currentImage?.captured_at)
  const uploadedAt = formatMetaDate(currentImage?.uploaded_at)
  const shutterSpeed = formatMetaValue(currentImage?.shutter_speed)
  const aperture = formatMetaValue(currentImage?.aperture)
  const iso = formatMetaValue(currentImage?.iso)
  const exhibitionLinks =
    active?.exhibitions.map((exhibition) => {
      const exhibitionMuseumName = isFloorLabel(exhibition.museum_name) ? active.museum_name : exhibition.museum_name
      const href = exhibition.catalog_source_id
        ? `/exhibitions/source/${encodeURIComponent(exhibition.catalog_source_id)}`
        : exhibition.catalog_exhibition_id
          ? `/exhibitions/${exhibition.catalog_exhibition_id}`
          : `/exhibitions/history/${encodeURIComponent(exhibition.name)}?${new URLSearchParams({
              museum: exhibitionMuseumName,
            }).toString()}`
      const label = `${exhibitionMuseumName} · ${exhibition.name} · ${formatExhibitionPeriod(
        exhibition.start_at,
        exhibition.end_at,
        exhibition.name,
      )}`
      return { id: exhibition.id, href, label }
    }) ?? []

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
            currentImage={currentImage}
            currentImageName={currentImage ? getGalleryImageFilename(currentImage.url, pageState.activeImageIndex) : ""}
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
                activeImageIndexById={activeImageIndexById}
                museumOptions={pageState.museumOptions}
                eraOptions={pageState.eraOptions}
                editForm={editingActions.editForm}
                historicalExhibitions={editingActions.historicalExhibitions}
                draggedImageId={editingActions.draggedImageId}
                advancedEditingOpen={editingActions.advancedEditingOpen}
                tagInput={editingActions.tagInput}
                uploadedAt={uploadedAt}
                saving={saveArtifact.saving}
                generatingDescription={editingActions.generatingDescription}
                descriptionProgress={editingActions.descriptionProgress}
                saveError={editingActions.saveError}
                onSubmit={saveArtifact.handleSave}
                onFormPatch={(patch) =>
                  editingActions.setEditForm((current) => (current ? { ...current, ...patch } : current))
                }
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
              />
            ) : (
              <GalleryDetailReadView
                artifact={active}
                currentImage={currentImage}
                capturedAt={capturedAt}
                shutterSpeed={shutterSpeed}
                aperture={aperture}
                iso={iso}
                subjectTags={subjectTags}
                saveNotice={editingActions.saveNotice}
                exhibitionLinks={exhibitionLinks}
              />
            )}
          </GalleryDetailShell>

          {pageState.imagePreviewOpen && currentImage ? (
            <GalleryImagePreview
              open={pageState.imagePreviewOpen}
              images={active.images.map((image, index) => ({
                src: toAbsoluteUrl(apiBaseUrl, image.url),
                alt: `${active.name} · 图 ${index + 1}`,
                name: getGalleryImageFilename(image.url, index),
              }))}
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
