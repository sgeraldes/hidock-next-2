import { extname } from 'path'
import { RECORDING_AUDIO_EXTENSIONS } from '../../../src/shared/audio-extensions'
import type { PasteResult, PasteSnapshot } from '../../../src/shared/paste-to-library'

export type PasteKind = 'image' | 'pdf' | 'audio' | 'video' | 'note' | 'url' | 'file'
export interface PasteItem { kind: PasteKind; path?: string; text?: string; png?: Uint8Array }
export interface PasteDeps {
  artifact: (path: string) => Promise<PasteResult>
  note: (text: string) => Promise<PasteResult>
  bitmap: (png: Uint8Array) => Promise<PasteResult>
  audio: (path: string) => Promise<PasteResult>
  video: (path: string) => Promise<PasteResult>
  connector: (url: string) => Promise<PasteResult | null>
  link: (url: string) => Promise<PasteResult>
}
export function classifyPaste(snapshot: PasteSnapshot): PasteItem[] {
  if (snapshot.files?.length) return snapshot.files.map((path) => {
    const ext = extname(path).toLowerCase()
    const kind: PasteKind = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'].includes(ext) ? 'video'
      : (RECORDING_AUDIO_EXTENSIONS as readonly string[]).includes(ext) ? 'audio'
        : ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.tiff'].includes(ext) ? 'image'
          : ext === '.pdf' ? 'pdf'
            : ['.txt', '.text', '.md', '.markdown', '.json', '.csv', '.tsv', '.yaml', '.yml'].includes(ext) ? 'note' : 'file'
    return { kind, path }
  })
  if (snapshot.png?.length) return [{ kind: 'image', png: snapshot.png }]
  const text = snapshot.text?.trim()
  if (!text) return []
  try {
    const url = new URL(text)
    if (/^https?:$/.test(url.protocol) && !/\s/.test(text) && !url.username && !url.password) return [{ kind: 'url', text }]
  } catch { /* Ordinary text is a note. */ }
  return [{ kind: 'note', text: snapshot.text }]
}

export function isConnectorLink(raw: string): boolean {
  const url = new URL(raw)
  return (/^[\w-]+\.slack\.com$/i.test(url.hostname) && /^\/archives\/[A-Z0-9]+(?:\/p\d+)?\/?$/.test(url.pathname))
    || /^\/browse\/[A-Z][A-Z0-9_]*-\d+\/?$/.test(url.pathname)
    || (url.hostname === 'app.slack.com' && /^\/client\/T[A-Z0-9]+\/[CDG][A-Z0-9]+/.test(url.pathname))
}

/** Identity remains useful even when a provider returns only a login page. */
export function connectorLinkIdentity(raw: string): { name: string; title: string } | null {
  if (!isConnectorLink(raw)) return null
  const url = new URL(raw)
  if (url.hostname.endsWith('.slack.com')) {
    const archive = url.pathname.match(/\/archives\/([^/]+)(?:\/p(\d+))?/)
    const client = url.pathname.match(/\/client\/([^/]+)\/([^/]+)/)
    const workspace = client?.[1] ?? url.hostname.split('.')[0]
    const channel = archive?.[1] ?? client?.[2]
    const digits = archive?.[2]
    const thread = url.searchParams.get('thread_ts') ?? (digits ? `${digits.slice(0, -6)}.${digits.slice(-6)}` : null)
    return { name: 'Slack', title: `${workspace} · ${channel}${thread ? ` · thread ${thread}` : ' · channel'}` }
  }
  return { name: 'Jira', title: `${url.hostname} · ${url.pathname.split('/').filter(Boolean).pop()}` }
}

export async function importPaste(snapshot: PasteSnapshot, deps: PasteDeps): Promise<PasteResult[]> {
  const items = classifyPaste(snapshot)
  if (!items.length) return [{ title: 'Clipboard', error: 'The clipboard is empty or has no supported content.' }]
  const results: PasteResult[] = []
  for (const item of items) {
    try {
      if (item.path) {
        results.push(await (item.kind === 'audio' ? deps.audio(item.path) : item.kind === 'video' ? deps.video(item.path) : deps.artifact(item.path)))
      } else if (item.png) results.push(await deps.bitmap(item.png))
      else if (item.kind === 'url') {
        let connected: PasteResult | null = null
        let connectorFallback: string | undefined
        const identity = connectorLinkIdentity(item.text!)
        if (identity) {
          try {
            connected = await deps.connector(item.text!)
            if (!connected) connectorFallback = `the ${identity.name} connector is not set up`
          } catch (error) {
            connectorFallback = `the ${identity.name} connector failed: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        const result = connected ?? await deps.link(item.text!)
        results.push({ ...result, connectorFallback })
      } else results.push(await deps.note(item.text!))
    } catch (error) {
      results.push({ title: item.path ?? item.text?.slice(0, 80) ?? 'Screenshot', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
