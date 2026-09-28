/**
 * Changing a storage folder moves the files and the stored paths with it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'

const st = vi.hoisted(() => ({
  recordings: '',
  transcripts: '',
  data: '',
  downloading: false,
  sql: [] as Array<{ sql: string; params: unknown[] }>,
  updates: [] as Array<Record<string, unknown>>,
  watcher: [] as string[]
}))

vi.mock('../config', () => ({
  getConfig: () => ({ storage: { dataPath: st.data } }),
  getDataPath: () => st.data,
  updateConfig: vi.fn(async (_section: string, values: Record<string, unknown>) => {
    st.updates.push(values)
    if (typeof values.recordingsPath === 'string') st.recordings = values.recordingsPath
  })
}))
vi.mock('../file-storage', () => ({
  getRecordingsPath: () => st.recordings,
  getTranscriptsPath: () => st.transcripts,
  initializeFileStorage: vi.fn(async () => undefined)
}))
vi.mock('../database', () => ({
  runInTransaction: (fn: () => unknown) => fn(),
  runNoSave: (sql: string, params: unknown[]) => st.sql.push({ sql, params })
}))
vi.mock('../recording-watcher', () => ({
  startRecordingWatcher: () => st.watcher.push('start'),
  stopRecordingWatcher: () => st.watcher.push('stop')
}))
vi.mock('../download-service', () => ({
  getDownloadService: () => ({ getState: () => ({ queue: st.downloading ? [{ status: 'downloading' }] : [] }) })
}))

import { moveFolder, planMove, rewriteStoredPaths, switchFolder } from '../storage-move'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'storage-move-'))
  st.recordings = join(root, 'old')
  st.transcripts = join(root, 'transcripts')
  st.data = root
  st.downloading = false
  st.sql = []
  st.updates = []
  st.watcher = []
  mkdirSync(st.recordings)
  mkdirSync(join(st.recordings, 'sub'))
  writeFileSync(join(st.recordings, 'a.mp3'), 'aaaa')
  writeFileSync(join(st.recordings, 'sub', 'b.mp3'), 'bb')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('storage folder move', () => {
  it('plans a move with the file count, and blocks the unsafe cases', async () => {
    const plan = await planMove('recordings', join(root, 'new'))
    expect(plan).toMatchObject({ files: 2, bytes: 6, blocker: null })
    expect((await planMove('recordings', st.recordings)).blocker).toMatch(/already the folder/)
    expect((await planMove('recordings', join(st.recordings, 'inner'))).blocker).toMatch(/inside the current one/)
    st.downloading = true
    expect((await planMove('recordings', join(root, 'new'))).blocker).toMatch(/Downloads are running/)
  })

  it('copies every file, rewrites the paths, switches and restarts the watcher, keeping the originals', async () => {
    const from = st.recordings
    const to = join(root, 'new')
    const progress: number[] = []
    const result = await moveFolder('recordings', to, (p) => progress.push(p.copiedFiles))
    expect(result).toEqual({ copiedFiles: 2, copiedBytes: 6, cancelled: false })
    expect(readFileSync(join(to, 'sub', 'b.mp3'), 'utf8')).toBe('bb')
    expect(existsSync(join(from, 'a.mp3'))).toBe(true)
    expect(st.updates).toEqual([{ recordingsPath: to }])
    expect(st.watcher).toEqual(['stop', 'start'])
    expect(st.sql.map((q) => q.sql.split(' ')[1])).toEqual(['recordings', 'synced_files', 'audio_sources'])
    expect(progress.at(-1)).toBe(2)
  })

  it('rewrites only paths under the old folder, keeping the separator', () => {
    rewriteStoredPaths(join(root, 'Rec'), join(root, 'New'))
    const params = st.sql[0].params
    expect(params[0]).toBe(join(root, 'New') + sep)
    expect(params[3]).toBe(join(root, 'Rec') + sep)
  })

  it('switching without moving changes the folder and the watcher, not the files or paths', async () => {
    await switchFolder('recordings', join(root, 'new'))
    expect(st.updates).toEqual([{ recordingsPath: join(root, 'new') }])
    expect(st.sql).toEqual([])
    expect(st.watcher).toEqual(['stop', 'start'])
  })

  it('says whether a new data folder already has a library', async () => {
    const other = join(root, 'other')
    mkdirSync(join(other, 'data'), { recursive: true })
    writeFileSync(join(other, 'data', 'hidock.db'), '')
    expect((await planMove('data', other)).targetHasDatabase).toBe(true)
    expect((await planMove('data', join(root, 'empty'))).targetHasDatabase).toBe(false)
  })
})
