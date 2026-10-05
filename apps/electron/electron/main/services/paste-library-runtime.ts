import { clipboard, net } from 'electron'
import { randomUUID } from 'crypto'
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'fs'
import { basename, join } from 'path'
import { SlackClient, messageToSourceItems } from '@hidock/connectors-slack'
import type { PasteResult, PasteSnapshot } from '../../../src/shared/paste-to-library'
import { importPaste, connectorLinkIdentity, type PasteDeps } from './paste-to-library'
import { readPasteClipboard } from './paste-clipboard'
import { fetchPastePage } from './paste-page'
import { importArtifact, type ImportArtifactOptions } from './artifact-service'
import { importExternalRecording } from './external-recording-import'
import { extractVideoAudio } from './paste-video'
import { getDataPath } from './config'
import { getConnectorHost } from './connectors'
import { getConnectorStore } from './connectors/connector-store'
import { queryOne, run } from './database'
import { createNote, updateNote } from './notes'
import { queueTranscriptionIfEnabled } from './transcription'

async function staged<T>(name: string, bytes: Uint8Array | string, action: (path: string) => Promise<T>): Promise<T> {
  const root = join(getDataPath(), 'paste-staging')
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'paste-'))
  const path = join(dir, name)
  try { writeFileSync(path, bytes); return await action(path) }
  finally { if (existsSync(path)) unlinkSync(path); rmdirSync(dir) }
}

async function artifact(path: string, opts: ImportArtifactOptions = {}): Promise<PasteResult> {
  const imported = await importArtifact(path, { ...opts, localOnly: true })
  const title = queryOne<{ title: string; user_title: string | null }>('SELECT title, user_title FROM knowledge_captures WHERE id = ?', [imported.knowledgeCaptureId])
  const metadata = JSON.parse(imported.artifact.metadata || '{}') as Record<string, unknown>
  const warning = metadata.extractionError && metadata.extractionError !== 'NO_TYPE'
    ? `Search cannot find this file's contents. Text extraction failed: ${String(metadata.extractionMessage || metadata.extractionError)}` : undefined
  return { id: imported.knowledgeCaptureId, title: title?.user_title || title?.title || opts.title || basename(path), warning,
    textUnreadable: warning ? true : undefined }
}

async function textArtifact(text: string, title: string, extension: string, opts: ImportArtifactOptions = {}): Promise<PasteResult> {
  const result = await staged(`content.${extension}`, text, (path) => artifact(path, { ...opts, title: `${title}.${extension}` }))
  // Display title is independent of the extension used by Library's kind facet.
  run('UPDATE knowledge_captures SET user_title = ? WHERE id = ? AND user_title IS NULL', [title, result.id!])
  return { ...result, title }
}

async function importAudio(path: string): Promise<PasteResult> {
  const result = importExternalRecording(path)
  if (!result.success || !result.recording) throw new Error(result.error || 'Audio import failed.')
  return { id: result.recording.id, title: basename(path) }
}

async function importVideo(path: string): Promise<PasteResult> {
  const result = await artifact(path)
  const existing = queryOne<{ id: string; metadata: string | null; storage_path: string }>('SELECT id, metadata, storage_path FROM artifacts WHERE knowledge_capture_id = ? AND kind = ?', [result.id!, 'video'])
  if (!existing) throw new Error('Stored video could not be found.')
  const metadata = JSON.parse(existing.metadata || '{}') as Record<string, unknown>
  if (typeof metadata.audioRecordingId === 'string') return result
  const root = join(getDataPath(), 'paste-staging')
  mkdirSync(root, { recursive: true })
  const wav = join(root, `video-audio-${randomUUID()}.wav`)
  try {
    await extractVideoAudio(existing.storage_path, wav)
    const audio = await importAudio(wav)
    run('UPDATE recordings SET original_filename = ? WHERE id = ?', [`${basename(path)} (audio)`, audio.id!])
    run('UPDATE artifacts SET metadata = ? WHERE id = ?', [JSON.stringify({ ...metadata, audioRecordingId: audio.id }), existing.id])
    const queued = queueTranscriptionIfEnabled(audio.id!)
    return { ...result, warning: queued ? undefined : 'Video saved. Audio transcription is disabled in your current settings; its audio is available in Library.' }
  } catch (error) {
    return { ...result, error: `Video was saved, but audio could not be transcribed: ${error instanceof Error ? error.message : String(error)}` }
  } finally { if (existsSync(wav)) unlinkSync(wav) }
}

