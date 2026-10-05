// @vitest-environment node
import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, rmdirSync, readdirSync, openSync, ftruncateSync, closeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import ffmpeg from 'ffmpeg-static'
import { createRequire } from 'module'
import { dirname } from 'path'
import fs, { createReadStream, createWriteStream } from 'fs'
import fsPromises, { readFile } from 'node:fs/promises'
import { createHash } from 'crypto'
import { finished } from 'node:stream/promises'

// Observe the real filesystem streams without replacing their I/O or lifecycle.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream), createWriteStream: vi.fn(actual.createWriteStream) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const mocks = vi.hoisted(() => ({
  list: vi.fn<() => Array<{ descriptor: { id: string }; instanceId: string }>>(() => []),
  secret: vi.fn<() => string | null>(() => null)
}))

const root = mkdtempSync(join(tmpdir(), 'hidock-paste-runtime-'))
vi.mock('../file-storage', () => ({ getDatabasePath: () => join(root, 'test.db'), getCapturesPath: () => join(root, 'artifacts'), getRecordingsPath: () => join(root, 'recordings') }))
vi.mock('../config', () => ({ getDataPath: () => root, getConfig: () => ({ transcription: { geminiApiKey: '' } }) }))
vi.mock('../transcription', () => ({ queueTranscriptionIfEnabled: vi.fn(() => false) }))
vi.mock('../connectors', () => ({ getConnectorHost: () => ({ list: mocks.list }) }))
vi.mock('../connectors/connector-store', () => ({ getConnectorStore: () => ({ getSecret: mocks.secret }) }))
vi.mock('../vector-store', () => ({ getVectorStore: vi.fn(() => { throw new Error('Paste must not embed') }), chunkText: (text: string) => [text] }))
vi.mock('electron', () => ({ clipboard: { read: vi.fn() }, net: { fetch: vi.fn(async () => new Response('<title>Example</title><p>Readable body</p>', { headers: { 'content-type': 'text/html' } })) }, BrowserWindow: { getAllWindows: () => [] } }))
import { initializeDatabase, closeDatabase, queryOne, getRecordings } from '../database'
import { pasteLibrary, newLibraryNote } from '../paste-library-runtime'
import { importArtifact, MAX_VIDEO_BYTES } from '../artifact-service'
import { getArtifactType } from '../artifact-types'
import { queueTranscriptionIfEnabled } from '../transcription'
import { getVectorStore } from '../vector-store'
import { net } from 'electron'
vi.mock('../paste-page', () => ({ fetchPastePage: vi.fn(async () => ({ title: 'Example', text: 'Readable body' })) }))

beforeAll(async () => { mkdirSync(join(root, 'recordings')); await initializeDatabase() })
// All cleanup targets are fixture-owned literal paths under this unique temp root.
function clean(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name)
    if (entry.isDirectory()) clean(target)
    else unlinkSync(target)
  }
  rmdirSync(path)
}
afterAll(() => { closeDatabase(); clean(root) })

