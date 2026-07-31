import type { Dispatch, MutableRefObject, SetStateAction } from "react"
import { applySharedForm, ensureCandidates, ensureStringList, fileBaseName, normalizeVerifiedClaims, uniqueTags } from "../lib/exifFormDomain"
import { cloneFormState } from "../lib/exifWorkbenchFormState"
import { patchWorkbenchItemForm, replaceWorkbenchItemForm } from "../lib/exifWorkbenchItemMutations"
import type { DescriptionCandidate, ExifWorkbenchItem, FormState, GeneratedDescription, LiveProviderState, SubmitNotice, VerifiedClaim } from "../components/types"

type ItemChange = { label: string; detail: string; nextItems: ExifWorkbenchItem[]; affected: string[] }

type Options = {
  apiBaseUrl: string
  items: ExifWorkbenchItem[]
  itemsRef: MutableRefObject<ExifWorkbenchItem[]>
  selectedItem: ExifWorkbenchItem | null
  sharedForm: FormState
  setSharedForm: Dispatch<SetStateAction<FormState>>
  setGenerating: Dispatch<SetStateAction<boolean>>
  setGeneratingIds: Dispatch<SetStateAction<string[]>>
  setProgress: Dispatch<SetStateAction<string[]>>
  setResearchSummary: Dispatch<SetStateAction<string>>
  setProviders: Dispatch<SetStateAction<Record<string, LiveProviderState>>>
  setNotice: Dispatch<SetStateAction<SubmitNotice | null>>
  updateSelectedForm: (patch: Partial<FormState>) => void
  recordItemsChange: (change: ItemChange) => unknown
  recordSharedDescription: (nextItems: ExifWorkbenchItem[], nextSharedForm: FormState, generated: GeneratedDescription) => void
}

