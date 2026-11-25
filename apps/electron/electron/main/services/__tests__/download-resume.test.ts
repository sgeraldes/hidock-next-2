// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile, appendFile, rm, stat, rename } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { downloadWithResume, forgetPublishedResume, releaseResumedDownload, RESUME_RANGE_BYTES, type ResumeSource, type ResumeAdapter } from '../download-resume'
import { cleanupInterruptedDownloads, validateStagedRecording } from '../download-staging'

function fixture(size = 2 * RESUME_RANGE_BYTES + 79) {
  const bytes = Buffer.alloc(size)
  for (let n = 0; n < size; n++) bytes[n] = (n * 31 + (n >>> 8)) & 255
  const source: ResumeSource = { deviceId: 'test-device', sessionId: 'session-one', model: 'H1E', firmware: '6.3.0', filename: 'closed.hda', size,
    signature: 'completed-list-record', listingComplete: true, completed: true }
  const reads: Array<{ offset: number; count: number }> = []
  const adapter: ResumeAdapter = { snapshot: async () => ({ ...source }), readRange: async (_name, _size, offset, count, onChunk, signal, onStarted) => {
    onStarted?.(); reads.push({ offset, count })
    let received = 0
    for (let at = offset; at < offset + count; at += 8192) {
      if (signal?.aborted) return { status: 'cancelled', offset, count, received, reason: 'cancelled' }
      const packet = Buffer.from(bytes.subarray(at, Math.min(offset + count, at + 8192)))
      onChunk(packet); received += packet.length; packet.fill(0xff) // consumer must own a copy
    }
    return { status: 'complete', offset, count, received, reason: null }
  } }
  return { bytes, source, reads, adapter }
}
async function checkpoint(directory: string) {
  const name = (await readdir(directory)).find(name => name.endsWith('.json'))!
  return { path: join(directory, name), data: JSON.parse(await readFile(join(directory, name), 'utf8')) }
}
async function interrupted(directory: string, f: ReturnType<typeof fixture>) {
  const controller = new AbortController()
  await expect(downloadWithResume({ directory, adapter: f.adapter, expected: { ...f.source }, signal: controller.signal,
    onProgress: committed => { if (committed === RESUME_RANGE_BYTES) controller.abort() } })).rejects.toThrow('cancelled')
}

