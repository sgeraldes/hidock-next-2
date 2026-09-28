/**
 * Release notes for the Releases page, read from apps/electron/CHANGELOG.md at
 * build time. Each `## <date> | <title>` heading starts one release; its body
 * is Markdown.
 */

import changelog from '../../../CHANGELOG.md?raw'

export interface Release {
  /** The build date, YYYY-MM-DD; also the id. */
  date: string
  title: string
  body: string
}

export function parseReleases(markdown: string): Release[] {
  const releases: Release[] = []
  const parts = markdown.replace(/\r\n/g, '\n').split(/^## /m).slice(1)
  for (const part of parts) {
    const newline = part.indexOf('\n')
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim()
    const body = newline === -1 ? '' : part.slice(newline + 1).trim()
    const [date, ...rest] = heading.split('|')
    releases.push({ date: date.trim(), title: rest.join('|').trim(), body })
  }
  return releases
}

export const RELEASES: Release[] = parseReleases(changelog)
