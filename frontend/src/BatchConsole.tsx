import { useCallback, useEffect, useState } from "react"

type PendingArtifact = {
  id: number
  source_path: string
  file_name: string
  status: string
  error: string | null
  museum_name: string | null
  name: string | null
  era: string | null
  description: string | null
  tags: string[]
  confidence: number | null
  provider: string | null
  analysis: string | null
  cloud_artifact_id: number | null
  created_at: string
  updated_at: string
}

type BatchScanResponse = {
  scanned: number
  added: number
  skipped: number
  items: PendingArtifact[]
}

type StreamEvent = {
  stage: string
  total?: number
  id?: number
  file_name?: string
  item?: PendingArtifact
  message?: string
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待识别",
  identifying: "识别中…",
  identified: "已识别",
  submitting: "提交中…",
  submitted: "已入库",
  failed: "失败",
}

function statusClass(status: string) {
  if (status === "submitted") return "ok"
  if (status === "failed") return "failed"
  if (status === "identifying" || status === "submitting") return "busy"
  return ""
}

export default function BatchConsole({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [directory, setDirectory] = useState("")
  const [items, setItems] = useState<PendingArtifact[]>([])
  const [scanning, setScanning] = useState(false)
  const [identifying, setIdentifying] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadPending = useCallback(async () => {
    const res = await fetch(`${apiBaseUrl}/api/batch/pending`)
    if (res.ok) {
      setItems((await res.json()) as PendingArtifact[])
    }
  }, [apiBaseUrl])

  useEffect(() => {
    void loadPending()
  }, [loadPending])

  function patchLocal(id: number, patch: Partial<PendingArtifact>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  async function handleScan() {
    if (!directory.trim()) {
      setError("请填写要扫描的目录绝对路径")
      return
    }
    setScanning(true)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch(`${apiBaseUrl}/api/batch/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: directory.trim() }),
      })
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(detail.detail ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as BatchScanResponse
      setItems(data.items)
      setMessage(`扫描 ${data.scanned} 张，新增 ${data.added}，跳过 ${data.skipped}（已存在）`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "扫描失败")
    } finally {
      setScanning(false)
    }
  }

  async function handleIdentifyAll(ids: number[] = []) {
    setIdentifying(true)
    setError(null)
    setMessage(null)
    setProgress(null)
    let done = 0
    try {
      const res = await fetch(`${apiBaseUrl}/api/batch/identify/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok || !res.body) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(detail.detail ?? `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() ?? ""
        for (const chunk of chunks) {
          const line = chunk.trim()
          if (!line.startsWith("data:")) continue
          let event: StreamEvent
          try {
            event = JSON.parse(line.replace(/^data:\s*/, "")) as StreamEvent
          } catch {
            continue
          }
          if (event.stage === "meta") {
            setProgress({ done: 0, total: event.total ?? 0 })
          } else if (event.stage === "start" && event.id != null) {
            patchLocal(event.id, { status: "identifying" })
          } else if (event.stage === "item" && event.item) {
            patchLocal(event.item.id, event.item)
            done += 1
            setProgress((p) => (p ? { ...p, done } : { done, total: done }))
          } else if (event.stage === "item_error" && event.id != null) {
            patchLocal(event.id, { status: "failed", error: event.message ?? "识别失败" })
            done += 1
            setProgress((p) => (p ? { ...p, done } : { done, total: done }))
          }
        }
      }
      setMessage("识别完成，请逐条核对后提交云端")
    } catch (err) {
      setError(err instanceof Error ? err.message : "识别失败")
    } finally {
      setIdentifying(false)
    }
  }

  async function saveItem(item: PendingArtifact) {
    const res = await fetch(`${apiBaseUrl}/api/batch/pending/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        museum_name: item.museum_name,
        name: item.name,
        era: item.era,
        description: item.description,
        tags: item.tags,
      }),
    })
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { detail?: string }
      throw new Error(detail.detail ?? `HTTP ${res.status}`)
    }
    return (await res.json()) as PendingArtifact
  }

  async function handleSubmit(item: PendingArtifact) {
    setError(null)
    setMessage(null)
    try {
      await saveItem(item)
      patchLocal(item.id, { status: "submitting" })
      const res = await fetch(`${apiBaseUrl}/api/batch/pending/${item.id}/submit`, {
        method: "POST",
      })
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(detail.detail ?? `HTTP ${res.status}`)
      }
      const updated = (await res.json()) as PendingArtifact
      patchLocal(item.id, updated)
      setMessage(`「${updated.name}」已提交云端`)
    } catch (err) {
      patchLocal(item.id, { status: "failed", error: err instanceof Error ? err.message : "提交失败" })
      setError(err instanceof Error ? err.message : "提交失败")
    }
  }

  async function handleDelete(id: number) {
    await fetch(`${apiBaseUrl}/api/batch/pending/${id}`, { method: "DELETE" })
    setItems((current) => current.filter((item) => item.id !== id))
  }

  const pendingCount = items.filter((i) => i.status === "pending" || i.status === "failed").length

  return (
    <section className="panel form-wide">
      <div className="section-heading">
        <span className="step-badge">B</span>
        <div>
          <h2>批量识别入库</h2>
          <p className="muted">
            选定本地目录递归扫描所有图片，顺序经通义网页端识别，逐条核对后提交到云端（图片入 OSS）。
          </p>
        </div>
      </div>

      <div className="scan-row">
        <label className="field scan-input">
          <span>本地目录（绝对路径）</span>
          <input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="例如：/Users/you/photos/museum 或容器内 /data/import"
          />
        </label>
        <button type="button" className="primary" onClick={handleScan} disabled={scanning}>
          {scanning ? "扫描中…" : "扫描目录"}
        </button>
      </div>

      <div className="upload-actions">
        <button
          type="button"
          className="primary"
          onClick={() => void handleIdentifyAll([])}
          disabled={identifying || pendingCount === 0}
        >
          {identifying ? "识别中…" : `开始识别（${pendingCount} 张待识别）`}
        </button>
        <button type="button" className="ghost" onClick={() => void loadPending()} disabled={identifying}>
          刷新列表
        </button>
        {progress ? (
          <span className="muted">
            进度 {progress.done}/{progress.total}
          </span>
        ) : null}
      </div>

      {message ? <p className="success-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">📁</span>
          <strong>暂无待处理图片</strong>
          <p className="muted">填写目录后点击「扫描目录」开始。</p>
        </div>
      ) : null}

      <div className="batch-list">
        {items.map((item) => (
          <article key={item.id} className="batch-card">
            <div className="batch-thumb">
              <img
                src={`${apiBaseUrl}/api/batch/pending/${item.id}/image`}
                alt={item.file_name}
                loading="lazy"
              />
              <span className={`pulse ${statusClass(item.status)}`} />
            </div>

            <div className="batch-fields">
              <div className="batch-head">
                <span className="muted small">{item.file_name}</span>
                <span className={`badge ${item.status === "submitted" ? "best" : "conf"}`}>
                  {STATUS_LABEL[item.status] ?? item.status}
                  {item.confidence != null ? ` · ${Math.round(item.confidence * 100)}%` : ""}
                </span>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>博物馆 / 出土地</span>
                  <input
                    value={item.museum_name ?? ""}
                    onChange={(e) => patchLocal(item.id, { museum_name: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>文物名称</span>
                  <input
                    value={item.name ?? ""}
                    onChange={(e) => patchLocal(item.id, { name: e.target.value })}
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>时代</span>
                  <input
                    value={item.era ?? ""}
                    onChange={(e) => patchLocal(item.id, { era: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>标签（逗号分隔）</span>
                  <input
                    value={item.tags.join(", ")}
                    onChange={(e) =>
                      patchLocal(item.id, {
                        tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
                      })
                    }
                  />
                </label>
              </div>
              <label className="field">
                <span>描述</span>
                <textarea
                  rows={2}
                  value={item.description ?? ""}
                  onChange={(e) => patchLocal(item.id, { description: e.target.value })}
                />
              </label>

              {item.error ? <p className="error-text">{item.error}</p> : null}

              <div className="batch-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void saveItem(item).then(() => setMessage("已保存"))}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="primary small"
                  onClick={() => void handleSubmit(item)}
                  disabled={item.status === "submitting" || item.status === "submitted"}
                >
                  {item.status === "submitted" ? "已入库" : "提交云端"}
                </button>
                <button type="button" className="ghost danger" onClick={() => void handleDelete(item.id)}>
                  删除
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