it('persists pasted text in notes with a first-line title and no artifact', async () => {
  const text = `${'a'.repeat(100)}\nDetails`
  const [result] = await pasteLibrary({ text })
  expect(result.title).toHaveLength(80)
  const row = queryOne<{ content: string; title: string }>('SELECT content, title FROM notes WHERE id = ?', [result.id!])!
  expect(row.content).toBe(text)
  expect(row.title).toBe('a'.repeat(80))
  expect(result.destination).toBe('note')
  expect(queryOne('SELECT id FROM artifacts WHERE knowledge_capture_id = ?', [result.id!])).toBeUndefined()
  expect(getVectorStore).not.toHaveBeenCalled()
})
it('stores screenshot PNG without calling image vision or embeddings', async () => {
  const image = getArtifactType('image')!
  const spy = vi.spyOn(image, 'extractText')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=', 'base64')
  const [result] = await pasteLibrary({ png })
  const row = queryOne<{ kind: string; storage_path: string }>('SELECT kind, storage_path FROM artifacts WHERE knowledge_capture_id = ?', [result.id!])!
  expect(row.kind).toBe('image')
  expect(readFileSync(row.storage_path)).toEqual(png)
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
})
it('persists URL, title and readable page text as a link artifact', async () => {
  const [result] = await pasteLibrary({ text: 'https://example.test/page' })
  const row = queryOne<{ kind: string; extracted_text: string; metadata: string }>('SELECT kind, extracted_text, metadata FROM artifacts WHERE knowledge_capture_id = ?', [result.id!])!
  expect(row.kind).toBe('link')
  expect(row.extracted_text).toContain('Readable body')
  expect(JSON.parse(row.metadata).url).toBe('https://example.test/page')
  expect(result.title).toBe('Example')
})
it('stores a video and imports its real extracted audio, linked by artifact metadata', async () => {
  const path = join(root, 'fixture.mp4')
  execFileSync(ffmpeg!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=0.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-shortest', path], { windowsHide: true })
  const [result] = await pasteLibrary({ files: [path] })
  expect(result.error).toBeUndefined()
  const row = queryOne<{ kind: string; metadata: string }>('SELECT kind, metadata FROM artifacts WHERE knowledge_capture_id = ?', [result.id!])!
  expect(row.kind).toBe('video')
  const audioId = JSON.parse(row.metadata).audioRecordingId
  const audio = queryOne<{ file_path: string; source: string }>('SELECT file_path, source FROM recordings WHERE id = ?', [audioId])!
  expect(audio.source).toBe('external')
  expect(getRecordings().find((recording) => recording.id === audioId)).toMatchObject({
    original_filename: 'fixture.mp4 · audio', parent_video_capture_id: result.id
  })
  expect(readFileSync(audio.file_path).subarray(0, 4).toString()).toBe('RIFF')
  expect(queueTranscriptionIfEnabled).toHaveBeenCalledWith(audioId)
})
it('imports audio through external recording storage and creates an empty editor note', async () => {
  const path = join(root, 'voice.wav')
  writeFileSync(path, 'fixture-audio')
  const [result] = await pasteLibrary({ files: [path] })
  expect(queryOne('SELECT id FROM recordings WHERE id = ?', [result.id!])).toBeDefined()
  const note = newLibraryNote()
  expect(queryOne<{ content: string }>('SELECT content FROM notes WHERE id = ?', [note.id!])!.content).toBe('')
})

it('keeps a silent video and explains why its audio import failed', async () => {
  const path = join(root, 'silent.mp4')
  execFileSync(ffmpeg!, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=0.2', path], { windowsHide: true })
  const [result] = await pasteLibrary({ files: [path] })
  expect(result.error).toContain('Video was saved')
  expect(result.error).toContain('audio')
  expect(queryOne('SELECT id FROM artifacts WHERE knowledge_capture_id = ?', [result.id!])).toBeDefined()
})

it('reports a PDF extraction failure while preserving the imported original', async () => {
  const path = join(root, 'broken.pdf')
  writeFileSync(path, 'This is not a PDF')
  const [result] = await pasteLibrary({ files: [path] })
  expect(result.error).toBeUndefined()
  expect(result.warning).toContain('extraction')
  expect(result.textUnreadable).toBe(true)
  expect(queryOne('SELECT id FROM artifacts WHERE knowledge_capture_id = ?', [result.id!])).toBeDefined()
})

it('uses Slack URL identity and explains a missing connector without fetching its login page', async () => {
  mocks.list.mockReturnValue([])
  const calls = vi.mocked(net.fetch).mock.calls.length
  const [result] = await pasteLibrary({ text: 'https://team.slack.com/archives/C123/p1234567890123456' })
  expect(result.title).toContain('team')
  expect(result.title).toContain('C123')
  expect(result.title).toBe('Slack · team · #C123 · thread')
  expect(result.connectorFallback).toBe('the Slack connector is not set up')
  expect(vi.mocked(net.fetch).mock.calls.length).toBe(calls)
  expect(queryOne<{ kind: string }>('SELECT kind FROM artifacts WHERE knowledge_capture_id = ?', [result.id!])!.kind).toBe('link')
})

it('imports PDF and text file fixtures through the existing artifact extraction path', async () => {
  const req = createRequire(import.meta.url)
  const pdfRoot = dirname(req.resolve('pdf-parse/package.json'))
  const pdf = join(root, 'paper.pdf')
  writeFileSync(pdf, readFileSync(join(pdfRoot, 'test/data/05-versions-space.pdf')))
  const text = join(root, 'file-note.txt')
  writeFileSync(text, 'File note\nOffline contents')
  const results = await pasteLibrary({ files: [pdf, text] })
  expect(results.every((result) => !result.error)).toBe(true)
  for (const result of results) {
    const row = queryOne<{ kind: string; storage_path: string; extracted_text: string }>('SELECT kind, storage_path, extracted_text FROM artifacts WHERE knowledge_capture_id = ?', [result.id!])!
    expect(['pdf', 'txt']).toContain(row.kind)
    expect(readFileSync(row.storage_path).length).toBeGreaterThan(0)
    expect(row.extracted_text).toBeTruthy()
  }
})

it('uses the real Slack client with mocked HTTP and stores connector provenance without sending credentials to the pasted host', async () => {
  mocks.list.mockReturnValue([{ descriptor: { id: 'slack' }, instanceId: 'slack-fixture' }])
  mocks.secret.mockReturnValue('fixture-only')
  vi.mocked(net.fetch).mockImplementation(async (input) => {
    const method = new URL(String(input)).pathname.split('/').pop()
    const body = method === 'auth.test' ? { ok: true, url: 'https://team.slack.com/', team_id: 'T123' }
      : method === 'conversations.list' ? { ok: true, channels: [{ id: 'C123', name: 'fixture-channel' }] }
        : { ok: true, messages: [{ ts: '1234567890.123456', user: 'U123', text: 'Connector message' }] }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  })
  const before = vi.mocked(net.fetch).mock.calls.length
  const [result] = await pasteLibrary({ text: 'https://team.slack.com/archives/C123/p1234567890123456' })
  expect(result.error).toBeUndefined()
  const row = queryOne<{ source_connector_id: string; extracted_text: string }>('SELECT source_connector_id, extracted_text FROM artifacts WHERE knowledge_capture_id = ?', [result.id!])!
  expect(row.source_connector_id).toBe('slack-fixture')
  expect(row.extracted_text).toContain('Connector message')
  for (const [input, init] of vi.mocked(net.fetch).mock.calls.slice(before)) {
    expect(new URL(String(input)).origin).toBe('https://slack.com')
    expect(init?.redirect).toBe('error')
  }
  mocks.list.mockReturnValue([])
  mocks.secret.mockReturnValue(null)
})

it('reserves the same screenshot across watcher extraction and explicit local paste', async () => {
  const png = Buffer.from('concurrent-screenshot-fixture')
  const path = join(root, 'watcher.png')
  writeFileSync(path, png)
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const spy = vi.spyOn(getArtifactType('image')!, 'extractText').mockImplementation(async () => {
    started(); await held; return { text: '' }
  })
  try {
    const watcher = importArtifact(path)
    await entered
    const pasted = pasteLibrary({ png })
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const [auto, [explicit]] = await Promise.all([watcher, pasted])
    expect(explicit.id).toBe(auto.knowledgeCaptureId)
    expect(queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM artifacts WHERE content_hash = ?', [auto.artifact.content_hash])!.count).toBe(1)
    expect(spy).toHaveBeenCalledTimes(1)
  } finally { release(); spy.mockRestore() }
})

it('rejects a sparse oversized video before storage or extraction', async () => {
  const path = join(root, 'oversized.mp4')
  const fd = openSync(path, 'w')
  try { ftruncateSync(fd, MAX_VIDEO_BYTES + 1) } finally { closeSync(fd) }
  const spy = vi.spyOn(getArtifactType('video')!, 'extractText')
  try {
    const [result] = await pasteLibrary({ files: [path] })
    expect(result.error).toBe('Video exceeds the 512 MB limit.')
    expect(queryOne('SELECT id FROM knowledge_captures WHERE title = ?', ['oversized.mp4'])).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  } finally { spy.mockRestore() }
})

it('streams video hash and copy without invoking its byte extractor', async () => {
  const path = join(root, 'streaming.mp4')
  const bytes = Buffer.from('small video fixture spanning several real stream chunks')
  writeFileSync(path, bytes)
  const spy = vi.spyOn(getArtifactType('video')!, 'extractText')
  const reads: Array<{ stream: fs.ReadStream; chunks: Buffer[] }> = []
  const writes: fs.WriteStream[] = []
  const closures: Promise<void>[] = []
  vi.mocked(createReadStream).mockImplementation((source, options) => {
    const stream = fs.createReadStream(source, { ...(typeof options === 'object' ? options : {}), highWaterMark: 7 })
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
    reads.push({ stream, chunks })
    closures.push(finished(stream, { cleanup: true }))
    return stream
  })
  vi.mocked(createWriteStream).mockImplementation((destination, options) => {
    const stream = fs.createWriteStream(destination, options)
    writes.push(stream)
    closures.push(finished(stream, { cleanup: true }))
    return stream
  })
  vi.mocked(readFile).mockClear()
  vi.mocked(readFile).mockRejectedValue(new Error('Video must not use whole-file reads'))
  const syncRead = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('Video must not use whole-file reads') })
  vi.mocked(createReadStream).mockClear()
  vi.mocked(createWriteStream).mockClear()
  try {
    const result = await importArtifact(path, { localOnly: true })
    await Promise.all(closures)
    expect(createReadStream).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createReadStream).mock.calls.map(([source]) => source)).toEqual([path, path])
    for (const { stream, chunks } of reads) {
      expect(chunks.length).toBeGreaterThan(1)
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
      expect(stream.closed).toBe(true)
      expect(stream.destroyed).toBe(true)
    }
    expect(createWriteStream).toHaveBeenCalledExactlyOnceWith(result.artifact.storage_path, { flags: 'wx' })
    expect(writes[0].closed).toBe(true)
    expect(writes[0].destroyed).toBe(true)
    expect(readFile).not.toHaveBeenCalled()
    expect(syncRead).not.toHaveBeenCalled()
    syncRead.mockRestore()
    expect(readFileSync(result.artifact.storage_path!).equals(bytes)).toBe(true)
    expect(result.artifact.content_hash).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.artifact.size).toBe(bytes.length)
    expect(spy).not.toHaveBeenCalled()
  } finally {
    for (const { stream } of reads) stream.destroy()
    for (const stream of writes) stream.destroy()
    await Promise.allSettled(closures)
    syncRead.mockRestore()
    vi.mocked(createReadStream).mockImplementation(fs.createReadStream)
    vi.mocked(createWriteStream).mockImplementation(fs.createWriteStream)
    vi.mocked(readFile).mockImplementation(fsPromises.readFile)
    spy.mockRestore()
  }
})
