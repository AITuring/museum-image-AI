import { AutoComplete, Button, Input, Select, Tag } from "antd"
import { isMissingValue, needsSelection, statusClass } from "../lib/batchHelpers"
import { STATUS_LABEL, type ExhibitionOption, type ExistingArtifactMatch, type MuseumOption, type PendingArtifact } from "../lib/batchDomain"
import { BatchArtifactMatchCard } from "./BatchArtifactMatchCard"

const Textarea = Input.TextArea

type Props = {
  apiBaseUrl: string
  item: PendingArtifact
  tagInput: string
  hasMuseumOptions: boolean
  hasEraOptions: boolean
  selectedMuseum: MuseumOption | null
  museumSuggestions: MuseumOption[]
  exhibitionSuggestions: ExhibitionOption[]
  matchedArtifact: ExistingArtifactMatch | null
  sameArtifactDecision: "yes" | "no" | null
  museumOptionsListId: string
  eraOptionsListId: string
  onPatch: (id: number, patch: Partial<PendingArtifact>) => void
  onSave: (item: PendingArtifact) => void | Promise<void>
  onSubmit: (item: PendingArtifact) => void | Promise<void>
  onDelete: (id: number) => void | Promise<void>
  onAddTags: (id: number, rawValue: string) => void
  onRemoveTag: (id: number, tagToRemove: string) => void
  onTagInputChange: (id: number, value: string) => void
  onSelectExhibition: (id: number, value: string) => void
  onSelectMuseum: (item: PendingArtifact, value: string) => void
  onConfirmSameArtifact: (item: PendingArtifact, matchedArtifact: ExistingArtifactMatch) => void
  onRejectSameArtifact: (item: PendingArtifact) => void
}

