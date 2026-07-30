import { useCallback, useEffect, useState } from "react"
import { isFloorLabel, normalizeLookupText } from "../lib/galleryEditorHelpers"
import { buildEditForm, normalizeTags } from "../lib/galleryPageHelpers"
import type { GalleryEditFormState, HistoricalExhibitionDraft } from "../lib/galleryEditorTypes"
import type { GalleryArtifact } from "../lib/galleryTypes"

type GeneratedDescription = {
  provider: string
  model: string
  description: string
  candidates?: Array<{
    provider: string
    model: string
    description: string
    status: string
  }>
}

type NoticeApi = {
  info(content: string): unknown
}

type Params = {
  apiBaseUrl: string
  active: GalleryArtifact | null
  activeImageIndex: number
  noticeApi: NoticeApi
}

export function useGalleryEditingActions({
  apiBaseUrl,
  active,
  activeImageIndex,
  noticeApi,
}: Params) {
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<GalleryEditFormState | null>(null)
  const [historicalExhibitions, setHistoricalExhibitions] = useState<HistoricalExhibitionDraft[]>([])
  const [draggedImageId, setDraggedImageId] = useState<number | null>(null)
  const [advancedEditingOpen, setAdvancedEditingOpen] = useState(false)
  const [tagInput, setTagInput] = useState("")
  const [generatingDescription, setGeneratingDescription] = useState(false)
  const [descriptionProgress, setDescriptionProgress] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

  const resetEditingState = useCallback(() => {
    setEditing(false)
    setEditForm(null)
    setHistoricalExhibitions([])
    setDraggedImageId(null)
    setAdvancedEditingOpen(false)
    setTagInput("")
    setSaveError(null)
    setSaveNotice(null)
    setGeneratingDescription(false)
    setDescriptionProgress(null)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      resetEditingState()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [active?.id, resetEditingState])

  const handleStartEdit = useCallback(
    (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
      event?.preventDefault?.()
      event?.stopPropagation?.()
      if (!active) {
        return
      }
      const image = active.images[activeImageIndex] ?? active.images[0] ?? null
      setEditForm(buildEditForm(active, image))
      setHistoricalExhibitions(
        active.images.map((item) => {
          const sameNameExhibitions = active.exhibitions.filter(
            (candidate) => normalizeLookupText(candidate.name) === normalizeLookupText(item.exhibition_name),
          )
          const exhibition =
            active.exhibitions.find(
              (candidate) =>
                candidate.id === item.exhibition_id ||
                (normalizeLookupText(candidate.museum_name) === normalizeLookupText(item.capture_museum_name) &&
                  normalizeLookupText(candidate.name) === normalizeLookupText(item.exhibition_name)),
            ) ?? (sameNameExhibitions.length === 1 ? sameNameExhibitions[0] : undefined)
          const exhibitionMuseumName = isFloorLabel(exhibition?.museum_name) ? "" : exhibition?.museum_name ?? ""
          return {
            imageId: item.id,
            artifactId: item.artifact_id ?? active.id,
            captureMuseumName: isFloorLabel(item.capture_museum_name)
              ? exhibitionMuseumName || active.museum_name
              : item.capture_museum_name ?? (exhibitionMuseumName || active.museum_name),
            exhibitionName: item.exhibition_name ?? "常设",
            catalogSourceId: item.catalog_exhibition_source_id ?? exhibition?.catalog_source_id ?? "",
            catalogExhibitionId: item.catalog_exhibition_id ?? exhibition?.catalog_exhibition_id ?? null,
            startAt: exhibition?.start_at ?? null,
            endAt: exhibition?.end_at ?? null,
          }
        }),
      )
      setTagInput("")
      setSaveError(null)
      setSaveNotice(null)
      setDescriptionProgress(null)
      setAdvancedEditingOpen(false)
      setEditing(true)
    },
    [active, activeImageIndex],
  )

  const handleCancelEdit = useCallback(() => {
    setEditing(false)
    setEditForm(null)
    setAdvancedEditingOpen(false)
    setTagInput("")
    setSaveError(null)
    setDescriptionProgress(null)
  }, [])

  const handleAddHistoricalExhibition = useCallback(() => {
    if (!active) return
    const image = active.images[activeImageIndex]
    if (!image) return
    const existing = historicalExhibitions.find((item) => item.imageId === image.id)
    if (existing && !existing.captureMuseumName.trim() && !existing.exhibitionName.trim()) {
      noticeApi.info(`图${activeImageIndex + 1}已在新增展览行中`)
      return
    }
    const blankRecord: HistoricalExhibitionDraft = {
      imageId: image.id,
      artifactId: image.artifact_id ?? active.id,
      captureMuseumName: active.museum_name,
      exhibitionName: "",
      catalogSourceId: "",
      catalogExhibitionId: null,
      startAt: null,
      endAt: null,
    }
    setHistoricalExhibitions((current) =>
      current.some((item) => item.imageId === image.id)
        ? current.map((item) => (item.imageId === image.id ? blankRecord : item))
        : [...current, blankRecord],
    )
    setSaveError(null)
    setSaveNotice(`已为图${activeImageIndex + 1}新增展览行，请选择场馆和展览`)
  }, [active, activeImageIndex, historicalExhibitions, noticeApi])

  const handleGenerateDescription = useCallback(
    async (event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
      event?.preventDefault?.()
      event?.stopPropagation?.()
      if (!active || generatingDescription) {
        return
      }

      const image = active.images[activeImageIndex] ?? active.images[0] ?? null
      const targetForm = editForm ?? buildEditForm(active, image)
      if (!targetForm.name.trim()) {
        setSaveError("请先填写文物名称")
        return
      }
      if (!editForm) {
        setEditForm(targetForm)
        setTagInput("")
        setEditing(true)
      }

      setGeneratingDescription(true)
      setDescriptionProgress("正在整理资料并生成描述，这不会影响已经入库的图片…")
      setSaveError(null)
      setSaveNotice(null)

      try {
        const form = new FormData()
        form.append("museum_name", targetForm.museumName.trim())
        form.append("name", targetForm.name.trim())
        form.append("era", targetForm.era.trim())
        form.append("Place_of_Excavation", targetForm.Place_of_Excavation.trim())
        const response = await fetch(`${apiBaseUrl}/api/artifacts/generate-description-stream-file`, {
          method: "POST",
          body: form,
        })
        if (!response.ok || !response.body) {
          throw new Error(`生成描述失败（HTTP ${response.status}）`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ""
        let generated: GeneratedDescription | null = null
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          pending += decoder.decode(value, { stream: true })
          const lines = pending.split("\n")
          pending = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.startsWith("data:")) continue
            const payload = JSON.parse(line.slice(5).trim()) as {
              type: string
              message?: string
              result?: GeneratedDescription
            }
            if (payload.message) setDescriptionProgress(payload.message)
            if (payload.type === "result" && payload.result) generated = payload.result
          }
        }
        if (!generated) {
          throw new Error("模型未返回可用描述")
        }

        const preferred =
          generated.candidates?.find(
            (candidate) =>
              candidate.status === "success" &&
              candidate.provider === generated.provider &&
              candidate.model === generated.model,
          )?.description ||
          generated.candidates?.find((candidate) => candidate.status === "success")?.description ||
          generated.description
        if (!preferred.trim()) {
          throw new Error("模型返回的描述为空")
        }

        setEditForm((current) => (current ? { ...current, description: preferred } : current))
        setDescriptionProgress(`已由 ${generated.provider} / ${generated.model} 生成，请检查后保存`)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "生成描述失败")
        setDescriptionProgress(null)
      } finally {
        setGeneratingDescription(false)
      }
    },
    [active, activeImageIndex, apiBaseUrl, editForm, generatingDescription],
  )

  const addTags = useCallback((rawValue: string) => {
    setEditForm((current) => {
      if (!current) {
        return current
      }
      const nextTags = normalizeTags(rawValue.split(/[,\n，、；;]/).map((tag) => tag.trim()))
      if (nextTags.length === 0) {
        return current
      }
      return {
        ...current,
        tags: normalizeTags([...current.tags, ...nextTags]),
      }
    })
    setTagInput("")
  }, [])

  const removeTag = useCallback((tagToRemove: string) => {
    setEditForm((current) =>
      current
        ? {
            ...current,
            tags: current.tags.filter((tag) => tag !== tagToRemove),
          }
        : current,
    )
  }, [])

  const handleCoordinateChange = useCallback((next: { latitude: string; longitude: string }) => {
    setEditForm((current) => (current ? { ...current, latitude: next.latitude, longitude: next.longitude } : current))
  }, [])

  const handleLocationTextChange = useCallback((next: string) => {
    setEditForm((current) => (current ? { ...current, captureLocation: next } : current))
  }, [])

  return {
    editing,
    setEditing,
    editForm,
    setEditForm,
    historicalExhibitions,
    setHistoricalExhibitions,
    draggedImageId,
    setDraggedImageId,
    advancedEditingOpen,
    setAdvancedEditingOpen,
    tagInput,
    setTagInput,
    generatingDescription,
    descriptionProgress,
    saveError,
    setSaveError,
    saveNotice,
    setSaveNotice,
    handleStartEdit,
    handleCancelEdit,
    handleAddHistoricalExhibition,
    handleGenerateDescription,
    addTags,
    removeTag,
    handleCoordinateChange,
    handleLocationTextChange,
  }
}
