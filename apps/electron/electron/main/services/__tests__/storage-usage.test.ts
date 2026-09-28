/**
 * Space per storage location, its disk, and the optional limit.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ data: '', recordings: '', transcripts: '', captures: '', limits: {} as Record<string, number | null> }))

vi.mock('../config', () => ({
  getDataPath: () => paths.data,
  getConfig: () => ({ storage: { limitsGB: paths.limits } })
}))
vi.mock('../file-storage', () => ({
  getRecordingsPath: () => paths.recordings,
  getTranscriptsPath: () => paths.transcripts,
  getCapturesPath: () => paths.captures
}))

import { folderSize, getStorageUsage, recordingsOverLimit, resetStorageLimitCache } from '../storage-usage'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'storage-usage-'))
  paths.data = root
  paths.recordings = join(root, 'recordings')
  paths.transcripts = join(root, 'transcripts')
  paths.captures = join(root, 'artifacts')
  paths.limits = {}
  mkdirSync(paths.recordings)
  mkdirSync(paths.transcripts)
  mkdirSync(join(root, 'data'))
  writeFileSync(join(paths.recordings, 'a.mp3'), Buffer.alloc(3000))
  writeFileSync(join(paths.recordings, 'b.mp3'), Buffer.alloc(2000))
  writeFileSync(join(paths.transcripts, 'a.md'), Buffer.alloc(100))
  mkdirSync(paths.captures)
  writeFileSync(join(paths.captures, 'x.png'), Buffer.alloc(40))
  writeFileSync(join(root, 'data', 'hidock.db'), Buffer.alloc(700))
  resetStorageLimitCache()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('storage usage', () => {
  it('counts each location, and the data folder skips the ones inside it', async () => {
    const usage = await getStorageUsage()
    const byId = Object.fromEntries(usage.map((u) => [u.id, u]))
    expect(byId.recordings).toMatchObject({ bytes: 5000, files: 2, limitBytes: null, overLimit: false })
    expect(byId.transcripts).toMatchObject({ bytes: 100, files: 1 })
    expect(byId.captures).toMatchObject({ bytes: 40, files: 1 })
    expect(byId.data).toMatchObject({ bytes: 700, files: 1 })
    expect(byId.recordings.disk?.totalBytes).toBeGreaterThan(0)
  })

  it('a missing folder counts as empty', async () => {
    expect(await folderSize(join(root, 'nope'))).toEqual({ bytes: 0, files: 0 })
  })

  it('reports a location over its limit, and auto-download sees it', async () => {
    paths.limits = { recordings: 4000 / 1024 ** 3 }
    const usage = await getStorageUsage()
    expect(usage.find((u) => u.id === 'recordings')?.overLimit).toBe(true)
    expect(await recordingsOverLimit()).toBe(true)
    paths.limits = {}
    resetStorageLimitCache()
    expect(await recordingsOverLimit()).toBe(false)
  })
})
