import { useCallback, useEffect, useRef, useState } from "react"
import { getBackendImageVariantUrl } from "../lib/galleryArtifactIdentity"
import { normalizeMuseumOptions } from "../lib/galleryEditorHelpers"
import type { EraOption, MuseumOption } from "../lib/galleryEditorTypes"
import {
  fetchGalleryArtifacts,
  getGalleryArtifactIdFromLocation,
  getGalleryReturnTarget,
} from "../lib/galleryPageHelpers"
import type { GalleryArtifact } from "../lib/galleryTypes"

type Params = {
  apiBaseUrl: string
  editingRef: { current: boolean }
}

export function useGalleryPageState({ apiBaseUrl, editingRef }: Params) {
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [items, setItems] = useState<GalleryArtifact[]>([])
  const [museumOptions, setMuseumOptions] = useState<MuseumOption[]>([])
  const [eraOptions, setEraOptions] = useState<EraOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<GalleryArtifact | null>(null)
  const [artifactRouteId, setArtifactRouteId] = useState<number | null>(getGalleryArtifactIdFromLocation)
  const [activeImageIndex, setActiveImageIndex] = useState(0)
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false)
  const [previewImageIndex, setPreviewImageIndex] = useState(0)
  const thumbnailStripRef = useRef<HTMLDivElement | null>(null)

  const resetMediaState = useCallback(() => {
    setImagePreviewOpen(false)
    setPreviewImageIndex(0)
    setActiveImageIndex(0)
  }, [])

  const fetchJson = useCallback(async <T,>(input: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(input, init)
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
    return (await response.json()) as T
  }, [])

  const load = useCallback(
    async (q: string) => {
      setLoading(true)
      setError(null)
      try {
        setItems(await fetchGalleryArtifacts(apiBaseUrl, q))
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载失败")
      } finally {
        setLoading(false)
      }
    },
    [apiBaseUrl],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load("")
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    const syncRoute = () => {
      const routeId = getGalleryArtifactIdFromLocation()
      setArtifactRouteId(routeId)
      if (routeId === null) {
        resetMediaState()
        setActive(null)
      }
    }
    window.addEventListener("popstate", syncRoute)
    return () => window.removeEventListener("popstate", syncRoute)
  }, [resetMediaState])

  useEffect(() => {
    if (artifactRouteId === null) return
    const requestedArtifact = items.find((item) => item.id === artifactRouteId)
    if (!requestedArtifact) return
    const timer = window.setTimeout(() => {
      resetMediaState()
      setActive(requestedArtifact)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [artifactRouteId, items, resetMediaState])

  useEffect(() => {
    void (async () => {
      try {
        const [museums, eras] = await Promise.all([
          fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?limit=200`),
          fetchJson<EraOption[]>(`${apiBaseUrl}/api/era-options`),
        ])
        setMuseumOptions(normalizeMuseumOptions(museums))
        setEraOptions(eras)
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载联想选项失败")
      }
    })()
  }, [apiBaseUrl, fetchJson])

  const navigateToGallery = useCallback(() => {
    const returnTarget = getGalleryReturnTarget()
    if (window.location.pathname !== returnTarget.path || window.location.search) {
      window.history.pushState({}, "", returnTarget.path)
    }
    setArtifactRouteId(null)
    resetMediaState()
    setActive(null)
  }, [resetMediaState])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")

      if (isEditableTarget) return
      if (event.key === "Escape") {
        if (imagePreviewOpen) {
          setImagePreviewOpen(false)
          return
        }
        if (!editingRef.current) navigateToGallery()
        return
      }
      if (editingRef.current || active.images.length < 2) return
      if (event.key === "ArrowRight") {
        event.preventDefault()
        setActiveImageIndex((current) => (current + 1) % active.images.length)
        return
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        setActiveImageIndex((current) => (current - 1 + active.images.length) % active.images.length)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [active, editingRef, imagePreviewOpen, navigateToGallery])

  useEffect(() => {
    if (!active || active.images.length < 2) return

    const imageIndexes =
      active.images.length <= 8
        ? active.images.map((_, index) => index)
        : [
            (activeImageIndex - 1 + active.images.length) % active.images.length,
            (activeImageIndex + 1) % active.images.length,
          ]

    imageIndexes
      .filter((index) => index !== activeImageIndex)
      .forEach((index) => {
        const preloadImage = new window.Image()
        preloadImage.src = getBackendImageVariantUrl(apiBaseUrl, active.images[index].url, 1280)
      })
  }, [active, activeImageIndex, apiBaseUrl])

  useEffect(() => {
    const activeThumbnail = thumbnailStripRef.current?.querySelector<HTMLElement>(
      `[data-image-index="${activeImageIndex}"]`,
    )
    activeThumbnail?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active?.id, activeImageIndex])

  const handleSearch = useCallback(
    (event: { preventDefault(): void }) => {
      event.preventDefault()
      setSubmittedQuery(query)
      void load(query)
    },
    [load, query],
  )

  const navigateToArtifact = useCallback((artifact: GalleryArtifact) => {
    const nextPath = `/gallery/${artifact.id}`
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath)
    }
    setArtifactRouteId(artifact.id)
    resetMediaState()
    setActive(artifact)
    window.scrollTo(0, 0)
  }, [resetMediaState])

  return {
    query,
    setQuery,
    submittedQuery,
    items,
    setItems,
    museumOptions,
    eraOptions,
    loading,
    error,
    setError,
    active,
    setActive,
    activeImageIndex,
    setActiveImageIndex,
    imagePreviewOpen,
    setImagePreviewOpen,
    previewImageIndex,
    setPreviewImageIndex,
    thumbnailStripRef,
    handleSearch,
    navigateToArtifact,
    navigateToGallery,
  }
}
