import type {
  HistoricalExhibitionDraft,
  HistoricalExhibitionGroup,
  MuseumOption,
} from "./galleryEditorTypes"

const SHANGHAI_MUSEUM_BRANCHES = [
  "上海博物馆东馆",
  "上海博物馆人民广场馆",
] as const

export function groupHistoricalExhibitions(records: HistoricalExhibitionDraft[]) {
  const groups = new Map<string, HistoricalExhibitionGroup>()
  for (const record of records) {
    const key = `${record.captureMuseumName}\u0000${record.exhibitionName}\u0000${record.startAt ?? ""}\u0000${record.endAt ?? ""}`
    const existing = groups.get(key)
    if (existing) {
      existing.imageIds.push(record.imageId)
    } else {
      groups.set(key, { ...record, imageIds: [record.imageId] })
    }
  }
  return Array.from(groups.values())
}

export function normalizeLookupText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s·•・,，。．()（）[\]【】<>《》\-—–_/]+/g, "")
}

export function isFloorLabel(value: string | null | undefined) {
  const normalized = (value ?? "").trim()
  if (!normalized || /(博物馆|博物院|美术馆|纪念馆|艺术馆)$/.test(normalized)) return false
  return (
    /^[负-]?\d+\s*(楼|层)$/.test(normalized)
    || /(展厅|展区|展馆)$/.test(normalized)
  )
}

export function formatExhibitionPeriod(
  startAt: string | null,
  endAt: string | null,
  exhibitionName = "",
  missingLabel = "时间未注明",
) {
  if (!startAt && !endAt) {
    return normalizeLookupText(exhibitionName).includes("常设") ? "常设展" : missingLabel
  }
  return `${startAt?.slice(0, 10) ?? "未知"} – ${endAt?.slice(0, 10) ?? "至今"}`
}

export function normalizeMuseumOptions(options: MuseumOption[]) {
  const genericKey = normalizeLookupText("上海博物馆")
  const next = options.filter((museum) => normalizeLookupText(museum.name) !== genericKey)
  const existingNames = new Set(next.map((museum) => normalizeLookupText(museum.name)))
  SHANGHAI_MUSEUM_BRANCHES.forEach((name, index) => {
    if (!existingNames.has(normalizeLookupText(name))) {
      next.push({ id: -(index + 1), name })
    }
  })
  return next.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
}

export function catalogMuseumQueryName(museumName: string) {
  return normalizeLookupText(museumName) === normalizeLookupText("上海博物馆人民广场馆")
    ? "上海博物馆"
    : museumName
}

export function canonicalCatalogMuseumName(item: {
  museum_name: string | null
  address?: string | null
}) {
  const museumName = item.museum_name?.trim() ?? ""
  if (normalizeLookupText(museumName) === normalizeLookupText("上海博物馆")) {
    return "上海博物馆人民广场馆"
  }
  if (isFloorLabel(museumName)) {
    const addressKey = normalizeLookupText(item.address)
    if (addressKey.includes(normalizeLookupText("世纪大道1952号"))) {
      return "上海博物馆东馆"
    }
    if (addressKey.includes(normalizeLookupText("人民大道201号"))) {
      return "上海博物馆人民广场馆"
    }
  }
  return museumName
}

export function resolvedCatalogMuseumName(
  item: { museum_name: string | null; address?: string | null },
  fallbackMuseumName: string,
) {
  const canonicalName = canonicalCatalogMuseumName(item)
  return !canonicalName || isFloorLabel(canonicalName) ? fallbackMuseumName : canonicalName
}
