import type { ExifWorkbenchItem, FormState } from "../components/types"

export function resetSubmittedState(item: ExifWorkbenchItem): ExifWorkbenchItem {
  if (item.submitState !== "submitted") {
    return item
  }

  return {
    ...item,
    submitState: "idle",
    submitMessage: null,
  }
}

export function patchWorkbenchItemForm(
  item: ExifWorkbenchItem,
  patch: Partial<FormState>,
): ExifWorkbenchItem {
  return resetSubmittedState({
    ...item,
    form: {
      ...item.form,
      ...patch,
    },
  })
}

export function replaceWorkbenchItemForm(
  item: ExifWorkbenchItem,
  form: FormState,
): ExifWorkbenchItem {
  return resetSubmittedState({
    ...item,
    form,
  })
}

export function renameWorkbenchItem(
  item: ExifWorkbenchItem,
  fileName: string,
): ExifWorkbenchItem {
  return resetSubmittedState({
    ...item,
    fileName,
  })
}
