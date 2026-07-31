import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronRight, Image as ImageIcon, Landmark, Search } from "lucide-react"
import { Input, Spin } from "antd"
import "./EraBrowser.css"

type EraItem = {
  name: string
  aliases: string[]
  parent: string | null
  count: number
}

type Artifact = {
  id: number
  name: string
  era: string | null
  museum_name: string
  description: string | null
  tags: string[]
  images: Array<{ id: number; url: string }>
}

type EraTimelinePayload = {
  eras: EraItem[]
  selected_era: string | null
  total_artifacts: number
  artifacts: Artifact[]
}

const ERA_IMAGE_NAMES = new Set([
  "新石器时代", "夏", "商", "西周", "春秋", "战国", "秦", "西汉", "东汉", "三国",
  "西晋", "东晋", "北朝", "南朝", "北魏", "北齐", "北燕", "隋", "唐", "五代", "五代十国",
  "北宋", "南宋", "元", "明", "清",
])

const ERA_IMAGE_FALLBACKS: Record<string, string> = {
  "南北朝": "南朝",
  "刘宋": "南朝",
  "南齐": "南朝",
  "梁": "南朝",
  "陈": "南朝",
  "东魏": "北魏",
  "西魏": "北魏",
  "北齐": "北魏",
  "北周": "北魏",
  "北燕": "北魏",
}

function eraImageUrl(name: string) {
  const assetName = ERA_IMAGE_FALLBACKS[name] ?? (name === "五代十国" ? "五代" : name)
  return ERA_IMAGE_NAMES.has(assetName) ? `/era/${encodeURIComponent(assetName)}.png` : null
}

