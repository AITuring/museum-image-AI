import { Button } from "antd"

type Notice = { type: "success" | "error"; text: string }

export function BatchSubmitNotice({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  if (!notice) return null
  return <div className={`submit-toast ${notice.type}`}><div className="submit-toast-body"><strong>{notice.type === "error" ? "操作失败" : "操作成功"}</strong><p>{notice.text}</p></div><Button htmlType="button" type="text" shape="circle" aria-label="关闭提交提示" onClick={onClose}>×</Button></div>
}
