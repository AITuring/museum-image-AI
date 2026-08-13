import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react"
import {
  artifactReviewIdentityKey,
  lookupExistingArtifactCandidates,
  parseArtifactName,
  resolveMuseum,
} from "../lib/exifArtifactLookup"
import {
  applyFilenameParseWithoutOverwritingEdits,
  createExifHistorySnapshot,
  type ExifHistorySnapshot,
} from "../lib/exifWorkbenchFormState"
import type { ExifWorkbenchItem, MuseumOption } from "../components/types"

type Options = {
  apiBaseUrl: string
  ready: boolean
  items: ExifWorkbenchItem[]
  itemsRef: MutableRefObject<ExifWorkbenchItem[]>
  selectedItem: ExifWorkbenchItem | null
  selectedId: string | null
  sharedForm: ExifWorkbenchItem["form"]
  sourceId: string
  availableTargets: ExifWorkbenchItem[]
  lookupRef: MutableRefObject<Set<string>>
  filenameHistory: MutableRefObject<Map<string, string>>
  setItems: Dispatch<SetStateAction<ExifWorkbenchItem[]>>
  setSourceId: Dispatch<SetStateAction<string>>
  setTargetIds: Dispatch<SetStateAction<string[]>>
  setReviewIds: Dispatch<SetStateAction<string[]>>
  setParsing: Dispatch<SetStateAction<boolean>>
  updateItem: (id: string, updater: (item: ExifWorkbenchItem) => ExifWorkbenchItem) => void
  updateAfter: (id: string, snapshot: ExifHistorySnapshot) => void
  revokePreview: (url: string) => void
}

export function useExifEditorEffects({
  apiBaseUrl,
  ready,
  items,
  itemsRef,
  selectedItem,
  selectedId,
  sharedForm,
  sourceId,
  availableTargets,
  lookupRef,
  filenameHistory,
  setItems,
  setSourceId,
  setTargetIds,
  setReviewIds,
  setParsing,
  updateItem,
  updateAfter,
  revokePreview,
}: Options) {
  useEffect(() => {
    if (!ready) {
      return
    }

    const target = items.find((item) => {
      const identity = artifactReviewIdentityKey(item.form)
      return (
        item.existingArtifactId == null
        && (item.existingArtifactCandidates?.length ?? 0) === 0
        && Boolean(identity)
        && item.existingArtifactReviewKey !== identity
      )
    })
    if (!target) {
      return
    }

    const identity = artifactReviewIdentityKey(target.form)
    const lookupKey = `${target.id}:${identity}`
    if (lookupRef.current.has(lookupKey)) {
      return
    }

    lookupRef.current.add(lookupKey)
    setItems((current) =>
      current.map((item) => item.id === target.id ? { ...item, existingArtifactReviewKey: identity } : item),
    )

    void lookupExistingArtifactCandidates(apiBaseUrl, target.form)
      .then((matches) => {
        if (matches.length === 0) {
          return
        }

        setItems((current) =>
          current.map((item) => item.id === target.id
            ? {
                ...item,
                existingArtifactCandidates: matches,
                descriptionMeta: `发现 ${matches.length} 件可能对应的已入库文物，请确认后填入。`,
                submitMessage: "发现可能对应的已入库文物，请先选择是否复用。",
              }
            : item),
        )
        setReviewIds((current) => (current.includes(target.id) ? current : [...current, target.id]))
      })
      .catch(() => {
        // Existing-artifact matching is best-effort; cloud query failures must
        // not surface as unhandled promises or block editing the new photo.
      })
      .finally(() => {
        lookupRef.current.delete(lookupKey)
      })
  }, [apiBaseUrl, items, lookupRef, ready, setItems, setReviewIds])

  useEffect(() => {
    if (!sourceId || !items.some((item) => item.id === sourceId)) {
      setSourceId(items[0]?.id ?? "")
    }
  }, [items, setSourceId, sourceId])

  useEffect(() => {
    const ids = new Set(availableTargets.map((item) => item.id))
    setTargetIds((current) => current.filter((id) => ids.has(id)))
  }, [availableTargets, setTargetIds])

  useEffect(() => {
    const previewItems = itemsRef.current
    return () => {
      previewItems.forEach((item) => revokePreview(item.previewUrl))
    }
  }, [itemsRef, revokePreview])

  useEffect(() => {
    const item = selectedItem
    if (!item?.fileName.trim() || item.parsedName?.original_name === item.fileName) {
      return
    }

    let cancelled = false
    const timer = window.setTimeout(async () => {
      setParsing(true)
      try {
        const parsed = await parseArtifactName(apiBaseUrl, item.fileName)
        if (cancelled) {
          return
        }

        let museum: MuseumOption | null = null
        if (parsed.museum_name) {
          try {
            museum = await resolveMuseum(apiBaseUrl, parsed.museum_name)
          } catch {
            museum = null
          }
        }
        if (cancelled) {
          return
        }

        updateItem(item.id, (current) => ({
          ...current,
          parsedName: parsed,
          form: {
            ...applyFilenameParseWithoutOverwritingEdits(current.form, current.parsedName, parsed),
            latitude: current.form.latitude || museum?.latitude?.toString() || "",
            longitude: current.form.longitude || museum?.longitude?.toString() || "",
          },
        }))

        const operationId = filenameHistory.current.get(item.id)
        if (operationId) {
          updateAfter(operationId, createExifHistorySnapshot(itemsRef.current, selectedId, sharedForm))
        }
      } finally {
        if (!cancelled) {
          setParsing(false)
        }
      }
    }, 280)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [apiBaseUrl, filenameHistory, itemsRef, selectedId, selectedItem, setParsing, sharedForm, updateAfter, updateItem])
}
