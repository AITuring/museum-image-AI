import { Card } from "antd"
import { formatCapturedAt } from "../lib/exifDisplay"
import { changedParts, fileBaseName, fileExtension, researchSourceUrl } from "../lib/exifFormDomain"
import { BasicArtifactInfoCard } from "./BasicArtifactInfoCard"
import { ExifCaptureCard } from "./ExifCaptureCard"
import { ExifDescriptionCandidates } from "./ExifDescriptionCandidates"
import { ExifEmptyState } from "./ExifEmptyState"
import { ExifFilePreview } from "./ExifFilePreview"
import { ExifLocationCard } from "./ExifLocationCard"
import { ExifMetadataEditor } from "./ExifMetadataEditor"
import { ExifWorkbenchFooter } from "./ExifWorkbenchFooter"
import type { ArtifactFieldWarning } from "./ReviewIndicators"
import { SharedArtifactForm } from "./SharedArtifactForm"
import type { DescriptionCandidate, ExistingArtifact, ExifWorkbenchItem, FormState, LiveProviderState, MuseumOption, SubmitNotice, UploadActivity, VerifiedClaim } from "./types"

type ExifEditorEmptyState = {
  uploading: boolean
  uploadActivity: UploadActivity
  onSelectImages: () => void
  onSelectDirectory: () => Promise<void> | void
}

type ExifEditorStatus = {
  generating: boolean
  descriptionProgress: string[]
  liveResearchSummary: string
  liveProviders: Record<string, LiveProviderState>
  parsingFileName: boolean
  submitNotice: SubmitNotice | null
}

type ExifEditorActions = {
  warningForField: (field: string) => ArtifactFieldWarning | undefined
  updateSharedForm: (patch: Partial<FormState>) => void
  fillSharedFromSelected: () => void
  applySharedToAll: () => void
  updateSelectedForm: (patch: Partial<FormState>) => void
  selectArtifactFromNameSearch: (artifact: ExistingArtifact) => void
  locateDisplayLocation: (value: string, museum?: MuseumOption) => Promise<void> | void
  renameSelected: (name: string) => void
  applyBatchRename: (payload: { batchRemove: string; batchPrefix: string; batchSuffix: string }) => void
  generateDescription: (scope?: "shared") => Promise<void> | void
  applyCandidate: (candidate: DescriptionCandidate) => void
  toggleCandidateTag: (tag: string) => void
  reviewVerifiedClaim: (claim: VerifiedClaim, decision: "accepted" | "rejected") => void
  submitOne: (itemId: string) => Promise<boolean> | Promise<void> | void
  addTags: (value: string) => boolean
  syncSelectedItem: () => void
}

type ExifEditorSectionProps = {
  apiBaseUrl: string
  items: ExifWorkbenchItem[]
  itemCount: number
  selectedItem: ExifWorkbenchItem | null
  sharedForm: FormState
  status: ExifEditorStatus
  actions: ExifEditorActions
  emptyState: ExifEditorEmptyState
  showDescriptionTools: boolean
}

export function ExifEditorSection({
  apiBaseUrl,
  items,
  itemCount,
  selectedItem,
  sharedForm,
  status,
  actions,
  emptyState,
  showDescriptionTools,
}: ExifEditorSectionProps) {
  return <section className="column column-right exif-main">
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
            itemCount={itemCount}
            showDescriptionTools={showDescriptionTools}
            generating={status.generating}
            onChange={actions.updateSharedForm}
            onFillFromSelected={actions.fillSharedFromSelected}
            onApplyToAll={actions.applySharedToAll}
            onGenerateDescription={() => void actions.generateDescription("shared")}
          />

          <Card className="exif-preview-card">
            <ExifFilePreview
              item={selectedItem}
              items={items}
              fileBaseName={fileBaseName(selectedItem.fileName)}
              fileExtension={fileExtension(selectedItem.fileName)}
              parsingFileName={status.parsingFileName}
              onRename={actions.renameSelected}
              onApplyBatchRename={actions.applyBatchRename}
            />
          </Card>

          <div className="form-fields exif-form-card-grid">
            <BasicArtifactInfoCard
              apiBaseUrl={apiBaseUrl}
              itemId={selectedItem.id}
              form={selectedItem.form}
              warningForField={actions.warningForField}
              onChange={actions.updateSelectedForm}
              onSelectExistingArtifact={actions.selectArtifactFromNameSearch}
            />

            <ExifCaptureCard
              form={selectedItem.form}
              onChange={actions.updateSelectedForm}
              formatCapturedAt={formatCapturedAt}
            />

            <ExifLocationCard
              apiBaseUrl={apiBaseUrl}
              itemId={selectedItem.id}
              form={selectedItem.form}
              onChange={actions.updateSelectedForm}
              onLocate={(value, museum) => void actions.locateDisplayLocation(value, museum)}
            />

            {showDescriptionTools ? (
              <ExifDescriptionCandidates
                item={selectedItem}
                generating={status.generating}
                progress={status.descriptionProgress}
                researchSummary={status.liveResearchSummary}
                liveProviders={status.liveProviders}
                onGenerate={() => void actions.generateDescription()}
                onReviewClaim={actions.reviewVerifiedClaim}
                onToggleTag={actions.toggleCandidateTag}
                onApplyCandidate={actions.applyCandidate}
                toResearchUrl={(url) => researchSourceUrl(apiBaseUrl, url)}
              />
            ) : null}

            {showDescriptionTools ? (
              <ExifMetadataEditor
                itemId={selectedItem.id}
                form={selectedItem.form}
                onChange={actions.updateSelectedForm}
                onAddTags={actions.addTags}
              />
            ) : null}
          </div>
        </div>

        <ExifWorkbenchFooter
          item={selectedItem}
          itemCount={itemCount}
          submitNotice={status.submitNotice}
          changedPartCount={changedParts(selectedItem).length}
          onSync={actions.syncSelectedItem}
          onSubmit={() => void actions.submitOne(selectedItem.id)}
        />
      </form>
    ) : (
      <ExifEmptyState
        uploading={emptyState.uploading}
        activity={emptyState.uploadActivity}
        onSelectImages={emptyState.onSelectImages}
        onSelectDirectory={() => void emptyState.onSelectDirectory()}
      />
    )}
  </section>
}
