export function formatCapturedAt(value: string | null | undefined) {
  if (!value) return ""
  const normalized = value.trim().replace("T", " ").replace(/\.\d+(?=\s|$)/, "")
  return normalized.replace(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/, (_, year, month, day) => `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`)
}

export function compactFileName(value: string, maxLength = 38) {
  const characters = Array.from(value)
  if (characters.length <= maxLength) return value
  const tailLength = Math.max(14, Math.floor(maxLength * 0.46))
  const headLength = Math.max(10, maxLength - tailLength - 1)
  return `${characters.slice(0, headLength).join("")}…${characters.slice(-tailLength).join("")}`
}

export function distinctiveFileNames(values: string[], maxLength = 42) {
  if (values.length < 2) return values.map((value) => compactFileName(value, maxLength))

  const characterLists = values.map((value) => Array.from(value))
  const sortedEntries = values
    .map((value, index) => ({ index, value }))
    .sort((left, right) => left.value.localeCompare(right.value, "zh-CN"))
  const sharedPrefixLengths = values.map(() => 0)

  const commonPrefixLength = (left: string[], right: string[]) => {
    const limit = Math.min(left.length, right.length)
    let length = 0
    while (length < limit && left[length] === right[length]) length += 1
    return length
  }

  sortedEntries.forEach((entry, sortedIndex) => {
    const adjacentEntries = [sortedEntries[sortedIndex - 1], sortedEntries[sortedIndex + 1]].filter(Boolean)
    sharedPrefixLengths[entry.index] = adjacentEntries.reduce(
      (longest, adjacent) => Math.max(longest, commonPrefixLength(characterLists[entry.index], characterLists[adjacent.index])),
      0,
    )
  })

  return characterLists.map((characters, index) => {
    const sharedPrefixLength = sharedPrefixLengths[index]
    if (sharedPrefixLength < 8) return compactFileName(values[index], maxLength)
    const contextStart = Math.max(0, sharedPrefixLength - 10)
    if (contextStart === 0) return compactFileName(values[index], maxLength)
    const distinctiveCharacters = characters.slice(contextStart)
    const availableLength = Math.max(18, maxLength - 1)
    if (distinctiveCharacters.length <= availableLength) {
      return `…${distinctiveCharacters.join("")}`
    }

    const tailLength = Math.max(14, Math.floor((availableLength - 1) * 0.58))
    const headLength = Math.max(8, availableLength - tailLength - 1)
    return `…${distinctiveCharacters.slice(0, headLength).join("")}…${distinctiveCharacters.slice(-tailLength).join("")}`
  })
}
