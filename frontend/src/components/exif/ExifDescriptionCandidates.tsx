import { Button, Card, Tag, Tooltip } from "antd"
import { Check, Loader2, Sparkles, X } from "lucide-react"
import { AnnotatedDescription } from "./ReviewIndicators"
import type { DescriptionCandidate, ExifWorkbenchItem, LiveProviderState, VerifiedClaim } from "./types"

type DescriptionCandidatesProps = {
  item: ExifWorkbenchItem
  generating: boolean
  progress: string[]
  researchSummary: string
  liveProviders: Record<string, LiveProviderState>
  onGenerate: () => void
  onReviewClaim: (claim: VerifiedClaim, decision: "accepted" | "rejected") => void
  onToggleTag: (tag: string) => void
  onApplyCandidate: (candidate: DescriptionCandidate) => void
  toResearchUrl: (url: string) => string
}

function LiveProgress({ progress, researchSummary, providers }: { progress: string[]; researchSummary: string; providers: Record<string, LiveProviderState> }) {
  return <div className="research-live-panel" aria-live="polite">
    <div className="research-live-head"><span className="research-orbit" aria-hidden="true"><Sparkles size={16} /></span><div><strong>正在核验与生成</strong><span>检索 Agent 和两个模型的进度会实时更新</span></div><Loader2 className="research-live-spinner" size={18} aria-hidden="true" /></div>
    <div className="research-trace">{progress.map((step, index) => <span key={step} className={index === progress.length - 1 ? "is-active" : "is-done"}>{index < progress.length - 1 ? <Check size={12} /> : <Loader2 size={12} />}{step}</span>)}</div>
    {researchSummary ? <details className="live-reasoning" open><summary>Agent 实时核验摘要</summary><p>{researchSummary}</p></details> : null}
    {Object.keys(providers).length > 0 ? <div className="live-provider-grid">{Object.entries(providers).map(([provider, state]) => <article key={provider} className={`live-provider is-${state.status}`}><header><strong>{provider}</strong><span>{state.model}</span></header><p>{state.message}</p>{state.reasoning ? <pre>{state.reasoning}</pre> : <div className="reasoning-skeleton" aria-hidden="true"><i /><i /><i /></div>}{state.status === "complete" ? <small>{state.descriptionLength} 字描述 · {state.tagCount} 个标签</small> : null}</article>)}</div> : null}
  </div>
}

function CandidateCard({ candidate, item, onReviewClaim, onToggleTag, onApplyCandidate, toResearchUrl }: Pick<DescriptionCandidatesProps, "item" | "onReviewClaim" | "onToggleTag" | "onApplyCandidate" | "toResearchUrl"> & { candidate: DescriptionCandidate }) {
  return <article className={`exif-model-card ${candidate.status !== "success" ? "is-error" : ""}`}>
    <div className="result-head"><h3>{candidate.provider}</h3><span>{candidate.model}</span></div>
    <details className="exif-model-details"><summary>查看模型依据</summary><pre className="exif-model-reasoning">{candidate.reasoning || candidate.error || "暂无依据返回"}</pre></details>
    {candidate.research_summary ? <details className="exif-model-details"><summary>查看联网核验报告</summary><pre className="exif-model-reasoning">{candidate.research_summary}</pre></details> : null}
    {candidate.status !== "success" ? <p className="error-text">{candidate.error || "模型调用失败"}</p> : <>
      <AnnotatedDescription description={candidate.description || "暂无描述"} warnings={candidate.field_warnings ?? []} />
      {(candidate.verified_claims?.length ?? 0) > 0 ? <div className="verified-claim-list">{candidate.verified_claims?.filter((claim) => item.verificationDecisions?.[claim.text] !== "rejected").map((claim) => {
        const accepted = item.verificationDecisions?.[claim.text] === "accepted"
        return <article key={claim.text} className={accepted ? "is-accepted" : ""}><div className="verified-claim-copy"><div className="verified-claim-tags"><Tag color="blue">联网核验</Tag>{claim.source_refs.filter((source) => source !== "联网核验").map((source) => <Tag key={source}>{source}</Tag>)}</div><p>{claim.text}</p></div><div className="verified-claim-actions"><Tooltip title="内容正确，加入最终正文"><Button htmlType="button" type={accepted ? "primary" : "default"} shape="circle" size="small" aria-label="确认联网核验内容并加入正文" icon={<Check size={14} />} onClick={() => onReviewClaim(claim, "accepted")} /></Tooltip><Tooltip title="内容错误，从最终正文删除"><Button htmlType="button" danger shape="circle" size="small" aria-label="否认联网核验内容并删除" icon={<X size={14} />} onClick={() => onReviewClaim(claim, "rejected")} /></Tooltip></div></article>
      })}</div> : null}
      {(candidate.search_hits?.length ?? 0) > 0 ? <details className="exif-model-details exif-research-sources"><summary>查看检索来源（{candidate.search_hits?.length}）</summary><div className="exif-source-list">{candidate.search_hits?.map((hit, index) => <article key={hit.url}><a href={toResearchUrl(hit.url)} target="_blank" rel="noreferrer">[{index + 1}] {hit.title}</a>{hit.source ? <span>{hit.source}</span> : null}{hit.snippet ? <p>{hit.snippet}</p> : null}</article>)}</div></details> : null}
      <div className="result-meta selectable-model-tags">{candidate.tags.length > 0 ? candidate.tags.map((tag) => <Tag.CheckableTag key={tag} checked={item.form.tags.includes(tag)} onChange={() => onToggleTag(tag)}>{item.form.tags.includes(tag) ? <Check size={12} /> : <span>＋</span>}{tag}</Tag.CheckableTag>) : <span>暂无标签</span>}</div>
      {candidate.tags.length > 0 ? <p className="model-tag-help">点击任意模型标签，可加入或移出最终标签。</p> : null}
      <Button htmlType="button" type="primary" icon={<Check size={14} aria-hidden="true" />} onClick={() => onApplyCandidate(candidate)}>采用此描述</Button>
    </>}
  </article>
}

export function ExifDescriptionCandidates({ item, generating, progress, researchSummary, liveProviders, onGenerate, onReviewClaim, onToggleTag, onApplyCandidate, toResearchUrl }: DescriptionCandidatesProps) {
  return <Card size="small" className="form-section exif-form-card" title={<Tooltip title="可以跳过直接入库，也可以生成候选描述后选一版写回当前图片。" placement="topLeft" trigger={["hover", "focus"]}><span className="exif-section-title" tabIndex={0}><Sparkles size={16} strokeWidth={1.8} aria-hidden="true" /><span>AI 补充描述（可选）</span></span></Tooltip>}>
    <div className="form-section-body">
      <div className="upload-actions exif-model-actions"><Button htmlType="button" type="primary" onClick={onGenerate} disabled={generating}>生成描述</Button>{item.descriptionMeta ? <p className="muted">{item.descriptionMeta}</p> : null}</div>
      {generating ? <LiveProgress progress={progress} researchSummary={researchSummary} providers={liveProviders} /> : null}
      <div className="exif-model-grid">{item.candidates.map((candidate) => <CandidateCard key={`${candidate.provider}-${candidate.model}`} candidate={candidate} item={item} onReviewClaim={onReviewClaim} onToggleTag={onToggleTag} onApplyCandidate={onApplyCandidate} toResearchUrl={toResearchUrl} />)}</div>
      {item.unavailableProviders.length > 0 ? <p className="muted">未配置模型：{item.unavailableProviders.join(" / ")}</p> : null}
    </div>
  </Card>
}
