import type {
  ExistingArtifact,
  ExistingArtifactMatch,
  FormState,
  MuseumOption,
  ParsedArtifactName,
  WritableDirectoryHandle,
  WritableFileHandle,
} from "../components/types"

const IMAGE_FILE_PATTERN = /\.(?:jpe?g|png|webp|tiff?)$/i

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    let detail = "HTTP " + response.status
    try { detail = ((await response.json()) as { detail?: string }).detail || detail } catch { /* retain HTTP fallback */ }
    throw new Error(detail)
  }
  return (await response.json()) as T
}

export async function loadMuseumSuggestions(
  apiBaseUrl: string,
  keyword: string,
  setter: (items: MuseumOption[]) => void,
) {
  try {
    const params = new URLSearchParams({ limit: "8" })
    if (keyword) {
      params.set("q", keyword)
    }
    const items = await fetchJson<MuseumOption[]>(`${apiBaseUrl}/api/museums?${params.toString()}`)
    setter(items)
  } catch {
    setter([])
  }
}

export async function verifyWritablePermission(handle: WritableFileHandle | WritableDirectoryHandle) {
  const descriptor = { mode: "readwrite" as const }
  try {
    if (await handle.queryPermission?.(descriptor) === "granted") return true
    if (await handle.requestPermission?.(descriptor) === "granted") return true
    return !handle.queryPermission && !handle.requestPermission
  } catch {
    return false
  }
}

export async function listDirectoryImageEntries(handle: WritableDirectoryHandle) {
  const entries: Array<{ handle: WritableFileHandle; file: File }> = []
  for await (const entry of handle.values()) {
    if (entry.kind === "directory" || !IMAGE_FILE_PATTERN.test(entry.name)) continue
    const fileHandle = entry as WritableFileHandle
    entries.push({ handle: fileHandle, file: await fileHandle.getFile() })
  }
  return entries.sort((left, right) => left.file.name.localeCompare(right.file.name, "zh-CN"))
}

export async function resolveMuseum(apiBaseUrl: string, name: string): Promise<MuseumOption | null> {
  const items = await fetchJson<MuseumOption[]>(
    `${apiBaseUrl}/api/museums?${new URLSearchParams({ q: name, limit: "8" }).toString()}`,
  )
  const exact = items.find((item) => item.name === name)
  return exact ?? items[0] ?? null
}

export async function parseArtifactName(apiBaseUrl: string, name: string): Promise<ParsedArtifactName> {
  return fetchJson<ParsedArtifactName>(
    `${apiBaseUrl}/api/artifacts/parse-name?${new URLSearchParams({ name }).toString()}`,
  )
}

export async function searchExistingArtifactsByName(
  apiBaseUrl: string,
  name: string,
  limit = 8,
): Promise<ExistingArtifact[]> {
  return fetchJson<ExistingArtifact[]>(
    `${apiBaseUrl}/api/artifacts?${new URLSearchParams({
      q: name,
      limit: String(limit),
    }).toString()}`,
  )
}

export async function lookupExistingArtifact(
  apiBaseUrl: string,
  form: FormState,
): Promise<ExistingArtifactMatch | null> {
  if (!form.name.trim() || !form.museumName.trim() || !form.era.trim()) return null
  const params = new URLSearchParams({
    name: form.name.trim(),
    museum_name: form.museumName.trim(),
    era: form.era.trim(),
  })
  try {
    return await fetchJson<ExistingArtifactMatch | null>(
      `${apiBaseUrl}/api/artifacts/match?${params.toString()}`,
    )
  } catch {
    return null
  }
}

export function compactArtifactIdentity(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}_]+/gu, "")
}

export function artifactReviewIdentityKey(form: FormState) {
  if (!form.name.trim() || !form.museumName.trim() || !form.era.trim()) return ""
  return [
    compactArtifactIdentity(form.name),
    compactArtifactIdentity(form.museumName),
    compactArtifactIdentity(form.era),
  ].join("|")
}

export async function lookupExistingArtifactCandidates(
  apiBaseUrl: string,
  form: FormState,
): Promise<ExistingArtifactMatch[]> {
  if (!form.name.trim() || !form.museumName.trim() || !form.era.trim()) return []
  const params = new URLSearchParams({
    q: form.name.trim(),
    era: form.era.trim(),
  })
  const [bestMatch, searchResults] = await Promise.all([
    lookupExistingArtifact(apiBaseUrl, form),
    fetchJson<ExistingArtifact[]>(`${apiBaseUrl}/api/artifacts?${params.toString()}`).catch(() => []),
  ])
  const normalizedMuseum = compactArtifactIdentity(form.museumName)
  const normalizedEra = compactArtifactIdentity(form.era)
  const normalizedName = compactArtifactIdentity(form.name)
  const candidates = new Map<string, ExistingArtifactMatch>()
  const candidateIdentity = (artifact: ExistingArtifact) => [
    compactArtifactIdentity(artifact.name),
    compactArtifactIdentity(artifact.museum_name),
    compactArtifactIdentity(artifact.era),
  ].join("|")
  if (bestMatch) candidates.set(candidateIdentity(bestMatch.artifact), bestMatch)
  searchResults.forEach((artifact) => {
    if (
      compactArtifactIdentity(artifact.museum_name) !== normalizedMuseum
      || compactArtifactIdentity(artifact.era) !== normalizedEra
    ) return
    const candidateName = compactArtifactIdentity(artifact.name)
    const exact = candidateName === normalizedName
    const related = candidateName.includes(normalizedName) || normalizedName.includes(candidateName)
    if (!exact && !related) return
    const identity = candidateIdentity(artifact)
    const nextMatch: ExistingArtifactMatch = {
      artifact,
      match_score: exact ? 1 : 0.8,
      match_reason: exact
        ? "名称完全一致，且时代、馆藏一致。"
        : "名称相近，且时代、馆藏一致。",
    }
    const current = candidates.get(identity)
    if (!current || nextMatch.match_score > current.match_score) {
      candidates.set(identity, nextMatch)
    }
  })
  return Array.from(candidates.values())
    .sort((left, right) => right.match_score - left.match_score)
    .slice(0, 6)
}
