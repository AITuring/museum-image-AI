import { useEffect, useState } from "react"
import { AutoComplete, Card, Input, Tooltip } from "antd"
import { Landmark, Search } from "lucide-react"
import { loadMuseumSuggestions, searchExistingArtifactsByName } from "../lib/exifArtifactLookup"
import { FieldReviewBadge, type ArtifactFieldWarning } from "./ReviewIndicators"
import type { ExistingArtifact, FormState, MuseumOption } from "./types"

type BasicArtifactInfoCardProps = {
  apiBaseUrl: string
  itemId: string
  form: FormState
  warningForField: (field: string) => ArtifactFieldWarning | undefined
  onChange: (changes: Partial<FormState>) => void
  onSelectExistingArtifact: (artifact: ExistingArtifact) => void
}

const SectionTitle = () => <Tooltip title="优先确认文物名称、馆藏单位和时代。" placement="topLeft" trigger={["hover", "focus"]}><span className="exif-section-title" tabIndex={0}><Landmark size={16} strokeWidth={1.8} aria-hidden="true" /><span>基础信息</span></span></Tooltip>

export function BasicArtifactInfoCard({
  apiBaseUrl,
  itemId,
  form,
  warningForField,
  onChange,
  onSelectExistingArtifact,
}: BasicArtifactInfoCardProps) {
  const [museumSuggestions, setMuseumSuggestions] = useState<MuseumOption[]>([])
  const [artifactSearchResults, setArtifactSearchResults] = useState<ExistingArtifact[]>([])
  const [showMuseumSuggestions, setShowMuseumSuggestions] = useState(false)
  const [showArtifactSearch, setShowArtifactSearch] = useState(false)

  useEffect(() => {
    setShowMuseumSuggestions(false)
    setShowArtifactSearch(false)
    setMuseumSuggestions([])
    setArtifactSearchResults([])
  }, [itemId])

  useEffect(() => {
    if (!showMuseumSuggestions) {
      return
    }

    const timer = window.setTimeout(() => {
      void loadMuseumSuggestions(apiBaseUrl, form.museumName.trim(), setMuseumSuggestions)
    }, 180)

    return () => window.clearTimeout(timer)
  }, [apiBaseUrl, form.museumName, showMuseumSuggestions])

  useEffect(() => {
    const query = form.name.trim()
    if (!showArtifactSearch || query.length < 2) {
      setArtifactSearchResults([])
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      void searchExistingArtifactsByName(apiBaseUrl, query)
        .then((results) => {
          if (!cancelled) {
            setArtifactSearchResults(results)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setArtifactSearchResults([])
          }
        })
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [apiBaseUrl, form.name, showArtifactSearch])

  return <Card size="small" className="form-section exif-form-card" title={<SectionTitle />}>
    <div className="form-section-body">
      <div className="field-row">
        <label className="field">
          <span>馆藏单位 <FieldReviewBadge warning={warningForField("museum_name")} /></span>
          <AutoComplete
            value={form.museumName}
            options={museumSuggestions.map((museum) => ({ key: museum.id, value: museum.name, label: museum.name }))}
            filterOption={false} open={showMuseumSuggestions && museumSuggestions.length > 0}
            placeholder="例如：山东省博物馆"
            onFocus={() => setShowMuseumSuggestions(true)} onOpenChange={setShowMuseumSuggestions}
            onChange={(value) => { onChange({ museumName: value }); setShowMuseumSuggestions(true) }}
            onSelect={(value) => { onChange({ museumName: value }); setShowMuseumSuggestions(false) }}
          />
        </label>
        <label className="field">
          <span>文物名称 <FieldReviewBadge warning={warningForField("artifact_name")} /><small className="field-search-hint"><Search size={12} /> 搜索并选择已有文物后才复用</small></span>
          <AutoComplete
            value={form.name}
            options={artifactSearchResults.map((artifact) => ({ value: `artifact:${artifact.id}`, label: <div className="artifact-name-search-option"><strong>{artifact.name}</strong><span>{artifact.era || "时代待补充"} · {artifact.museum_name}</span></div> }))}
            filterOption={false} open={showArtifactSearch && artifactSearchResults.length > 0}
            placeholder="例如：夫妇宴享行乐图"
            onFocus={() => setShowArtifactSearch(true)} onOpenChange={setShowArtifactSearch}
            onChange={(value) => { if (!value.startsWith("artifact:")) { onChange({ name: value }); setShowArtifactSearch(true) } }}
            onSelect={(value) => {
              const artifact = artifactSearchResults.find((item) => `artifact:${item.id}` === value)
              if (artifact) {
                onSelectExistingArtifact(artifact)
                setShowArtifactSearch(false)
                setArtifactSearchResults([])
              }
            }}
          />
        </label>
      </div>
      <div className="field-row">
        <label className="field"><span>时代 <FieldReviewBadge warning={warningForField("era")} /></span><Input value={form.era} placeholder="例如：隋代" onChange={(event) => onChange({ era: event.target.value })} /></label>
        <label className="field"><span>出土地 <FieldReviewBadge warning={warningForField("place_of_excavation")} /></span><Input value={form.placeOfExcavation} placeholder="例如：1976年嘉祥英山一号隋墓出土" onChange={(event) => onChange({ placeOfExcavation: event.target.value })} /></label>
      </div>
    </div>
  </Card>
}
