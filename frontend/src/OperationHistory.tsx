import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  use,
  type ReactNode,
} from "react"
import { Button, Modal, Popover, Tooltip } from "antd"
import { FilePenLine, History, Landmark, MapPin, Redo2, Sparkles, Trash2, Undo2 } from "lucide-react"
import "./OperationHistory.css"

const HISTORY_LIMIT = 80
const HISTORY_MERGE_WINDOW_MS = 1_200
const HISTORY_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

type HistoryDirection = "undo" | "redo" | "restore"
type HistorySnapshot = unknown

type OperationHistoryEntry = {
  id: string
  scope: string
  scopeLabel: string
  label: string
  detail: string
  affected: string[]
  before: HistorySnapshot
  after: HistorySnapshot
  mergeKey: string | null
  createdAt: number
  updatedAt: number
}

type RecordOperationInput = Omit<
  OperationHistoryEntry,
  "id" | "createdAt" | "updatedAt" | "mergeKey"
> & {
  mergeKey?: string
}

type OperationHistoryContextValue = {
  histories: Record<string, ScopeHistory>
  dirtyScopes: Readonly<Record<string, boolean>>
  record: (input: RecordOperationInput) => string
  updateAfter: (id: string, after: HistorySnapshot, detail?: string) => void
  registerScope: (
    scope: string,
    applySnapshot: (snapshot: HistorySnapshot, direction: HistoryDirection, entry: OperationHistoryEntry) => void,
  ) => () => void
  undo: (scope: string) => void
  redo: (scope: string) => void
  restore: (scope: string, entryId: string) => void
  clear: (scope: string) => void
  hasChanges: (scope: string) => boolean
  setScopeDirty: (scope: string, dirty: boolean) => void
}

type ScopeHistory = {
  past: OperationHistoryEntry[]
  future: OperationHistoryEntry[]
}

const OperationHistoryContext = createContext<OperationHistoryContextValue | null>(null)
const EMPTY_SCOPE_HISTORY: ScopeHistory = { past: [], future: [] }

