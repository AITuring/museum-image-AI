import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { Button, Input, Select, Spin } from "antd"
import {
  ArrowLeft,
  Building2,
  CalendarDays,
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
  backfill_remaining: number | null
  processed: number
  run: ExhibitionSyncRun | null
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
              <dd>{item.venue || "场馆待补充"}</dd>
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
        timer = window.setTimeout(poll, data.run?.status === "running" ? 1500 : 15000)
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

  const hasMore = payload ? items.length < payload.total : false
  const currentRun = syncStatus?.run ?? null
  const syncRunning = currentRun?.status === "running"
  const syncProgress = currentRun?.attempted
    ? Math.min(100, Math.round((syncStatus?.processed ?? 0) / currentRun.attempted * 100))
    : 0
  const catalogTotal = syncStatus?.catalog_total ?? payload?.total ?? 0
  const backfillRemaining = syncStatus?.backfill_remaining ?? payload?.backfill_remaining ?? null
  const cityOptions = [
    { value: "", label: "全部城市" },
    ...(payload?.cities ?? []).map((item) => ({
      value: item.value,
      label: `${item.value} · ${item.count}`,
    })),
  ]

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
        <div className={`exhibition-sync-card${syncRunning ? " running" : ""}`}>
          <div className="exhibition-sync-card-head">
            <span className="exhibition-sync-state">
              <i aria-hidden="true" />
              {currentRun ? SYNC_STATUS_LABELS[currentRun.status] : "同步状态"}
            </span>
            <span>{formatSyncTime(payload?.last_synced_at ?? null)}</span>
          </div>
          <div className="exhibition-sync-total">
            <strong>{catalogTotal.toLocaleString("zh-CN")}</strong>
            <span>条展览已同步</span>
          </div>
          {currentRun ? (
            <>
              <div className="exhibition-sync-progress-head">
                <span>本轮已处理 {syncStatus?.processed.toLocaleString("zh-CN") ?? 0} / {currentRun.attempted.toLocaleString("zh-CN")}</span>
                <span>{syncProgress}%</span>
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
            </>
          ) : null}
          <div className="exhibition-sync-card-foot">
            <span>
              {syncStatusError
                ? "实时状态暂不可用"
                : backfillRemaining
                  ? `待补详情 ${backfillRemaining.toLocaleString("zh-CN")} 条`
                  : "目录详情已追平"}
            </span>
            <a href="https://art.icity.ly/" target="_blank" rel="noreferrer">
              数据来源 iMuseum <ExternalLink size={12} />
            </a>
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
          onChange={(event) => setQuery(event.target.value)}
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
          onChange={(value) => {
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
            <span>{region || "全球"} · {payload?.total.toLocaleString("zh-CN") ?? 0} 个展览</span>
          </div>

          {loading ? (
            <div className="exhibition-state"><Spin size="small" /> 正在读取展览目录…</div>
          ) : error ? (
            <div className="exhibition-state error">
              <span>展览目录暂时无法加载（{error}）</span>
              <Button size="small" onClick={() => void fetchPage(1)}>重试</Button>
            </div>
          ) : groupedItems.length === 0 ? (
            <div className="exhibition-state">当前筛选下暂无展览记录。</div>
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
                          <span>{item.city}{item.venue ? ` · ${item.venue}` : ""}</span>
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
