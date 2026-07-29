import type { Dispatch, MutableRefObject, SetStateAction } from "react"
import { applySharedForm } from "../lib/exifFormDomain"
import { cloneFormState, describeFormChange, FORM_HISTORY_LABELS } from "../lib/exifWorkbenchFormState"
import type { ExifWorkbenchItem, FormState, SubmitNotice } from "../components/exif/types"

type ItemChange = { label: string; detail: string; nextItems: ExifWorkbenchItem[]; affected: string[] }
type SharedChange = { label: string; detail: string; nextSharedForm: FormState; mergeKey?: string }
type Options = {
  items: ExifWorkbenchItem[]; itemsRef: MutableRefObject<ExifWorkbenchItem[]>; selectedItem: ExifWorkbenchItem | null; sharedForm: FormState
  recordItemsChange: (change: ItemChange) => unknown; recordSharedChange: (change: SharedChange) => unknown
  setNotice: Dispatch<SetStateAction<SubmitNotice | null>>
}
export function useExifSharedFormActions({ items, itemsRef, selectedItem, sharedForm, recordItemsChange, recordSharedChange, setNotice }: Options) {
  function updateSharedForm(patch: Partial<FormState>) {
    const changed = (Object.keys(patch) as Array<keyof FormState>).filter((key) => JSON.stringify(sharedForm[key]) !== JSON.stringify(patch[key])); if (changed.length === 0) return
    const nextSharedForm = { ...sharedForm, ...patch }; const labels = changed.map((key) => FORM_HISTORY_LABELS[key] ?? String(key))
    recordSharedChange({ label: `编辑共享${labels.join("、")}`, detail: `共享文物信息 · ${describeFormChange(sharedForm, patch, changed)}`, nextSharedForm, mergeKey: `shared:${changed.sort().join(",")}` })
  }
  function fillSharedFromSelected() {
    if (!selectedItem) return
    recordSharedChange({ label: "采用当前照片的共享信息", detail: selectedItem.fileName, nextSharedForm: cloneFormState(selectedItem.form) })
    setNotice({ type: "success", text: "已用当前图片内容刷新共享文物信息" })
  }
  function applySharedToAll() {
    if (items.length === 0) return
    const nextShared = cloneFormState(sharedForm)
    const nextItems = itemsRef.current.map((item) => ({ ...item, form: applySharedForm(item.form, nextShared), submitState: item.submitState === "submitted" ? "idle" : item.submitState, submitMessage: item.submitState === "submitted" ? null : item.submitMessage }))
    recordItemsChange({ label: "应用共享文物信息", detail: `应用到 ${nextItems.length} 张照片`, nextItems, affected: nextItems.map((item) => item.fileName) })
    setNotice({ type: "success", text: `已将共享字段应用到 ${nextItems.length} 张图片` })
  }
  return { updateSharedForm, fillSharedFromSelected, applySharedToAll }
}
