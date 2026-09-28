/**
 * Changing a storage folder moves the files and the stored paths with it, and
 * never leaves the library half switched (storage review, 28-sep-2026).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'

const st = vi.hoisted(() => ({
  recordings: '',
  transcripts: '',
  data: '',
  downloading: false,
  rows: [] as Array<{ rid: number; p: string }>,
  updates: [] as Array<Record<string, unknown>>,
  failConfig: false,
  watcher: [] as string[],
  paused: [] as string[]
}))

vi.mock('../config', () => ({
  getConfig: () => ({ storage: { dataPath: st.data } }),
  getDataPath: () => st.data,
  updateConfig: vi.fn(async (_section: string, values: Record<string, unknown>) => {
    if (st.failConfig) throw new Error('disk full')
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
  // Only the recordings table holds rows in these tests.
  queryAll: (sql: string) => (sql.includes('FROM recordings') ? st.rows.map((r) => ({ ...r })) : []),
  run: (_sql: string, params: unknown[]) => {
    const row = st.rows.find((r) => r.rid === params[1])
    if (row) row.p = params[0] as string
  }
}))
vi.mock('../recording-watcher', () => ({
  startRecordingWatcher: () => st.watcher.push('start'),
  stopRecordingWatcher: () => st.watcher.push('stop')
}))
vi.mock('../download-service', () => ({
  getDownloadService: () => ({
    getState: () => ({ isPaused: false, queue: st.downloading ? [{ status: 'downloading' }] : [] }),
    pause: () => st.paused.push('downloads'),
    resume: () => st.paused.push('downloads-resumed')
  })
}))
vi.mock('../transcription', () => ({
  getQueueState: () => ({ paused: false, isProcessing: false, shortLaneId: null }),
  pauseQueue: () => st.paused.push('transcription'),
  resumeQueue: () => st.paused.push('transcription-resumed')
}))

import { cancelMove, moveFolder, planMove, rewriteStoredPaths, switchFolder } from '../storage-move'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'storage-move-'))
  st.recordings = join(root, 'old')
  st.transcripts = join(root, 'transcripts')
  st.data = root
  st.downloading = false
  st.failConfig = false
  st.updates = []
  st.watcher = []
  st.paused = []
  mkdirSync(join(st.recordings, 'sub'), { recursive: true })
  writeFileSync(join(st.recordings, 'a.mp3'), 'aaaa')
  writeFileSync(join(st.recordings, 'sub', 'b.mp3'), 'bb')
  st.rows = [
    { rid: 1, p: join(st.recordings, 'a.mp3') },
    { rid: 2, p: join(st.recordings, 'sub', 'b.mp3') },
    { rid: 3, p: join(root, 'old-archive', 'c.mp3') }
  ]
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('storage folder move', () => {
  it('plans a move with the file count, and blocks the unsafe cases', async () => {
    expect(await planMove('recordings', join(root, 'new'))).toMatchObject({ files: 2, bytes: 6, blocker: null, canSwitchWithoutMoving: false })
    expect((await planMove('recordings', st.recordings)).blocker).toMatch(/already the folder/)
    expect((await planMove('recordings', join(st.recordings, 'inner'))).blocker).toMatch(/inside the current one, or contain it/)
    expect((await planMove('recordings', root)).blocker).toMatch(/inside the current one, or contain it/)
    mkdirSync(join(root, 'busy'))
    writeFileSync(join(root, 'busy', 'x.mp3'), 'x')
    expect((await planMove('recordings', join(root, 'busy'))).blocker).toMatch(/Choose an empty folder/)
  })

  it('pauses the pipeline, copies, rewrites only paths under the folder, switches, and resumes', async () => {
    const to = join(root, 'new')
    const result = await moveFolder('recordings', to, { files: 2, bytes: 6 }, () => undefined)
    expect(result).toEqual({ copiedFiles: 2, copiedBytes: 6, cancelled: false })
    expect(readFileSync(join(to, 'sub', 'b.mp3'), 'utf8')).toBe('bb')
    expect(readdirSync(to).some((f) => f.endsWith('.partial'))).toBe(false)
    expect(existsSync(join(st.recordings.replace('new', 'old'), 'a.mp3'))).toBe(true)
    expect(st.rows.map((r) => r.p)).toEqual([join(to, 'a.mp3'), join(to, 'sub', 'b.mp3'), join(root, 'old-archive', 'c.mp3')])
    expect(st.updates).toEqual([{ recordingsPath: to }])
    expect(st.watcher).toEqual(['stop', 'start'])
    expect(st.paused).toEqual(['downloads', 'transcription', 'transcription-resumed', 'downloads-resumed'])
  })

  it('refuses when the folder changed since it was confirmed', async () => {
    await expect(moveFolder('recordings', join(root, 'new'), { files: 1, bytes: 4 }, () => undefined)).rejects.toThrow(/changed since you confirmed/)
    expect(st.updates).toEqual([])
    expect(st.watcher).toEqual(['stop', 'start'])
  })

  it('puts the paths back and removes the copies when the setting cannot be saved', async () => {
    st.failConfig = true
    const to = join(root, 'new')
    await expect(moveFolder('recordings', to, { files: 2, bytes: 6 }, () => undefined)).rejects.toThrow(/disk full/)
    expect(st.rows[0].p).toBe(join(root, 'old', 'a.mp3'))
    expect(existsSync(join(to, 'a.mp3'))).toBe(false)
  })

  it('a second move cannot start while one runs', async () => {
    const first = moveFolder('recordings', join(root, 'new'), { files: 2, bytes: 6 }, () => undefined)
    await expect(moveFolder('recordings', join(root, 'other'), { files: 2, bytes: 6 }, () => undefined)).rejects.toThrow(/already running/)
    await first
  })

  it('stop before the switch removes the copies and switches nothing', async () => {
    const to = join(root, 'new')
    const run = moveFolder('recordings', to, { files: 2, bytes: 6 }, () => undefined)
    cancelMove()
    expect(await run).toEqual({ copiedFiles: 0, copiedBytes: 0, cancelled: true })
    expect(st.updates).toEqual([])
    expect(existsSync(join(to, 'a.mp3'))).toBe(false)
  })

  it('rewrites drive-root and non-BMP paths correctly', () => {
    st.rows = [{ rid: 9, p: join(root, 'Rec🎙', 'x.mp3') }]
    rewriteStoredPaths(join(root, 'Rec🎙'), join(root, 'New'))
    expect(st.rows[0].p).toBe(join(root, 'New', 'x.mp3'))
    const driveRoot = `${root.slice(0, 3)}`
    st.rows = [{ rid: 10, p: `${driveRoot}x.mp3` }]
    rewriteStoredPaths(driveRoot, join(root, 'New'))
    expect(st.rows[0].p).toBe(join(root, 'New', 'x.mp3'))
    expect(driveRoot.endsWith(sep)).toBe(true)
  })

  it('switching without moving is only for an empty folder', async () => {
    await expect(switchFolder('recordings', join(root, 'new'))).rejects.toThrow()
    rmSync(st.recordings, { recursive: true, force: true })
    await switchFolder('recordings', join(root, 'new'))
    expect(st.updates).toEqual([{ recordingsPath: join(root, 'new') }])
  })

  it('says whether a new data folder already has a library', async () => {
    const other = join(root, 'other')
    mkdirSync(join(other, 'data'), { recursive: true })
    writeFileSync(join(other, 'data', 'hidock.db'), '')
    expect((await planMove('data', other)).targetHasDatabase).toBe(true)
    expect((await planMove('data', join(root, 'empty'))).targetHasDatabase).toBe(false)
  })
})
