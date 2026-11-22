// @vitest-environment node
import { it, expect } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { createReadStream } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { performance } from 'perf_hooks'
import { stageDownload, MAX_DOWNLOAD_BUFFER_BYTES } from '../download-staging'

it('coalesces 65,536 burst packets into 128 writes with exact real-disk readback and event-loop yields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hidock-burst-bench-'))
  const total = 32 * 1024 * 1024
  let failure: Error | undefined, heartbeats = 0
  const pulse = setInterval(() => { heartbeats++ }, 1)
  const writer = stageDownload(directory, total, error => { failure = error })
  const packet = Buffer.alloc(512, 0x6a), expected = createHash('sha256')
  const start = performance.now()
  try {
    for (let n = 0; n < 65536; n++) {
      writer.write(packet); expected.update(packet)
      if (n % 2048 === 2047) await writer.flush()
    }
    const staged = await writer.finish(), elapsedMs = performance.now() - start
    const disk = createHash('sha256')
    for await (const chunk of createReadStream(staged.path)) disk.update(chunk)
    const sha256 = disk.digest('hex')
    expect(failure).toBeUndefined()
    expect(staged.sha256).toBe(expected.digest('hex'))
    expect(staged.sha256).toBe(sha256)
    expect(writer.getMetrics().writes).toBe(128)
    expect(writer.getMetrics().peakBufferedBytes).toBeLessThanOrEqual(MAX_DOWNLOAD_BUFFER_BYTES)
    expect(heartbeats).toBeGreaterThan(0)
    if (process.env.HIDOCK_DOWNLOAD_EVIDENCE) {
      await mkdir(process.env.HIDOCK_DOWNLOAD_EVIDENCE, { recursive: true })
      await writeFile(join(process.env.HIDOCK_DOWNLOAD_EVIDENCE, 'writer-benchmark.json'), JSON.stringify({
        status: 'passed_actual_temporary_disk_readback', sourcePacketCalls: 65536, packetBytes: 512, diskWriteCalls: 128,
        bytes: total, sha256, ...writer.getMetrics(), elapsedMs, heartbeatCallbacks: heartbeats,
        boundary: 'Synthetic paced source; real Node writer/filesystem/readback and main event loop. No USB throughput or deployed-app claim.'
      }, null, 2))
    }
  } finally { clearInterval(pulse); await writer.discard(); await rm(directory, { recursive: true, force: true }) }
}, 30000)
