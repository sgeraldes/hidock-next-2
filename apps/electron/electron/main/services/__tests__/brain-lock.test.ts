/**
 * The brain lock file: how the app and a headless brain agree that there is
 * only ever one of them, and that the app wins.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  brainLockPath,
  LOCK_WRITE_RETRIES,
  packagedExe,
  probeBrain,
  readBrainLock,
  removeBrainLockIfOwned,
  writeBrainLock,
  type BrainLock,
} from '../brain-lock'
import { startBrainServer, type RunningBrainServer } from '../brain-server'

let dir: string
let path: string
let server: RunningBrainServer | null = null

const noQueries = {
  meetingsSince: () => [],
  pendingActionablesSince: () => [],
  actionableById: () => null,
  knowledgeByIds: () => [],
  knowledgeById: () => null,
  meetingRecordings: () => [],
  transcriptForRecording: () => null,
  recordingById: () => null,
  recordingsByFilenamePrefix: () => [],
}

function lockFor(overrides: Partial<BrainLock> = {}): BrainLock {
  return {
    kind: 'service',
    pid: 1234,
    port: 1,
    token: 't'.repeat(64),
    instanceId: 'inst-a',
    startedAt: '2026-09-22T00:00:00.000Z',
    exe: 'C:/HiDock Next.exe',
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hidock-brainlock-'))
  path = brainLockPath(dir)
})

afterEach(async () => {
  if (server) await server.close()
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('the lock file', () => {
  it('round-trips', () => {
    writeBrainLock(path, lockFor())
    expect(readBrainLock(path)).toEqual(lockFor())
  })

  it('reads as absent when missing, unreadable or malformed', () => {
    expect(readBrainLock(path)).toBeNull()
    writeFileSync(path, '{not json')
    expect(readBrainLock(path)).toBeNull()
    writeFileSync(path, JSON.stringify({ kind: 'daemon', port: 1, token: 'x', instanceId: 'y' }))
    expect(readBrainLock(path)).toBeNull()
  })

  it('leaves no temporary file behind after a write', () => {
    writeBrainLock(path, lockFor())
    expect(readdirSync(dir)).toEqual(['brain.json'])
  })

  it('is removed only by the process it names', () => {
    // The app takes over by writing itself into the lock. A headless brain on
    // its way out must not delete the app's claim.
    writeBrainLock(path, lockFor({ kind: 'app', instanceId: 'the-app' }))
    removeBrainLockIfOwned(path, 'inst-a')
    expect(readBrainLock(path)?.instanceId).toBe('the-app')
    removeBrainLockIfOwned(path, 'the-app')
    expect(existsSync(path)).toBe(false)
  })

  it('retries a rename that Windows refuses while another process reads the lock', () => {
    // Review of PR #29: renameSync over a file another handle has open fails
    // with EPERM on Windows, and the app's first write then never recovered.
    let refusals = 2
    const flakyRename: typeof renameSync = (from, to) => {
      if (refusals-- > 0) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      renameSync(from, to)
    }
    writeBrainLock(path, lockFor(), flakyRename)
    expect(readBrainLock(path)).toEqual(lockFor())
    expect(readdirSync(dir)).toEqual(['brain.json'])
  })

  it('gives up after its retries, cleans its temp file, and does not retry other errors', () => {
    let calls = 0
    const alwaysBusy: typeof renameSync = () => {
      calls++
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    expect(() => writeBrainLock(path, lockFor(), alwaysBusy)).toThrow('busy')
    expect(calls).toBe(LOCK_WRITE_RETRIES + 1)
    expect(readdirSync(dir)).toEqual([])

    calls = 0
    const missing: typeof renameSync = () => {
      calls++
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    }
    expect(() => writeBrainLock(path, lockFor(), missing)).toThrow('gone')
    expect(calls).toBe(1)
  })

  it('names an executable only when the writer is an installed build', () => {
    // A dev lock named electron.exe or a local unpacked build, and the bridge
    // launched it against the owner's data.
    expect(packagedExe(true, 'C:/Programs/hidock-next/HiDock Next.exe')).toBe('C:/Programs/hidock-next/HiDock Next.exe')
    expect(packagedExe(false, 'G:/Code/hidock-next-2/node_modules/electron/dist/electron.exe')).toBe('')
  })
})

describe('probing', () => {
  it('counts a lock as alive only when its server answers with the same instance id', async () => {
    server = await startBrainServer({ kind: 'service', token: 't'.repeat(64), instanceId: 'inst-a', queries: noQueries })
    expect(await probeBrain(lockFor({ port: server.port }))).toBe(true)
    // A reused port with a different process behind it is not this brain.
    expect(await probeBrain(lockFor({ port: server.port, instanceId: 'someone-else' }))).toBe(false)
    // Nor is a lock carrying the wrong token.
    expect(await probeBrain(lockFor({ port: server.port, token: 'u'.repeat(64) }))).toBe(false)
  })

  it('counts a lock as dead when nothing listens on its port', async () => {
    const probe = await startBrainServer({ kind: 'service', token: 't'.repeat(64), instanceId: 'x', queries: noQueries })
    const freed = probe.port
    await probe.close()
    expect(await probeBrain(lockFor({ port: freed }), 500)).toBe(false)
  })
})