export function BatchArtifactCard({
  apiBaseUrl,
  item,
  tagInput,
  hasMuseumOptions,
  hasEraOptions,
  selectedMuseum,
  museumSuggestions,
  exhibitionSuggestions,
  matchedArtifact,
  sameArtifactDecision,
  museumOptionsListId,
  eraOptionsListId,
  onPatch,
  onSave,
  onSubmit,
  onDelete,
  onAddTags,
  onRemoveTag,
  onTagInputChange,
  onSelectExhibition,
  onSelectMuseum,
  onConfirmSameArtifact,
  onRejectSameArtifact,
}: Props) {
  const submitButtonText =
    item.status === "submitted"
      ? "已入库"
      : matchedArtifact && sameArtifactDecision !== "no"
        ? "更新已有文物并上传图片"
        : "提交云端"

  return (
    <article className="batch-card">
      <div className="batch-thumb">
        <img src={item.image_url} alt={item.file_name} loading="lazy" />
        <span className={`pulse ${statusClass(item.status)}`} />
      </div>

      <div className="batch-fields">
        <div className="batch-head">
          <span className="muted small">{item.file_name}</span>
          <Tag color={item.status === "submitted" ? "success" : undefined}>
            {STATUS_LABEL[item.status] ?? item.status}
            {item.confidence != null ? ` · ${Math.round(item.confidence * 100)}%` : ""}
          </Tag>
        </div>

        <div className="batch-core-card">
          <div className="batch-section-head">
            <strong>核心信息</strong>
            <span>先确认这 4 项，其他字段再补充。</span>
          </div>
          <div className="batch-core-grid">
            <label className={`field ${isMissingValue(item.museum_name) ? "field-invalid" : ""}`}>
              <span>博物馆 / 出土地</span>
              <Input
                list={museumOptionsListId}
                value={item.museum_name ?? ""}
                onChange={(event) => onPatch(item.id, { museum_name: event.target.value || null })}
                placeholder={hasMuseumOptions ? "输入或选择博物馆 / 出土地" : "加载博物馆选项中…"}
              />
              {isMissingValue(item.museum_name) ? (
                <span className="field-help error">请先确认文物所属博物馆或出土地。</span>
              ) : (
                <span className="field-help">支持直接输入，也可从联想候选中选择，减少馆名不一致的问题。</span>
              )}
            </label>
            <label className={`field ${isMissingValue(item.name) ? "field-invalid" : ""}`}>
              <span>文物名称</span>
              <Input
                value={item.name ?? ""}
                onChange={(event) => onPatch(item.id, { name: event.target.value })}
                placeholder="例如：天王俑"
              />
              {isMissingValue(item.name) ? (
                <span className="field-help error">请填写最终入库名称，不要留空。</span>
              ) : (
                <span className="field-help">尽量用明确器名，避免“待确认文物”这类占位词。</span>
              )}
            </label>
            <label className={`field ${isMissingValue(item.era) ? "field-soft-missing" : ""}`}>
              <span>时代</span>
              <Input
                list={eraOptionsListId}
                value={item.era ?? ""}
                onChange={(event) => onPatch(item.id, { era: event.target.value || null })}
                placeholder={hasEraOptions ? "输入或选择时代" : "加载时代选项中…"}
              />
              <span className="field-help">
                {isMissingValue(item.era)
                  ? "支持直接输入，也可从参考时代中联想选择，便于后续检索和筛选。"
                  : "可直接输入或从参考时代列表中联想选择。"}
              </span>
            </label>
            <label
              className={`field ${
                isMissingValue(item.exhibition_name) || needsSelection(item.exhibition_name) ? "field-invalid" : ""
              }`}
            >
              <span>展览</span>
              <AutoComplete
                value={item.exhibition_name ?? ""}
                options={exhibitionSuggestions.map((exhibition) => ({
                  key: exhibition.id,
                  value: exhibition.name,
                  label: (
                    <span className="autocomplete-option">
                      <span>{exhibition.name}</span>
                      <span className="autocomplete-option-meta">{exhibition.museum_name}</span>
                    </span>
                  ),
                }))}
                filterOption={false}
                onChange={(value) => onPatch(item.id, { exhibition_name: value })}
                onSelect={(value) => onSelectExhibition(item.id, value)}
                placeholder={
                  selectedMuseum ? "默认常设，输入 @ 后联想检索该馆展览" : "例如：常设 / 大唐遗宝特展"
                }
              />
              {needsSelection(item.exhibition_name) ? (
                <span className="field-help error">请输入 `@关键词` 后从联想结果里选择展览。</span>
              ) : isMissingValue(item.exhibition_name) ? (
                <span className="field-help error">请填写或选择展览名称，常设展可直接填“常设”。</span>
              ) : (
                <span className="field-help">如果是常设展，可直接保留“常设”。</span>
              )}
            </label>
          </div>
        </div>

        {matchedArtifact ? (
          <BatchArtifactMatchCard
            apiBaseUrl={apiBaseUrl}
            item={item}
            matchedArtifact={matchedArtifact}
            sameArtifactDecision={sameArtifactDecision}
            onConfirmSameArtifact={onConfirmSameArtifact}
            onRejectSameArtifact={onRejectSameArtifact}
          />
        ) : null}

        <div className="field-row">
          <label className="field">
            <span>标签</span>
            <div className="tag-editor">
              <div className="tag-editor-chips">
                {item.tags.length > 0 ? (
                  item.tags.map((tag) => (
                    <Tag key={tag} closable onClose={() => onRemoveTag(item.id, tag)}>
                      {tag}
                    </Tag>
                  ))
                ) : (
                  <span className="tag-editor-placeholder">暂无标签</span>
                )}
              </div>
              <Input
                value={tagInput}
                onChange={(event) => onTagInputChange(item.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === "," || event.key === "\uFF0C") {
                    event.preventDefault()
                    onAddTags(item.id, tagInput)
                  }
                  if (event.key === "Backspace" && !tagInput && item.tags.length > 0) {
                    onRemoveTag(item.id, item.tags[item.tags.length - 1])
                  }
                }}
                onBlur={() => onAddTags(item.id, tagInput)}
                placeholder="输入后回车或逗号添加"
              />
            </div>
            <span className="field-help">建议保留器型、工艺、题材、地域等检索标签。</span>
          </label>
          <label
            className={`field ${
              isMissingValue(item.capture_museum_name) || needsSelection(item.capture_museum_name)
                ? "field-invalid"
                : ""
            }`}
          >
            <span>拍摄时博物馆</span>
            <AutoComplete
              value={item.capture_museum_name ?? ""}
              options={museumSuggestions.map((museum) => ({
                key: museum.id,
                value: museum.name,
                label: museum.name,
              }))}
              filterOption={false}
              onChange={(value) => {
                onPatch(item.id, {
                  capture_museum_name: value || null,
                  exhibition_name:
                    value && (!(item.exhibition_name ?? "").trim() || (item.exhibition_name ?? "").trim().startsWith("@"))
                      ? "常设"
                      : item.exhibition_name,
                })
              }}
              onSelect={(value) => onSelectMuseum(item, value)}
              placeholder={hasMuseumOptions ? "输入 @ 后联想检索，例如：@南博" : "加载博物馆选项中…"}
            />
            {needsSelection(item.capture_museum_name) ? (
              <span className="field-help error">请输入 `@关键词` 后，从下方结果选择拍摄时所在博物馆。</span>
            ) : isMissingValue(item.capture_museum_name) ? (
              <span className="field-help error">提交前必须确认拍摄时所在博物馆。</span>
            ) : (
              <span className="field-help">支持直接输入，也可通过 `@关键词` 联想选择标准馆名。</span>
            )}
          </label>
        </div>

        <label className="field">
          <span>描述</span>
          <Textarea
            rows={4}
            value={item.description ?? ""}
            onChange={(event) => onPatch(item.id, { description: event.target.value })}
          />
          <span className="field-help">描述里保留器型、工艺、用途和典型特征，不再重复标签列表。</span>
        </label>

        <div className="field-row">
          <label className="field">
            <span>机型</span>
            <Input
              value={item.camera_model ?? ""}
              onChange={(event) => onPatch(item.id, { camera_model: event.target.value })}
            />
          </label>
          <label className="field">
            <span>镜头</span>
            <Input
              value={item.lens_model ?? ""}
              onChange={(event) => onPatch(item.id, { lens_model: event.target.value })}
            />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>经度</span>
            <Input
              value={item.longitude ?? ""}
              onChange={(event) =>
                onPatch(item.id, {
                  longitude: event.target.value.trim() ? Number(event.target.value) : null,
                })
              }
              placeholder="例如：108.9402"
            />
          </label>
          <label className="field">
            <span>纬度</span>
            <Input
              value={item.latitude ?? ""}
              onChange={(event) =>
                onPatch(item.id, {
                  latitude: event.target.value.trim() ? Number(event.target.value) : null,
                })
              }
              placeholder="例如：34.3416"
            />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>拍摄时间</span>
            <Input
              value={item.captured_at ?? ""}
              onChange={(event) => onPatch(item.id, { captured_at: event.target.value })}
            />
          </label>
          <label className="field">
            <span>修图方式</span>
            <Select
              allowClear
              placeholder="未填写"
              value={item.edit_method || undefined}
              options={[
                { value: "简单调整", label: "简单调整" },
                { value: "堆栈合成", label: "堆栈合成" },
              ]}
              onChange={(value) => onPatch(item.id, { edit_method: value ?? null })}
            />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>快门</span>
            <Input
              value={item.shutter_speed ?? ""}
              onChange={(event) => onPatch(item.id, { shutter_speed: event.target.value })}
            />
          </label>
          <label className="field">
            <span>光圈</span>
            <Input
              value={item.aperture ?? ""}
              onChange={(event) => onPatch(item.id, { aperture: event.target.value })}
            />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>感光度</span>
            <Input
              value={item.iso ?? ""}
              onChange={(event) =>
                onPatch(item.id, {
                  iso: event.target.value.trim() ? Number(event.target.value) : null,
                })
              }
            />
          </label>
        </div>

        {item.error ? <p className="error-text">{item.error}</p> : null}
        {item.analysis ? <p className="muted">{item.analysis}</p> : null}

        <div className="batch-actions">
          <Button htmlType="button" type="text" onClick={() => void onSave(item)}>
            保存
          </Button>
          <Button
            htmlType="button"
            type="primary"
            size="small"
            onClick={() => void onSubmit(item)}
            disabled={item.status === "submitting" || item.status === "submitted"}
          >
            {submitButtonText}
          </Button>
          <Button htmlType="button" type="text" danger onClick={() => void onDelete(item.id)}>
            删除
          </Button>
        </div>
      </div>
    </article>
  )
}
