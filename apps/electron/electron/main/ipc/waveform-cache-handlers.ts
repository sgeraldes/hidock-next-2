import { ipcMain } from 'electron'
import { queryOne, updateRecordingDuration } from '../services/database'
import {
  getWaveformCache,
  setWaveformCache,
  clearWaveformCache,
  type WaveformCacheEntry
} from '../services/waveform-cache'
import {
  cancelWaveformDecode,
  getWaveformSourceIdentity,
  requestWaveformDecode,
  sameWaveformSource,
  WAVEFORM_MAX_CHANNELS,
  WAVEFORM_PEAKS,
  type WaveformSourceIdentity
} from '../services/waveform-stream-decoder'

/** IPC handlers for the disk-backed waveform cache and bounded cache-miss generation. */
export function registerWaveformCacheHandlers(): void {
  ipcMain.handle('waveform:getCache', async (event, recordingId: string, _fileSize?: number, requestId?: string) => {
    const row = queryOne<{ file_path: string | null; duration_seconds: number | null }>(
      'SELECT file_path, duration_seconds FROM recordings WHERE id = ?', [recordingId]
    )
    if (!row?.file_path) return null

    let before: WaveformSourceIdentity
    try { before = getWaveformSourceIdentity(row.file_path) }
    catch { return null }

    const cached = getWaveformCache(recordingId, before.size, before.fingerprint)
    if (isDisplayReady(cached, before)) return cached
    // Playback checks are read-only. Only the selected-row loader supplies an id
    // and may request bounded generation, so clicking Play never waits on FFmpeg.
    if (!requestId || requestId.length > 120) return null

    const owner = `${event.sender.id}:${requestId}`
    const cancelForRendererExit = () => cancelWaveformDecode(owner)
    const cancelForNavigation = (_navigationEvent: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !isInPlace) cancelForRendererExit()
    }
    event.sender.once('destroyed', cancelForRendererExit)
    event.sender.once('render-process-gone', cancelForRendererExit)
    event.sender.on('did-start-navigation', cancelForNavigation)
    try {
      const decoded = await requestWaveformDecode(before.canonicalPath, owner)
      const current = queryOne<{ file_path: string | null; duration_seconds: number | null }>(
        'SELECT file_path, duration_seconds FROM recordings WHERE id = ?', [recordingId]
      )
      if (!current?.file_path) return null
      const after = getWaveformSourceIdentity(current.file_path)
      if (!sameWaveformSource(before, after) || !sameWaveformSource(decoded.sourceIdentity, after)) return null

      const saved = setWaveformCache(
        recordingId,
        decoded.peaks,
        decoded.durationSeconds,
        after.size,
        false,
        decoded.channels,
        after.fingerprint
      )
      if (!saved) return null

      // Only backfill an unknown DB duration after the current row and source
      // identity have been revalidated. Do not overwrite existing metadata.
      if (current.duration_seconds == null) {
        try { updateRecordingDuration(recordingId, decoded.durationSeconds, 'file') }
        catch (error) { console.warn('[WaveformCache] Duration backfill failed:', recordingId, error) }
      }
      const generated = getWaveformCache(recordingId, after.size, after.fingerprint)
      return isDisplayReady(generated, after) ? generated : null
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Waveform decode cancelled') {
        console.warn('[WaveformCache] Streaming waveform generation failed:', recordingId, error)
      }
      return null
    } finally {
      event.sender.removeListener('destroyed', cancelForRendererExit)
      event.sender.removeListener('render-process-gone', cancelForRendererExit)
      event.sender.removeListener('did-start-navigation', cancelForNavigation)
    }
  })

  ipcMain.handle('waveform:cancelGeneration', (event, requestId: string) => {
    if (!requestId || requestId.length > 120) return false
    return cancelWaveformDecode(`${event.sender.id}:${requestId}`)
  })

  ipcMain.handle(
    'waveform:setCache',
    async (_event, recordingId: string, peaks: number[], duration?: number, fileSize?: number, channels?: number[][]) => {
      return setWaveformCache(recordingId, peaks, duration ?? 0, fileSize ?? 0, false, channels)
    }
  )

  ipcMain.handle('waveform:clearCache', async (_event, recordingId: string) => clearWaveformCache(recordingId))
  console.log('[WaveformCache] IPC handlers registered')
}

function isDisplayReady(entry: WaveformCacheEntry | null, identity: WaveformSourceIdentity): entry is WaveformCacheEntry {
  if (!entry || entry.coarse) return false
  // Keep complete v2 entries that predate source fingerprints usable when
  // their original file-size check still matches. New entries get strict
  // metadata identity validation, including same-size replacements.
  if (entry.sourceFingerprint
    ? entry.sourceFingerprint !== identity.fingerprint
    : entry.fileSize !== identity.size) return false
  if (!Number.isFinite(entry.duration) || entry.duration <= 0 || entry.fileSize !== identity.size) return false
  const valid = (values: number[] | undefined) =>
    Array.isArray(values) && values.length === WAVEFORM_PEAKS && values.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
  return !!entry.channels && entry.channels.length >= 1 && entry.channels.length <= WAVEFORM_MAX_CHANNELS &&
    valid(entry.peaks) && entry.channels.every(valid)
}
