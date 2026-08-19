import { Button } from "antd"
import { FolderOpen, ImagePlus, Loader2 } from "lucide-react"
import type { UploadActivity } from "./types"

export function ExifEmptyState({ uploading, activity, onSelectImages, onSelectDirectory }: {
  uploading: boolean
  activity: UploadActivity
  onSelectImages: () => void
  onSelectDirectory: () => void
}) {
  return <div className="panel empty-state exif-main-empty">
    <span className="exif-empty-symbol" aria-hidden="true"><ImagePlus size={22} strokeWidth={1.6} /></span>
    <h2>从一张文物照片开始</h2>
    <div className="upload-actions exif-empty-actions">
      <Button htmlType="button" type="primary" icon={activity === "files" ? <Loader2 size={14} strokeWidth={1.8} className="animate-spin" aria-hidden="true" /> : <ImagePlus size={14} strokeWidth={1.8} aria-hidden="true" />} onClick={onSelectImages} disabled={uploading}>{activity === "files" ? "正在读取…" : "添加图片"}</Button>
      <Button htmlType="button" icon={activity === "directory" ? <Loader2 size={14} strokeWidth={1.8} className="animate-spin" aria-hidden="true" /> : <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" />} onClick={onSelectDirectory} disabled={uploading}>{activity === "directory" ? "正在载入…" : "载入文件夹"}</Button>
    </div>
    <p className="exif-empty-note">选择图片后即可校对；保存时再依次完成原文件授权、改名、EXIF 校验与云端入库。</p>
  </div>
}
