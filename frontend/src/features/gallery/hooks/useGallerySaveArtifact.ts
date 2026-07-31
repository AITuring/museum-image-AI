import { useCallback, useState, type Dispatch, type SetStateAction } from "react"
import { fetchGalleryArtifacts, mergeGalleryArtifacts, parseOptionalNumber } from "../lib/galleryPageHelpers"
import type { GalleryEditFormState, HistoricalExhibitionDraft } from "../lib/galleryEditorTypes"
import type { GalleryArtifact, GalleryImage } from "../lib/galleryTypes"

type NoticeApi = {
  error(content: string): unknown
}

type Params = {
  apiBaseUrl: string
  active: GalleryArtifact | null
  editForm: GalleryEditFormState | null
  historicalExhibitions: HistoricalExhibitionDraft[]
  setSaveError: (value: string | null) => void
  setSaveNotice: (value: string | null) => void
  setEditing: (value: boolean) => void
  setEditForm: (value: GalleryEditFormState | null) => void
  setTagInput: (value: string) => void
  setItems: Dispatch<SetStateAction<GalleryArtifact[]>>
  setActive: Dispatch<SetStateAction<GalleryArtifact | null>>
  setActiveImageIndex: (value: number) => void
  noticeApi: NoticeApi
}

export function useGallerySaveArtifact({
  apiBaseUrl,
  active,
  editForm,
  historicalExhibitions,
  setSaveError,
  setSaveNotice,
  setEditing,
  setEditForm,
  setTagInput,
  setItems,
  setActive,
  setActiveImageIndex,
  noticeApi,
}: Params) {
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(
    async (event: { preventDefault(): void }) => {
      event.preventDefault()
      if (!active || !editForm) {
        return
      }

      const historyByImageId = new Map(historicalExhibitions.map((record) => [record.imageId, record]))
      const incompleteImageNumbers = active.images.flatMap((image, index) => {
        const history = historyByImageId.get(image.id)
        return history?.captureMuseumName.trim() && history.exhibitionName.trim() ? [] : [index + 1]
      })
      if (incompleteImageNumbers.length > 0) {
        const errorMessage = `图${incompleteImageNumbers.join("、图")}缺少展出场馆或展览，无法保存`
        setSaveError(errorMessage)
        noticeApi.error(errorMessage)
        return
      }

      setSaving(true)
      setSaveError(null)
      setSaveNotice(null)

      try {
        if (!editForm.museumName.trim()) {
          throw new Error("请填写或确认博物馆名称")
        }
        if (!editForm.name.trim()) {
          throw new Error("请填写或确认文物名称")
        }

        // Merged historical cards can contain images that belong to a different
        // underlying artifact record. Update the record that owns the selected
        // image, otherwise the cloud correctly rejects the image_id with 404.
        const selectedImage =
          editForm.imageId === null ? null : active.images.find((image) => image.id === editForm.imageId) ?? null
        const targetArtifactId = selectedImage?.artifact_id ?? active.id
        const buildImageUpdatePayload = (image: GalleryImage, isSelected: boolean) => {
          const history = historyByImageId.get(image.id)
          return {
            museum_name: editForm.museumName.trim(),
            name: editForm.name.trim(),
            era: editForm.era.trim() || null,
            Place_of_Excavation: editForm.Place_of_Excavation.trim() || null,
            description: editForm.description.trim() || null,
            tags: editForm.tags,
            image_id: image.id,
            camera_model: isSelected ? editForm.cameraModel.trim() || null : image.camera_model ?? null,
            lens_model: isSelected ? editForm.lensModel.trim() || null : image.lens_model ?? null,
            capture_museum_name: history?.captureMuseumName.trim() || image.capture_museum_name || null,
            exhibition_name: history ? history.exhibitionName.trim() || null : null,
            catalog_exhibition_source_id: history?.catalogSourceId || null,
            catalog_exhibition_id: history?.catalogExhibitionId ?? null,
            capture_location: isSelected ? editForm.captureLocation.trim() || null : image.capture_location ?? null,
            latitude: isSelected ? parseOptionalNumber(editForm.latitude, "纬度") : image.latitude ?? null,
            longitude: isSelected ? parseOptionalNumber(editForm.longitude, "经度") : image.longitude ?? null,
            captured_at: isSelected ? editForm.capturedAt.trim() || null : image.captured_at ?? null,
            shutter_speed: isSelected ? editForm.shutterSpeed.trim() || null : image.shutter_speed ?? null,
            aperture: isSelected ? editForm.aperture.trim() || null : image.aperture ?? null,
            iso: isSelected ? parseOptionalNumber(editForm.iso, "ISO") : image.iso ?? null,
            edit_method: isSelected ? editForm.editMethod || null : image.edit_method ?? null,
          }
        }

        const primaryImage = selectedImage ?? active.images[0] ?? null
        if (primaryImage === null) throw new Error("这件文物没有可编辑的图片")

        const response = await fetch(`${apiBaseUrl}/api/artifacts/${targetArtifactId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildImageUpdatePayload(primaryImage, true)),
        })
        if (!response.ok) {
          let message = `HTTP ${response.status}`
          try {
            const payload = (await response.json()) as { detail?: string }
            if (payload.detail) {
              message = payload.detail
            }
          } catch {
            // Ignore non-JSON error bodies.
          }
          throw new Error(message)
        }

        const otherImages = active.images.filter((image) => image.id !== primaryImage.id)
        for (const image of otherImages) {
          const historyResponse = await fetch(`${apiBaseUrl}/api/artifacts/${image.artifact_id ?? active.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildImageUpdatePayload(image, false)),
          })
          if (!historyResponse.ok) {
            throw new Error(`第 ${active.images.findIndex((item) => item.id === image.id) + 1} 张图的历史展出保存失败`)
          }
        }

        await response.json()
        const refreshedItems = await fetchGalleryArtifacts(apiBaseUrl, editForm.name.trim())
        const refreshedActive = refreshedItems.find((item) =>
          item.images.some((image) => active.images.some((previous) => previous.id === image.id)),
        )
        if (!refreshedActive) throw new Error("修改已保存，但未找到刷新后的文物")

        setItems((current) =>
          mergeGalleryArtifacts([...current.filter((item) => item.id !== active.id), refreshedActive]),
        )
        setActive(refreshedActive)
        const nextIndex = refreshedActive.images.findIndex((image) => image.id === primaryImage.id)
        setActiveImageIndex(nextIndex >= 0 ? nextIndex : 0)
        setEditing(false)
        setEditForm(null)
        setTagInput("")
        setSaveNotice("已保存修改")
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "保存失败")
      } finally {
        setSaving(false)
      }
    },
    [
      active,
      apiBaseUrl,
      editForm,
      historicalExhibitions,
      noticeApi,
      setActive,
      setActiveImageIndex,
      setEditForm,
      setEditing,
      setItems,
      setSaveError,
      setSaveNotice,
      setTagInput,
    ],
  )

  return {
    saving,
    handleSave,
  }
}
