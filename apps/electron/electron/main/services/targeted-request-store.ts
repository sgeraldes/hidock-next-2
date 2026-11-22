import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { createHash } from 'crypto'

export interface TargetedReceipt {
  fingerprint: string
  jobs: Array<{ recordingId: string; queueItemId?: string; status: string }>
}

function storePath(): string { return join(app.getPath('userData'), 'targeted-transcription-requests.json') }
function read(): Record<string, TargetedReceipt> {
  const path = storePath()
  if (!existsSync(path)) return Object.create(null) as Record<string, TargetedReceipt>
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (!data || data.version !== 1 || !data.requests || typeof data.requests !== 'object') throw new Error('Directed request store is invalid')
  return Object.assign(Object.create(null), data.requests) as Record<string, TargetedReceipt>
}
export function requestFingerprint(ids: string[], provider: string): string {
  return createHash('sha256').update(JSON.stringify({ ids: [...new Set(ids)].sort(), provider })).digest('hex')
}
export function findTargetedReceipt(requestId: string, fingerprint: string): TargetedReceipt | undefined {
  const receipt = read()[requestId]
  if (receipt && receipt.fingerprint !== fingerprint) throw new Error('requestId already used with different parameters')
  return receipt
}
export function saveTargetedReceipt(requestId: string, receipt: TargetedReceipt): void {
  const requests = read()
  if (!requests[requestId] && Object.keys(requests).length >= 1000) throw new Error('Directed request store capacity reached')
  requests[requestId] = receipt
  const path = storePath()
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, requests }), 'utf8')
  renameSync(temporary, path)
}

export function admittedTargetedQueueIds(): Set<string> {
  const ids = new Set<string>()
  for (const receipt of Object.values(read())) {
    for (const job of receipt.jobs ?? []) if (typeof job.queueItemId === 'string') ids.add(job.queueItemId)
  }
  return ids
}
