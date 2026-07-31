export async function fetchBatchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const data = (await response.json()) as { detail?: string }
      if (data.detail) message = data.detail
    } catch {
      // Keep the HTTP fallback for proxy and other non-JSON errors.
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}