describe('durable contiguous range downloads on real temporary files', () => {
  it('copies mutable tiny callbacks directly into one range without per-callback Buffer allocations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-tiny-')); const f = fixture(256 * 1024 + 73)
    const packet = new Uint8Array(1), empty = new Uint8Array()
    let inCallbacks = false, callbackBufferCopies = 0
    const originalFrom = Buffer.from
    const from = vi.spyOn(Buffer, 'from').mockImplementation(((...args: Parameters<typeof Buffer.from>) => {
      if (inCallbacks) callbackBufferCopies++
      return Reflect.apply(originalFrom, Buffer, args)
    }) as typeof Buffer.from)
    f.adapter.readRange = async (_name, _size, offset, count, onChunk) => {
      inCallbacks = true
      try {
        for (let n = 0; n < count; n++) {
          packet[0] = f.bytes[offset + n]
          onChunk(empty); onChunk(packet); packet[0] = 0xff
        }
      } finally { inCallbacks = false }
      return { status: 'complete', offset, count, received: count, reason: null }
    }
    try {
      const staged = await downloadWithResume({ directory, expected: f.source, adapter: f.adapter })
      expect(callbackBufferCopies).toBe(0)
      expect(await readFile(staged.path)).toEqual(f.bytes)
      expect(staged.sha256).toBe(createHash('sha256').update(f.bytes).digest('hex'))
      releaseResumedDownload(staged)
    } finally { from.mockRestore(); await rm(directory, { recursive: true, force: true }) }
  })

  it('commits exact bytes/hash and publishes atomically only after complete size', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture()
    try {
      let started = 0
      const staged = await downloadWithResume({ directory, expected: f.source, adapter: f.adapter, onStarted: () => { started++ }, onProgress: async () => {} })
      validateStagedRecording(staged, directory)
      expect(await readFile(staged.path)).toEqual(f.bytes)
      expect(staged.sha256).toBe(createHash('sha256').update(f.bytes).digest('hex'))
      expect(started).toBe(3)
      expect(f.reads.every(r => r.count <= RESUME_RANGE_BYTES)).toBe(true)
      const target = join(directory, 'published.hda')
      expect((await readdir(directory)).includes('published.hda')).toBe(false)
      await rename(staged.path, target); await forgetPublishedResume(staged)
      expect(await readFile(target)).toEqual(f.bytes)
      expect((await readdir(directory)).filter(name => name.endsWith('.json'))).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('resumes a fsynced checkpoint after a new connection with prefix and overlap probes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture()
    try {
      await interrupted(directory, f)
      const c = await checkpoint(directory)
      expect(c.data.committed).toBe(RESUME_RANGE_BYTES)
      const partial = join(directory, c.path.split(/[\\/]/).pop()!.replace('.json', '.partial'))
      expect((await stat(partial)).size).toBe(RESUME_RANGE_BYTES)
      expect(await cleanupInterruptedDownloads(directory)).toBe(0)
      f.source.sessionId = 'session-two'; f.reads.length = 0
      const result = await downloadWithResume({ directory, expected: { ...f.source }, adapter: f.adapter })
      expect(f.reads[0]).toEqual({ offset: 0, count: 4096 })
      expect(f.reads[1]).toEqual({ offset: RESUME_RANGE_BYTES - 4096, count: 4096 })
      expect(f.reads[2].offset).toBe(RESUME_RANGE_BYTES)
      expect(await readFile(result.path)).toEqual(f.bytes)
      releaseResumedDownload(result)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('discards an uncommitted crash suffix after validating the committed disk and source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture()
    try {
      await interrupted(directory, f); const c = await checkpoint(directory)
      await appendFile(c.path.replace('.json', '.partial'), Buffer.alloc(57, 0xaa))
      const staged = await downloadWithResume({ directory, adapter: f.adapter, expected: { ...f.source } })
      expect(await readFile(staged.path)).toEqual(f.bytes)
      releaseResumedDownload(staged)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  for (const mode of ['short', 'wrong-offset', 'error'] as const) {
    it(`rejects ${mode} range settlement before any checkpoint`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture(100)
      try {
        f.adapter.readRange = async (_name, _size, offset, count, onChunk) => {
          onChunk(Buffer.alloc(mode === 'short' ? count - 1 : count))
          return { status: mode === 'error' ? 'error' : 'complete', offset: mode === 'wrong-offset' ? offset + 1 : offset,
            count, received: mode === 'short' ? count - 1 : count, reason: 'fixture' }
        }
        await expect(downloadWithResume({ directory, adapter: f.adapter, expected: f.source })).rejects.toThrow('exact boundary')
        expect(await readdir(directory)).toEqual([])
      } finally { await rm(directory, { recursive: true, force: true }) }
    })
  }

  it('a growing file discovered after a range returns cannot be committed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture(100)
    const original = f.adapter.readRange
    f.adapter.readRange = async (...args) => { const result = await original(...args); f.source.size++; return result }
    try {
      await expect(downloadWithResume({ directory, adapter: f.adapter, expected: { ...f.source } })).rejects.toThrow('identity')
      expect(await readdir(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  for (const corruption of ['local-prefix', 'remote-prefix', 'remote-overlap', 'checkpoint-gap', 'truncated-local'] as const) {
    it(`rejects ${corruption} before appending or publishing`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture()
      try {
        await interrupted(directory, f); const c = await checkpoint(directory)
        const partial = c.path.replace('.json', '.partial')
        if (corruption === 'local-prefix') { const data = await readFile(partial); data[2] ^= 1; await writeFile(partial, data) }
        if (corruption === 'remote-prefix') f.bytes[2] ^= 1
        if (corruption === 'remote-overlap') f.bytes[RESUME_RANGE_BYTES - 2] ^= 1
        if (corruption === 'checkpoint-gap') { c.data.committed++; await writeFile(c.path, JSON.stringify(c.data)) }
        if (corruption === 'truncated-local') await writeFile(partial, Buffer.alloc(10))
        const before = await readFile(partial)
        await expect(downloadWithResume({ directory, adapter: f.adapter, expected: { ...f.source } })).rejects.toThrow(/prefix|overlap|range/)
        expect(await readFile(partial)).toEqual(before)
        expect((await readdir(directory)).every(name => !name.endsWith('.hda'))).toBe(true)
      } finally { await rm(directory, { recursive: true, force: true }) }
    })
  }

  for (const state of ['partial-list', 'growing', 'session-change', 'signature-change'] as const) {
    it(`fails closed for ${state} before committing a range`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture()
      try {
        const expected = { ...f.source }
        if (state === 'partial-list') f.source.listingComplete = false
        if (state === 'growing') f.source.completed = false
        if (state === 'session-change') f.source.sessionId = 'other'
        if (state === 'signature-change') f.source.signature = 'other'
        await expect(downloadWithResume({ directory, adapter: f.adapter, expected })).rejects.toThrow(/stable|identity|session/)
        expect(f.reads).toHaveLength(0)
      } finally { await rm(directory, { recursive: true, force: true }) }
    })
  }

  it('rejects short/overlong ranges and removes only its new uncommitted orphan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture(100)
    try {
      await writeFile(join(directory, 'unrelated.hda'), 'keep')
      f.adapter.readRange = async (_name, _size, offset, count, onChunk) => { onChunk(Buffer.alloc(count + 1)); return { status: 'complete', offset, count, received: count, reason: null } }
      await expect(downloadWithResume({ directory, adapter: f.adapter, expected: f.source })).rejects.toThrow('exact boundary')
      expect(await readdir(directory)).toEqual(['unrelated.hda'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not delete active partials, and concurrent owners cannot open the same identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture(100)
    let release!: () => void; let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const original = f.adapter.readRange
    f.adapter.readRange = async (...args) => { entered(); await new Promise<void>(resolve => { release = resolve }); return original(...args) }
    try {
      const first = downloadWithResume({ directory, adapter: f.adapter, expected: f.source })
      await enteredPromise
      expect(await cleanupInterruptedDownloads(directory)).toBe(0)
      await expect(downloadWithResume({ directory, adapter: f.adapter, expected: f.source })).rejects.toThrow('already has an owner')
      release(); releaseResumedDownload(await first)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('retains completed staging ownership until its publisher explicitly releases it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture(100)
    try {
      const staged = await downloadWithResume({ directory, adapter: f.adapter, expected: f.source })
      await expect(downloadWithResume({ directory, adapter: f.adapter, expected: f.source })).rejects.toThrow('already has an owner')
      releaseResumedDownload(staged)
      const retry = await downloadWithResume({ directory, adapter: f.adapter, expected: f.source })
      releaseResumedDownload(staged) // stale descriptor cannot release a newer lease
      await expect(downloadWithResume({ directory, adapter: f.adapter, expected: f.source })).rejects.toThrow('already has an owner')
      releaseResumedDownload(retry)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('cannot discard a completed checkpoint before atomic publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hidock-resume-')); const f = fixture(100)
    try {
      const staged = await downloadWithResume({ directory, adapter: f.adapter, expected: f.source })
      await expect(forgetPublishedResume(staged)).rejects.toThrow('unpublished')
      expect(await readFile(staged.path)).toEqual(f.bytes)
      expect((await readdir(directory)).some(name => name.endsWith('.json'))).toBe(true)
      const retry = await downloadWithResume({ directory, adapter: f.adapter, expected: f.source })
      releaseResumedDownload(retry)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
