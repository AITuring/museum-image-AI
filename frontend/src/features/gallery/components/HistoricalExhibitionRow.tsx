import { AutoComplete, Button, Input } from "antd"
import { Trash2 } from "lucide-react"
import { formatExhibitionPeriod, isFloorLabel, normalizeLookupText } from "../lib/galleryEditorHelpers"
import type { HistoricalExhibitionDraft, HistoricalExhibitionGroup, MuseumOption } from "../lib/galleryEditorTypes"
import { useHistoricalExhibitionOptions } from "../hooks/useHistoricalExhibitionOptions"

export type HistoricalExhibitionRowProps = {
  activeImageId: number | null
  apiBaseUrl: string
  draggedImageId: number | null
  group: HistoricalExhibitionGroup
  imageIndexes: Map<number, number>
  index: number
  museumOptions: MuseumOption[]
  onActivateImage: (imageIndex: number) => void
  onDelete: () => void
  onDropImage: (imageId: number) => void
  onSetDraggedImage: (imageId: number | null) => void
  onUpdate: (patch: Partial<HistoricalExhibitionDraft>) => void
}

export function HistoricalExhibitionRow({
  activeImageId,
  apiBaseUrl,
  draggedImageId,
  group,
  imageIndexes,
  index,
  museumOptions,
  onActivateImage,
  onDelete,
  onDropImage,
  onSetDraggedImage,
  onUpdate,
}: HistoricalExhibitionRowProps) {
  const {
    exhibitionChoices,
    exhibitionOptions,
    loadingExhibitions,
    setExhibitionQuery,
  } = useHistoricalExhibitionOptions({
    apiBaseUrl,
    group,
    exhibitionName: group.exhibitionName,
    onUpdate,
  })

  return (
    <div
      className={`gallery-history-row${draggedImageId !== null && !group.imageIds.includes(draggedImageId) ? " is-drop-target" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => {
        if (draggedImageId === null || group.imageIds.includes(draggedImageId)) return
        onDropImage(draggedImageId)
      }}
    >
      <span className="gallery-history-index" title={`第 ${index + 1} 条展出记录`}>
        {index + 1}
      </span>
      <div className="gallery-history-field gallery-history-field-museum">
        <span className="gallery-history-field-label">展出博物馆</span>
        <AutoComplete
          className="gallery-history-museum"
          value={group.captureMuseumName}
          options={museumOptions.map((museum) => ({ value: museum.name }))}
          filterOption={(input, option) =>
            normalizeLookupText(String(option?.value ?? "")).includes(normalizeLookupText(input))
          }
          aria-label={`第 ${index + 1} 条历史展出的博物馆`}
          placeholder="输入博物馆名称联想搜索…"
          onChange={(value) =>
            onUpdate({
              captureMuseumName: value,
              catalogSourceId: "",
              catalogExhibitionId: null,
              startAt: null,
              endAt: null,
            })}
        >
          <Input />
        </AutoComplete>
      </div>
      <div className="gallery-history-field gallery-history-field-exhibition">
        <span className="gallery-history-field-label">展览名称</span>
        <AutoComplete
          className="gallery-history-exhibition"
          value={group.exhibitionName}
          options={exhibitionOptions}
          filterOption={false}
          aria-label={`第 ${index + 1} 条历史展出的展览`}
          placeholder={group.captureMuseumName.trim() ? "输入展览名称联想搜索…" : "请先选择博物馆…"}
          notFoundContent={loadingExhibitions ? "正在检索展览…" : "没有匹配展览"}
          onFocus={() => setExhibitionQuery(group.exhibitionName)}
          onSearch={setExhibitionQuery}
          onChange={(value) => {
            setExhibitionQuery(value)
            onUpdate({
              exhibitionName: value,
              catalogSourceId: "",
              catalogExhibitionId: null,
              startAt: null,
              endAt: null,
            })
          }}
          onSelect={(value) => {
            const choice = exhibitionChoices.find((item) => item.name === value)
            if (!choice) return
            setExhibitionQuery(choice.name)
            onUpdate({
              captureMuseumName: !choice.museumName || isFloorLabel(choice.museumName)
                ? group.captureMuseumName
                : choice.museumName,
              exhibitionName: choice.name,
              catalogSourceId: choice.catalogSourceId,
              catalogExhibitionId: choice.catalogExhibitionId,
              startAt: choice.startAt,
              endAt: choice.endAt,
            })
          }}
        >
          <Input />
        </AutoComplete>
      </div>
      <div className="gallery-history-meta">
        <div className="gallery-history-meta-item">
          <span className="gallery-history-field-label">展期</span>
          <span className="gallery-history-period">
            {formatExhibitionPeriod(group.startAt, group.endAt, group.exhibitionName, "请选择目录展览以带回时间")}
          </span>
        </div>
        <div className="gallery-history-meta-item">
          <span className="gallery-history-field-label">关联图片</span>
          <div className="gallery-history-images" aria-label={`第 ${index + 1} 条历史展出的图片`}>
            {group.imageIds.map((imageId) => {
              const imageIndex = imageIndexes.get(imageId) ?? -1
              return (
                <button
                  key={imageId}
                  type="button"
                  draggable
                  className={`gallery-history-image-link${imageId === activeImageId ? " is-active" : ""}`}
                  onClick={() => onActivateImage(imageIndex)}
                  onDragStart={() => onSetDraggedImage(imageId)}
                  onDragEnd={() => onSetDraggedImage(null)}
                >
                  图{imageIndex + 1}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <Button
        type="text"
        danger
        size="small"
        className="gallery-history-delete"
        aria-label={`删除第 ${index + 1} 条历史展出`}
        title="删除这条展出记录"
        icon={<Trash2 size={13} aria-hidden="true" />}
        onClick={onDelete}
      >
        <span className="sr-only">删除</span>
      </Button>
    </div>
  )
}
