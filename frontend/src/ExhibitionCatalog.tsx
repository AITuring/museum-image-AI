import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react"
import { Button, Input, Select, Spin } from "antd"
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  ChevronDown,
  Clock3,
  ExternalLink,
  Images,
  MapPin,
  Search,
  Ticket,
} from "lucide-react"
import "./styles/exhibitions.css"

type Facet = {
  value: string
  count: number
}

type YearFacet = {
  year: number
  count: number
}

type ExhibitionItem = {
  id: number
  source_id: string
  source_url: string
  source_name: string
  title: string
  region: string
  city: string
  museum_name: string | null
  venue: string | null
  address: string | null
  start_date: string | null
  end_date: string | null
  start_year: number | null
  end_year: number | null
  is_permanent: boolean
  opening_hours: string | null
  fee: string | null
  summary: string | null
  cover_url: string | null
  source_time_text: string | null
  synced_at: string
  status: "ongoing" | "upcoming" | "ended" | "permanent"
}

type ExhibitionDetail = ExhibitionItem & {
  description: string | null
  image_urls: string[]
}

type ExhibitionArtifact = {
  id: number
  name: string
  museum_name: string
  era: string | null
  cover_url: string | null
  captured_at: string | null
}

type ExhibitionDetailReference =
  | { kind: "id"; value: string }
  | { kind: "source"; value: string }
  | { kind: "history"; value: string; museum: string | null }

type HistoricalExhibitionDetail = {
  name: string
  museum_name: string
  start_at: string | null
  end_at: string | null
  artifacts: ExhibitionArtifact[]
}

type CatalogResponse = {
  items: ExhibitionItem[]
  total: number
  page: number
  page_size: number
  years: YearFacet[]
  regions: Facet[]
  cities: Facet[]
  last_synced_at: string | null
  backfill_remaining: number | null
}

type ExhibitionSyncRun = {
  id: number
  mode: string
  trigger: string
  status: "running" | "success" | "partial" | "failed"
  discovered: number
  attempted: number
  created: number
  updated: number
  failed: number
  error: string | null
  started_at: string
  completed_at: string | null
}

type ExhibitionSyncStatus = {
  catalog_total: number
  discovered_total: number
  backfill_remaining: number | null
  processed: number
  overall_progress: number
  rate_per_minute: number | null
  eta_seconds: number | null
  run: ExhibitionSyncRun | null
  recent_runs: ExhibitionSyncRun[]
  worker: {
    status: "starting" | "syncing" | "retry_wait" | "waiting_daily" | string
    message: string | null
    heartbeat_at: string
    next_run_at: string | null
    online: boolean
  } | null
}

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "ongoing", label: "正在展出" },
  { value: "upcoming", label: "即将开始" },
  { value: "permanent", label: "常设展" },
  { value: "ended", label: "已结束" },
]

const STATUS_LABELS: Record<ExhibitionItem["status"], string> = {
  ongoing: "正在展出",
  upcoming: "即将开始",
  ended: "已结束",
  permanent: "常设展",
}

const SYNC_STATUS_LABELS: Record<ExhibitionSyncRun["status"], string> = {
  running: "正在同步",
  success: "同步完成",
  partial: "部分完成",
  failed: "同步失败",
}

function formatDate(value: string | null) {
  if (!value) return null
  return value.replaceAll("-", ".")
}

function formatDateRange(item: ExhibitionItem) {
  if (item.is_permanent) return "常设展"
  const start = formatDate(item.start_date)
  const end = formatDate(item.end_date)
  if (start && end) return `${start} — ${end}`
  if (start) return `${start} 起`
  if (end) return `至 ${end}`
  return item.source_time_text || "日期待补充"
}

function formatSyncTime(value: string | null) {
  if (!value) return "等待首次同步"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "同步时间未知"
  return `更新于 ${date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`
}

function formatDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "计算中"
  if (seconds < 60) return "不足 1 分钟"
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `约 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes ? `约 ${hours} 小时 ${remainingMinutes} 分` : `约 ${hours} 小时`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours ? `约 ${days} 天 ${remainingHours} 小时` : `约 ${days} 天`
}

const DAY_IN_MS = 24 * 60 * 60 * 1000

function parseDateValue(value: string | null) {
  if (!value) return null
  const [year, month, day] = value.slice(0, 10).split("-").map(Number)
  if (!year || !month || !day) return null
  return Date.UTC(year, month - 1, day)
}

function getTimelinePlacement(item: ExhibitionItem, year: number) {
  const yearStart = Date.UTC(year, 0, 1)
  const yearEnd = Date.UTC(year + 1, 0, 1)
  const startValue = parseDateValue(item.start_date)
  const endValue = parseDateValue(item.end_date)

  if (startValue == null && endValue == null && !item.is_permanent) return null

  const sourceStart = item.is_permanent ? yearStart : (startValue ?? endValue ?? yearStart)
  const sourceEnd = item.is_permanent
    ? yearEnd
    : (endValue != null ? endValue + DAY_IN_MS : (startValue ?? yearStart) + DAY_IN_MS)

  if (sourceEnd <= yearStart || sourceStart >= yearEnd) return null

  const start = Math.max(sourceStart, yearStart)
  const end = Math.min(Math.max(sourceEnd, start + DAY_IN_MS), yearEnd)
  const total = yearEnd - yearStart
  const leftPercent = (start - yearStart) / total * 100
  const rawWidthPercent = (end - start) / total * 100

  return {
    start,
    end,
    leftPercent,
    widthPercent: Math.min(Math.max(rawWidthPercent, 1.2), 100 - leftPercent),
  }
}

function resolveBackendAssetUrl(apiBaseUrl: string, value: string) {
  if (!value.startsWith("/")) return value
  return `${apiBaseUrl}${value}`
}

function getDetailReferenceFromPath(): ExhibitionDetailReference | null {
  const numericMatch = window.location.pathname.match(/^\/exhibitions\/(\d+)\/?$/)
  if (numericMatch) return { kind: "id", value: numericMatch[1] }
  const sourceMatch = window.location.pathname.match(
    /^\/exhibitions\/source\/([A-Za-z0-9_-]+)\/?$/,
  )
  if (sourceMatch) return { kind: "source", value: sourceMatch[1] }
  const historyMatch = window.location.pathname.match(/^\/exhibitions\/history\/([^/]+)\/?$/)
  if (!historyMatch) return null
  return {
    kind: "history",
    value: decodeURIComponent(historyMatch[1]),
    museum: new URLSearchParams(window.location.search).get("museum"),
  }
}

function navigateTo(path: string) {
  if (window.location.pathname === path) return
  window.history.pushState({}, "", path)
  window.dispatchEvent(new PopStateEvent("popstate"))
  window.scrollTo({ top: 0, behavior: "instant" })
}

function ExhibitionDetailView({
  apiBaseUrl,
  detailReference,
}: {
  apiBaseUrl: string
  detailReference: ExhibitionDetailReference
}) {
  const [item, setItem] = useState<ExhibitionDetail | null>(null)
  const [artifacts, setArtifacts] = useState<ExhibitionArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const timeout = window.setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        if (detailReference.kind === "history") {
          const params = new URLSearchParams({ name: detailReference.value })
          if (detailReference.museum) params.set("museum_name", detailReference.museum)
          const historyResponse = await fetch(
            `${apiBaseUrl}/api/exhibition-history?${params.toString()}`,
            { signal: controller.signal },
          )
          if (!historyResponse.ok) throw new Error(`HTTP ${historyResponse.status}`)
          const history = (await historyResponse.json()) as HistoricalExhibitionDetail
          const today = new Date().toISOString().slice(0, 10)
          const startDate = history.start_at?.slice(0, 10) ?? null
          const endDate = history.end_at?.slice(0, 10) ?? null
          const status: ExhibitionItem["status"] = endDate && endDate < today
            ? "ended"
            : startDate && startDate > today
              ? "upcoming"
              : "ongoing"
          setItem({
            id: -1,
            source_id: "",
            source_url: "",
            source_name: "Museum",
            title: history.name,
            region: "历史展出",
            city: history.museum_name,
            museum_name: history.museum_name,
            venue: history.museum_name,
            address: null,
            start_date: startDate,
            end_date: endDate,
            start_year: startDate ? Number(startDate.slice(0, 4)) : null,
            end_year: endDate ? Number(endDate.slice(0, 4)) : null,
            is_permanent: false,
            opening_hours: null,
            fee: null,
            summary: "该页面由已上传文物的历史展出记录汇总。",
            description: "该页面由已上传文物的历史展出记录汇总。后续匹配到全球展览目录后，将自动切换为完整展览资料。",
            image_urls: [],
            cover_url: history.artifacts[0]?.cover_url ?? null,
            source_time_text: null,
            synced_at: new Date().toISOString(),
            status,
          })
          setArtifacts(history.artifacts)
          return
        }
        const response = await fetch(
          detailReference.kind === "source"
            ? `${apiBaseUrl}/api/exhibition-catalog/source/${encodeURIComponent(detailReference.value)}`
            : `${apiBaseUrl}/api/exhibition-catalog/${detailReference.value}`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const detail = (await response.json()) as ExhibitionDetail
        setItem(detail)
        const artifactResponse = await fetch(
          `${apiBaseUrl}/api/exhibition-catalog/source/${encodeURIComponent(detail.source_id)}/artifacts`,
          { signal: controller.signal },
        )
        if (artifactResponse.ok) {
          setArtifacts((await artifactResponse.json()) as ExhibitionArtifact[])
        } else {
          setArtifacts([])
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "加载展览详情失败")
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 0)
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [apiBaseUrl, detailReference])

  if (loading) {
    return <section className="exhibition-detail-state"><Spin size="small" /> 正在读取展览详情…</section>
  }

  if (error || !item) {
    return (
      <section className="exhibition-detail-state error">
        <span>展览详情暂时无法加载（{error || "记录不存在"}）</span>
        <Button size="small" onClick={() => navigateTo("/exhibitions")}>返回展览列表</Button>
      </section>
    )
  }

  const paragraphs = (item.description || item.summary || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  const galleryImages = item.image_urls.filter((url) => url !== item.cover_url)

  return (
    <article className="exhibition-detail">
      <button type="button" className="exhibition-detail-back" onClick={() => navigateTo("/exhibitions")}>
        <ArrowLeft size={15} />
        返回展览列表
      </button>

      <header className="exhibition-detail-hero">
        {item.cover_url ? (
          <img src={item.cover_url} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="exhibition-detail-cover-placeholder"><CalendarDays size={32} /></div>
        )}
        <div className="exhibition-detail-hero-shade" />
        <div className="exhibition-detail-heading">
          <div>
            <span className={`exhibition-detail-status ${item.status}`}>
              {item.source_name === "Museum" ? "历史记录" : STATUS_LABELS[item.status]}
            </span>
            <span className="exhibition-detail-region">{item.region} · {item.city}</span>
          </div>
          <h2>{item.title}</h2>
        </div>
      </header>

      <div className="exhibition-detail-layout">
        <main className="exhibition-detail-main">
          <section className="exhibition-detail-intro">
            <span className="exhibition-kicker">ABOUT THE EXHIBITION</span>
            <h3>展览简介</h3>
            {paragraphs.length ? (
              paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 16)}`}>{paragraph}</p>)
            ) : (
              <p className="muted">该展览的正文简介尚在补同步中。</p>
            )}
          </section>

          {galleryImages.length ? (
            <section className="exhibition-detail-gallery">
              <div className="exhibition-detail-section-title">
                <span className="exhibition-kicker">EXHIBITION IMAGES</span>
                <h3>展览图片</h3>
              </div>
              <div className="exhibition-detail-image-grid">
                {galleryImages.map((url, index) => (
                  <img
                    key={url}
                    src={url}
                    alt={`${item.title} · 图片 ${index + 1}`}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="exhibition-detail-artifacts">
            <div className="exhibition-detail-section-title">
              <span className="exhibition-kicker">UPLOADED ARTIFACTS</span>
              <h3>已上传文物</h3>
              <p>{artifacts.length > 0 ? `已有 ${artifacts.length} 件文物关联到本次展览。` : "暂时还没有关联文物。"}</p>
            </div>
            {artifacts.length > 0 ? (
              <div className="exhibition-artifact-grid">
                {artifacts.map((artifact) => (
                  <a
                    key={artifact.id}
                    className="exhibition-artifact-card"
                    href={`/gallery?artifact=${artifact.id}`}
                  >
                    <div className="exhibition-artifact-cover">
                      {artifact.cover_url ? (
                        <img
                          src={resolveBackendAssetUrl(apiBaseUrl, artifact.cover_url)}
                          alt={artifact.name}
                          loading="lazy"
                        />
                      ) : (
                        <Images size={24} aria-hidden="true" />
                      )}
                    </div>
                    <div>
                      <strong>{artifact.name}</strong>
                      <span>{artifact.era || "时代待确认"} · {artifact.museum_name}</span>
                    </div>
                  </a>
                ))}
              </div>
            ) : null}
          </section>
        </main>

        <aside className="exhibition-detail-aside">
          <dl>
            <div>
              <dt><CalendarDays size={15} /> 日期</dt>
              <dd>{formatDateRange(item)}</dd>
            </div>
            {item.opening_hours ? (
              <div>
                <dt><Clock3 size={15} /> 开放时间</dt>
                <dd>{item.opening_hours}</dd>
              </div>
            ) : null}
            <div>
              <dt><Building2 size={15} /> 展馆</dt>
              <dd>{item.museum_name || "博物馆待补充"}</dd>
            </div>
            {item.address ? (
              <div>
                <dt><MapPin size={15} /> 地址</dt>
                <dd>{item.address}</dd>
              </div>
            ) : null}
            {item.fee ? (
              <div>
                <dt><Ticket size={15} /> 费用</dt>
                <dd>{item.fee}</dd>
              </div>
            ) : null}
          </dl>
          {item.source_url ? (
            <a className="exhibition-source-button" href={item.source_url} target="_blank" rel="noreferrer">
              查看原始来源
              <ExternalLink size={14} />
            </a>
          ) : null}
          <span className="exhibition-detail-sync">最后同步 {formatSyncTime(item.synced_at).replace("更新于 ", "")}</span>
        </aside>
      </div>
    </article>
  )
}

export default function ExhibitionCatalog({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [detailReference, setDetailReference] = useState<ExhibitionDetailReference | null>(
    () => getDetailReferenceFromPath(),
  )
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [year, setYear] = useState<number | null>(new Date().getFullYear())
  const [region, setRegion] = useState("")
  const [city, setCity] = useState("")
  const [status, setStatus] = useState("")
  const [payload, setPayload] = useState<CatalogResponse | null>(null)
  const [items, setItems] = useState<ExhibitionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<ExhibitionSyncStatus | null>(null)
  const [syncStatusError, setSyncStatusError] = useState(false)
  const [syncCardExpanded, setSyncCardExpanded] = useState(false)
  const previousSyncRunState = useRef<string | null>(null)

  useEffect(() => {
    const handleLocationChange = () => setDetailReference(getDetailReferenceFromPath())
    window.addEventListener("popstate", handleLocationChange)
    return () => window.removeEventListener("popstate", handleLocationChange)
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timeout)
  }, [query])

  const fetchPage = useCallback(
    async (page: number, append = false) => {
      if (append) {
        setLoadingMore(true)
      } else {
        setLoading(true)
      }
      setError(null)
      const params = new URLSearchParams({
        page: String(page),
        page_size: "36",
      })
      if (debouncedQuery) params.set("q", debouncedQuery)
      if (year) params.set("year", String(year))
      if (region) params.set("region", region)
      if (city) params.set("city", city)
      if (status) params.set("status", status)

      try {
        const response = await fetch(`${apiBaseUrl}/api/exhibition-catalog?${params.toString()}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = (await response.json()) as CatalogResponse
        setPayload(data)
        setItems((current) => (append ? [...current, ...data.items] : data.items))
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载展览目录失败")
        if (!append) setItems([])
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [apiBaseUrl, city, debouncedQuery, region, status, year],
  )

  useEffect(() => {
    if (detailReference !== null) return
    const timeout = window.setTimeout(() => void fetchPage(1), 0)
    return () => window.clearTimeout(timeout)
  }, [detailReference, fetchPage])

  useEffect(() => {
    if (detailReference !== null) return
    const controller = new AbortController()
    let timer: number | undefined
    const poll = async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/exhibition-catalog/sync/status`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = (await response.json()) as ExhibitionSyncStatus
        setSyncStatus(data)
        setSyncStatusError(false)
        const workerSyncing = Boolean(data.worker?.online && data.worker.status === "syncing")
        const activelySyncing = data.worker
          ? workerSyncing
          : data.run?.status === "running"
        const backfillActive = (data.backfill_remaining ?? 0) > 0
        timer = window.setTimeout(
          poll,
          activelySyncing
            ? 1500
            : backfillActive
              ? 5000
              : 30000,
        )
      } catch {
        if (!controller.signal.aborted) {
          setSyncStatusError(true)
          timer = window.setTimeout(poll, 15000)
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [apiBaseUrl, detailReference])

  useEffect(() => {
    const currentState = syncStatus?.run
      ? `${syncStatus.run.id}:${syncStatus.run.status}`
      : null
    const previousState = previousSyncRunState.current
    previousSyncRunState.current = currentState
    if (
      detailReference === null
      && previousState?.endsWith(":running")
      && currentState
      && !currentState.endsWith(":running")
    ) {
      void fetchPage(1)
    }
  }, [detailReference, fetchPage, syncStatus?.run])

  const groupedItems = useMemo(() => {
    const groups = new Map<string, ExhibitionItem[]>()
    items.forEach((item) => {
      const group = groups.get(item.region) ?? []
      group.push(item)
      groups.set(item.region, group)
    })
    return Array.from(groups.entries())
  }, [items])
  const timelineRows = useMemo(() => {
    if (!year) return []

    const rows = new Map<string, {
      key: string
      museum: string
      city: string
      region: string
      items: ExhibitionItem[]
    }>()

    items.forEach((item) => {
      // `venue` is an exhibition hall, never the museum label. Older catalog
      // rows without a parent museum stay grouped as explicitly incomplete
      // instead of being presented as if a hall were a museum.
      const museum = item.museum_name?.trim() || "博物馆待补充"
      const key = [museum, item.city, item.region].join("::")
      const row = rows.get(key) ?? {
        key,
        museum,
        city: item.city,
        region: item.region,
        items: [],
      }
      row.items.push(item)
      rows.set(key, row)
    })

    return Array.from(rows.values())
      .map((row) => {
        const undated: ExhibitionItem[] = []
        const placed = row.items
          .map((item) => {
            const placement = getTimelinePlacement(item, year)
            if (!placement) {
              undated.push(item)
              return null
            }
            return { item, ...placement }
          })
          .filter((segment): segment is NonNullable<typeof segment> => segment !== null)
          .sort((left, right) => {
            if (left.start !== right.start) return left.start - right.start
            return right.end - left.end
          })

        const laneEndTimes: number[] = []
        const segments = placed.map((segment) => {
          let lane = laneEndTimes.findIndex((end) => segment.start >= end)
          if (lane === -1) {
            lane = laneEndTimes.length
            laneEndTimes.push(segment.end)
          } else {
            laneEndTimes[lane] = segment.end
          }
          return {
            ...segment,
            lane,
          }
        })

        return {
          ...row,
          count: row.items.length,
          laneCount: Math.max(laneEndTimes.length, segments.length ? 1 : 0),
          segments,
          undated,
        }
      })
      .sort((left, right) => {
        const cityOrder = left.city.localeCompare(right.city, "zh-CN")
        if (cityOrder !== 0) return cityOrder
        return left.museum.localeCompare(right.museum, "zh-CN")
      })
  }, [items, year])
  const monthLabels = useMemo(
    () => Array.from({ length: 12 }, (_, index) => `${index + 1}月`),
    [],
  )
  const currentYear = new Date().getFullYear()

  const hasMore = payload ? items.length < payload.total : false
  const currentRun = syncStatus?.run ?? null
  const syncRunning = currentRun?.status === "running"
  const syncProgress = currentRun?.attempted
    ? Math.min(100, Math.round((syncStatus?.processed ?? 0) / currentRun.attempted * 100))
    : 0
  const catalogTotal = syncStatus?.catalog_total ?? payload?.total ?? 0
  const backfillRemaining = syncStatus?.backfill_remaining ?? payload?.backfill_remaining ?? null
  const discoveredTotal = syncStatus?.discovered_total ?? currentRun?.discovered ?? catalogTotal
  const overallProgress = syncStatus?.overall_progress
    ?? (discoveredTotal ? Math.min(100, catalogTotal / discoveredTotal * 100) : 0)
  const worker = syncStatus?.worker ?? null
  const syncActive = worker
    ? Boolean(worker.online && worker.status === "syncing")
    : syncRunning
  const syncStateLabel = worker && !worker.online
    ? "Worker 离线"
    : worker?.status === "retry_wait"
      ? "等待重试"
      : worker?.status === "waiting_daily"
        ? "数据已追平"
        : backfillRemaining && backfillRemaining > 0
          ? "持续同步中"
          : currentRun
            ? SYNC_STATUS_LABELS[currentRun.status]
            : "同步状态"
  const recentRuns = syncStatus?.recent_runs ?? (currentRun ? [currentRun] : [])
  const syncFootnote = syncStatusError
    ? "实时状态暂不可用"
    : worker?.status === "waiting_daily" && worker.next_run_at
      ? formatSyncTime(worker.next_run_at).replace("更新于 ", "下次同步 ")
      : worker?.message
        ?? (backfillRemaining
          ? `待补详情 ${backfillRemaining.toLocaleString("zh-CN")} 条`
          : "目录详情已追平")
  const cityOptions = [
    { value: "", label: "全部城市" },
    ...(payload?.cities ?? []).map((item) => ({
      value: item.value,
      label: `${item.value} · ${item.count}`,
    })),
  ]
  const syncCardPanelId = "exhibition-sync-status-panel"

  const openDetail = useCallback((event: MouseEvent<HTMLAnchorElement>, exhibitionId: number) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) {
      return
    }
    event.preventDefault()
    navigateTo(`/exhibitions/${exhibitionId}`)
  }, [])
  const showTimeline = year !== null && year < currentYear

  if (detailReference !== null) {
    return <ExhibitionDetailView apiBaseUrl={apiBaseUrl} detailReference={detailReference} />
  }

  return (
    <section className="exhibition-catalog">
      <header className="exhibition-hero">
        <div>
          <span className="exhibition-kicker">EXHIBITION ARCHIVE</span>
          <h2>全球展览</h2>
          <p>按年份与地域浏览展览记录，数据每日从公开展览目录同步。</p>
        </div>
        <div className={`exhibition-sync-card${syncActive ? " running" : ""}${syncCardExpanded ? " expanded" : ""}`}>
          <button
            type="button"
            className="exhibition-sync-card-toggle"
            aria-expanded={syncCardExpanded}
            aria-controls={syncCardPanelId}
            onClick={() => setSyncCardExpanded((current) => !current)}
          >
            <div className="exhibition-sync-card-head">
              <span className="exhibition-sync-state">
                <i aria-hidden="true" />
                {syncStateLabel}
              </span>
              <span>
                {worker?.heartbeat_at
                  ? `心跳 ${formatSyncTime(worker.heartbeat_at).replace("更新于 ", "")}`
                  : formatSyncTime(payload?.last_synced_at ?? null)}
              </span>
            </div>
            <div className="exhibition-sync-card-summary">
              <div className="exhibition-sync-card-summary-main">
                <strong>{overallProgress.toFixed(overallProgress < 10 ? 1 : 0)}%</strong>
                <span>
                  已同步 {catalogTotal.toLocaleString("zh-CN")} / {discoveredTotal.toLocaleString("zh-CN")}
                </span>
              </div>
              <div className="exhibition-sync-card-summary-side">
                <span>{syncFootnote}</span>
                <ChevronDown size={16} aria-hidden="true" />
              </div>
            </div>
            <div
              className="exhibition-sync-progress exhibition-sync-progress-overall"
              role="progressbar"
              aria-label="展览总体同步进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={overallProgress}
            >
              <span style={{ width: `${overallProgress}%` }} />
            </div>
          </button>

          <div
            id={syncCardPanelId}
            className={`exhibition-sync-card-panel${syncCardExpanded ? " expanded" : ""}`}
          >
            <div className="exhibition-sync-card-panel-inner">
              <div className="exhibition-sync-metrics">
                <div>
                  <strong>{(backfillRemaining ?? 0).toLocaleString("zh-CN")}</strong>
                  <span>待同步</span>
                </div>
                <div>
                  <strong>
                    {syncStatus?.rate_per_minute != null
                      ? syncStatus.rate_per_minute.toLocaleString("zh-CN", { maximumFractionDigits: 1 })
                      : "—"}
                  </strong>
                  <span>条 / 分钟</span>
                </div>
                <div>
                  <strong>{formatDuration(syncStatus?.eta_seconds ?? null)}</strong>
                  <span>预计完成</span>
                </div>
                <div className={worker?.online ? "online" : "offline"}>
                  <strong>{worker?.online ? "在线" : "未连接"}</strong>
                  <span>同步 Worker</span>
                </div>
              </div>

              {currentRun ? (
                <div className="exhibition-sync-batch">
                  <div className="exhibition-sync-progress-head">
                    <span>{syncActive ? "当前批次" : "最近批次"}</span>
                    <span>{syncStatus?.processed.toLocaleString("zh-CN") ?? 0} / {currentRun.attempted.toLocaleString("zh-CN")} · {syncProgress}%</span>
                  </div>
                  <div
                    className="exhibition-sync-progress"
                    role="progressbar"
                    aria-label="展览同步进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={syncProgress}
                  >
                    <span style={{ width: `${syncProgress}%` }} />
                  </div>
                  <div className="exhibition-sync-counts">
                    <span>发现 {currentRun.discovered.toLocaleString("zh-CN")}</span>
                    <span>新增 {currentRun.created.toLocaleString("zh-CN")}</span>
                    <span>更新 {currentRun.updated.toLocaleString("zh-CN")}</span>
                    {currentRun.failed > 0 ? <span className="failed">失败 {currentRun.failed.toLocaleString("zh-CN")}</span> : null}
                  </div>
                </div>
              ) : null}

              {recentRuns.length > 0 ? (
                <div className="exhibition-sync-history">
                  <span>最近批次</span>
                  <div>
                    {recentRuns.slice(0, 5).map((run) => (
                      <i
                        key={run.id}
                        className={run.status === "failed" ? "failed" : ""}
                        title={`新增 ${run.created} · 更新 ${run.updated} · 失败 ${run.failed}`}
                      >
                        +{run.created.toLocaleString("zh-CN")}
                      </i>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="exhibition-sync-card-foot">
                <span>{syncFootnote}</span>
                <a href="https://art.icity.ly/" target="_blank" rel="noreferrer">
                  数据来源 iMuseum <ExternalLink size={12} />
                </a>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="exhibition-toolbar">
        <Input
          allowClear
          className="exhibition-search"
          placeholder="搜索展览、场馆或城市"
          prefix={<Search size={15} />}
          value={query}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
        />
        <Select
          aria-label="地域"
          value={region}
          options={[
            { value: "", label: "全部地域" },
            ...(payload?.regions ?? []).map((item) => ({
              value: item.value,
              label: `${item.value} · ${item.count}`,
            })),
          ]}
          onChange={(value: string) => {
            setRegion(value)
            setCity("")
          }}
        />
        <Select aria-label="城市" value={city} options={cityOptions} onChange={setCity} />
        <Select aria-label="状态" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
      </div>

      <div className="exhibition-layout">
        <aside className="exhibition-year-rail" aria-label="年份筛选">
          <div className="exhibition-year-heading">
            <span>年份</span>
            <button type="button" className={!year ? "active" : ""} onClick={() => setYear(null)}>
              全部
            </button>
          </div>
          <div className="exhibition-year-list">
            {(payload?.years ?? []).map((item) => (
              <button
                type="button"
                className={year === item.year ? "active" : ""}
                key={item.year}
                onClick={() => setYear(item.year)}
              >
                <strong>{item.year}</strong>
                <span>{item.count}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="exhibition-results">
          <div className="exhibition-result-summary">
            <strong>{year ? `${year} 年` : "全部年份"}</strong>
            <span>
              {region || "全球"} · {payload?.total.toLocaleString("zh-CN") ?? 0} 个展览
              {showTimeline ? ` · ${timelineRows.length} 个馆 · 时间轴` : " · 卡片混排"}
            </span>
          </div>

          {loading ? (
            <div className="exhibition-state"><Spin size="small" /> 正在读取展览目录…</div>
          ) : error ? (
            <div className="exhibition-state error">
              <span>展览目录暂时无法加载（{error}）</span>
              <Button size="small" onClick={() => void fetchPage(1)}>重试</Button>
            </div>
          ) : (showTimeline ? timelineRows.length : groupedItems.length) === 0 ? (
            <div className="exhibition-state">当前筛选下暂无展览记录。</div>
          ) : showTimeline ? (
            <div className="exhibition-timeline">
              <div className="exhibition-timeline-head">
                <div className="exhibition-timeline-head-label">
                  <span>博物馆</span>
                  <strong>{timelineRows.length} 馆</strong>
                </div>
                <div className="exhibition-timeline-months" aria-hidden="true">
                  {monthLabels.map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
              </div>

              <div className="exhibition-timeline-list">
                {timelineRows.map((row) => (
                  <section className="exhibition-timeline-row" key={row.key}>
                    <div className="exhibition-timeline-museum">
                      <strong>{row.museum}</strong>
                      <span>
                        {row.city}
                        {row.region && row.region !== row.city ? ` · ${row.region}` : ""}
                        {` · ${row.count} 展`}
                      </span>
                    </div>

                    <div className="exhibition-timeline-row-body">
                      <div
                        className="exhibition-timeline-track"
                        style={{ minHeight: `${Math.max(row.laneCount, 1) * 72}px` }}
                      >
                        <div className="exhibition-timeline-track-grid" aria-hidden="true">
                          {monthLabels.map((label) => (
                            <span key={`${row.key}-${label}`} />
                          ))}
                        </div>

                        {row.segments.map((segment) => (
                          <a
                            key={segment.item.id}
                            href={`/exhibitions/${segment.item.id}`}
                            className={`exhibition-timeline-bar ${segment.item.status}`}
                            onClick={(event) => openDetail(event, segment.item.id)}
                            style={{
                              left: `${segment.leftPercent}%`,
                              width: `${segment.widthPercent}%`,
                              top: `${segment.lane * 72 + 10}px`,
                            }}
                            aria-label={`${segment.item.title}, ${formatDateRange(segment.item)}`}
                          >
                            <span className="exhibition-timeline-bar-title">{segment.item.title}</span>
                            <span className="exhibition-timeline-bar-meta">
                              {formatDateRange(segment.item)}
                            </span>
                          </a>
                        ))}
                      </div>

                      {row.undated.length ? (
                        <div className="exhibition-timeline-undated">
                          <span>日期待补充</span>
                          {row.undated.map((item) => (
                            <a
                              key={item.id}
                              href={`/exhibitions/${item.id}`}
                              onClick={(event) => openDetail(event, item.id)}
                            >
                              {item.title}
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          ) : (
            groupedItems.map(([groupRegion, group]) => (
              <section className="exhibition-region-group" key={groupRegion}>
                <div className="exhibition-region-title">
                  <h3>{groupRegion}</h3>
                  <span>{group.length} 条已加载</span>
                </div>
                <div className="exhibition-grid">
                  {group.map((item) => (
                    <article className="exhibition-card" key={item.id}>
                      <a
                        href={`/exhibitions/${item.id}`}
                        className="exhibition-cover"
                        onClick={(event) => openDetail(event, item.id)}
                      >
                        {item.cover_url ? (
                          <img src={item.cover_url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="exhibition-cover-placeholder"><CalendarDays size={24} /></div>
                        )}
                        <span className={`exhibition-status ${item.status}`}>
                          {STATUS_LABELS[item.status]}
                        </span>
                      </a>
                      <div className="exhibition-card-body">
                        <div className="exhibition-location">
                          <MapPin size={13} />
                          <span>
                            {item.museum_name || "博物馆待补充"}
                            {item.city ? ` · ${item.city}` : ""}
                          </span>
                        </div>
                        <h4>
                          <a
                            href={`/exhibitions/${item.id}`}
                            onClick={(event) => openDetail(event, item.id)}
                          >
                            {item.title}
                          </a>
                        </h4>
                        <div className="exhibition-date">{formatDateRange(item)}</div>
                        {item.summary ? <p>{item.summary}</p> : null}
                        <div className="exhibition-card-foot">
                          <span>{item.fee || item.opening_hours || "详情见来源页"}</span>
                          <a
                            href={`/exhibitions/${item.id}`}
                            onClick={(event) => openDetail(event, item.id)}
                            aria-label={`查看${item.title}详情`}
                          >
                            查看详情
                          </a>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))
          )}

          {hasMore ? (
            <div className="exhibition-load-more">
              <Button loading={loadingMore} onClick={() => void fetchPage((payload?.page ?? 1) + 1, true)}>
                加载更多
              </Button>
            </div>
          ) : null}
        </main>
      </div>
    </section>
  )
}
