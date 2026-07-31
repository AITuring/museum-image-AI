import { Button } from "antd"
import { Plus } from "lucide-react"
import { groupHistoricalExhibitions } from "../lib/galleryEditorHelpers"
import type { HistoricalExhibitionDraft, MuseumOption } from "../lib/galleryEditorTypes"
import { HistoricalExhibitionRow } from "./HistoricalExhibitionRow"

type Props = {
  activeImageId: number | null
  activeImageIndex: number
  apiBaseUrl: string
  draggedImageId: number | null
  historicalExhibitions: HistoricalExhibitionDraft[]
  imageIndexes: Map<number, number>
  museumOptions: MuseumOption[]
  onActivateImage: (imageIndex: number) => void
  onAddHistoricalExhibition: () => void
  onSetDraggedImage: (imageId: number | null) => void
  onChangeHistoricalExhibitions: (updater: (current: HistoricalExhibitionDraft[]) => HistoricalExhibitionDraft[]) => void
  onNotice: (message: string) => void
}

export function GalleryHistoryEditor({
  activeImageId,
  activeImageIndex,
  apiBaseUrl,
  draggedImageId,
  historicalExhibitions,
  imageIndexes,
  museumOptions,
  onActivateImage,
  onAddHistoricalExhibition,
  onSetDraggedImage,
  onChangeHistoricalExhibitions,
  onNotice,
}: Props) {
  return (
    <div className="field gallery-tags-field">
      <span>历史展出</span>
      <small className="gallery-history-help">拖动图片编号可调整照片所属展览</small>
      <div className="gallery-history-editor">
        <div className="gallery-history-columns" aria-hidden="true">
          <span>序号</span>
          <span>展出博物馆</span>
          <span>展览名称</span>
          <span>展期</span>
          <span className="gallery-history-columns-delete">删除</span>
        </div>
        {groupHistoricalExhibitions(historicalExhibitions).map((group, index) => (
          <HistoricalExhibitionRow
            key={group.imageIds.slice().sort((left, right) => left - right).join("-")}
            activeImageId={activeImageId}
            apiBaseUrl={apiBaseUrl}
            draggedImageId={draggedImageId}
            group={group}
            imageIndexes={imageIndexes}
            index={index}
            museumOptions={museumOptions}
            onActivateImage={onActivateImage}
            onSetDraggedImage={onSetDraggedImage}
            onUpdate={(patch) =>
              onChangeHistoricalExhibitions((current) =>
                current.map((item) => (group.imageIds.includes(item.imageId) ? { ...item, ...patch } : item)),
              )}
            onDropImage={(imageId) => {
              onChangeHistoricalExhibitions((current) =>
                current.map((item) =>
                  item.imageId === imageId
                    ? {
                        ...item,
                        captureMuseumName: group.captureMuseumName,
                        exhibitionName: group.exhibitionName,
                        catalogSourceId: group.catalogSourceId,
                        catalogExhibitionId: group.catalogExhibitionId,
                        startAt: group.startAt,
                        endAt: group.endAt,
                      }
                    : item,
                ),
              )
              onSetDraggedImage(null)
            }}
            onDelete={() => {
              onChangeHistoricalExhibitions((current) =>
                current.map((item) =>
                  group.imageIds.includes(item.imageId)
                    ? {
                        ...item,
                        captureMuseumName: "",
                        exhibitionName: "",
                        catalogSourceId: "",
                        catalogExhibitionId: null,
                        startAt: null,
                        endAt: null,
                      }
                    : item,
                ),
              )
              onNotice("已删除该条展出记录，请为这些图片重新选择场馆和展览")
            }}
          />
        ))}
        <Button
          htmlType="button"
          type="text"
          size="small"
          className="gallery-history-add"
          icon={<Plus size={13} aria-hidden="true" />}
          onClick={onAddHistoricalExhibition}
        >
          为图{activeImageIndex + 1}新增展览
        </Button>
      </div>
    </div>
  )
}
