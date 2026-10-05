/**
 * highlightText Utility
 *
 * Returns React elements with matching portions of text wrapped in <mark> tags
 * for visual highlighting of search query matches in the Library list.
 *
 * Supports multi-token queries: "Sofia Connect" highlights "Sofia" and "Connect"
 * independently wherever they appear in the text.
 */

import React from 'react'

/** Offset-based highlights for literal, accent-insensitive reader matches. */
export function highlightRanges(text: string, ranges: Array<{ start: number; end: number; id: string }>, currentId?: string): React.ReactNode {
  const nodes: React.ReactNode[] = []
  let offset = 0
  for (const range of ranges) {
    nodes.push(text.slice(offset, range.start))
    nodes.push(<mark key={range.id} data-find-current={range.id === currentId ? 'true' : undefined}
      className={range.id === currentId ? 'bg-orange-400 text-black rounded-sm ring-2 ring-orange-600 scroll-mt-32' : 'bg-yellow-200 text-black dark:bg-yellow-800 dark:text-white rounded-sm'}>{text.slice(range.start, range.end)}</mark>)
    offset = range.end
  }
  nodes.push(text.slice(offset))
  return nodes
}

/**
 * Highlights portions of text that match the given query.
 * The query is split on whitespace into tokens; each token is highlighted
 * independently. Returns React nodes with <mark> elements around matches.
 *
 * If query is empty or no tokens match, returns the original text string.
 */
export function highlightText(text: string, query: string): React.ReactNode {
  if (!query || query.length === 0) return text

  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return text

  // Build alternation regex from all tokens
  const escapedTokens = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
  const regex = new RegExp(`(${escapedTokens.join('|')})`, 'gi')
  const parts = text.split(regex)

  if (parts.length === 1) return text

  const tokenSet = new Set(tokens)

  return (
    <>
      {parts.map((part, i) =>
        tokenSet.has(part.toLowerCase()) ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 rounded-sm px-0.5">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  )
}
