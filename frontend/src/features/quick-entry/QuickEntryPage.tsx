import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react"
import "./QuickEntryPage.css"

type QuickEntryForm = {
  museumName: string
  name: string
  era: string
  placeOfExcavation: string
  description: string
  tags: string
}

type QuickUploadState = "queued" | "uploading" | "done" | "error"

type QuickUploadItem = {
  id: string
  file: File
  previewUrl: string
  state: QuickUploadState
  progress: number
  message: string | null
  artifactId: number | null
}

type QuickEntryPageProps = {
  apiBaseUrl: string
  configuredToken: string
}

type ArtifactResponse = {
  id?: number
  duplicate_image_detail?: string | null
  duplicate_image_skipped?: boolean
  duplicate_image_replaced?: boolean
}

const TOKEN_STORAGE_KEY = "museum-quick-entry-token"
let nextItemId = 0

const initialForm: QuickEntryForm = {
  museumName: "",
  name: "",
  era: "",
  placeOfExcavation: "",
  description: "",
  tags: "",
}

function createItem(file: File): QuickUploadItem {
  return {
    id: `${Date.now()}-${nextItemId++}`,
    file,
    previewUrl: URL.createObjectURL(file),
    state: "queued",
    progress: 0,
    message: null,
    artifactId: null,
  }
}

function isImageFile(file: File) {
  if (file.type.startsWith("image/")) return true
  return /\.(jpe?g|png|webp|gif|tiff?|bmp)$/i.test(file.name)
}

function parseTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  )
}

function readErrorMessage(xhr: XMLHttpRequest) {
  try {
    const payload = JSON.parse(xhr.responseText) as { detail?: unknown }
    if (typeof payload.detail === "string" && payload.detail.trim()) {
      return payload.detail.trim()
    }
  } catch {
    // Keep the status fallback for HTML/proxy failures.
  }
  if (xhr.status === 401) return "云端写入令牌无效，请检查快速录入配置。"
  if (xhr.status === 429) return "云端正在处理其他图片，请稍后重试。"
  return `云端提交失败（HTTP ${xhr.status || "网络错误"}）`
}

function submitQuickEntry({
  apiBaseUrl,
  token,
  item,
  form,
  onProgress,
}: {
  apiBaseUrl: string
  token: string
  item: QuickUploadItem
  form: QuickEntryForm
  onProgress: (progress: number) => void
}) {
  return new Promise<ArtifactResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const body = new FormData()
    body.append("image", item.file, item.file.name)
    body.append("museum_name", form.museumName.trim())
    body.append("name", form.name.trim())
    body.append("era", form.era.trim())
    body.append("Place_of_Excavation", form.placeOfExcavation.trim())
    body.append("description", form.description.trim())
    body.append("tags", JSON.stringify(parseTags(form.tags)))
    body.append("exhibition_name", "常设")

    xhr.open("POST", `${apiBaseUrl}/api/ingest/artifacts`)
    xhr.timeout = 180_000
    xhr.setRequestHeader("X-Quick-Entry-Token", token)
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return
      onProgress(Math.max(1, Math.min(95, Math.round((event.loaded / event.total) * 95))))
    })
    xhr.addEventListener("error", () => reject(new Error("无法连接云端后端，请检查网络或代理设置。")))
    xhr.addEventListener("abort", () => reject(new Error("提交已取消。")))
    xhr.addEventListener("timeout", () => reject(new Error("云端处理超时，请稍后重试这张图片。")))
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(readErrorMessage(xhr)))
        return
      }
      try {
        resolve(JSON.parse(xhr.responseText) as ArtifactResponse)
      } catch {
        reject(new Error("云端返回格式不正确。"))
      }
    })
    xhr.send(body)
  })
}

