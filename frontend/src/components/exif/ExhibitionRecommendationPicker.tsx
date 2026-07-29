import { useEffect, useState } from "react"
import { Input, Select } from "antd"
import type { ExhibitionRecommendation } from "./types"

type ExhibitionRecommendationPickerProps = {
  apiBaseUrl: string
  capturedAt: string
  latitude: string
  longitude: string
  location: string
  selectedSourceId: string
  selectedName: string
  onSelect: (item: ExhibitionRecommendation | null) => void
  onManualChange: (value: string) => void
}

function formatRecommendationDate(item: ExhibitionRecommendation) {
  if (item.is_permanent) return "常设展"
  if (item.start_date && item.end_date) return `${item.start_date} — ${item.end_date}`
  if (item.start_date) return `${item.start_date} 起`
  if (item.end_date) return `至 ${item.end_date}`
  return "日期待确认"
}

async function fetchRecommendations(input: string, init: RequestInit) {
  const response = await fetch(input, init)
  if (response.ok) return response.json() as Promise<ExhibitionRecommendation[]>
  const payload = await response.json().catch(() => null) as { detail?: string } | null
  throw new Error(payload?.detail || `HTTP ${response.status}`)
}

export function ExhibitionRecommendationPicker({
  apiBaseUrl,
  capturedAt,
  latitude,
  longitude,
  location,
  selectedSourceId,
  selectedName,
  onSelect,
  onManualChange,
}: ExhibitionRecommendationPickerProps) {
  const [recommendations, setRecommendations] = useState<ExhibitionRecommendation[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const hasContext = Boolean(capturedAt.trim() || location.trim() || (latitude.trim() && longitude.trim()) || query.trim())
    if (!hasContext) {
      const resetTimer = window.setTimeout(() => { setRecommendations([]); setError(null) }, 0)
      return () => window.clearTimeout(resetTimer)
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "10" })
      if (capturedAt.trim()) params.set("captured_at", capturedAt.trim())
      if (location.trim()) params.set("location", location.trim())
      if (latitude.trim()) params.set("latitude", latitude.trim())
      if (longitude.trim()) params.set("longitude", longitude.trim())
      if (query.trim()) params.set("q", query.trim())
      setLoading(true)
      setError(null)
      void fetchRecommendations(`${apiBaseUrl}/api/exhibition-catalog/recommendations?${params.toString()}`, { signal: controller.signal })
        .then(setRecommendations)
        .catch((nextError) => { if (!controller.signal.aborted) setError(nextError instanceof Error ? nextError.message : "展览推荐加载失败") })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 320)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [apiBaseUrl, capturedAt, latitude, longitude, location, query])

  const options = recommendations.map((item) => ({
    value: item.source_id,
    label: <div className="exhibition-option"><strong>{item.title}</strong><span>{Array.from(new Set([item.city, item.museum_name, item.venue, formatRecommendationDate(item)].filter((value): value is string => Boolean(value)))).join(" · ")}</span>{item.match_reasons.length ? <small>{item.match_reasons.join("；")}</small> : null}</div>,
  }))
  if (selectedSourceId && !options.some((option) => option.value === selectedSourceId)) {
    options.unshift({ value: selectedSourceId, label: <div className="exhibition-option"><strong>{selectedName || "已关联展览"}</strong><span>已保存的展览关联</span></div> })
  }

  return <div className="exhibition-picker">
    <Select
      allowClear showSearch filterOption={false} loading={loading} value={selectedSourceId || undefined}
      placeholder={capturedAt || latitude || longitude || location ? "按 EXIF 时间与地点推荐展览" : "照片含时间或定位后自动推荐"}
      options={options} popupMatchSelectWidth={420} notFoundContent={loading ? "正在检索…" : "没有符合条件的展览"}
      onSearch={setQuery} onClear={() => onSelect(null)}
      onSelect={(sourceId) => { const item = recommendations.find((candidate) => candidate.source_id === sourceId); if (item) onSelect(item) }}
    />
    <Input value={selectedName} placeholder="找不到时可手动填写展览名称" onChange={(event) => onManualChange(event.target.value)} />
    {error ? <span className="field-help error">{error}</span> : null}
    {!error && recommendations.length > 0 ? <span className="field-help">已按展出地点筛选，并结合拍摄日期排序；匹配地点的常设展也会持续参与推荐。</span> : null}
  </div>
}
