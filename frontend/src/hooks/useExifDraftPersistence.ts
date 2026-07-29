import { useEffect, useRef, useState } from "react"
import { clearExifDraft, readExifDraft, writeExifDraft } from "../lib/exifDraftStore"
import { changedParts } from "../lib/exifFormDomain"
import { cloneFormState } from "../lib/exifWorkbenchFormState"
import { restoreExifDraftItems, serializeExifDraftItem, writeReuploadHints } from "../lib/exifDraftRecovery"
import type { ExifWorkbenchItem, FormState, SubmitNotice } from "../components/exif/types"

type FetchJson = <T>(input: string, init?: RequestInit) => Promise<T>
type Options = { apiBaseUrl: string; items: ExifWorkbenchItem[]; selectedId: string | null; sharedForm: FormState; setItems: (items: ExifWorkbenchItem[]) => void; setSelectedId: (id: string | null) => void; setSharedForm: (form: FormState) => void; setNotice: (notice: SubmitNotice) => void; fetchJson: FetchJson; revokePreviewUrl: (url: string) => void }
export function useExifDraftPersistence({ apiBaseUrl, items, selectedId, sharedForm, setItems, setSelectedId, setSharedForm, setNotice, fetchJson, revokePreviewUrl }: Options) {
  const [ready, setReady] = useState(false); const timerRef = useRef<number | null>(null); const failureRef = useRef(false)
  useEffect(() => { let disposed = false; void (async () => { try { await navigator.storage?.persist?.(); const draft = await readExifDraft(); if (disposed || !draft || draft.version !== 1 || draft.items.length === 0) return; const restored = await restoreExifDraftItems(draft.items, apiBaseUrl, fetchJson); if (disposed) { restored.forEach((item) => revokePreviewUrl(item.previewUrl)); return }; setItems(restored); setSelectedId(restored.some((item) => item.id === draft.selectedId) ? draft.selectedId : restored[0]?.id ?? null); setSharedForm(cloneFormState(draft.sharedForm)); setNotice({ type: "success", text: `已恢复 ${restored.length} 张未提交图片的本地草稿；如需回写原文件，请重新授权照片文件夹。` }) } catch { if (!disposed) setNotice({ type: "error", text: "本地草稿无法恢复；请重新添加图片。" }) } finally { if (!disposed) setReady(true) } })(); return () => { disposed = true } }, [])
  useEffect(() => { if (!ready) return; if (timerRef.current !== null) window.clearTimeout(timerRef.current); const pending = items.filter((item) => item.submitState !== "submitted" || changedParts(item).length > 0); timerRef.current = window.setTimeout(() => { const persist = pending.length > 0 ? writeExifDraft({ version: 1, items: pending.map(serializeExifDraftItem), selectedId: pending.some((item) => item.id === selectedId) ? selectedId : pending[0]?.id ?? null, sharedForm: cloneFormState(sharedForm) }) : clearExifDraft(); void Promise.all([persist, writeReuploadHints(items)]).then(() => { failureRef.current = false }).catch(() => { if (failureRef.current) return; failureRef.current = true; setNotice({ type: "error", text: "本地草稿存储空间不足，未提交内容仍保留在当前页面；请先完成部分入库或清理浏览器站点数据。" }) }) }, 650); return () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) } }, [ready, items, selectedId, sharedForm])
  return ready
}
