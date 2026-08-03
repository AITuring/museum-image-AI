import { useCallback, useEffect, useMemo, useState } from "react"
import { buildEditForm, buildHistoricalExhibitionDrafts, normalizeTags } from "../lib/galleryPageHelpers"
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
  const [initialDraft, setInitialDraft] = useState<string | null>(null)

  const currentDraft = useMemo(
    () => (editForm ? JSON.stringify({ editForm, historicalExhibitions }) : null),
    [editForm, historicalExhibitions],
  )
  const hasUnsavedChanges = editing && Boolean(initialDraft && currentDraft !== initialDraft)

  const clearFeedback = useCallback((options?: { keepNotice?: boolean }) => {
    setSaveError(null)
    if (!options?.keepNotice) {
      setSaveNotice(null)
    }
    setDescriptionProgress(null)
  }, [])

  const resetEditingState = useCallback(() => {
    setInitialDraft(null)
    setEditing(false)
    setEditForm(null)
    setHistoricalExhibitions([])
    setDraggedImageId(null)
    setAdvancedEditingOpen(false)
    setTagInput("")
    clearFeedback()
    setGeneratingDescription(false)
  }, [clearFeedback])

  const updateEditForm = useCallback((patch: Partial<GalleryEditFormState>) => {
    setEditForm((current) => (current ? { ...current, ...patch } : current))
  }, [])

  const startEditingSession = useCallback((nextForm: GalleryEditFormState, nextHistory: HistoricalExhibitionDraft[]) => {
    setInitialDraft(JSON.stringify({ editForm: nextForm, historicalExhibitions: nextHistory }))
    setEditForm(nextForm)
    setHistoricalExhibitions(nextHistory)
    setTagInput("")
    clearFeedback()
    setAdvancedEditingOpen(false)
    setEditing(true)
  }, [clearFeedback])

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
      startEditingSession(buildEditForm(active, image), buildHistoricalExhibitionDrafts(active))
    },
    [active, activeImageIndex, startEditingSession],
  )

  const handleCancelEdit = useCallback(() => {
    setInitialDraft(null)
    setEditing(false)
    setEditForm(null)
    setAdvancedEditingOpen(false)
    setTagInput("")
    clearFeedback({ keepNotice: true })
  }, [clearFeedback])

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
        startEditingSession(targetForm, buildHistoricalExhibitionDrafts(active))
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

        updateEditForm({ description: preferred })
        setDescriptionProgress(`已由 ${generated.provider} / ${generated.model} 生成，请检查后保存`)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "生成描述失败")
        setDescriptionProgress(null)
      } finally {
        setGeneratingDescription(false)
      }
    },
    [active, activeImageIndex, apiBaseUrl, editForm, generatingDescription, startEditingSession, updateEditForm],
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
    updateEditForm({ latitude: next.latitude, longitude: next.longitude })
  }, [updateEditForm])

  const handleLocationTextChange = useCallback((next: string) => {
    updateEditForm({ captureLocation: next })
  }, [updateEditForm])

  return {
    editing,
    setEditing,
    editForm,
    setEditForm,
    updateEditForm,
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
    hasUnsavedChanges,
    handleAddHistoricalExhibition,
    handleGenerateDescription,
    addTags,
    removeTag,
    handleCoordinateChange,
    handleLocationTextChange,
  }
}