function initialToken(configuredToken: string) {
  if (configuredToken.trim()) return configuredToken.trim()
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

export function QuickEntryPage({ apiBaseUrl, configuredToken }: QuickEntryPageProps) {
  const [form, setForm] = useState<QuickEntryForm>(initialForm)
  const [items, setItems] = useState<QuickUploadItem[]>([])
  const [token, setToken] = useState(() => initialToken(configuredToken))
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const itemsRef = useRef<QuickUploadItem[]>([])
  const normalizedApiBaseUrl = apiBaseUrl.replace(/\/$/, "")

  const completedCount = useMemo(
    () => items.filter((item) => item.state === "done").length,
    [items],
  )
  const pendingCount = items.length - completedCount

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    return () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl))
    }
  }, [])

  function updateItem(id: string, update: Partial<QuickUploadItem>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...update } : item)))
  }

  function addFiles(fileList: FileList | File[]) {
    const selectedFiles = Array.from(fileList).filter(isImageFile)
    if (selectedFiles.length === 0) {
      setNotice({ type: "error", text: "请选择 JPG、PNG、WEBP、TIFF 等图片文件。" })
      return
    }
    const rejectedCount = Array.from(fileList).length - selectedFiles.length
    setItems((current) => [...current, ...selectedFiles.map(createItem)])
    setNotice({
      type: "success",
      text: `已立即载入 ${selectedFiles.length} 张图片${rejectedCount > 0 ? `，忽略 ${rejectedCount} 个非图片文件` : ""}。填写文字后即可提交云端。`,
    })
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (!submitting) addFiles(event.dataTransfer.files)
  }

  function removeItem(id: string) {
    if (submitting) return
    setItems((current) => {
      const target = current.find((item) => item.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return current.filter((item) => item.id !== id)
    })
  }

  function clearItems() {
    if (submitting) return
    items.forEach((item) => URL.revokeObjectURL(item.previewUrl))
    setItems([])
    setNotice(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  async function submitAll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (items.length === 0) {
      setNotice({ type: "error", text: "请先选择至少一张图片。" })
      return
    }
    if (!form.museumName.trim() || !form.name.trim()) {
      setNotice({ type: "error", text: "请先填写博物馆和文物名称。" })
      return
    }
    const submitToken = token.trim()
    if (!submitToken) {
      setNotice({ type: "error", text: "请在连接设置中填写云端写入令牌。" })
      return
    }

    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, submitToken)
    } catch {
      // Session storage is optional; the current page can still submit.
    }

    setSubmitting(true)
    setNotice({ type: "success", text: "已开始按顺序提交，页面不会启动 Docker。" })
    let successCount = 0
    let failureCount = 0

    for (const item of items) {
      if (item.state === "done") {
        successCount += 1
        continue
      }
      updateItem(item.id, { state: "uploading", progress: 1, message: "正在上传图片…" })
      try {
        const result = await submitQuickEntry({
          apiBaseUrl: normalizedApiBaseUrl,
          token: submitToken,
          item,
          form,
          onProgress: (progress) => updateItem(item.id, { progress }),
        })
        successCount += 1
        updateItem(item.id, {
          state: "done",
          progress: 100,
          artifactId: typeof result.id === "number" ? result.id : null,
          message:
            result.duplicate_image_detail
            || (result.duplicate_image_replaced ? "已覆盖云端同图记录。" : "已入库云端。"),
        })
      } catch (error) {
        failureCount += 1
        updateItem(item.id, {
          state: "error",
          message: error instanceof Error ? error.message : "提交失败。",
        })
      }
    }

    setSubmitting(false)
    setNotice({
      type: failureCount === 0 ? "success" : "error",
      text: failureCount === 0
        ? `已完成 ${successCount} 张图片的云端入库。`
        : `已完成 ${successCount} 张，${failureCount} 张失败；可修正后再次点击提交。`,
    })
  }

  return (
    <main className="quick-entry-page">
      <header className="quick-entry-header">
        <div>
          <p className="quick-entry-eyebrow">MUSEUM IMAGE · CLOUD INTAKE</p>
          <h1>快速录入</h1>
          <p>只上传图片和文字，直接入云。这里不读取本地 EXIF、不做 AI 识别，也不需要启动 Docker。</p>
        </div>
        <div className="quick-entry-runtime" aria-label="运行方式">
          <span className="quick-entry-runtime-dot" />
          <span>云端后端</span>
        </div>
      </header>

      <form className="quick-entry-layout" onSubmit={(event) => void submitAll(event)}>
        <section className="quick-entry-card quick-entry-form-card" aria-labelledby="quick-entry-form-title">
          <div className="quick-entry-card-heading">
            <div>
              <p className="quick-entry-card-kicker">01 · 文字</p>
              <h2 id="quick-entry-form-title">填写这批图片的共同信息</h2>
            </div>
            <span className="quick-entry-count">{items.length} 张图片</span>
          </div>

          <div className="quick-entry-fields">
            <label>
              <span>博物馆 <b>*</b></span>
              <input value={form.museumName} onChange={(event) => setForm((current) => ({ ...current, museumName: event.target.value }))} placeholder="例如：上海博物馆" />
            </label>
            <label>
              <span>文物名称 <b>*</b></span>
              <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：四虎蟠龙纹豆" />
            </label>
            <label>
              <span>时代</span>
              <input value={form.era} onChange={(event) => setForm((current) => ({ ...current, era: event.target.value }))} placeholder="例如：春秋" />
            </label>
            <label>
              <span>出土地</span>
              <input value={form.placeOfExcavation} onChange={(event) => setForm((current) => ({ ...current, placeOfExcavation: event.target.value }))} placeholder="可选" />
            </label>
            <label className="quick-entry-field-wide">
              <span>描述</span>
              <textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} rows={7} placeholder="可选。这里直接保存人工填写的文字，不调用 AI。" />
            </label>
            <label className="quick-entry-field-wide">
              <span>标签</span>
              <input value={form.tags} onChange={(event) => setForm((current) => ({ ...current, tags: event.target.value }))} placeholder="用逗号分隔，例如：青铜器，纹饰" />
            </label>
          </div>

          <details className="quick-entry-settings">
            <summary>连接设置</summary>
            <label>
              <span>云端写入令牌</span>
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="使用 QUICK_ENTRY_TOKEN" />
            </label>
            <p>令牌只保存在当前浏览器会话；推荐使用专门的快速录入令牌，不要把云端主入库令牌写进公开前端。</p>
          </details>
        </section>

        <section className="quick-entry-card quick-entry-upload-card" aria-labelledby="quick-entry-upload-title">
          <div className="quick-entry-card-heading">
            <div>
              <p className="quick-entry-card-kicker">02 · 图片</p>
              <h2 id="quick-entry-upload-title">选择图片后立即进入列表</h2>
            </div>
            {items.length > 0 ? <button className="quick-entry-text-button" type="button" onClick={clearItems} disabled={submitting}>清空</button> : null}
          </div>

          <input
            ref={fileInputRef}
            className="quick-entry-file-input"
            type="file"
            accept="image/*,.tif,.tiff"
            multiple
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files)
              event.target.value = ""
            }}
          />
          <div
            className={`quick-entry-dropzone${dragging ? " is-dragging" : ""}`}
            onClick={() => {
              if (!submitting) fileInputRef.current?.click()
            }}
            onDragOver={(event) => {
              event.preventDefault()
              if (!submitting) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            role="button"
            tabIndex={submitting ? -1 : 0}
            onKeyDown={(event) => {
              if ((event.key === "Enter" || event.key === " ") && !submitting) fileInputRef.current?.click()
            }}
          >
            <span className="quick-entry-drop-icon" aria-hidden="true">＋</span>
            <strong>点击选择或拖入图片</strong>
            <span>可多选；图片会先在浏览器本地显示，不等待接口返回</span>
          </div>

          <div className="quick-entry-queue" aria-live="polite">
            {items.length === 0 ? (
              <div className="quick-entry-empty">还没有图片。选择后会马上显示在这里。</div>
            ) : items.map((item) => (
              <article className={`quick-entry-item is-${item.state}`} key={item.id}>
                <img src={item.previewUrl} alt="" loading="lazy" decoding="async" />
                <div className="quick-entry-item-body">
                  <div className="quick-entry-item-topline">
                    <strong title={item.file.name}>{item.file.name}</strong>
                    <span>{item.state === "queued" ? "待提交" : item.state === "uploading" ? "提交中" : item.state === "done" ? "已完成" : "失败"}</span>
                  </div>
                  {item.state === "uploading" ? <div className="quick-entry-progress"><i style={{ width: `${item.progress}%` }} /></div> : null}
                  <p>{item.message ?? `${(item.file.size / 1024 / 1024).toFixed(1)} MB`}{item.artifactId ? ` · 文物 #${item.artifactId}` : ""}</p>
                </div>
                <button className="quick-entry-remove" type="button" onClick={() => removeItem(item.id)} disabled={submitting} aria-label={`移除 ${item.file.name}`}>×</button>
              </article>
            ))}
          </div>

          <div className="quick-entry-submit-row">
            <div>
              {notice ? <p className={`quick-entry-notice ${notice.type}`}>{notice.text}</p> : <p className="quick-entry-muted">图片按顺序提交，避免云端并发拥堵。</p>}
              {items.length > 0 ? <p className="quick-entry-muted">已完成 {completedCount}/{items.length}，待处理 {pendingCount} 张</p> : null}
            </div>
            <button className="quick-entry-submit" type="submit" disabled={submitting || items.length === 0}>
              {submitting ? "正在入库…" : "上传并入库"}
            </button>
          </div>
        </section>
      </form>
    </main>
  )
}
