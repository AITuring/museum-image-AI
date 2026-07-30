import { useEffect, useState } from "react"
import { Card, Input, Tag, Tooltip } from "antd"
import { FileCheck2 } from "lucide-react"
import type { FormState } from "./types"

const Textarea = Input.TextArea

type ExifMetadataEditorProps = {
  itemId: string
  form: FormState
  onChange: (changes: Partial<FormState>) => void
  onAddTags: (value: string) => boolean
}

export function ExifMetadataEditor({ itemId, form, onChange, onAddTags }: ExifMetadataEditorProps) {
  const [tagInput, setTagInput] = useState("")

  useEffect(() => {
    setTagInput("")
  }, [itemId])

  return <Card
    size="small"
    className="form-section exif-form-card"
    title={<Tooltip title="这里的描述与标签会写入 EXIF 和云端数据库。" placement="topLeft" trigger={["hover", "focus"]}><span className="exif-section-title" tabIndex={0}><FileCheck2 size={16} strokeWidth={1.8} aria-hidden="true" /><span>最终写入内容</span></span></Tooltip>}
  >
    <div className="form-section-body">
      <label className="field"><span>描述</span><Textarea rows={5} value={form.description} placeholder="文物描述会写入 EXIF 与云端数据库中" onChange={(event) => onChange({ description: event.target.value })} /></label>
      <label className="field">
        <span>标签</span>
        <div className="tag-editor">
          <div className="tag-editor-chips">
            {form.tags.length > 0 ? form.tags.map((tag) => <Tag key={tag} closable onClose={() => onChange({ tags: form.tags.filter((entry) => entry !== tag) })}>{tag}</Tag>) : <span className="tag-editor-placeholder">暂无标签</span>}
          </div>
          <Input
            value={tagInput}
            placeholder="输入后回车或逗号添加"
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault()
                if (onAddTags(tagInput)) {
                  setTagInput("")
                }
              }
            }}
            onBlur={() => {
              if (onAddTags(tagInput)) {
                setTagInput("")
              }
            }}
          />
        </div>
      </label>
    </div>
  </Card>
}
