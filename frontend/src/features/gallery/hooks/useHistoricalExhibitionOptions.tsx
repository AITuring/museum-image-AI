import { useEffect, useMemo, useRef, useState } from "react"
import {
  catalogMuseumQueryName,
  canonicalCatalogMuseumName,
  formatExhibitionPeriod,
  normalizeLookupText,
  resolvedCatalogMuseumName,
} from "../lib/galleryEditorHelpers"
import type {
  CatalogExhibitionOption,
  HistoricalExhibitionChoice,
  HistoricalExhibitionDraft,
  LocalExhibitionOption,
} from "../lib/galleryEditorTypes"

type Params = {
  apiBaseUrl: string
  group: Pick<HistoricalExhibitionDraft, "captureMuseumName" | "catalogSourceId" | "startAt" | "endAt">
  exhibitionName: string
  onUpdate: (patch: Partial<HistoricalExhibitionDraft>) => void
}

export function useHistoricalExhibitionOptions({
  apiBaseUrl,
  group,
  exhibitionName,
  onUpdate,
}: Params) {
  const [exhibitionQuery, setExhibitionQuery] = useState(exhibitionName)
  const [exhibitionChoices, setExhibitionChoices] = useState<HistoricalExhibitionChoice[]>([])
  const [loadingExhibitions, setLoadingExhibitions] = useState(false)
  const hydratedCatalogSourceRef = useRef<string | null>(null)

  useEffect(() => {
    setExhibitionQuery(exhibitionName)
  }, [exhibitionName])

  useEffect(() => {
    if (
      !group.catalogSourceId
      || group.startAt
      || group.endAt
      || hydratedCatalogSourceRef.current === group.catalogSourceId
    ) {
      return
    }

    hydratedCatalogSourceRef.current = group.catalogSourceId
    const controller = new AbortController()

    void (async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/exhibition-catalog/source/${encodeURIComponent(group.catalogSourceId)}`,
          { signal: controller.signal },
        )
        if (!response.ok) return
        const catalogItem = (await response.json()) as CatalogExhibitionOption
        onUpdate({
          catalogExhibitionId: catalogItem.id,
          startAt: catalogItem.start_date,
          endAt: catalogItem.end_date,
        })
      } catch {
        // Keep the saved exhibition link when the catalog is temporarily unavailable.
      }
    })()

    return () => controller.abort()
  }, [apiBaseUrl, group.catalogSourceId, group.endAt, group.startAt, onUpdate])

  useEffect(() => {
    const museumName = group.captureMuseumName.trim()
    if (!museumName) {
      setExhibitionChoices([])
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoadingExhibitions(true)
      try {
        const catalogMuseumName = catalogMuseumQueryName(museumName)
        const catalogParams = new URLSearchParams({
          include_facets: "false",
          museum_name: catalogMuseumName,
          page_size: "50",
        })
        const keyword = exhibitionQuery.trim()
        if (keyword) catalogParams.set("q", keyword)

        const localParams = new URLSearchParams({
          museum_name: museumName,
          limit: "100",
        })
        if (keyword) localParams.set("q", keyword)

        const broadCatalogParams = new URLSearchParams({
          include_facets: "false",
          page_size: "50",
        })
        if (keyword) broadCatalogParams.set("q", keyword)

        const [catalogResponse, broadCatalogResponse, localResponse] = await Promise.all([
          fetch(`${apiBaseUrl}/api/exhibition-catalog?${catalogParams.toString()}`, {
            signal: controller.signal,
          }),
          keyword
            ? fetch(`${apiBaseUrl}/api/exhibition-catalog?${broadCatalogParams.toString()}`, {
                signal: controller.signal,
              })
            : Promise.resolve(null),
          fetch(`${apiBaseUrl}/api/exhibitions?${localParams.toString()}`, {
            signal: controller.signal,
          }),
        ])

        if (!catalogResponse.ok || (broadCatalogResponse && !broadCatalogResponse.ok) || !localResponse.ok) {
          throw new Error("展览联想加载失败")
        }

        const catalogPayload = (await catalogResponse.json()) as { items: CatalogExhibitionOption[] }
        const broadCatalogPayload = broadCatalogResponse
          ? ((await broadCatalogResponse.json()) as { items: CatalogExhibitionOption[] })
          : { items: [] }
        const localPayload = (await localResponse.json()) as LocalExhibitionOption[]
        const museumKey = normalizeLookupText(museumName)
        const catalogMuseumQueryKey = normalizeLookupText(catalogMuseumName)

        const constrainedCatalogItems = [...catalogPayload.items, ...broadCatalogPayload.items].filter((item) => {
          const catalogMuseumKey = normalizeLookupText(canonicalCatalogMuseumName(item))
          const museumMatches =
            Boolean(catalogMuseumKey)
            && (
              catalogMuseumKey.includes(museumKey)
              || museumKey.includes(catalogMuseumKey)
              || catalogMuseumKey === catalogMuseumQueryKey
            )
          return item.source_id === group.catalogSourceId || museumMatches
        })

        const combined: HistoricalExhibitionChoice[] = [
          ...constrainedCatalogItems.map((item) => ({
            key: `catalog:${item.source_id}`,
            name: item.title,
            museumName: resolvedCatalogMuseumName(item, museumName),
            venue: item.venue ?? "",
            catalogSourceId: item.source_id,
            catalogExhibitionId: item.id,
            startAt: item.start_date,
            endAt: item.end_date,
            isPermanent: item.is_permanent,
          })),
          ...localPayload.map((item) => ({
            key: item.catalog_source_id ? `catalog:${item.catalog_source_id}` : `local:${item.id}`,
            name: item.name,
            museumName: resolvedCatalogMuseumName({ museum_name: item.museum_name }, museumName),
            venue: "",
            catalogSourceId: item.catalog_source_id ?? "",
            catalogExhibitionId: item.catalog_exhibition_id,
            startAt: item.start_at,
            endAt: item.end_at,
            isPermanent: normalizeLookupText(item.name).includes("常设"),
          })),
        ]

        const seen = new Set<string>()
        setExhibitionChoices(
          combined.filter((choice) => {
            const identity = `${normalizeLookupText(choice.museumName)}:${normalizeLookupText(choice.name)}`
            if (seen.has(identity)) return false
            seen.add(identity)
            return true
          }),
        )
      } catch {
        if (!controller.signal.aborted) {
          setExhibitionChoices([])
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingExhibitions(false)
        }
      }
    }, 180)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [apiBaseUrl, exhibitionQuery, group.captureMuseumName, group.catalogSourceId])

  const exhibitionOptions = useMemo(
    () =>
      exhibitionChoices.map((choice) => ({
        value: choice.name,
        label: (
          <span className="gallery-exhibition-option">
            <strong>{choice.name}</strong>
            <small>
              {[choice.museumName, choice.venue, formatExhibitionPeriod(choice.startAt, choice.endAt, choice.name)]
                .filter((item, optionIndex, details) => {
                  return (
                    Boolean(item)
                    && details.findIndex((candidate) => normalizeLookupText(candidate) === normalizeLookupText(item)) === optionIndex
                  )
                })
                .join(" · ")}
            </small>
          </span>
        ),
      })),
    [exhibitionChoices],
  )

  return {
    exhibitionChoices,
    exhibitionOptions,
    exhibitionQuery,
    loadingExhibitions,
    setExhibitionQuery,
  }
}
