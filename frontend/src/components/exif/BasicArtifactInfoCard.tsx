import { AutoComplete, Card, Input, Tooltip } from "antd"
import { Landmark, Search } from "lucide-react"
import { FieldReviewBadge, type ArtifactFieldWarning } from "./ReviewIndicators"
import type { ExistingArtifact, FormState, MuseumOption } from "./types"

type BasicArtifactInfoCardProps = {
  form: FormState
  museumSuggestions: MuseumOption[]
  artifactSearchResults: ExistingArtifact[]
  showMuseumSuggestions: boolean
  showArtifactSearch: boolean
  warningForField: (field: string) => ArtifactFieldWarning | undefined
  onChange: (changes: Partial<FormState>) => void
  onMuseumSuggestionsOpenChange: (open: boolean) => void
  onArtifactSearchOpenChange: (open: boolean) => void
  onSelectExistingArtifact: (id: number) => void
}

const SectionTitle = () => <Tooltip title="优先确认文物名称、馆藏单位和时代。" placement="topLeft" trigger={["hover", "focus"]}><span className="exif-section-title" tabIndex={0}><Landmark size={16} strokeWidth={1.8} aria-hidden="true" /><span>基础信息</span></span></Tooltip>

export function BasicArtifactInfoCard({
  form,
  museumSuggestions,
  artifactSearchResults,
  showMuseumSuggestions,
  showArtifactSearch,
  warningForField,
  onChange,
  onMuseumSuggestionsOpenChange,
  onArtifactSearchOpenChange,
  onSelectExistingArtifact,
}: BasicArtifactInfoCardProps) {
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
            onFocus={() => onMuseumSuggestionsOpenChange(true)} onOpenChange={onMuseumSuggestionsOpenChange}
            onChange={(value) => { onChange({ museumName: value }); onMuseumSuggestionsOpenChange(true) }}
            onSelect={(value) => { onChange({ museumName: value }); onMuseumSuggestionsOpenChange(false) }}
          />
        </label>
        <label className="field">
          <span>文物名称 <FieldReviewBadge warning={warningForField("artifact_name")} /><small className="field-search-hint"><Search size={12} /> 搜索并选择已有文物后才复用</small></span>
          <AutoComplete
            value={form.name}
            options={artifactSearchResults.map((artifact) => ({ value: `artifact:${artifact.id}`, label: <div className="artifact-name-search-option"><strong>{artifact.name}</strong><span>{artifact.era || "时代待补充"} · {artifact.museum_name}</span></div> }))}
            filterOption={false} open={showArtifactSearch && artifactSearchResults.length > 0}
            placeholder="例如：夫妇宴享行乐图"
            onFocus={() => onArtifactSearchOpenChange(true)} onOpenChange={onArtifactSearchOpenChange}
            onChange={(value) => { if (!value.startsWith("artifact:")) { onChange({ name: value }); onArtifactSearchOpenChange(true) } }}
            onSelect={(value) => { const id = Number(value.replace("artifact:", "")); if (Number.isInteger(id)) onSelectExistingArtifact(id) }}
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
