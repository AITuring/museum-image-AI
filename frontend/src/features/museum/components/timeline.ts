import type { ExhibitionItem } from "../ExhibitionCatalog"

export function formatDate(value: string | null) {
  if (!value) return "日期待定"
  return value.replace(/-/g, ".")
}

export function formatDateRange(item: ExhibitionItem) {
  if (item.is_permanent) return "常设展"
  if (!item.start_date && !item.end_date) return "日期待定"
  if (!item.start_date) return `至 ${formatDate(item.end_date)}`
  if (!item.end_date) return `${formatDate(item.start_date)} 起`
  return `${formatDate(item.start_date)} — ${formatDate(item.end_date)}`
}

export function formatSyncTime(value: string | null) {
  if (!value) return "尚未同步"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `更新于 ${date.toLocaleString("zh-CN", { hour12: false })}`
}

export function formatDuration(seconds: number | null) {
  if (!seconds || seconds < 1) return "刚刚"
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
  return `${(seconds / 3600).toFixed(1)} 小时`
}

const DAY_IN_MS = 24 * 60 * 60 * 1000

export function parseDateValue(value: string | null) {
  if (!value) return null
  const [year, month, day] = value.slice(0, 10).split("-").map(Number)
  if (!year || !month || !day) return null
  return Date.UTC(year, month - 1, day)
}

export function getTimelinePlacement(item: ExhibitionItem, year: number) {
  const yearStart = Date.UTC(year, 0, 1)
  const yearEnd = Date.UTC(year + 1, 0, 1)
  const startValue = parseDateValue(item.start_date)
  const endValue = parseDateValue(item.end_date)
  if (startValue == null && endValue == null && !item.is_permanent) return null
  const sourceStart = item.is_permanent ? yearStart : (startValue ?? endValue ?? yearStart)
  const sourceEnd = item.is_permanent ? yearEnd : (endValue != null ? endValue + DAY_IN_MS : (startValue ?? yearStart) + DAY_IN_MS)
  if (sourceEnd <= yearStart || sourceStart >= yearEnd) return null
  const start = Math.max(sourceStart, yearStart)
  const end = Math.min(Math.max(sourceEnd, start + DAY_IN_MS), yearEnd)
  const total = yearEnd - yearStart
  const leftPercent = (start - yearStart) / total * 100
  const rawWidthPercent = (end - start) / total * 100
  return {
    start,
    end,
    leftPercent,
    widthPercent: Math.min(Math.max(rawWidthPercent, 1.2), 100 - leftPercent),
  }
}