/** Reuse the existing Slack Web API client/mappers, never a pasted host for authenticated requests. */
async function connectorLink(raw: string): Promise<PasteResult | null> {
  const url = new URL(raw)
  if (!(url.hostname.endsWith('.slack.com') || url.hostname === 'app.slack.com')) return null // No Jira connector is registered yet.
  const archive = url.pathname.match(/^\/archives\/([A-Z0-9]+)(?:\/p(\d+))?/)
  const clientLink = url.pathname.match(/^\/client\/(T[A-Z0-9]+)\/([CDG][A-Z0-9]+)/)
  if (!archive && !clientLink) return null
  const channelId = archive?.[1] ?? clientLink![2]
  const timestamp = url.searchParams.get('thread_ts') ?? (archive?.[2] ? `${archive[2].slice(0, -6)}.${archive[2].slice(-6)}` : undefined)
  let configured = false
  for (const summary of getConnectorHost().list()) {
    if (summary.descriptor.id !== 'slack') continue
    const token = getConnectorStore().getSecret(summary.instanceId, 'token')
    if (!token) continue
    configured = true
    const client = new SlackClient(token, { maxRetries: 0, fetchFn: async (input, init) => {
      const requestUrl = new URL(String(input))
      if (requestUrl.origin !== 'https://slack.com' || !requestUrl.pathname.startsWith('/api/')) throw new Error('Refused credentials for an unknown Slack API host.')
      return net.fetch(input, { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000) })
    } })
    const auth = await client.authTest()
    if (clientLink ? auth.team_id !== clientLink[1] : !auth.url || new URL(auth.url).hostname !== url.hostname) continue
    const channel = (await client.listChannels()).find((candidate) => candidate.id === channelId)
    if (!channel) throw new Error('Slack channel is not accessible to the configured connector.')
    const response = await client.conversationsHistory({ channel: channelId, limit: timestamp ? 1 : 100,
      ...(timestamp ? { oldest: timestamp, latest: timestamp, inclusive: true } : {}) })
    let messages = response.messages ?? []
    if (timestamp && messages.length) {
      // The existing replies helper omits the parent; fetch/preserve it explicitly.
      const rootTs = messages[0].thread_ts || timestamp
      if (rootTs !== timestamp) {
        const root = await client.conversationsHistory({ channel: channelId, oldest: rootTs, latest: rootTs, inclusive: true, limit: 1 })
        messages = root.messages ?? messages
      }
      messages = [...messages, ...await client.conversationsReplies({ channel: channelId, ts: rootTs, limit: 100 })]
    }
    messages = messages.slice(0, 100)
    if (!messages.length) throw new Error('Slack returned no messages for this link.')
    const text = messages.map((message) => messageToSourceItems(channelId, message, { connectorId: summary.instanceId })
      .filter((item) => item.kind === 'message').map((item) => item.text).join('\n')).join('\n\n')
    return textArtifact(text, `${channel.name || channelId}${timestamp ? ' · thread' : ' · channel'}`, 'md', {
      sourceConnectorId: summary.instanceId, sourceRef: raw, metadata: { url: raw, channelId, threadTs: timestamp }
    })
  }
  if (configured) throw new Error('No configured Slack connector matches this workspace.')
  return null
}

const deps: PasteDeps = {
  artifact: (path) => artifact(path),
  audio: importAudio,
  video: importVideo,
  note: async (text) => {
    const title = text.split(/\r?\n/)[0].trim().slice(0, 80) || 'Pasted note'
    const note = createNote({ content: text })
    updateNote(note.id, { title })
    return { id: note.id, title, destination: 'note' }
  },
  bitmap: (png) => staged(`Screenshot ${new Date().toISOString().replace(/[:.]/g, '-')}.png`, png, (path) => artifact(path)),
  connector: connectorLink,
  link: async (url) => {
    const identity = connectorLinkIdentity(url)
    if (identity) return textArtifact(url, identity.title, 'url', { metadata: { url, pageTitle: identity.title } })
    let page: { title: string; text: string } = { title: new URL(url).hostname, text: '' }
    let warning: string | undefined
    try { page = await fetchPastePage(url, (input, init) => net.fetch(input, init)) }
    catch (error) { warning = `Link saved; readable content could not be fetched: ${error instanceof Error ? error.message : String(error)}` }
    return { ...await textArtifact(`${url}\n\n${page.text}`, page.title, 'url', { metadata: { url, pageTitle: page.title } }), warning }
  }
}

export async function pasteLibrary(snapshot?: PasteSnapshot): Promise<PasteResult[]> {
  return importPaste(snapshot ?? await readPasteClipboard(clipboard), deps)
}

export function newLibraryNote(): PasteResult {
  const note = createNote()
  return { id: note.id, title: 'New note' }
}
