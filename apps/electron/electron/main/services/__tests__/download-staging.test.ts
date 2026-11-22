// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, statSync, existsSync, createReadStream, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { stageDownload, validateStagedRecording, cleanupInterruptedDownloads } from '../download-staging'

describe('main-process download staging', () => {
  it('bounds queued objects for empty and single-byte callbacks with exact real-disk readback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-tiny-packets-'))
    const total = 1024 * 1024
    const writer = stageDownload(dir, total, error => { throw error })
    try {
      const empty = new Uint8Array(), byte = new Uint8Array([0x53])
      for (let n = 0; n < 200000; n++) writer.write(empty)
      expect(writer.getMetrics()).toMatchObject({ receivedBytes: 0, peakQueuedBuffers: 0, writes: 0 })
      for (let n = 0; n < total; n++) writer.write(byte)
      byte[0] = 0xff
      expect(writer.getMetrics().peakQueuedBuffers).toBe(4)
      const staged = await writer.finish()
      expect(writer.getMetrics().writes).toBe(4)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(staged.path)) hash.update(chunk)
      expect(hash.digest('hex')).toBe(createHash('sha256').update(Buffer.alloc(total, 0x53)).digest('hex'))
    } finally { await writer.discard(); await rm(dir, { recursive: true, force: true }) }
  })

  it('coalesces burst packets, copies mutable input and yields without exceeding the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-burst-test-'))
    const writer = stageDownload(dir, 1024 * 1024, error => { throw error })
    try {
      const chunk = Buffer.alloc(1024, 0x31)
      for (let n = 0; n < 1024; n++) writer.write(chunk)
      chunk.fill(0xff)
      let yielded = false
      setImmediate(() => { yielded = true })
      const result = await writer.finish()
      expect(yielded).toBe(true)
      expect(writer.getMetrics().writes).toBe(4)
      expect(writer.getMetrics().peakBufferedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
      const disk = createHash('sha256')
      for await (const bytes of createReadStream(result.path)) disk.update(bytes)
      expect(disk.digest('hex')).toBe(createHash('sha256').update(Buffer.alloc(1024 * 1024, 0x31)).digest('hex'))
    } finally { await writer.discard(); await rm(dir, { recursive: true, force: true }) }
  })

  it('fails a synchronous burst beyond 8 MiB and never publishes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-cap-test-'))
    let aborts = 0
    const writer = stageDownload(dir, 9 * 1024 * 1024, () => { aborts++ })
    try {
      for (let n = 0; n < 9; n++) writer.write(Buffer.alloc(1024 * 1024))
      expect(aborts).toBe(1)
      expect(writer.getMetrics().peakBufferedBytes).toBe(8 * 1024 * 1024)
      await expect(writer.finish()).rejects.toThrow('disk buffer')
    } finally { await writer.discard(); await rm(dir, { recursive: true, force: true }) }
  })
  it('streams 48 MB through a bounded buffer and verifies the disk bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-stream-test-'))
    let failure: Error | undefined
    const writer = stageDownload(dir, 48 * 1024 * 1024, error => { failure = error })
    try {
      const expected = createHash('sha256')
      const chunk = Buffer.alloc(32768, 0x42)
      for (let n = 0; n < 1536; n++) {
        writer.write(chunk)
        expected.update(chunk)
        // Simulate paced device packets while the OS writes pending chunks.
        if (n % 8 === 7) await new Promise(resolve => setTimeout(resolve, 1))
      }
      const result = await writer.finish()
      expect(failure).toBeUndefined()
      validateStagedRecording(result, dir)
      expect(statSync(result.path).size).toBe(48 * 1024 * 1024)
      const diskHash = createHash('sha256')
      for await (const bytes of createReadStream(result.path)) diskHash.update(bytes)
      expect(result.sha256).toBe(expected.digest('hex'))
      expect(result.sha256).toBe(diskHash.digest('hex'))
    } finally {
      await writer.discard()
      expect(existsSync(writer.path)).toBe(false)
      await rm(dir, { recursive: true, force: true })
    }
  }, 30000)

  it('cleans crash leftovers but preserves live downloads and unrelated files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-stream-test-'))
    const stale = join(dir, '.hidock-12345678-1234-1234-1234-123456789abc.partial')
    const recording = join(dir, 'recording.hda')
    const other = join(dir, '.hidock-user.partial')
    writeFileSync(stale, 'interrupted')
    writeFileSync(recording, 'keep')
    writeFileSync(other, 'keep')
    const live = stageDownload(dir, 1, () => {})
    try {
      live.write(Buffer.from([1]))
      await live.finish()
      expect(await cleanupInterruptedDownloads(dir)).toBe(1)
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(live.path)).toBe(true)
      expect(existsSync(recording)).toBe(true)
      expect(existsSync(other)).toBe(true)
    } finally { await live.discard(); await rm(dir, { recursive: true, force: true }) }
  })

  it('aborts an oversized packet and discards only its partial file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-stream-test-'))
    let aborted = false
    const writer = stageDownload(dir, 10, () => { aborted = true })
    try {
      writer.write(Buffer.alloc(11))
      expect(aborted).toBe(true)
      await expect(writer.finish()).rejects.toThrow('byte boundary')
    } finally {
      await writer.discard()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
