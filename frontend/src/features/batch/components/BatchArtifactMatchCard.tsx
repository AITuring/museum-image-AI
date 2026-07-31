import { Button, Tag } from "antd"
import type { ExistingArtifactMatch, PendingArtifact } from "../lib/batchDomain"

type Props = {
  apiBaseUrl: string
  item: PendingArtifact
  matchedArtifact: ExistingArtifactMatch
  sameArtifactDecision: "yes" | "no" | null
  onConfirmSameArtifact: (item: PendingArtifact, matchedArtifact: ExistingArtifactMatch) => void
  onRejectSameArtifact: (item: PendingArtifact) => void
}

export function BatchArtifactMatchCard({
  apiBaseUrl,
  item,
  matchedArtifact,
  sameArtifactDecision,
  onConfirmSameArtifact,
  onRejectSameArtifact,
}: Props) {
  return (
    <section className="backend-match-card">
      <div className="backend-match-head">
        <div>
          <h3>后端疑似同一件</h3>
          <p className="muted">
            {matchedArtifact.match_reason} 匹配度 {Math.round(matchedArtifact.match_score * 100)}%
          </p>
        </div>
        <span className="backend-match-count">{matchedArtifact.artifact.images.length} 张历史图片</span>
      </div>
      <div className="backend-match-meta">
        <span>名称：{matchedArtifact.artifact.name}</span>
        <span>时代：{matchedArtifact.artifact.era || "待确认"}</span>
        <span>馆藏：{matchedArtifact.artifact.museum_name}</span>
      </div>
      {matchedArtifact.artifact.tags.length > 0 ? (
        <div className="tag-row">
          {matchedArtifact.artifact.tags.map((tag) => (
            <Tag key={`batch-match-tag-${item.id}-${tag}`}>{tag}</Tag>
          ))}
        </div>
      ) : null}
      {matchedArtifact.artifact.description ? (
        <p className="result-desc">{matchedArtifact.artifact.description}</p>
      ) : (
        <p className="muted small">库中这条记录暂无描述。</p>
      )}
      {matchedArtifact.artifact.images.length > 0 ? (
        <div className="existing-artifact-gallery">
          {matchedArtifact.artifact.images.map((image) => (
            <a
              key={image.id}
              href={`${apiBaseUrl}${image.url}`}
              target="_blank"
              rel="noreferrer"
              className="existing-artifact-thumb"
            >
              <img src={`${apiBaseUrl}${image.url}`} alt={matchedArtifact.artifact.name} loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      <div className="backend-match-actions">
        <Button
          htmlType="button"
          type="primary"
          size="small"
          onClick={() => onConfirmSameArtifact(item, matchedArtifact)}
        >
          是同一件
        </Button>
        <Button
          htmlType="button"
          type={sameArtifactDecision === "no" ? "primary" : "text"}
          onClick={() => onRejectSameArtifact(item)}
        >
          不是同一件
        </Button>
      </div>
      {sameArtifactDecision === "yes" ? (
        <p className="success-text">提交时会直接更新这条已有文物，并把当前图片作为新图追加。</p>
      ) : sameArtifactDecision === "no" ? (
        <p className="muted small">已按“不是同一件”处理，提交时会新建文物记录。</p>
      ) : (
        <p className="muted small">如不手动处理，提交时也会优先合并到这条已有文物，避免重复建档。</p>
      )}
    </section>
  )
}