export function useExifDescriptionOperations({
  apiBaseUrl, items, itemsRef, selectedItem, sharedForm, setSharedForm,
  setGenerating, setGeneratingIds, setProgress, setResearchSummary, setProviders, setNotice,
  updateSelectedForm, recordItemsChange, recordSharedDescription,
}: Options) {
  async function generateDescription(target: "selected" | "shared" = "selected") {
    if (!selectedItem) return
    const isSharedTarget = target === "shared"
    const fallbackName = selectedItem.parsedName?.artifact_name || fileBaseName(selectedItem.fileName)
    const targetForm = isSharedTarget ? sharedForm : selectedItem.form
    const targetIds = isSharedTarget ? items.map((item) => item.id) : [selectedItem.id]
    const resolvedForm = targetForm.name.trim() ? targetForm : { ...targetForm, name: fallbackName }
    if (!resolvedForm.name.trim()) return
    if (!targetForm.name.trim()) {
      if (isSharedTarget) setSharedForm((current) => ({ ...current, name: resolvedForm.name }))
      else updateSelectedForm({ name: resolvedForm.name })
    }
    setGenerating(true); setGeneratingIds((current) => Array.from(new Set([...current, ...targetIds])))
    setProgress(["正在整理名称、年代、博物馆与出土地点…"]); setResearchSummary(""); setProviders({}); setNotice(null)
    try {
      const form = new FormData()
      form.append("museum_name", resolvedForm.museumName.trim()); form.append("name", resolvedForm.name.trim())
      form.append("era", resolvedForm.era.trim()); form.append("Place_of_Excavation", resolvedForm.placeOfExcavation.trim())
      const response = await fetch(`${apiBaseUrl}/api/artifacts/generate-description-stream-file`, { method: "POST", body: form })
      if (!response.ok || !response.body) throw new Error(`生成描述失败（HTTP ${response.status}）`)
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ""; let generated: GeneratedDescription | null = null
      while (true) {
        const { value, done } = await reader.read(); if (done) break
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split("\n"); pending = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const event = JSON.parse(line.slice(5).trim()) as { type: string; message?: string; result?: GeneratedDescription; provider?: string; model?: string; reasoning?: string; summary?: string; description_length?: number; tag_count?: number }
          if ((event.type === "progress" || event.type === "research_start") && event.message) setProgress((current) => current.includes(event.message!) ? current : [...current, event.message!])
          if (event.type === "research_complete") { if (event.message) setProgress((current) => current.includes(event.message!) ? current : [...current, event.message!]); setResearchSummary(event.summary || "") }
          if (event.type === "provider_start" && event.provider) setProviders((current) => ({ ...current, [event.provider!]: { model: event.model || "", status: "running", reasoning: "", message: "正在阅读检索证据并组织描述…", descriptionLength: 0, tagCount: 0 } }))
          if (event.type === "provider_complete" && event.provider) setProviders((current) => ({ ...current, [event.provider!]: { model: event.model || current[event.provider!]?.model || "", status: "complete", reasoning: event.reasoning || "", message: "核验摘要与候选描述已返回", descriptionLength: event.description_length || 0, tagCount: event.tag_count || 0 } }))
          if (event.type === "provider_error" && event.provider) setProviders((current) => ({ ...current, [event.provider!]: { model: event.model || current[event.provider!]?.model || "", status: "error", reasoning: "", message: event.message || "模型调用失败", descriptionLength: 0, tagCount: 0 } }))
          if (event.type === "result" && event.result) generated = event.result
        }
      }
      if (!generated) throw new Error("模型未返回可用结果")
      const candidates = ensureCandidates(generated.candidates)
      const description = candidates.find((candidate) => candidate.provider === generated!.provider && candidate.model === generated!.model && candidate.status === "success")?.description ?? normalizeVerifiedClaims(generated.description, []).description
      const unavailableProviders = ensureStringList(generated.unavailable_providers)
      const meta = `${isSharedTarget ? "共享描述采用" : "默认采用"}：${generated.provider} / ${generated.model}${generated.research_id ? ` · 研究 ${generated.research_id.slice(0, 8)}` : ""}`
      if (isSharedTarget) {
        const nextSharedForm = { ...cloneFormState(resolvedForm), description, tags: [...resolvedForm.tags] }
        const nextItems = itemsRef.current.map((item) => ({
          ...replaceWorkbenchItemForm(item, applySharedForm(item.form, nextSharedForm)),
          candidates,
          unavailableProviders,
          descriptionMeta: meta,
          verificationDecisions: {},
        }))
        recordSharedDescription(nextItems, nextSharedForm, generated)
        setNotice({ type: "success", text: `已根据共享字段并行请求千问和豆包，并把完整描述应用到 ${nextItems.length} 张图片` })
      } else {
        const nextItems = itemsRef.current.map((item) => item.id === selectedItem.id
          ? {
              ...patchWorkbenchItemForm(item, { description, tags: [...item.form.tags] }),
              candidates,
              unavailableProviders,
              descriptionMeta: meta,
              verificationDecisions: {},
            }
          : item)
        recordItemsChange({ label: "生成文物描述", detail: `${selectedItem.fileName} · ${generated.provider} / ${generated.model}`, nextItems, affected: [selectedItem.fileName] })
        setNotice({ type: "success", text: "已根据名称、年代、博物馆与出土地点生成完整描述" })
      }
    } catch (error) { setNotice({ type: "error", text: error instanceof Error ? error.message : "生成描述失败" }) }
    finally { setGenerating(false); const complete = new Set(targetIds); setGeneratingIds((current) => current.filter((id) => !complete.has(id))) }
  }

  function applyCandidate(candidate: DescriptionCandidate) {
    if (!selectedItem || candidate.status !== "success") return
    const nextItems = itemsRef.current.map((item) => item.id === selectedItem.id
      ? {
          ...patchWorkbenchItemForm(item, { description: candidate.description, tags: [...item.form.tags] }),
          descriptionMeta: `当前采用：${candidate.provider} / ${candidate.model}`,
        }
      : item)
    recordItemsChange({ label: "切换描述版本", detail: `${selectedItem.fileName} · ${candidate.provider} / ${candidate.model}`, nextItems, affected: [selectedItem.fileName] })
    setNotice({ type: "success", text: `已采用 ${candidate.provider} 的描述；标签仍可跨模型单独点选` })
  }

  function toggleCandidateTag(tag: string) {
    if (!selectedItem) return
    updateSelectedForm({ tags: selectedItem.form.tags.includes(tag) ? selectedItem.form.tags.filter((entry) => entry !== tag) : uniqueTags([...selectedItem.form.tags, tag]) })
  }

  function reviewVerifiedClaim(claim: VerifiedClaim, decision: "accepted" | "rejected") {
    if (!selectedItem) return
    const nextItems = itemsRef.current.map((item) => {
      if (item.id !== selectedItem.id) return item
      const withoutClaim = item.form.description.replace(claim.text, "").replace(/\n{3,}/g, "\n\n").trim()
      const description = decision === "accepted" ? [withoutClaim, claim.text].filter(Boolean).join(withoutClaim ? "\n\n" : "") : withoutClaim
      return { ...item, form: { ...item.form, description }, verificationDecisions: { ...(item.verificationDecisions ?? {}), [claim.text]: decision } }
    })
    recordItemsChange({ label: decision === "accepted" ? "采纳核验内容" : "移除核验内容", detail: `${selectedItem.fileName} · ${claim.text.slice(0, 32)}${claim.text.length > 32 ? "…" : ""}`, nextItems, affected: [selectedItem.fileName] })
    setNotice({ type: "success", text: decision === "accepted" ? "已将这条联网核验内容加入最终正文" : "已从最终正文移除这条联网核验内容" })
  }
  return { generateDescription, applyCandidate, toggleCandidateTag, reviewVerifiedClaim }
}
