export function formatFileSize(size: number) {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}
