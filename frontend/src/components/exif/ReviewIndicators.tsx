import { type ReactNode } from "react"
import { Tooltip } from "antd"

export type ArtifactFieldWarning = {
  field: "artifact_name" | "era" | "museum_name" | "place_of_excavation" | string
  label: string
  input_value: string
  suggested_value: string | null
  reason: string
  source_refs: string[]
}

export function warningDetail(warning: ArtifactFieldWarning) {
  const suggestion = warning.suggested_value ? `建议值：${warning.suggested_value}。` : ""
  const sources = warning.source_refs.length > 0 ? `依据：${warning.source_refs.join("、")}。` : ""
  return `${warning.reason}${suggestion}${sources}`
}

export function FieldReviewBadge({ warning }: { warning?: ArtifactFieldWarning }) {
  return warning ? <Tooltip title={warningDetail(warning)}><span className="field-review-badge">需要复核</span></Tooltip> : null
}

export function AnnotatedDescription({ description, warnings }: { description: string; warnings: ArtifactFieldWarning[] }) {
  const markers = warnings.flatMap((warning) => {
    const value = [warning.suggested_value, warning.input_value].map((item) => item?.trim()).filter((item): item is string => Boolean(item)).find((item) => description.includes(item))
    return value ? [{ warning, value, index: description.indexOf(value) }] : []
  }).sort((left, right) => left.index - right.index)
  if (markers.length === 0) return <p className="result-desc">{description || "暂无描述"}</p>
  const parts: ReactNode[] = []
  let cursor = 0
  markers.forEach(({ warning, value, index }, markerIndex) => {
    if (index < cursor) return
    parts.push(description.slice(cursor, index + value.length))
    parts.push(<Tooltip key={`${warning.field}-${markerIndex}`} title={warningDetail(warning)}><span className="inline-review-badge">需要复核</span></Tooltip>)
    cursor = index + value.length
  })
  parts.push(description.slice(cursor))
  return <p className="result-desc annotated-description">{parts}</p>
}
