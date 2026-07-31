import { useCallback } from "react"
import { assertWrittenExif, changedParts, toNullableNumber } from "./exifFormDomain"
import { cloneFormState } from "./exifWorkbenchFormState"
import { confirmPreviouslySubmittedItem, confirmSubmittedSourceHash, postFormDataWithProgress, waitForRetry } from "./exifSubmissionRecovery"
import { verifyWritablePermission } from "./exifArtifactLookup"
import type { ArtifactSubmitResult, ExifWorkbenchItem, ImageExifMetadata, SubmitNotice, WritableDirectoryHandle } from "../components/types"

type FetchJson = <T>(input: string, init?: RequestInit) => Promise<T>

type SubmitOptions = {
  apiBaseUrl: string
  directoryHandle: WritableDirectoryHandle | null
  itemsRef: { current: ExifWorkbenchItem[] }
  updateItem: (itemId: string, updater: (item: ExifWorkbenchItem) => ExifWorkbenchItem) => void
  setNotice: (notice: SubmitNotice) => void
  clearHistory: () => void
  fetchJson: FetchJson
  responseErrorMessage: (response: Response, prefix?: string) => Promise<string>
}

export function useExifSubmitOne({
  apiBaseUrl,
  directoryHandle,
  itemsRef,
  updateItem,
  setNotice,
  clearHistory,
  fetchJson,
  responseErrorMessage,
}: SubmitOptions) {
  return useCallback(async (itemId: string): Promise<boolean> => {
      // Read the latest form snapshot at click time. Filename parsing and other
      // async updates must never cause a stale render closure to submit older
      // name or excavation values after the operator has corrected them.
      const target = itemsRef.current.find((item) => item.id === itemId)
      if (!target) {
        return false
      }
      if (target.submitState === "submitted" && changedParts(target).length === 0) {
        setNotice({ type: "success", text: "该图片已入库且没有新的修改，无需重复提交。" })
        clearHistory()
        return true
      }
      if (await confirmPreviouslySubmittedItem(apiBaseUrl, target)) {
        updateItem(itemId, (item) => ({
          ...item,
          submitState: "submitted",
          submitMessage: "已从云端确认这张图片完成入库。",
          uploadProgress: 100,
          uploadStage: "已完成",
          originalForm: cloneFormState(item.form),
        }))
        clearHistory()
        return true
      }
      if (!target.form.name.trim() || !target.form.museumName.trim()) {
        updateItem(itemId, (item) => ({
          ...item,
          submitState: "error",
          submitMessage: "请先确认名称和馆藏信息",
        }))
        return false
      }
      if (!target.fileHandle && !directoryHandle) {
        updateItem(itemId, (item) => ({
          ...item,
          submitState: "error",
          submitMessage: "提交前请先点击图片列表上方的文件夹按钮并授权原文件；保存并入库会同时修改本地文件名和 EXIF。",
        }))
        return false
      }
      if (target.fileName !== target.originalFileName && !directoryHandle) {
        updateItem(itemId, (item) => ({
          ...item,
          submitState: "error",
          submitMessage: "目标文件名已修改，请先点击图片列表上方的文件夹按钮授权原文件，才能在本地完成重命名。",
        }))
        return false
      }
    
      updateItem(itemId, (item) => ({ ...item, submitState: "submitting", submitMessage: null, uploadProgress: 8, uploadStage: "正在准备 EXIF 信息" }))
      try {
        // A retry click is a fresh user gesture, so request write permission
        // before any network request can consume that activation.
        let sourceHandle = target.fileHandle
        if (directoryHandle) {
          if (!await verifyWritablePermission(directoryHandle)) {
            throw new Error("文件夹写入权限未授权，请重新选择照片文件夹")
          }
          // A directory grant is authoritative for its children. Reacquire the
          // current child handle here instead of incorrectly demanding a second
          // independent permission prompt for a file already imported from it.
          try {
            sourceHandle = await directoryHandle.getFileHandle(target.originalFileName)
          } catch (error) {
            if ((error as Error).name !== "NotFoundError" || target.fileName === target.originalFileName) throw error
            // A prior attempt may have already completed the local rename.
            sourceHandle = await directoryHandle.getFileHandle(target.fileName)
          }
        } else if (sourceHandle && !await verifyWritablePermission(sourceHandle)) {
          throw new Error(`“${target.originalFileName}”的写入权限未授权，请点击图片列表上方的文件夹按钮重新授权`)
        }
        if (!sourceHandle) throw new Error("未找到可写原文件，请授权照片文件夹")
    
        const latestLocalFile = await sourceHandle.getFile()
        const latitude = toNullableNumber(target.form.latitude)
        const longitude = toNullableNumber(target.form.longitude)
        const appendMetadata = (data: FormData, includeArtifactLink = false) => {
          data.append("museum_name", target.form.museumName.trim())
          data.append("name", target.form.name.trim())
          data.append("era", target.form.era.trim() || "")
          data.append("Place_of_Excavation", target.form.placeOfExcavation.trim() || "")
          data.append("description", target.form.description.trim() || "")
          data.append("display_location_name", target.form.displayLocationName.trim() || "")
          data.append("exhibition_name", target.form.exhibitionName.trim() || "常设")
          if (target.form.catalogExhibitionSourceId) {
            data.append("catalog_exhibition_source_id", target.form.catalogExhibitionSourceId)
          }
          if (target.form.catalogExhibitionId !== null) {
            data.append("catalog_exhibition_id", String(target.form.catalogExhibitionId))
          }
          if (latitude !== null) data.append("latitude", String(latitude))
          if (longitude !== null) data.append("longitude", String(longitude))
          data.append("camera_model", target.form.cameraModel.trim())
          data.append("lens_model", target.form.lensModel.trim())
          if (target.form.capturedAt.trim()) data.append("captured_at", target.form.capturedAt.trim())
          data.append("shutter_speed", target.form.shutterSpeed.trim())
          data.append("aperture", target.form.aperture.trim())
          if (target.form.iso.trim()) data.append("iso", target.form.iso.trim())
          if (includeArtifactLink && target.existingArtifactId != null) {
            data.append("existing_artifact_id", String(target.existingArtifactId))
          }
        }
    
        let response: Response | null = null
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const useCleanExif = attempt === 3
          updateItem(itemId, (item) => ({
            ...item,
            uploadProgress: 13 + attempt * 3,
            uploadStage: useCleanExif
              ? "正在使用兼容模式重建 EXIF（第 3/3 次）"
              : `正在生成最终 EXIF 图片（第 ${attempt}/3 次）`,
          }))
          const exifForm = new FormData()
          exifForm.append("file", latestLocalFile)
          appendMetadata(exifForm)
          if (useCleanExif) exifForm.append("clean_exif", "true")
          response = await fetch(`${apiBaseUrl}/api/artifacts/prepare-exif-file`, {
            method: "POST",
            body: exifForm,
          })
          if (response.ok) break
    
          const message = await responseErrorMessage(response, "本地 EXIF 回写准备失败")
          if (attempt === 3) throw new Error(`已重试 3 次，${message}`)
          await waitForRetry(350 * attempt)
        }
        if (!response?.ok) throw new Error("本地 EXIF 回写准备失败")
        const sourceHash = response.headers.get("X-Source-Hash")
        const cleanRewriteUsed = response.headers.get("X-Exif-Rewrite-Mode") === "clean"
        const editedBlob = await response.blob()
        updateItem(itemId, (item) => ({ ...item, sourceHash: sourceHash || item.sourceHash }))
    
        let resolvedWriteHandle = sourceHandle
        if (directoryHandle && target.fileName !== target.originalFileName) {
          try {
            // A previous attempt may have completed the local rename and only
            // failed during cloud submission. Reuse and overwrite that target
            // instead of treating it as a duplicate.
            resolvedWriteHandle = await directoryHandle.getFileHandle(target.fileName)
          } catch (error) {
            if ((error as Error).name !== "NotFoundError") throw error
            resolvedWriteHandle = await directoryHandle.getFileHandle(target.fileName, { create: true })
          }
        } else if (!await verifyWritablePermission(resolvedWriteHandle)) {
          throw new Error(`“${target.originalFileName}”的写入权限已失效，请点击图片列表上方的文件夹按钮重新授权`)
        }
    
        updateItem(itemId, (item) => ({ ...item, uploadProgress: 30, uploadStage: "正在改名并写回本地原图" }))
        const writable = await resolvedWriteHandle.createWritable()
        await writable.write(editedBlob)
        await writable.close()
        if (directoryHandle && target.fileName !== target.originalFileName) {
          try {
            await directoryHandle.removeEntry(target.originalFileName)
          } catch (error) {
            // Retrying after a successful local rename is normal: the old source
            // name has already disappeared, while the target file is durable.
            if ((error as Error).name !== "NotFoundError") throw error
          }
        }
    
        const writtenFile = await resolvedWriteHandle.getFile()
        if (writtenFile.name !== target.fileName || writtenFile.size !== editedBlob.size) {
          throw new Error("本地图片写入校验失败，已停止云端提交")
        }
        const verifyForm = new FormData()
        verifyForm.append("file", writtenFile)
        const writtenMetadata = await fetchJson<ImageExifMetadata>(`${apiBaseUrl}/api/artifacts/extract-exif-file`, {
          method: "POST",
          body: verifyForm,
        })
        assertWrittenExif(writtenMetadata, target.form)
        const uploadFile = new File([writtenFile], target.fileName, {
          type: editedBlob.type || target.localFile.type,
          lastModified: writtenFile.lastModified,
        })
    
        // The local save is already durable at this point. Keep the refreshed
        // handle and filename even if the subsequent cloud request fails, so a
        // retry does not look for the deleted pre-rename file.
        updateItem(itemId, (item) => ({
          ...item,
          localFile: uploadFile,
          fileHandle: resolvedWriteHandle,
          originalFileName: item.fileName,
          originalForm: cloneFormState(item.form),
        }))
    
        updateItem(itemId, (item) => ({ ...item, uploadProgress: 45, uploadStage: "正在上传 OSS 并写入档案" }))
    
        const formData = new FormData()
        formData.append("file", uploadFile)
        appendMetadata(formData, true)
        formData.append("tags", JSON.stringify(target.form.tags))
        formData.append("exif_prepared", "true")
        if (sourceHash) formData.append("source_hash", sourceHash)
        let result: ArtifactSubmitResult | null = null
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            updateItem(itemId, (item) => ({
              ...item,
              uploadStage: `正在上传 OSS 并写入档案（第 ${attempt}/3 次）`,
            }))
            result = await postFormDataWithProgress<ArtifactSubmitResult>(
              `${apiBaseUrl}/api/artifacts/exif-submit-file`,
              formData,
              (progress) => {
                updateItem(itemId, (item) => ({
                  ...item,
                  uploadProgress: progress,
                  uploadStage: progress >= 95
                    ? "图片已上传，正在等待云端入库确认"
                    : `正在上传 OSS 并写入档案（第 ${attempt}/3 次）`,
                }))
              },
            )
            break
          } catch (error) {
            if (sourceHash && await confirmSubmittedSourceHash(apiBaseUrl, sourceHash)) {
              result = {
                reconciled_after_timeout: true,
                duplicate_image_detail: "云端已确认这张图片完成入库。",
              }
              break
            }
            if (attempt === 3) {
              const message = error instanceof Error ? error.message : "未知错误"
              throw new Error(`云端提交已重试 3 次：${message}`, { cause: error })
            }
            await waitForRetry(700 * attempt)
          }
        }
        if (!result) throw new Error("云端提交失败")
        updateItem(itemId, (item) => ({
          ...item,
          localFile: uploadFile,
          fileHandle: resolvedWriteHandle,
          originalFileName: item.fileName,
          originalForm: cloneFormState(item.form),
          submitState: "submitted",
          submitMessage: result.reconciled_after_timeout
            ? (result.duplicate_image_detail || "云端已确认这张图片完成入库。")
            : result.duplicate_image_replaced
            ? (result.duplicate_image_detail || "已用本次校正覆盖云端已有图片。")
            : result.duplicate_image_skipped
            ? (result.duplicate_image_detail || "云端已存在相同原图，本次未重复上传。")
            : cleanRewriteUsed
              ? "已通过兼容模式重建 EXIF，并同步上传 OSS 与云端数据库"
              : "已修改本地文件名与 EXIF，并同步上传 OSS 与云端数据库",
          uploadProgress: 100,
          uploadStage: "已完成",
        }))
        clearHistory()
        return true
      } catch (error) {
        updateItem(itemId, (item) => ({
          ...item,
          submitState: "error",
          submitMessage: error instanceof Error ? error.message : "提交失败",
          uploadStage: "提交失败",
        }))
        return false
      }
  }, [apiBaseUrl, clearHistory, directoryHandle, fetchJson, itemsRef, responseErrorMessage, setNotice, updateItem])
}
