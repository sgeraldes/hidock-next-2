export type FindSection = 'transcript' | 'summary' | 'moments'
export interface FindDocument { key: string; section: FindSection; text: string; timeMs?: number }
export interface FindMatch extends FindDocument { start: number; end: number; id: string }

// The existing identity/card helpers fold NFD diacritics, but are private and
// discard offsets. Keep offsets here so composed and decomposed text highlight
// the original characters rather than a normalized copy.
export function normalizeFindText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}
export function buildFindIndex(documents: FindDocument[]) {
  return documents.map(document => {
    let normalized = ''
    const starts: number[] = [], ends: number[] = []
    let offset = 0
    for (const char of document.text) {
      const folded = normalizeFindText(char)
      if (!folded && ends.length) ends[ends.length - 1] = offset + char.length
      for (let j = 0; j < folded.length; j++) {
        starts.push(offset)
        ends.push(offset + char.length)
      }
      normalized += folded
      offset += char.length
    }
    return { document, normalized, starts, ends }
  })
}
export function searchFindIndex(index: ReturnType<typeof buildFindIndex>, query: string): FindMatch[] {
  const needle = normalizeFindText(query)
  if (!needle.trim()) return []
  const matches: FindMatch[] = []
  for (const { document, normalized, starts, ends } of index) {
    let at = normalized.indexOf(needle)
    while (at !== -1) {
      const start = starts[at], end = ends[at + needle.length - 1]
      matches.push({ ...document, start, end, id: `${document.key}:${start}` })
      at = normalized.indexOf(needle, at + needle.length)
    }
  }
  return matches
}
export function wrapFindIndex(current: number, direction: number, count: number): number {
  return count ? (current + direction + count) % count : 0
}
