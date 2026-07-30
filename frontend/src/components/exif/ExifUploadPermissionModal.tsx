import { Button, Modal } from "antd"

type ExifUploadPermissionModalProps = {
  open: boolean
  recentUploadedCount: number
  bindingDirectory: boolean
  onClose: () => void
  onAuthorize: () => Promise<void> | void
}

export function ExifUploadPermissionModal({
  open,
  recentUploadedCount,
  bindingDirectory,
  onClose,
  onAuthorize,
}: ExifUploadPermissionModalProps) {
  return <Modal
    title="图片已读取，继续授权原文件"
    open={open}
    centered
    width={520}
    destroyOnHidden
    onCancel={onClose}
    footer={[
      <Button
        key="later"
        htmlType="button"
        onClick={onClose}
      >
        稍后授权
      </Button>,
      <Button
        key="authorize"
        htmlType="button"
        type="primary"
        loading={bindingDirectory}
        onClick={() => void onAuthorize()}
      >
        选择原文件夹并授权
      </Button>,
    ]}
  >
    <div className="exif-upload-permission">
      <p>
        已读取 {recentUploadedCount} 张图片。为了在保存入库时同时修改本地文件名和 EXIF，
        请继续选择这些照片所在的文件夹，并允许浏览器读写。
      </p>
      <div className="exif-upload-permission-note">
        刚才选择图片只授予了读取权限，这是浏览器要求的原文件写入确认。系统只会绑定当前队列里的同名照片，不会把文件夹中的其他图片加入队列。
      </div>
    </div>
  </Modal>
}
