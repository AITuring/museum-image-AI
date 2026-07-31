import type { ReactNode } from "react"
import { Modal } from "antd"

type WorkbenchModalProps = {
  open: boolean
  title: ReactNode
  onCancel: () => void
  footer?: ReactNode
  children: ReactNode
  width?: number
}

export function WorkbenchModal({ open, title, onCancel, footer, children, width = 760 }: WorkbenchModalProps) {
  return <Modal open={open} title={title} width={width} destroyOnHidden onCancel={onCancel} footer={footer}>{children}</Modal>
}
