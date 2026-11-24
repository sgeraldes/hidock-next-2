export type FindSection = 'transcript' | 'summary' | 'moments'
export interface FindDocument { key: string; section: FindSection; text: string; timeMs?: number }
export interface FindMatch extends FindDocument { start: number; end: number; id: string }

// The existing identity/card helpers fold NFD diacritics, but are private and
// discard offsets. Keep offsets here so composed and decomposed text highlight
// the original characters rather than a normalized copy.
export function normalizeFindText(text: string): string {
  // Final sigma lowercases by context (a whole string ends in ς, one letter is σ):
  // fold both to σ so the text, indexed letter by letter, meets a whole query.
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')
}
// Plain ASCII folds to itself one character for one, so its offsets need no map.
const NOT_PLAIN_ASCII = /[^\t\n\r\x20-\x7e]/
export interface FindIndexEntry { document: FindDocument; normalized: string; starts: number[] | null; ends: number[] | null }
export function buildFindIndex(documents: FindDocument[]): FindIndexEntry[] {
  return documents.map(document => {
    if (!NOT_PLAIN_ASCII.test(document.text)) return { document, normalized: document.text.toLowerCase(), starts: null, ends: null }
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
export function searchFindIndex(index: FindIndexEntry[], query: string): FindMatch[] {
  const needle = normalizeFindText(query)
  if (!needle.trim()) return []
  const matches: FindMatch[] = []
  for (const { document, normalized, starts, ends } of index) {
    let at = normalized.indexOf(needle)
    while (at !== -1) {
      const start = starts ? starts[at] : at, end = ends ? ends[at + needle.length - 1] : at + needle.length
      matches.push({ ...document, start, end, id: `${document.key}:${start}` })
      at = normalized.indexOf(needle, at + needle.length)
    }
  }
  return matches
}
export function wrapFindIndex(current: number, direction: number, count: number): number {
  return count ? (current + direction + count) % count : 0
}
