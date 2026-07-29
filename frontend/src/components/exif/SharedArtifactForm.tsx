import { Button, Input } from "antd"
import type { FormState } from "./types"

const Textarea = Input.TextArea

type SharedArtifactFormProps = {
  form: FormState
  itemCount: number
  showDescriptionTools: boolean
  generating: boolean
  onChange: (changes: Partial<FormState>) => void
  onFillFromSelected: () => void
  onApplyToAll: () => void
  onGenerateDescription: () => void
}

export function SharedArtifactForm({
  form,
  itemCount,
  showDescriptionTools,
  generating,
  onChange,
  onFillFromSelected,
  onApplyToAll,
  onGenerateDescription,
}: SharedArtifactFormProps) {
  return <details className="exif-shared-section">
    <summary><div><strong>批量套用同一件文物的信息</strong><p>多张图片属于同一件文物时，再展开统一填写。</p></div><span>可选</span></summary>
    <div className="form-section-body">
      <p className="muted">这些图片指向同一件文物时，在这里统一填写基础信息和展出地点，再一键应用到全部图片。</p>
      <div className="field-row">
        <label className="field"><span>馆藏单位</span><Input value={form.museumName} placeholder="例如：山东省博物馆" onChange={(event) => onChange({ museumName: event.target.value })} /></label>
        <label className="field"><span>文物名称</span><Input value={form.name} placeholder="例如：夫妇宴享行乐图" onChange={(event) => onChange({ name: event.target.value })} /></label>
      </div>
      <div className="field-row">
        <label className="field"><span>时代</span><Input value={form.era} placeholder="例如：隋代" onChange={(event) => onChange({ era: event.target.value })} /></label>
        <label className="field"><span>出土地</span><Input value={form.placeOfExcavation} placeholder="例如：1976年嘉祥英山一号隋墓出土" onChange={(event) => onChange({ placeOfExcavation: event.target.value })} /></label>
      </div>
      <div className="field-row">
        <label className="field"><span>展出地点名称</span><Input value={form.displayLocationName} placeholder="例如：山东省博物馆" onChange={(event) => onChange({ displayLocationName: event.target.value })} /></label>
        <label className="field"><span>对应展览</span><Input value={form.exhibitionName} placeholder="例如：常设展 / 汉唐文明展" onChange={(event) => onChange({ exhibitionName: event.target.value, catalogExhibitionId: null, catalogExhibitionSourceId: "" })} /></label>
        <label className="field"><span>纬度 / 经度</span><div className="field-row"><Input value={form.latitude} placeholder="纬度" onChange={(event) => onChange({ latitude: event.target.value })} /><Input value={form.longitude} placeholder="经度" onChange={(event) => onChange({ longitude: event.target.value })} /></div></label>
      </div>
      {showDescriptionTools ? <label className="field"><span>共享描述</span><Textarea rows={4} value={form.description} placeholder="这里的描述会作为同一文物的默认描述应用到全部图片" onChange={(event) => onChange({ description: event.target.value })} /></label> : null}
      <div className="upload-actions exif-shared-actions">
        <Button htmlType="button" type="default" onClick={onFillFromSelected}>从当前图片带入</Button>
        <Button htmlType="button" type="default" onClick={onApplyToAll} disabled={itemCount === 0}>应用到全部图片</Button>
        {showDescriptionTools ? <Button htmlType="button" type="primary" onClick={onGenerateDescription} disabled={generating}>并行生成共享描述</Button> : null}
      </div>
      <p className="field-help">当前会同步到 {itemCount} 张图片；AI 描述是可选项，也可直接入库后再到图库补充。</p>
    </div>
  </details>
}
