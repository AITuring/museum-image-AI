import { useEffect, useState } from "react"
import { AutoComplete, Card, Input, Tooltip } from "antd"
import { MapPin } from "lucide-react"
import { loadMuseumSuggestions } from "../../lib/exifArtifactLookup"
import { ExhibitionRecommendationPicker } from "./ExhibitionRecommendationPicker"
import { GpsMapPicker } from "./GpsMapPicker"
import type { ExhibitionRecommendation, FormState, MuseumOption } from "./types"

type ExifLocationCardProps = {
  apiBaseUrl: string
  itemId: string
  form: FormState
  onChange: (changes: Partial<FormState>) => void
  onLocate: (value: string, museum?: MuseumOption) => void
}

const SectionTitle = () => <Tooltip title="填写展出地点、展览名称和定位坐标。" placement="topLeft" trigger={["hover", "focus"]}><span className="exif-section-title" tabIndex={0}><MapPin size={16} strokeWidth={1.8} aria-hidden="true" /><span>展出地点</span></span></Tooltip>

export function ExifLocationCard({
  apiBaseUrl,
  itemId,
  form,
  onChange,
  onLocate,
}: ExifLocationCardProps) {
  const [locationSuggestions, setLocationSuggestions] = useState<MuseumOption[]>([])
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)

  useEffect(() => {
    setShowLocationSuggestions(false)
    setLocationSuggestions([])
  }, [itemId])

  useEffect(() => {
    if (!showLocationSuggestions) {
      return
    }

    const timer = window.setTimeout(() => {
      void loadMuseumSuggestions(apiBaseUrl, form.displayLocationName.trim(), setLocationSuggestions)
    }, 180)

    return () => window.clearTimeout(timer)
  }, [apiBaseUrl, form.displayLocationName, showLocationSuggestions])

  const selectRecommendation = (item: ExhibitionRecommendation | null) => onChange(item ? {
    exhibitionName: item.title,
    catalogExhibitionId: item.id,
    catalogExhibitionSourceId: item.source_id,
  } : {
    exhibitionName: "常设",
    catalogExhibitionId: null,
    catalogExhibitionSourceId: "",
  })

  return <Card size="small" className="form-section exif-form-card" title={<SectionTitle />}>
    <div className="form-section-body">
      <label className="field">
        <span>展出地点名称</span>
        <AutoComplete
          value={form.displayLocationName}
          options={locationSuggestions.map((museum) => ({
            key: museum.id,
            value: museum.name,
            label: <span className="autocomplete-option"><span>{museum.name}</span>{museum.latitude !== null && museum.longitude !== null ? <span className="autocomplete-option-meta">{museum.latitude}, {museum.longitude}</span> : null}</span>,
          }))}
          filterOption={false}
          open={showLocationSuggestions && locationSuggestions.length > 0}
          placeholder="例如：山东省博物馆"
          onFocus={() => setShowLocationSuggestions(true)}
          onOpenChange={setShowLocationSuggestions}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return
            event.preventDefault()
            event.stopPropagation()
            onLocate(form.displayLocationName)
          }}
          onChange={(value) => { onChange({ displayLocationName: value }); setShowLocationSuggestions(true) }}
          onSelect={(value) => {
            const museum = locationSuggestions.find((option) => option.name === value)
            setShowLocationSuggestions(false)
            onLocate(value, museum)
          }}
        />
      </label>
      <label className="field">
        <span>对应展览</span>
        <ExhibitionRecommendationPicker
          apiBaseUrl={apiBaseUrl}
          capturedAt={form.capturedAt}
          latitude={form.latitude}
          longitude={form.longitude}
          location={form.displayLocationName}
          selectedSourceId={form.catalogExhibitionSourceId}
          selectedName={form.exhibitionName}
          onSelect={selectRecommendation}
          onManualChange={(value) => onChange({ exhibitionName: value, catalogExhibitionId: null, catalogExhibitionSourceId: "" })}
        />
      </label>
      <div className="field-row">
        <label className="field"><span>纬度</span><Input value={form.latitude} placeholder="例如：35.117" onChange={(event) => onChange({ latitude: event.target.value })} /></label>
        <label className="field"><span>经度</span><Input value={form.longitude} placeholder="例如：117.188" onChange={(event) => onChange({ longitude: event.target.value })} /></label>
      </div>
      <GpsMapPicker latitude={form.latitude} longitude={form.longitude} onPick={(latitude, longitude, displayLocationName) => onChange({ latitude, longitude, ...(displayLocationName ? { displayLocationName } : {}) })} />
    </div>
  </Card>
}
