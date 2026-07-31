import { AutoComplete, Button, Input, Select, Tag } from "antd"
import { Building2, Camera, Sparkles } from "lucide-react"
import { type FormEvent } from "react"
import { GalleryHistoryEditor } from "./GalleryHistoryEditor"
import { GalleryLocationPicker } from "./GalleryLocationPicker"
import type { GalleryArtifact } from "../lib/galleryTypes"
import type {
  EraOption,
  GalleryEditFormState,
  HistoricalExhibitionDraft,
  MuseumOption,
} from "../lib/galleryEditorTypes"

const Textarea = Input.TextArea

type Props = {
  id: string
  apiBaseUrl: string
  active: GalleryArtifact
  activeImageIndex: number
  activeImageIndexById: Map<number, number>
  museumOptions: MuseumOption[]
  eraOptions: EraOption[]
  editForm: GalleryEditFormState
  historicalExhibitions: HistoricalExhibitionDraft[]
  draggedImageId: number | null
  advancedEditingOpen: boolean
  tagInput: string
  uploadedAt: string
  saving: boolean
  generatingDescription: boolean
  descriptionProgress: string | null
  saveError: string | null
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onFormPatch: (patch: Partial<GalleryEditFormState>) => void
  onChangeHistoricalExhibitions: (updater: (current: HistoricalExhibitionDraft[]) => HistoricalExhibitionDraft[]) => void
  onSetDraggedImage: (imageId: number | null) => void
  onAdvancedEditingOpenChange: (open: boolean) => void
  onTagInputChange: (value: string) => void
  onAddTags: (rawValue: string) => void
  onRemoveTag: (tagToRemove: string) => void
  onGenerateDescription: (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => void | Promise<void>
  onAddHistoricalExhibition: () => void
  onCoordinateChange: (next: { latitude: string; longitude: string }) => void
  onLocationTextChange: (next: string) => void
  onSetActiveImageIndex: (index: number) => void
  onNotice: (message: string) => void
}

export function GalleryEditForm({
  id,
  apiBaseUrl,
  active,
  activeImageIndex,
  activeImageIndexById,
  museumOptions,
  eraOptions,
  editForm,
  historicalExhibitions,
  draggedImageId,
  advancedEditingOpen,
  tagInput,
  uploadedAt,
  saving,
  generatingDescription,
  descriptionProgress,
  saveError,
  onSubmit,
  onFormPatch,
  onChangeHistoricalExhibitions,
  onSetDraggedImage,
  onAdvancedEditingOpenChange,
  onTagInputChange,
  onAddTags,
  onRemoveTag,
  onGenerateDescription,
  onAddHistoricalExhibition,
  onCoordinateChange,
  onLocationTextChange,
  onSetActiveImageIndex,
  onNotice,
}: Props) {
  return (
    <form id={id} className="gallery-edit-form" onSubmit={onSubmit}>
      <div className="gallery-edit-scroll">
        <div className="form-fields">
          <section className="form-section gallery-edit-section gallery-edit-section-basic">
            <div className="form-section-head gallery-edit-section-head">
              <h3><Building2 size={15} aria-hidden="true" /> 文物信息</h3>
            </div>
            <div className="form-section-body">
              <div className="field-row">
                <label className="field">
                  <span>馆藏博物馆</span>
                  <Input
                    list="gallery-museum-options"
                    value={editForm.museumName}
                    onChange={(event) => onFormPatch({ museumName: event.target.value })}
                    placeholder={museumOptions.length > 0 ? "输入或选择博物馆名称…" : "加载博物馆选项中…"}
                  />
                </label>
                <label className="field">
                  <span>文物名称</span>
                  <Input
                    value={editForm.name}
                    onChange={(event) => onFormPatch({ name: event.target.value })}
                    placeholder="例如：如意云纹金盘…"
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>时代</span>
                  <AutoComplete
                    value={editForm.era}
                    options={eraOptions.map((era) => ({ value: era.name, label: era.name }))}
                    filterOption={(input, option) =>
                      String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
                    }
                    onChange={(value) => onFormPatch({ era: value })}
                    placeholder={eraOptions.length > 0 ? "输入或选择时代…" : "加载时代选项中…"}
                  >
                    <Input />
                  </AutoComplete>
                </label>
                <label className="field">
                  <span>出土地点</span>
                  <Input
                    value={editForm.Place_of_Excavation}
                    onChange={(event) => onFormPatch({ Place_of_Excavation: event.target.value })}
                    placeholder="例如：陕西西安何家村…"
                  />
                </label>
              </div>
              <div className="field-row">
                <GalleryHistoryEditor
                  activeImageId={active.images[activeImageIndex]?.id ?? null}
                  activeImageIndex={activeImageIndex}
                  apiBaseUrl={apiBaseUrl}
                  draggedImageId={draggedImageId}
                  historicalExhibitions={historicalExhibitions}
                  imageIndexes={activeImageIndexById}
                  museumOptions={museumOptions}
                  onActivateImage={onSetActiveImageIndex}
                  onAddHistoricalExhibition={onAddHistoricalExhibition}
                  onSetDraggedImage={onSetDraggedImage}
                  onChangeHistoricalExhibitions={onChangeHistoricalExhibitions}
                  onNotice={onNotice}
                />
              </div>
              <div className="field-row">
                <label className="field gallery-tags-field">
                  <span>标签</span>
                  <div className="tag-editor">
                    <div className="tag-editor-chips">
                      {editForm.tags.map((tag) => (
                        <Tag key={tag} closable onClose={() => onRemoveTag(tag)}>
                          {tag}
                        </Tag>
                      ))}
                    </div>
                    <Input
                      className="tag-editor-input"
                      value={tagInput}
                      onChange={(event) => onTagInputChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === "," || event.key === "\uFF0C") {
                          event.preventDefault()
                          onAddTags(tagInput)
                        }
                        if (event.key === "Backspace" && !tagInput && editForm.tags.length > 0) {
                          onRemoveTag(editForm.tags[editForm.tags.length - 1])
                        }
                      }}
                      onBlur={() => onAddTags(tagInput)}
                      placeholder="输入标签，按回车添加"
                    />
                  </div>
                </label>
              </div>
              <div className="field gallery-edit-description-field">
                <div className="gallery-description-editor-head">
                  <label htmlFor="gallery-description-input">文物描述</label>
                  <Button
                    htmlType="button"
                    type="default"
                    size="small"
                    className="gallery-ai-generate-button"
                    title={editForm.description.trim() ? "重新生成会替换当前描述，保存前仍可修改" : "根据文物信息生成一段描述"}
                    onClick={(event) => void onGenerateDescription(event)}
                    disabled={generatingDescription || saving}
                  >
                    <Sparkles size={13} aria-hidden="true" />
                    {generatingDescription
                      ? "正在生成…"
                      : editForm.description.trim()
                        ? "AI 重新生成"
                        : "AI 生成描述"}
                  </Button>
                </div>
                {(generatingDescription || descriptionProgress) ? (
                  <div
                    className={`gallery-ai-status ${generatingDescription ? "is-generating" : "is-ready"}`}
                    role="status"
                    aria-live="polite"
                  >
                    <div className="gallery-ai-steps" aria-hidden="true">
                      <span className="is-done">整理资料</span>
                      <span className={generatingDescription ? "is-active" : "is-done"}>生成草稿</span>
                      <span className={generatingDescription ? "" : "is-active"}>检查并保存</span>
                    </div>
                    <p>{descriptionProgress}</p>
                  </div>
                ) : null}
                <Textarea
                  id="gallery-description-input"
                  rows={4}
                  value={editForm.description}
                  onChange={(event) => onFormPatch({ description: event.target.value })}
                  placeholder="填写文物背景、形制、纹饰与相关历史"
                />
              </div>
            </div>
          </section>

          <section className="form-section gallery-edit-section gallery-edit-section-capture">
            <div className="form-section-head gallery-edit-section-head">
              <h3><Camera size={15} aria-hidden="true" /> 拍摄信息</h3>
            </div>
            <div className="form-section-body">
              <div className="field-row">
                <label className="field">
                  <span>机型</span>
                  <Input
                    value={editForm.cameraModel}
                    onChange={(event) => onFormPatch({ cameraModel: event.target.value })}
                    placeholder="自动读取后可补充修正…"
                  />
                </label>
                <label className="field">
                  <span>镜头</span>
                  <Input
                    value={editForm.lensModel}
                    onChange={(event) => onFormPatch({ lensModel: event.target.value })}
                    placeholder="自动读取后可补充修正…"
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>拍摄时间</span>
                  <Input
                    value={editForm.capturedAt}
                    onChange={(event) => onFormPatch({ capturedAt: event.target.value })}
                    placeholder="例如：2024-05-01T14:30:00…"
                  />
                </label>
                <label className="field">
                  <span>修图方式</span>
                  <Select
                    allowClear
                    placeholder="未填写…"
                    value={editForm.editMethod || undefined}
                    options={[
                      { value: "简单调整", label: "简单调整" },
                      { value: "堆栈合成", label: "堆栈合成" },
                    ]}
                    onChange={(value) => onFormPatch({ editMethod: value ?? "" })}
                  />
                </label>
              </div>
              <details
                className="gallery-advanced-details"
                open={advancedEditingOpen}
                onToggle={(event) => onAdvancedEditingOpenChange(event.currentTarget.open)}
              >
                <summary className="gallery-advanced-summary">
                  <span>更多拍摄信息</span>
                  <span className="gallery-advanced-hint">位置、坐标与曝光参数</span>
                </summary>
                {advancedEditingOpen ? (
                  <div className="gallery-advanced-body">
                    <GalleryLocationPicker
                      latitude={editForm.latitude}
                      longitude={editForm.longitude}
                      locationText={editForm.captureLocation}
                      onChange={onCoordinateChange}
                      onLocationTextChange={onLocationTextChange}
                    />
                    <div className="field-row gallery-coordinate-grid">
                      <label className="field">
                        <span>纬度</span>
                        <Input
                          value={editForm.latitude}
                          onChange={(event) => onFormPatch({ latitude: event.target.value })}
                          placeholder="例如：32.060255…"
                        />
                      </label>
                      <label className="field">
                        <span>经度</span>
                        <Input
                          value={editForm.longitude}
                          onChange={(event) => onFormPatch({ longitude: event.target.value })}
                          placeholder="例如：118.796877…"
                        />
                      </label>
                    </div>
                    <div className="gallery-exposure-grid">
                      <label className="field">
                        <span>快门</span>
                        <Input
                          value={editForm.shutterSpeed}
                          onChange={(event) => onFormPatch({ shutterSpeed: event.target.value })}
                          placeholder="例如：1/125s…"
                        />
                      </label>
                      <label className="field">
                        <span>光圈</span>
                        <Input
                          value={editForm.aperture}
                          onChange={(event) => onFormPatch({ aperture: event.target.value })}
                          placeholder="例如：f/2.8…"
                        />
                      </label>
                      <label className="field">
                        <span>ISO</span>
                        <Input
                          value={editForm.iso}
                          onChange={(event) => onFormPatch({ iso: event.target.value })}
                          placeholder="例如：400…"
                        />
                      </label>
                      <div className="field">
                        <span>上传时间</span>
                        <Input value={uploadedAt} readOnly placeholder="暂无记录…" />
                      </div>
                    </div>
                  </div>
                ) : null}
              </details>
            </div>
          </section>
        </div>
      </div>
      {saveError ? (
        <div className="form-footer gallery-form-footer">
          <div className="gallery-form-status">
            <p className="error-text">{saveError}</p>
          </div>
        </div>
      ) : null}
    </form>
  )
}
