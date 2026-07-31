import { useMemo, useState } from "react"
import { Button, Input, Tag } from "antd"
import { ChevronDown } from "lucide-react"
import { fileBaseName as getFileBaseName, normalizedFileName } from "../lib/exifFormDomain"
import type { ExifWorkbenchItem } from "./types"

const Textarea = Input.TextArea

type ExifFilePreviewProps = {
  item: ExifWorkbenchItem
  items: ExifWorkbenchItem[]
  fileBaseName: string
  fileExtension: string
  parsingFileName: boolean
  onRename: (name: string) => void
  onApplyBatchRename: (payload: { batchRemove: string; batchPrefix: string; batchSuffix: string }) => void
}

export function ExifFilePreview({
  item,
  items,
  fileBaseName,
  fileExtension,
  parsingFileName,
  onRename,
  onApplyBatchRename,
}: ExifFilePreviewProps) {
  const [batchRemove, setBatchRemove] = useState("")
  const [batchPrefix, setBatchPrefix] = useState("")
  const [batchSuffix, setBatchSuffix] = useState("")

  const batchRenameCount = useMemo(
    () =>
      items.filter(
        (entry) =>
          normalizedFileName(
            `${batchPrefix}${getFileBaseName(entry.fileName).split(batchRemove).join("")}${batchSuffix}`,
            entry.fileName,
          ) !== entry.fileName,
      ).length,
    [batchPrefix, batchRemove, batchSuffix, items],
  )

  return <div className="exif-selected-head">
    <img src={item.previewUrl} alt={item.fileName} className="exif-selected-preview" decoding="async" />
    <div className="exif-file-block">
      <div className="result-head"><h3>文件名</h3></div>
      <p className="result-desc exif-file-name">{item.fileName}</p>
      <label className="exif-file-rename">
        <span>目标文件名</span>
        <Textarea autoSize={{ minRows: 1, maxRows: 4 }} value={fileBaseName} onChange={(event) => onRename(event.target.value)} />
        <em>{fileExtension}</em>
      </label>
      <details className="batch-rename-panel exif-inline-batch-rename">
        <summary><span className="exif-tool-summary-copy"><strong>批量修改目标文件名</strong><small>在当前目标文件名旁统一清理文本或添加前后缀</small></span><span className="exif-tool-summary-meta"><span className="exif-tool-summary-count">影响 {batchRenameCount}/{items.length}</span><ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" /></span></summary>
        <div className="exif-tool-grid">
          <label className="exif-tool-field"><span>删除文本</span><Input value={batchRemove} placeholder="例如：IMG_" onChange={(event) => setBatchRemove(event.target.value)} /></label>
          <label className="exif-tool-field"><span>添加前缀</span><Input value={batchPrefix} placeholder="例如：南博-" onChange={(event) => setBatchPrefix(event.target.value)} /></label>
          <label className="exif-tool-field"><span>添加后缀</span><Input value={batchSuffix} placeholder="例如：-展厅A" onChange={(event) => setBatchSuffix(event.target.value)} /></label>
        </div>
        <div className="exif-tool-actions"><Button htmlType="button" onClick={() => onApplyBatchRename({ batchRemove, batchPrefix, batchSuffix })} disabled={items.length === 0 || batchRenameCount === 0}>应用到 {batchRenameCount} 张</Button></div>
      </details>
      {parsingFileName ? <p className="muted exif-file-parse-status">正在从文件名更新字段…</p> : null}
      {item.parsedName ? <div className="result-meta">
        {item.parsedName.era ? <Tag>时代：{item.parsedName.era}</Tag> : null}
        {item.parsedName.museum_name ? <Tag>馆藏：{item.parsedName.museum_name}</Tag> : null}
        {item.parsedName.Place_of_Excavation ? <Tag>出土地：{item.parsedName.Place_of_Excavation}</Tag> : null}
      </div> : <p className="muted">当前文件名暂无解析结果，可手动填写。</p>}
    </div>
  </div>
}
