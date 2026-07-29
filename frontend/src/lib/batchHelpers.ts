export function statusClass(status: string) {
  if (status === "submitted") return "ok"
  if (status === "failed") return "failed"
  if (status === "identifying" || status === "submitting") return "busy"
  return ""
}

export function normalizeTags(values: string[]) {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const value of values) {
    const tag = value.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

export function isMissingValue(value: string | null | undefined) {
  return !value || !value.trim()
}

export function needsSelection(value: string | null | undefined) {
  return (value ?? "").trim().startsWith("@")
}
