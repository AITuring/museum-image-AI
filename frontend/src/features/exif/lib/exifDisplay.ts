export function formatCapturedAt(value: string | null | undefined) {
  if (!value) return ""
  const normalized = value.trim().replace("T", " ").replace(/\.\d+(?=\s|$)/, "")
  return normalized.replace(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/, (_, year, month, day) => `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`)
}

export function compactFileName(value: string, maxLength = 38) {
  const characters = Array.from(value)
  if (characters.length <= maxLength) return value
  const tailLength = Math.max(14, Math.floor(maxLength * 0.46))
  const headLength = Math.max(10, maxLength - tailLength - 1)
  return `${characters.slice(0, headLength).join("")}…${characters.slice(-tailLength).join("")}`
}

export function indexedFileName(value: string, index: number) {
  return `${String(Math.max(index, 0) + 1).padStart(2, "0")} · ${compactFileName(value)}`
}
