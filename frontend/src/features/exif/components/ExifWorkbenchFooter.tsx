import { Button } from "antd"
import type { ExifWorkbenchItem, SubmitNotice } from "./types"

type ExifWorkbenchFooterProps = {
  item: ExifWorkbenchItem
  itemCount: number
  submitNotice: SubmitNotice | null
  changedPartCount: number
  onSync: () => void
  onSubmit: () => void
}

export function ExifWorkbenchFooter({ item, itemCount, submitNotice, changedPartCount, onSync, onSubmit }: ExifWorkbenchFooterProps) {
  const submitting = item.submitState === "submitting"
  const submittedWithoutChanges = item.submitState === "submitted" && changedPartCount === 0
  const statusText = submitting ? "正在入库…" : submittedWithoutChanges ? "已入库" : item.submitState === "error" ? "授权并重试" : "保存并入库"
  return <div className="form-footer exif-form-footer">
    <div className="exif-form-footer-copy" aria-live="polite">
      {item.submitMessage ? <p className={item.submitState === "error" ? "error-text" : "success-text"}>{item.submitMessage}</p>
        : submitNotice ? <p className={submitNotice.type === "error" ? "error-text" : "success-text"}>{submitNotice.text}</p>
          : <p className="muted">基础信息、拍摄信息和展出地点确认后即可入库；AI 描述可现在生成，也可稍后在图库补充。</p>}
    </div>
    <div className="exif-form-footer-actions">
      <Button htmlType="button" onClick={onSync} disabled={itemCount < 2 || submitting}>同步到其他照片</Button>
      <Button htmlType="button" type="primary" onClick={onSubmit} disabled={submitting || submittedWithoutChanges}>{statusText}</Button>
    </div>
  </div>
}
