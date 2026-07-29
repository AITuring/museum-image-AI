import { useState } from "react"
import type { ExifWorkbenchItem, SubmitNotice } from "../components/exif/types"

type UseExifBatchLocationOptions = {
  itemsRef: { current: ExifWorkbenchItem[] }
  selectedItem: ExifWorkbenchItem | null
  onItemsChange: (change: { label: string; detail: string; nextItems: ExifWorkbenchItem[]; affected: string[] }) => void
  onNotice: (notice: SubmitNotice) => void
  toNullableNumber: (value: string) => number | null
}

export function useExifBatchLocation({ itemsRef, selectedItem, onItemsChange, onNotice, toNullableNumber }: UseExifBatchLocationOptions) {
  const [locationName, setLocationName] = useState("")
  const [exhibitionName, setExhibitionName] = useState("常设")
  const [catalogExhibitionId, setCatalogExhibitionId] = useState<number | null>(null)
  const [catalogExhibitionSourceId, setCatalogExhibitionSourceId] = useState("")
  const [latitude, setLatitude] = useState("")
  const [longitude, setLongitude] = useState("")
  const [open, setOpen] = useState(false)

  const useSelectedLocation = () => {
    if (!selectedItem) return
    setLocationName(selectedItem.form.displayLocationName)
    setExhibitionName(selectedItem.form.exhibitionName)
    setCatalogExhibitionId(selectedItem.form.catalogExhibitionId)
    setCatalogExhibitionSourceId(selectedItem.form.catalogExhibitionSourceId)
    setLatitude(selectedItem.form.latitude)
    setLongitude(selectedItem.form.longitude)
    onNotice({ type: "success", text: "已带入当前图片的展出地点与 GPS，可继续微调后应用到全部图片" })
  }

  const updateExhibitionName = (value: string) => {
    setExhibitionName(value)
    setCatalogExhibitionId(null)
    setCatalogExhibitionSourceId("")
  }

  const apply = () => {
    const nextLatitude = toNullableNumber(latitude)
    const nextLongitude = toNullableNumber(longitude)
    if ((nextLatitude === null) !== (nextLongitude === null)) {
      onNotice({ type: "error", text: "批量 GPS 需要同时填写纬度和经度" })
      return
    }
    const nextItems = itemsRef.current.map((item) => ({
      ...item,
      form: {
        ...item.form,
        displayLocationName: locationName.trim() || item.form.displayLocationName,
        exhibitionName: exhibitionName.trim() || item.form.exhibitionName,
        catalogExhibitionId,
        catalogExhibitionSourceId,
        latitude: nextLatitude === null ? item.form.latitude : String(nextLatitude),
        longitude: nextLongitude === null ? item.form.longitude : String(nextLongitude),
      },
      submitState: item.submitState === "submitted" ? "idle" : item.submitState,
      submitMessage: item.submitState === "submitted" ? null : item.submitMessage,
    }))
    onItemsChange({ label: "统一展出地点与 GPS", detail: `${locationName.trim() || "保留地点"} · ${itemsRef.current.length} 张照片`, nextItems, affected: itemsRef.current.map((item) => item.fileName) })
    onNotice({ type: "success", text: `已更新 ${nextItems.length} 张图片的展出地点与 GPS` })
  }

  return {
    open, setOpen, locationName, setLocationName, exhibitionName, updateExhibitionName,
    latitude, setLatitude, longitude, setLongitude, useSelectedLocation, apply,
  }
}
