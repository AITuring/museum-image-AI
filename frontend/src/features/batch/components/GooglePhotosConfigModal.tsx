import { Button, Input } from "antd"
import { createPortal } from "react-dom"

type GooglePhotosConfigForm = {
  clientId: string
  clientSecret: string
  redirectUri: string
}

type Props = {
  open: boolean
  apiBaseUrl: string
  busy: boolean
  value: GooglePhotosConfigForm
  onChange: (updater: (current: GooglePhotosConfigForm) => GooglePhotosConfigForm) => void
  onClose: () => void
  onSave: () => void
}

export function GooglePhotosConfigModal({ open, apiBaseUrl, busy, value, onChange, onClose, onSave }: Props) {
  if (!open) return null
  return createPortal(
    <div className="gallery-modal" onClick={onClose}>
      <div className="gallery-modal-body bridge-login-modal" onClick={(event) => event.stopPropagation()}>
        <div className="gallery-detail-head"><div><h2>配置 Google Photos</h2><p className="muted">在这里填写 OAuth 参数，保存后会继续拉起 Google 授权。</p></div></div>
        <div className="form-fields">
          <label className="field"><span>Client ID</span><Input value={value.clientId} onChange={(event) => onChange((current) => ({ ...current, clientId: event.target.value }))} placeholder="Google Cloud Console 的 OAuth Client ID" /></label>
          <label className="field"><span>Client Secret</span><Input type="password" value={value.clientSecret} onChange={(event) => onChange((current) => ({ ...current, clientSecret: event.target.value }))} placeholder="Google Cloud Console 的 OAuth Client Secret" /></label>
          <label className="field"><span>Redirect URI</span><Input value={value.redirectUri} onChange={(event) => onChange((current) => ({ ...current, redirectUri: event.target.value }))} placeholder={`${apiBaseUrl}/api/google-photos/callback`} /><span className="field-help">这个地址要和 Google Cloud Console 里的 Authorized redirect URI 完全一致。</span></label>
        </div>
        <div className="gallery-form-footer bridge-login-actions">
          <Button htmlType="button" type="primary" disabled={busy || !value.clientId.trim() || !value.clientSecret.trim() || !value.redirectUri.trim()} onClick={onSave}>{busy ? "保存中…" : "保存并继续连接"}</Button>
          <Button htmlType="button" type="text" disabled={busy} onClick={onClose}>取消</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
