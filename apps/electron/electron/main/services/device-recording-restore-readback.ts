import { copyRecordingRestoreDescriptor } from '@hidock/jensen-protocol'
import type { JensenDevice, RecordingRestoreSession } from '@hidock/jensen-protocol'

type ReadbackDevice = Pick<JensenDevice, 'isConnected' | 'getModel' | 'getConnectionSessionId' | 'serialNumber' | 'versionNumber' | 'versionCode' |
  'getDeviceInfo' | 'getRecordingFile' | 'listFilesDetailed' | 'readFileRange' | 'getActiveDownloadSettlement'>
export interface RecordingRestoreReadbackResult { status: 'complete' | 'cancelled' | 'error'; received: number }
export const RECORDING_RESTORE_READBACK_RANGE_BYTES = 1024 * 1024

/** Caller already holds the global serializer. Callback must consume chunks synchronously.
 * This verifies a closed owned file and exact byte geometry; the caller verifies full SHA256. */
export async function readOwnedRecordingRestore(device: ReadbackDevice, session: RecordingRestoreSession,
  onChunk: (chunk: Uint8Array) => void, signal?: AbortSignal, onStarted?: () => void): Promise<RecordingRestoreReadbackResult> {
  let received = 0, activated = false
  const result = (status: RecordingRestoreReadbackResult['status']): RecordingRestoreReadbackResult => ({ status, received })
  if (signal?.aborted) return result('cancelled')
  const descriptor = copyRecordingRestoreDescriptor(session)
  if (!descriptor || !session || session.versionNumber !== 393988 || typeof onChunk !== 'function' ||
    onStarted !== undefined && typeof onStarted !== 'function') return result('error')
  const bound = { ...session, ...descriptor }
  const same = () => !signal?.aborted && device.isConnected() && device.getModel() === 'hidock-h1e' &&
    device.versionNumber === 393988 && device.versionCode === '6.3.4' && device.serialNumber === bound.serialNumber &&
    !!bound.serialNumber?.trim() && device.getConnectionSessionId() === bound.connectionSessionId
  const snapshot = async (): Promise<{ version: number; signature: string }> => {
    if (!same()) throw Error('Restore readback owner changed')
    const info = await device.getDeviceInfo()
    if (!same() || !info || info.model !== 'hidock-h1e' || info.versionNumber !== 393988 || info.versionCode !== '6.3.4' || info.serialNumber !== bound.serialNumber) throw Error('Restore readback identity unavailable')
    const active = await device.getRecordingFile()
    if (!same() || !active || active.recording !== null) throw Error('Restore readback native idle unavailable')
    const listing = await device.listFilesDetailed()
    if (!same() || !listing || listing.status !== 'complete' || listing.expectedCount === null ||
      listing.expectedCount !== listing.parsedCount || listing.parsedCount !== listing.files.length) throw Error('Restore readback catalog incomplete')
    const matches = listing.files.filter(file => file.name === bound.filename)
    if (matches.length !== 1 || matches[0].length !== bound.totalBytes || !Number.isSafeInteger(matches[0].version) ||
      typeof matches[0].signature !== 'string') throw Error('Restore readback file binding changed')
    return { version: matches[0].version, signature: matches[0].signature }
  }
  try {
    const original = await snapshot()
    while (received < bound.totalBytes) {
      if (!same()) return result(signal?.aborted ? 'cancelled' : 'error')
      const offset = received, count = Math.min(RECORDING_RESTORE_READBACK_RANGE_BYTES, bound.totalBytes - offset)
      let rangeReceived = 0
      let range
      try {
        range = await device.readFileRange(bound.filename, bound.totalBytes, offset, count, chunk => {
          if (!same() || !(chunk instanceof Uint8Array) || chunk.byteLength < 1 || chunk.byteLength > count - rangeReceived ||
            chunk.byteLength > bound.totalBytes - received) throw Error('Restore readback byte boundary changed')
          rangeReceived += chunk.byteLength; received += chunk.byteLength
          onChunk(chunk)
          if (!same()) throw Error('Restore readback owner changed during consumer')
        }, undefined, signal, () => {
          if (!same()) throw Error('Restore readback owner changed before start')
          if (!activated) { onStarted?.(); activated = true }
          if (!same()) throw Error('Restore readback owner changed before OUT')
        })
      } finally {
        await device.getActiveDownloadSettlement()
      }
      if (signal?.aborted || range?.status === 'cancelled') return result('cancelled')
      if (!same() || !range || range.status !== 'complete' || range.offset !== offset || range.count !== count ||
        range.received !== count || rangeReceived !== count) return result('error')
    }
    const final = await snapshot()
    if (!same() || received !== bound.totalBytes || final.version !== original.version || final.signature !== original.signature) return result('error')
    return result('complete')
  } catch {
    return result(signal?.aborted ? 'cancelled' : 'error')
  }
}