function navigateTo(path: string) {
  if (window.location.pathname === path) return
  window.history.pushState({}, "", path)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

function getSelectedEraFromLocation() {
  return new URLSearchParams(window.location.search).get("era")?.trim() || null
}

export default function EraBrowser({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [selectedEra, setSelectedEra] = useState<string | null>(getSelectedEraFromLocation)
  const [payload, setPayload] = useState<EraTimelinePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => new Set())

  const load = useCallback(async (era: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (era) params.set("era", era)
      const response = await fetch(`${apiBaseUrl}/api/era-timeline?${params.toString()}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setPayload((await response.json()) as EraTimelinePayload)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "时代目录加载失败")
    } finally {
      setLoading(false)
    }
  }, [apiBaseUrl])

  useEffect(() => { void load(selectedEra) }, [load, selectedEra])

  useEffect(() => {
    const syncRoute = () => setSelectedEra(getSelectedEraFromLocation())
    window.addEventListener("popstate", syncRoute)
    return () => window.removeEventListener("popstate", syncRoute)
  }, [])

  useEffect(() => {
    const selected = payload?.eras.find((item) => item.name === selectedEra)
    const parent = selected?.parent
    if (!parent) return
    setExpandedParents((current) => {
      if (!parent || current.has(parent)) return current
      const next = new Set(current)
      next.add(parent)
      return next
    })
  }, [payload?.eras, selectedEra])

  const visibleArtifacts = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return payload?.artifacts ?? []
    return (payload?.artifacts ?? []).filter((artifact) => [
      artifact.name,
      artifact.era,
      artifact.museum_name,
      artifact.description,
      ...artifact.tags,
    ].some((value) => value?.toLowerCase().includes(needle)))
  }, [payload?.artifacts, query])

  function chooseEra(era: string | null) {
    const params = era ? `?${new URLSearchParams({ era }).toString()}` : ""
    navigateTo(`/eras${params}`)
  }

  const selectedItem = payload?.eras.find((item) => item.name === selectedEra)
  const childParentNames = useMemo(
    () => new Set((payload?.eras ?? []).flatMap((item) => item.parent ? [item.parent] : [])),
    [payload?.eras],
  )
  const visibleEras = useMemo(
    () => (payload?.eras ?? []).filter((item) => !item.parent || expandedParents.has(item.parent)),
    [expandedParents, payload?.eras],
  )

  function handleEraSelection(item: EraItem) {
    if (childParentNames.has(item.name)) {
      setExpandedParents((current) => {
        const next = new Set(current)
        if (next.has(item.name)) next.delete(item.name)
        else next.add(item.name)
        return next
      })
    }
    chooseEra(item.name)
  }

  return (
    <section className={`era-browser${selectedEra ? "" : " is-overview"}`} aria-labelledby="era-browser-title">
      <header className="era-browser-head">
        <div>
          <span className="era-kicker">文物编年</span>
          <h2 id="era-browser-title">时代</h2>
          <p>按中国古代时期查看已入库文物；保留录入原文，在浏览中统一归类。</p>
        </div>
        <div className="era-browser-total">
          <strong>{payload?.total_artifacts.toLocaleString("zh-CN") ?? "—"}</strong>
          <span>件已归类文物</span>
        </div>
      </header>

      <div className="era-layout">
        <aside className="era-rail" aria-label="时代筛选">
          <div className="era-rail-heading"><span>朝代</span><button className={!selectedEra ? "active" : ""} onClick={() => chooseEra(null)}>全部</button></div>
          <div className="era-rail-list">
            {visibleEras.map((item) => (
              <button key={item.name} className={`${item.parent ? "era-rail-child" : ""} ${selectedEra === item.name ? "active" : ""}`} onClick={() => handleEraSelection(item)}>
                <span className="era-rail-title">
                  {eraImageUrl(item.name) ? <img src={eraImageUrl(item.name) ?? undefined} alt="" aria-hidden="true" /> : null}
                  <strong>{childParentNames.has(item.name) ? <><ChevronRight className={expandedParents.has(item.name) ? "expanded" : ""} size={14} aria-hidden="true" />{item.name}</> : item.name}</strong>
                </span>
                <span className="era-rail-count">{item.count}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="era-results">
          <div className="era-summary">
            <div><strong>{selectedEra ?? "中国古代"}</strong><span>{selectedEra ? `${payload?.artifacts.length ?? 0} 件文物` : "选择一段时代查看文物"}</span></div>
            {selectedEra ? <Input className="era-search" allowClear value={query} onChange={(event) => setQuery(event.target.value)} prefix={<Search size={15} />} placeholder="筛选名称、馆藏或标签" aria-label="筛选该时代文物" /> : null}
          </div>

          {selectedItem?.name === "新石器时代" ? <div className="era-subperiods" aria-label="新石器时代文化类型">{selectedItem.aliases.filter((item) => item !== "新石器时代").map((item) => <span key={item}>{item.replace("文化", "")}</span>)}</div> : null}

          {loading ? <div className="era-state"><Spin size="small" /> 正在读取时代目录…</div> : error ? <div className="era-state error">时代目录暂时无法加载（{error}）</div> : !selectedEra ? <div className="era-state">从时间轴选择一个时代，查看该时期的文物。</div> : visibleArtifacts.length === 0 ? <div className="era-state">该时代下暂无匹配文物。</div> : (
            <div className="era-artifact-grid">
              {visibleArtifacts.map((artifact) => {
                const image = artifact.images[0]
                const returnParams = new URLSearchParams({ from: "eras" })
                if (selectedEra) returnParams.set("era", selectedEra)
                const detailPath = `/gallery/${artifact.id}?${returnParams.toString()}`
                return <a className="era-artifact-card" href={detailPath} key={artifact.id} onClick={(event) => { event.preventDefault(); navigateTo(detailPath) }}>
                  <div className="era-artifact-cover">{image ? <img src={image.url} alt="" /> : <ImageIcon size={22} aria-hidden="true" />}</div>
                  <div className="era-artifact-copy"><span>{artifact.era || selectedEra}</span><strong>{artifact.name}</strong><p><Landmark size={12} aria-hidden="true" />{artifact.museum_name}</p></div>
                </a>
              })}
            </div>
          )}
        </main>
      </div>
    </section>
  )
}
