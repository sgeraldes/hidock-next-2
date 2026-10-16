import { createWriteStream, statSync } from 'fs'
import { rm, readdir } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { join, dirname, resolve } from 'path'
import { finished } from 'stream/promises'

const activeStagingFiles = new Set<string>()
const stagingFilename = /^\.hidock-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.partial$/
const resumeFilename = /^\.hidock-resume-[a-f0-9]{64}\.partial$/
export const MAX_DOWNLOAD_BUFFER_BYTES = 8 * 1024 * 1024
const WRITE_BATCH_BYTES = 256 * 1024

/** The resume owner holds this lease through writes/checkpoints/publication. */
export function retainActiveStagingFile(path: string): () => void {
  const key = resolve(path)
  if (activeStagingFiles.has(key)) throw new Error('Recording staging file already has an owner')
  activeStagingFiles.add(key)
  return () => { activeStagingFiles.delete(key) }
}

/** Run before downloads start; never remove recordings, links, directories, or live writers. */
export async function cleanupInterruptedDownloads(directory: string): Promise<number> {
  let removed = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !stagingFilename.test(entry.name)) continue
    const candidate = resolve(directory, entry.name)
    if (activeStagingFiles.has(candidate)) continue
    await rm(candidate, { force: true })
    removed++
  }
  return removed
}

export interface StagedRecording { path: string; length: number; sha256: string }

/** Only main-process callers can supply staged files; no renderer path is accepted. */
export function validateStagedRecording(data: StagedRecording, directory: string): void {
  const name = data.path.split(/[\\/]/).pop() || ''
  if (resolve(dirname(data.path)) !== resolve(directory) || (!stagingFilename.test(name) && !resumeFilename.test(name))) {
    throw new Error('Invalid recording staging path')
  }
  if (statSync(data.path).size !== data.length) throw new Error('Staged recording size changed')
}

/** Bounded asynchronous disk writer; a slow disk aborts instead of accumulating audio in RAM. */
export function stageDownload(directory: string, expectedBytes: number, abort: (error: Error) => void) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error('Invalid expected download size')
  const path = join(directory, `.hidock-${randomUUID()}.partial`)
  activeStagingFiles.add(resolve(path))
  const stream = createWriteStream(path, { flags: 'wx', highWaterMark: 256 * 1024, flush: true })
  const hash = createHash('sha256')
  let bytes = 0
  let failure: Error | null = null
  let ending = false
  let discarded = false
  let pendingBytes = 0
  const pending: Buffer[] = []
  let tail: Buffer | null = null
  let tailBytes = 0
  let pump: Promise<void> | null = null
  let writes = 0
  let peakBufferedBytes = 0
  let peakQueuedBuffers = 0
  const fail = (error: Error) => { if (!failure) { failure = error; abort(error) } }
  stream.on('error', fail)
  const completion = finished(stream)
  void completion.catch(() => undefined)
  const drain = () => new Promise<void>((resolveDrain, reject) => {
    const clean = () => { stream.off('drain', ready); stream.off('error', error); stream.off('close', closed) }
    const ready = () => { clean(); resolveDrain() }
    const error = (e: Error) => { clean(); reject(e) }
    const closed = () => { clean(); reject(new Error('Download writer closed before drain')) }
    stream.once('drain', ready); stream.once('error', error); stream.once('close', closed)
  })
  const sealTail = () => {
    if (!tail || !tailBytes) return
    // A partial write must not retain a 256KiB backing store for just a few
    // bytes while the OS stream is applying backpressure.
    pending.push(tailBytes === tail.length ? tail : Buffer.from(tail.subarray(0, tailBytes)))
    tail = null; tailBytes = 0
    peakQueuedBuffers = Math.max(peakQueuedBuffers, pending.length)
  }
  const flush = (): Promise<void> => {
    if (!pump) {
      pump = (async () => {
        await new Promise<void>(resolveYield => setImmediate(resolveYield))
        while ((pending.length || tailBytes) && !failure && !discarded) {
          sealTail()
          const chunk = pending.shift()!
          pendingBytes -= chunk.length
          writes++
          if (!stream.write(chunk)) await drain()
          await new Promise<void>(resolveYield => setImmediate(resolveYield))
        }
      })().catch(fail).finally(() => { pump = null })
    }
    return pump
  }
  return {
    path,
    write(chunk: Uint8Array) {
      if (failure || discarded) return
      if (ending) { fail(new Error('Download chunk arrived after completion')); return }
      if (!chunk.byteLength) return
      if (stream.writableLength + pendingBytes + chunk.byteLength > MAX_DOWNLOAD_BUFFER_BYTES || bytes + chunk.byteLength > expectedBytes) {
        fail(new Error('Download exceeded its disk buffer or expected byte boundary'))
        return
      }
      bytes += chunk.byteLength
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        if (!tail) tail = Buffer.allocUnsafe(Math.min(WRITE_BATCH_BYTES, expectedBytes - bytes + chunk.length - offset))
        const take = Math.min(tail.length - tailBytes, chunk.length - offset)
        tail.set(chunk.subarray(offset, offset + take), tailBytes)
        tailBytes += take; pendingBytes += take; offset += take
        if (tailBytes === tail.length) sealTail()
      }
      peakQueuedBuffers = Math.max(peakQueuedBuffers, pending.length + (tail ? 1 : 0))
      peakBufferedBytes = Math.max(peakBufferedBytes, stream.writableLength + pendingBytes)
      void flush()
    },
    /** Lets paced sources yield until coalesced buffers reach the OS writer. */
    flush,
    getMetrics: () => ({ writes, peakBufferedBytes, receivedBytes: bytes, peakQueuedBuffers }),
    async finish(): Promise<StagedRecording> {
      ending = true
      await flush()
      stream.end()
      await completion
      if (failure) throw failure
      if (bytes !== expectedBytes) throw new Error(`File size mismatch: expected ${expectedBytes}, received ${bytes}`)
      return { path, length: bytes, sha256: hash.digest('hex') }
    },
    async discard() {
      discarded = true
      pending.length = 0; pendingBytes = 0
      tail = null; tailBytes = 0
      stream.destroy()
      await pump
      await completion.catch(() => undefined)
      try { await rm(path, { force: true }) }
      finally { activeStagingFiles.delete(resolve(path)) }
    }
  }
}
