import { Button, Modal, Tag } from "antd"
import type { ExistingArtifactMatch, ExifWorkbenchItem } from "./types"

type ExifArtifactReviewModalProps = {
  apiBaseUrl: string
  item: ExifWorkbenchItem | null
  pendingCount: number
  onRejectMatches: () => void
  onSelectMatch: (match: ExistingArtifactMatch) => void
}

export function ExifArtifactReviewModal({
  apiBaseUrl,
  item,
  pendingCount,
  onRejectMatches,
  onSelectMatch,
}: ExifArtifactReviewModalProps) {
  return <Modal
    title="发现可能对应的已入库文物"
    open={item !== null}
    centered
    width={780}
    closable={false}
    mask={{ closable: false }}
    keyboard={false}
    destroyOnHidden
    footer={[
      <Button key="new" htmlType="button" onClick={onRejectMatches}>
        都不是，按新文物填写
      </Button>,
    ]}
  >
    {item ? (
      <div className="artifact-match-review">
        <div className="artifact-match-review-intro">
          <div>
            <span>当前上传</span>
            <strong>{item.fileName}</strong>
          </div>
          <Tag color="processing">
            {pendingCount > 1 ? `还有 ${pendingCount} 张待确认` : "请选择对应文物"}
          </Tag>
        </div>
        <p className="muted">
          选择后会填入已有文物的名称、馆藏、时代、描述和标签，并把这张新照片追加到该文物；新照片自己的相机参数和拍摄时间不会被覆盖。
        </p>
        <div className="artifact-match-candidates">
          {(item.existingArtifactCandidates ?? []).map((match) => {
            const cover = match.artifact.images[0]
            const previewUrl = cover
              ? `${apiBaseUrl}/api/image-variant?${new URLSearchParams({ url: cover.url, size: "360" }).toString()}`
              : ""
            return (
              <button
                key={match.artifact.id}
                type="button"
                className="artifact-match-candidate"
                onClick={() => onSelectMatch(match)}
              >
                <span className="artifact-match-thumb">
                  {cover ? (
                    <img
                      src={previewUrl}
                      alt={match.artifact.name}
                      onError={(event) => {
                        event.currentTarget.onerror = null
                        event.currentTarget.src = cover.url
                      }}
                    />
                  ) : <span>无图</span>}
                </span>
                <span className="artifact-match-copy">
                  <strong>{match.artifact.name}</strong>
                  <span>{match.artifact.era || "时代未填写"} · {match.artifact.museum_name}</span>
                  <small>{match.match_reason}</small>
                  {match.artifact.description ? <p>{match.artifact.description}</p> : null}
                  <span className="artifact-match-tags">
                    {match.artifact.tags
                      .filter((tag) => !/^(机型|镜头)\s*[:：]/.test(tag))
                      .slice(0, 6)
                      .map((tag) => <Tag key={tag}>{tag}</Tag>)}
                  </span>
                  <b>选择并填入这件文物</b>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    ) : null}
  </Modal>
}
