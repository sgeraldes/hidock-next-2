import { createHash } from 'crypto'
import { open, readFile, rename, rm, lstat } from 'fs/promises'
import { join } from 'path'
import type { FileHandle } from 'fs/promises'
import { retainActiveStagingFile, type StagedRecording } from './download-staging'

export const RESUME_RANGE_BYTES = 1024 * 1024
const PROBE_BYTES = 4096
const publicationLeases = new WeakMap<StagedRecording, () => void>()
export interface ResumeSource {
  deviceId: string
  sessionId: string
  model: string
  firmware: string
  filename: string
  size: number
  signature: string
  /** Fresh complete enumeration and native state must establish this is a closed file. */
  listingComplete: boolean
  completed: boolean
}
export interface ResumeRangeResult {
  status: 'complete' | 'cancelled' | 'error'
  offset: number
  count: number
  received: number
  reason: string | null
}
export interface ResumeAdapter {
  snapshot(): Promise<ResumeSource>
  readRange(filename: string, size: number, offset: number, count: number,
    onChunk: (chunk: Uint8Array) => void, signal?: AbortSignal,
    onStarted?: () => void): Promise<ResumeRangeResult>
}
interface Checkpoint {
  version: 1
  identity: Omit<ResumeSource, 'sessionId' | 'listingComplete' | 'completed'>
  committed: number
  sha256: string
  prefixSha256: string
  overlap: { offset: number; count: number; sha256: string }
}
export interface ResumeDownloadOptions {
  directory: string
  expected: ResumeSource
  adapter: ResumeAdapter
  signal?: AbortSignal
  onStarted?: () => void
  onProgress?: (committed: number, total: number) => void
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const identity = (s: ResumeSource): Checkpoint['identity'] => ({ deviceId: s.deviceId, model: s.model,
  firmware: s.firmware, filename: s.filename, size: s.size, signature: s.signature })
function validateSource(s: ResumeSource): void {
  if (!s.listingComplete || !s.completed || [s.deviceId, s.sessionId, s.model, s.firmware].some(value => typeof value !== 'string' || !value.length || value.length > 256) ||
      typeof s.signature !== 'string' || !s.signature.length || s.signature.length > 1024 ||
      !Number.isSafeInteger(s.size) || s.size <= 0 || s.size > 0x7fffffff ||
      typeof s.filename !== 'string' || !s.filename.length || s.filename.length > 120 || /[\\/]/.test(s.filename) || [...s.filename].some(char => char.charCodeAt(0) < 32)) {
    throw new Error('Resume requires a complete listing and a stable completed source file')
  }
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) { const error = new Error('Download cancelled'); error.name = 'AbortError'; throw error }
}
async function readExactly(file: FileHandle, offset: number, count: number): Promise<Buffer> {
  const output = Buffer.alloc(count)
  let received = 0
  while (received < count) {
    const { bytesRead } = await file.read(output, received, count - received, offset + received)
    if (!bytesRead) throw new Error('Resume disk prefix has a gap')
    received += bytesRead
  }
  return output
}
async function persist(path: string, value: Checkpoint): Promise<void> {
  const temporary = `${path}.next`
  const file = await open(temporary, 'w', 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
}

/** Contiguous fsynced ranges. Prefix/overlap checks are bounded evidence, not device full-file attestation. */
export async function downloadWithResume(options: ResumeDownloadOptions): Promise<StagedRecording> {
  const { adapter, directory, signal } = options
  const expected = { ...options.expected }
  validateSource(expected)
  const binding = identity(expected)
  const id = digest(Buffer.from(JSON.stringify(binding)))
  const path = join(directory, `.hidock-resume-${id}.partial`)
  const metadata = join(directory, `.hidock-resume-${id}.json`)
  const release = retainActiveStagingFile(path)
  let file: FileHandle | undefined
  let newPartial = false
  let durableCheckpoint = false
  let handedToPublisher = false
  const sameSource = async () => {
    cancelled(signal)
    const fresh = await adapter.snapshot()
    validateSource(fresh)
    if (fresh.sessionId !== expected.sessionId || JSON.stringify(identity(fresh)) !== JSON.stringify(binding)) {
      throw new Error('Resume source identity or session changed')
    }
  }
  const onStarted = () => { options.onStarted?.() }
  const range = async (offset: number, count: number): Promise<Buffer> => {
    cancelled(signal)
    // One allocation per bounded range; tiny/empty transport callbacks must not
    // create an unbounded array of packet objects or a second full-range concat.
    const output = Buffer.alloc(count)
    let received = 0
    let boundaryError = false
    const result = await adapter.readRange(expected.filename, expected.size, offset, count, bytes => {
      if (received + bytes.length > count) { boundaryError = true; return }
      output.set(bytes, received); received += bytes.length
    }, signal, onStarted)
    cancelled(signal)
    if (boundaryError || result.status !== 'complete' || result.offset !== offset || result.count !== count ||
        result.received !== count || received !== count) throw new Error(`Resume range did not complete its exact boundary: ${result.reason || result.status}`)
    return output
  }
  try {
    await sameSource()
    let checkpoint: Checkpoint | null = null
    try {
      const metadataStat = await lstat(metadata)
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 16384) throw new Error('Unbounded resume checkpoint')
      checkpoint = JSON.parse(await readFile(metadata, 'utf8')) as Checkpoint
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid resume checkpoint', { cause: error }) }
    if (checkpoint) {
      durableCheckpoint = true
      if (checkpoint.version !== 1 || JSON.stringify(checkpoint.identity) !== JSON.stringify(binding) ||
          !Number.isSafeInteger(checkpoint.committed) || checkpoint.committed <= 0 || checkpoint.committed > expected.size ||
          (checkpoint.committed !== expected.size && checkpoint.committed % RESUME_RANGE_BYTES !== 0) ||
          !/^[a-f0-9]{64}$/.test(checkpoint.sha256) || !/^[a-f0-9]{64}$/.test(checkpoint.prefixSha256) ||
          !checkpoint.overlap || checkpoint.overlap.offset !== Math.max(0, checkpoint.committed - PROBE_BYTES) ||
          checkpoint.overlap.count !== Math.min(PROBE_BYTES, checkpoint.committed) || !/^[a-f0-9]{64}$/.test(checkpoint.overlap.sha256)) {
        throw new Error('Resume checkpoint identity or contiguous range is invalid')
      }
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < checkpoint.committed ||
          stat.size > Math.min(expected.size, checkpoint.committed + RESUME_RANGE_BYTES)) throw new Error('Resume disk size is outside committed range')
      file = await open(path, 'r+')
    } else {
      // An orphan partial is never adopted without its committed checkpoint.
      file = await open(path, 'wx+', 0o600)
      newPartial = true
    }
    let committed = checkpoint?.committed ?? 0
    const hash = createHash('sha256')
    for (let at = 0; at < committed; at += RESUME_RANGE_BYTES) hash.update(await readExactly(file, at, Math.min(RESUME_RANGE_BYTES, committed - at)))
    if (checkpoint) {
      if (hash.copy().digest('hex') !== checkpoint.sha256) throw new Error('Resume local prefix hash mismatch')
      const prefixCount = Math.min(PROBE_BYTES, committed)
      const remotePrefix = await range(0, prefixCount)
      const remoteOverlap = await range(checkpoint.overlap.offset, checkpoint.overlap.count)
      if (digest(remotePrefix) !== checkpoint.prefixSha256 || digest(remoteOverlap) !== checkpoint.overlap.sha256) {
        throw new Error('Resume source prefix or checkpoint overlap changed')
      }
      await file.truncate(committed)
      await file.sync()
    }
    let prefixSha256 = checkpoint?.prefixSha256 ?? ''
    while (committed < expected.size) {
      await sameSource()
      const bytes = await range(committed, Math.min(RESUME_RANGE_BYTES, expected.size - committed))
      await sameSource()
      let written = 0
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, committed + written)
        if (!result.bytesWritten) throw new Error('Resume disk write did not advance')
        written += result.bytesWritten
      }
      await file.sync()
      hash.update(bytes)
      if (!prefixSha256) prefixSha256 = digest(bytes.subarray(0, Math.min(PROBE_BYTES, bytes.length)))
      committed += bytes.length
      const overlapCount = Math.min(PROBE_BYTES, committed)
      const overlapBytes = await readExactly(file, committed - overlapCount, overlapCount)
      checkpoint = { version: 1, identity: binding, committed, sha256: hash.copy().digest('hex'), prefixSha256,
        overlap: { offset: committed - overlapCount, count: overlapCount, sha256: digest(overlapBytes) } }
      await persist(metadata, checkpoint)
      durableCheckpoint = true
      options.onProgress?.(committed, expected.size)
      cancelled(signal)
      await new Promise<void>(resolveYield => setImmediate(resolveYield))
    }
    await sameSource()
    if ((await file.stat()).size !== expected.size) throw new Error('Resume completed disk size mismatch')
    await file.sync()
    cancelled(signal)
    await file.close()
    file = undefined
    cancelled(signal)
    const staged = { path, length: committed, sha256: hash.digest('hex') }
    publicationLeases.set(staged, release)
    handedToPublisher = true
    return staged
  } finally {
    try {
      await file?.close()
      // No checkpoint means no committed resumable evidence; remove only this call's new orphan.
      if (newPartial && !durableCheckpoint) {
        await rm(path, { force: true })
        await rm(`${metadata}.next`, { force: true })
      }
    } finally { if (!handedToPublisher) release() }
  }
}

/** Called only after atomic publication; interruption retains its committed checkpoint. */
export async function forgetPublishedResume(staged: StagedRecording): Promise<void> {
  try {
    if (!/\.hidock-resume-[a-f0-9]{64}\.partial$/.test(staged.path)) return
    try {
      await lstat(staged.path)
      throw new Error('Cannot forget an unpublished resume checkpoint')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rm(staged.path.replace(/\.partial$/, '.json'), { force: true })
    await rm(staged.path.replace(/\.partial$/, '.json.next'), { force: true })
  } finally { releaseResumedDownload(staged) }
}

/** Publisher failure/cancel retains the durable partial; release only this exact descriptor's lease. */
export function releaseResumedDownload(staged: StagedRecording): void {
  const release = publicationLeases.get(staged)
  if (release) { publicationLeases.delete(staged); release() }
}
export function isOwnedResumedDownload(staged: StagedRecording): boolean { return publicationLeases.has(staged) }
