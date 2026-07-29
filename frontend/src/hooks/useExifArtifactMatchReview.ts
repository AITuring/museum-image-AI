import type { Dispatch, MutableRefObject, SetStateAction } from "react"
import { applyExistingArtifactToForm, cloneFormState, resetFormForNewArtifact } from "../lib/exifWorkbenchFormState"
import { artifactReviewIdentityKey } from "../lib/exifArtifactLookup"
import type { ExifWorkbenchItem, ExistingArtifact, ExistingArtifactMatch } from "../components/exif/types"

type ItemChange = { label: string; detail: string; nextItems: ExifWorkbenchItem[]; affected: string[] }

type Options = {
  itemsRef: MutableRefObject<ExifWorkbenchItem[]>
  reviewIds: string[]
  reviewItem: ExifWorkbenchItem | null
  openPermissionAfterReview: boolean
  artifactSearchResults: ExistingArtifact[]
  setReviewIds: Dispatch<SetStateAction<string[]>>
  setOpenPermissionAfterReview: Dispatch<SetStateAction<boolean>>
  setUploadPermissionOpen: Dispatch<SetStateAction<boolean>>
  setSelectedId: Dispatch<SetStateAction<string | null>>
  setShowArtifactSearch: Dispatch<SetStateAction<boolean>>
  setArtifactSearchResults: Dispatch<SetStateAction<ExistingArtifact[]>>
  recordItemsChange: (change: ItemChange) => unknown
}

export function useExifArtifactMatchReview({
  itemsRef, reviewIds, reviewItem, openPermissionAfterReview, artifactSearchResults,
  setReviewIds, setOpenPermissionAfterReview, setUploadPermissionOpen, setSelectedId,
  setShowArtifactSearch, setArtifactSearchResults, recordItemsChange,
}: Options) {
  function beginReview(items: ExifWorkbenchItem[], shouldOpenUploadPermission: boolean) {
    const ids = items.filter((item) => (item.existingArtifactCandidates?.length ?? 0) > 0).map((item) => item.id)
    if (ids.length === 0) { if (shouldOpenUploadPermission) setUploadPermissionOpen(true); return }
    setReviewIds(ids); setOpenPermissionAfterReview(shouldOpenUploadPermission)
  }
  function advanceReview() {
    const remaining = reviewIds.slice(1); setReviewIds(remaining)
    if (remaining.length === 0 && openPermissionAfterReview) { setOpenPermissionAfterReview(false); setUploadPermissionOpen(true) }
  }
  function selectMatch(match: ExistingArtifactMatch) {
    if (!reviewItem) return
    const itemId = reviewItem.id
    const nextItems = itemsRef.current.map((item) => {
      if (item.id !== itemId) return item
      const form = applyExistingArtifactToForm(item.form, match.artifact)
      return { ...item, form, existingArtifactId: match.artifact.id, existingArtifactMatch: match.match_reason, existingArtifactCandidates: [], existingArtifactReviewKey: artifactReviewIdentityKey(form), descriptionMeta: `已关联云端文物 #${match.artifact.id}`, submitMessage: `已采用“${match.artifact.name}”的文物信息，新照片将追加到这件文物。` }
    })
    recordItemsChange({ label: "关联已有文物", detail: `${reviewItem.fileName} · ${match.artifact.name}`, nextItems, affected: [reviewItem.fileName] })
    setSelectedId(itemId); advanceReview()
  }
  function rejectMatches() {
    if (!reviewItem) return
    const nextItems = itemsRef.current.map((item) => {
      if (item.id !== reviewItem.id) return item
      const form = resetFormForNewArtifact(item.form, item.parsedName)
      return { ...item, form, originalForm: cloneFormState(form), existingArtifactId: null, existingArtifactMatch: null, existingArtifactCandidates: [], existingArtifactReviewKey: artifactReviewIdentityKey(form), descriptionMeta: null, submitMessage: "已选择不复用已有文物信息，本次将按当前照片的文件名与 EXIF 信息作为新文物提交。" }
    })
    recordItemsChange({ label: "按新文物填写", detail: reviewItem.fileName, nextItems, affected: [reviewItem.fileName] })
    advanceReview()
  }
  function selectSearchResult(artifactId: number, selectedItem: ExifWorkbenchItem | null) {
    if (!selectedItem) return
    const artifact = artifactSearchResults.find((item) => item.id === artifactId); if (!artifact) return
    const nextItems = itemsRef.current.map((item) => {
      if (item.id !== selectedItem.id) return item
      const form = applyExistingArtifactToForm(item.form, artifact)
      return { ...item, form, existingArtifactId: artifact.id, existingArtifactMatch: "手动搜索并选择已有文物。", existingArtifactCandidates: [], existingArtifactReviewKey: artifactReviewIdentityKey(form), descriptionMeta: `已手动关联云端文物 #${artifact.id}`, submitMessage: `已导入“${artifact.name}”的信息；新照片将追加到这件文物。` }
    })
    recordItemsChange({ label: "搜索并复用已有文物", detail: `${selectedItem.fileName} · ${artifact.name}`, nextItems, affected: [selectedItem.fileName] })
    setShowArtifactSearch(false); setArtifactSearchResults([])
  }
  return { beginReview, selectMatch, rejectMatches, selectSearchResult }
}
