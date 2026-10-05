/** Display order only; persisted sampling positions and membership remain untouched. */
export function labelDisplayOrder<T extends { position: number }>(setId: string, items: readonly T[]): T[] {
  const rank = (position: number): number => {
    let hash = 2166136261
    for (const char of `${setId}:${position}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    // Avalanche the hash so neighboring sampling positions do not stay adjacent.
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
    return (hash ^ (hash >>> 16)) >>> 0
  }
  return [...items].sort((a, b) => rank(a.position) - rank(b.position) || a.position - b.position)
}