function operationId() {
  return `operation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function OperationHistoryProvider({ children }: { children: ReactNode }) {
  const [histories, setHistories] = useState<Record<string, ScopeHistory>>({})
  const [dirtyScopes, setDirtyScopes] = useState<Record<string, boolean>>({})
  const historiesRef = useRef<Record<string, ScopeHistory>>({})
  const dirtyScopesRef = useRef<Record<string, boolean>>({})
  const scopeHandlersRef = useRef(new Map<
    string,
    (snapshot: HistorySnapshot, direction: HistoryDirection, entry: OperationHistoryEntry) => void
  >())

  const replaceScopeHistory = useCallback((scope: string, next: ScopeHistory) => {
    const nextHistories = { ...historiesRef.current, [scope]: next }
    historiesRef.current = nextHistories
    setHistories(nextHistories)
  }, [])

  const record = useCallback((input: RecordOperationInput) => {
    const now = Date.now()
    const current = historiesRef.current[input.scope] ?? EMPTY_SCOPE_HISTORY
    const latest = current.past.at(-1)
    if (
      input.mergeKey
      && latest?.mergeKey === input.mergeKey
      && latest.scope === input.scope
      && now - latest.updatedAt <= HISTORY_MERGE_WINDOW_MS
    ) {
      const merged = {
        ...latest,
        after: input.after,
        detail: input.detail,
        affected: input.affected,
        updatedAt: now,
      }
      replaceScopeHistory(input.scope, {
        past: [...current.past.slice(0, -1), merged],
        future: [],
      })
      return merged.id
    }

    const entry: OperationHistoryEntry = {
      ...input,
      id: operationId(),
      mergeKey: input.mergeKey ?? null,
      createdAt: now,
      updatedAt: now,
    }
    replaceScopeHistory(input.scope, {
      past: [...current.past, entry].slice(-HISTORY_LIMIT),
      future: [],
    })
    return entry.id
  }, [replaceScopeHistory])

  const updateAfter = useCallback((id: string, after: HistorySnapshot, detail?: string) => {
    for (const [scope, history] of Object.entries(historiesRef.current)) {
      if (!history.past.some((entry) => entry.id === id)) continue
      replaceScopeHistory(scope, {
        ...history,
        past: history.past.map((entry) => (
          entry.id === id
            ? { ...entry, after, detail: detail ?? entry.detail, updatedAt: Date.now() }
            : entry
        )),
      })
      return
    }
  }, [replaceScopeHistory])

  const registerScope = useCallback((
    scope: string,
    applySnapshot: (snapshot: HistorySnapshot, direction: HistoryDirection, entry: OperationHistoryEntry) => void,
  ) => {
    scopeHandlersRef.current.set(scope, applySnapshot)
    return () => {
      scopeHandlersRef.current.delete(scope)
    }
  }, [])

  const undo = useCallback((scope: string) => {
    const current = historiesRef.current[scope] ?? EMPTY_SCOPE_HISTORY
    const entry = current.past.at(-1)
    if (!entry) return
    const handler = scopeHandlersRef.current.get(scope)
    if (!handler) return
    handler(entry.before, "undo", entry)
    replaceScopeHistory(scope, {
      past: current.past.slice(0, -1),
      future: [...current.future, entry],
    })
  }, [replaceScopeHistory])

  const redo = useCallback((scope: string) => {
    const current = historiesRef.current[scope] ?? EMPTY_SCOPE_HISTORY
    const entry = current.future.at(-1)
    if (!entry) return
    const handler = scopeHandlersRef.current.get(scope)
    if (!handler) return
    handler(entry.after, "redo", entry)
    replaceScopeHistory(scope, {
      past: [...current.past, entry],
      future: current.future.slice(0, -1),
    })
  }, [replaceScopeHistory])

  const restore = useCallback((scope: string, entryId: string) => {
    const current = historiesRef.current[scope] ?? EMPTY_SCOPE_HISTORY
    const entryIndex = current.past.findIndex((entry) => entry.id === entryId)
    if (entryIndex < 0) return
    const entry = current.past[entryIndex]
    const handler = scopeHandlersRef.current.get(scope)
    if (!handler) return
    handler(entry.after, "restore", entry)
    // Treat restoring an older snapshot like returning to that point in the
    // timeline. Later operations remain available through normal redo.
    replaceScopeHistory(scope, {
      past: current.past.slice(0, entryIndex + 1),
      future: [...current.future, ...current.past.slice(entryIndex + 1).reverse()],
    })
  }, [replaceScopeHistory])

  const clear = useCallback((scope: string) => {
    replaceScopeHistory(scope, EMPTY_SCOPE_HISTORY)
  }, [replaceScopeHistory])

  const setScopeDirty = useCallback((scope: string, dirty: boolean) => {
    if (dirtyScopesRef.current[scope] === dirty) return
    const next = { ...dirtyScopesRef.current, [scope]: dirty }
    dirtyScopesRef.current = next
    setDirtyScopes(next)
  }, [])

  const hasChanges = useCallback(
    (scope: string) => Boolean(dirtyScopesRef.current[scope]),
    [],
  )

  const value = useMemo<OperationHistoryContextValue>(() => ({
    histories,
    dirtyScopes,
    record,
    updateAfter,
    registerScope,
    undo,
    redo,
    restore,
    clear,
    hasChanges,
    setScopeDirty,
  }), [clear, dirtyScopes, hasChanges, histories, record, redo, registerScope, restore, setScopeDirty, undo, updateAfter])

  return (
    <OperationHistoryContext value={value}>
      {children}
    </OperationHistoryContext>
  )
}

// The hook intentionally shares this module with the provider so both use the
// same private context contract.
// eslint-disable-next-line react-refresh/only-export-components
export function useOperationHistory() {
  const context = use(OperationHistoryContext)
  if (!context) throw new Error("useOperationHistory must be used inside OperationHistoryProvider")
  return context
}

function historyTime(timestamp: number) {
  return HISTORY_TIME_FORMATTER.format(timestamp)
}

function historyAppearance(label: string) {
  if (/文件名|改名/.test(label)) return { icon: FilePenLine, tone: "rename" }
  if (/地点|展览|GPS|定位/.test(label)) return { icon: MapPin, tone: "location" }
  if (/文物|馆藏|时代|出土地|复用/.test(label)) return { icon: Landmark, tone: "artifact" }
  if (/描述|标签|核验|识别/.test(label)) return { icon: Sparkles, tone: "content" }
  return { icon: History, tone: "default" }
}

export function OperationHistoryControls({
  scope,
  scopeLabel,
}: {
  scope: string
  scopeLabel: string
}) {
  const { histories, undo, redo, restore, clear } = useOperationHistory()
  const { past, future } = histories[scope] ?? EMPTY_SCOPE_HISTORY
  const latestPast = past.at(-1)
  const latestFuture = future.at(-1)
  const canUndo = Boolean(latestPast)
  const canRedo = Boolean(latestFuture)
  const visiblePast = past.slice(-12).reverse()
  const visibleFuture = future.slice(-6).reverse()
  const count = past.length + future.length
  const [previewEntry, setPreviewEntry] = useState<OperationHistoryEntry | null>(null)

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const wantsUndo = key === "z" && !event.shiftKey
      const wantsRedo = key === "y" || (key === "z" && event.shiftKey)
      if (wantsUndo && canUndo) {
        event.preventDefault()
        undo(scope)
      } else if (wantsRedo && canRedo) {
        event.preventDefault()
        redo(scope)
      }
    }
    window.addEventListener("keydown", handleKeyboard)
    return () => window.removeEventListener("keydown", handleKeyboard)
  }, [canRedo, canUndo, redo, scope, undo])

  const panel = (
    <section className="operation-history-panel" aria-label={`${scopeLabel}操作历史`}>
      <header className="operation-history-head">
        <div>
          <strong>{scopeLabel}历史</strong>
          <span>{count > 0 ? `${count} 条` : "尚无可撤销操作"}</span>
        </div>
        <Button
          htmlType="button"
          type="text"
          size="small"
          icon={<Trash2 size={13} aria-hidden="true" />}
          onClick={() => clear(scope)}
          disabled={count === 0}
        >
          清空
        </Button>
      </header>
      <div className="operation-history-list">
        {visibleFuture.map((entry) => (
          <article key={entry.id} className="operation-history-entry is-future">
            <span className="operation-history-marker" aria-hidden="true" />
            <div>
              <strong>{entry.label}</strong>
              <p>{entry.detail}</p>
              <small>{historyTime(entry.updatedAt)} · 已撤销</small>
            </div>
          </article>
        ))}
        {visiblePast.map((entry, index) => {
          const appearance = historyAppearance(entry.label)
          const Icon = appearance.icon
          return (
          <button
            type="button"
            key={entry.id}
            className={`operation-history-entry is-action ${appearance.tone}${index === 0 ? " is-current" : ""}`}
            onClick={() => setPreviewEntry(entry)}
          >
            <span className="operation-history-marker" aria-hidden="true" />
            <div>
              <strong><Icon size={14} aria-hidden="true" /> {entry.label}</strong>
              <Tooltip title={entry.detail} placement="left"><p>{entry.detail}</p></Tooltip>
              <small>
                {historyTime(entry.updatedAt)}
                {entry.affected.length > 0 ? ` · ${entry.affected.length} 个对象` : ""}
              </small>
            </div>
          </button>
          )
        })}
        {count === 0 ? (
          <div className="operation-history-empty">
            编辑文件名、文物信息或批量同步后，会在这里留下可回溯记录。
          </div>
        ) : null}
      </div>
      <footer className="operation-history-shortcuts">
        <span>撤销 ⌘Z / Ctrl Z</span>
        <span>重做 ⇧⌘Z / Ctrl Y</span>
      </footer>
      <Modal
        open={previewEntry !== null}
        title={previewEntry ? `恢复「${previewEntry.label}」后的内容` : ""}
        onCancel={() => setPreviewEntry(null)}
        footer={[
          <Button key="cancel" onClick={() => setPreviewEntry(null)}>取消</Button>,
          <Button
            key="restore"
            type="primary"
            onClick={() => {
              if (previewEntry) restore(scope, previewEntry.id)
              setPreviewEntry(null)
            }}
          >
            替换为此时内容
          </Button>,
        ]}
      >
        {previewEntry ? (
          <div className="operation-history-restore-detail">
            <p>将当前快速录入内容替换为此操作完成后的状态；之后的记录仍可通过“重做”继续恢复。</p>
            <dl>
              <div><dt>操作</dt><dd>{previewEntry.label}</dd></div>
              <div><dt>时间</dt><dd>{historyTime(previewEntry.updatedAt)}</dd></div>
              <div><dt>完整内容</dt><dd className="is-detail"><Tooltip title={previewEntry.detail}>{previewEntry.detail}</Tooltip></dd></div>
              <div><dt>影响照片</dt><dd className="is-affected">
                {previewEntry.affected.length > 0
                  ? previewEntry.affected.map((name) => <Tooltip key={name} title={name}><span>{name}</span></Tooltip>)
                  : "未记录具体照片"}
              </dd></div>
            </dl>
          </div>
        ) : null}
      </Modal>
    </section>
  )

  return (
    <div className="operation-history-controls" aria-label="撤销与重做">
      <Tooltip title={latestPast ? `撤销：${latestPast.label}` : "没有可撤销操作"}>
        <Button
          htmlType="button"
          type="text"
          size="small"
          icon={<Undo2 size={16} aria-hidden="true" />}
          onClick={() => undo(scope)}
          disabled={!canUndo}
          aria-label={latestPast ? `撤销 ${latestPast.label}` : "撤销"}
        />
      </Tooltip>
      <Tooltip title={latestFuture ? `重做：${latestFuture.label}` : "没有可重做操作"}>
        <Button
          htmlType="button"
          type="text"
          size="small"
          icon={<Redo2 size={16} aria-hidden="true" />}
          onClick={() => redo(scope)}
          disabled={!canRedo}
          aria-label={latestFuture ? `重做 ${latestFuture.label}` : "重做"}
        />
      </Tooltip>
      <Popover content={panel} trigger="click" placement="bottomRight" overlayClassName="operation-history-popover">
        <Button
          htmlType="button"
          type="text"
          size="small"
          icon={<History size={16} aria-hidden="true" />}
          aria-label={`查看操作历史${count > 0 ? `，共 ${count} 条` : ""}`}
        >
          {count > 0 ? <span className="operation-history-count">{count}</span> : null}
        </Button>
      </Popover>
    </div>
  )
}
