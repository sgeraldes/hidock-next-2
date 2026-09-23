/**
 * Truncated-download recovery (2026-09-22).
 *
 * backfillRecordingDurations measures every recording from its audio file and
 * refuses the measurement when the transcript runs past the end of the file:
 * the transcript proves the audio once existed, the file on disk is shorter.
 * On the owner's library that was 47 recordings. Counting them was all the app
 * did; nothing tried to get the audio back.
 *
 * This module decides, for each of them, whether the HiDock still holds a
 * copy worth fetching, and hands the ones that qualify to the ordinary
 * download queue. It never deletes anything and never changes a duration: the
 * file is only replaced once a complete copy has arrived and measured longer
 * (replaceRecordingFile), and the row is only settled by the backfill's own
 * rule after that (remeasureRecordingDuration).
 *
 * What the device holds comes from `device_file_cache`, the listing the
 * renderer persists after every device scan (deviceCache:saveAll). It is the
 * last list the app saw, not a live query: a file listed there may have been
 * deleted from the device since, in which case its download fails in the
 * queue and the local file stays as it was.
 *
 * Only a device copy STRICTLY larger than the local file qualifies. Equal size
 * means the device holds the same bytes, so the audio past the end of the
 * local file was never on the device under this name either; smaller can only
 * lose audio. Both are counted, not queued.
 *
 * The file the device is recording right now is never queued. The main
 * process knows the in-progress filename from the CMD-18 poll; while a
 * recording runs, or while that state has not been read yet, the newest file
 * in the listing is held back as well, since that is the one still growing.
 */

import { statSync } from 'fs'
import { findTruncatedRecordings, queryAll } from './database'
import { getDownloadService, type DownloadSkip, type ReplacementDownload } from './download-service'

/** A truncated recording the device can give back in full. */
export interface RecoverableRecording {
  recordingId: string
  deviceFilename: string
  deviceBytes: number
  localPath: string
  localBytes: number
  dateRecorded?: string
}

export interface TruncatedRecoveryPlan {
  /** Recordings whose transcript runs past the end of their local file. */
  truncated: number
  /** Device holds a strictly larger copy: these can be fetched again. */
  recoverable: RecoverableRecording[]
  /** Device holds a copy of the same size or smaller: fetching gains nothing. */
  deviceNotLarger: number
  /** Not in the device's last file listing: the audio is gone. */
  notOnDevice: number
  /** Would qualify, but the device is (or may be) still writing it. */
  heldBack: number
  /** False when the app has never stored a device listing, so "not on device" is unknown. */
  deviceListKnown: boolean
}

interface DeviceListing {
  filename: string
  size: number | null
  dateCreated: string | null
}

/** Strip the audio extension, so a local .wav matches the device's .hda. */
function baseName(filename: string): string {
  return filename.replace(/\.(hda|wav|mp3)$/i, '')
}

function readDeviceListing(): DeviceListing[] | null {
  try {
    return queryAll<DeviceListing>('SELECT filename, size, dateCreated FROM device_file_cache')
  } catch {
    // The table is created by the first deviceCache:saveAll. No table means the
    // app has never seen the device's file list.
    return null
  }
}

function localSize(path: string): number | null {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

/**
 * Sort the truncated recordings into what can be recovered and why the rest
 * cannot.
 *
 * `activeRecording` is the device's in-progress filename from the recording
 * poll: a string while recording, null when confirmed idle, undefined when the
 * state has not been read (device not connected, poll not started yet).
 */
export function planTruncatedRecovery(activeRecording: string | null | undefined): TruncatedRecoveryPlan {
  const truncated = findTruncatedRecordings()
  const listing = readDeviceListing()
  const plan: TruncatedRecoveryPlan = {
    truncated: truncated.length,
    recoverable: [],
    deviceNotLarger: 0,
    notOnDevice: 0,
    heldBack: 0,
    deviceListKnown: listing !== null && listing.length > 0,
  }
  if (truncated.length === 0) return plan

  const byBase = new Map<string, DeviceListing>()
  for (const entry of listing ?? []) byBase.set(baseName(entry.filename), entry)

  // The file still being written. By name when the poll gave one, and the
  // newest in the listing whenever the device is not confirmed idle.
  const growing = new Set<string>()
  if (activeRecording) growing.add(baseName(activeRecording))
  if (activeRecording !== null && listing && listing.length > 0) {
    const newest = listing.reduce((a, b) => ((b.dateCreated ?? '') > (a.dateCreated ?? '') ? b : a))
    growing.add(baseName(newest.filename))
  }

  for (const recording of truncated) {
    const onDevice = byBase.get(baseName(recording.filename)) ?? byBase.get(baseName(recording.filePath.replace(/^.*[\\/]/, '')))
    if (!onDevice) {
      plan.notOnDevice++
      continue
    }
    const localBytes = localSize(recording.filePath)
    const deviceBytes = onDevice.size ?? 0
    if (localBytes === null || deviceBytes <= localBytes) {
      plan.deviceNotLarger++
      continue
    }
    if (growing.has(baseName(onDevice.filename))) {
      plan.heldBack++
      continue
    }
    plan.recoverable.push({
      recordingId: recording.id,
      deviceFilename: onDevice.filename,
      deviceBytes,
      localPath: recording.filePath,
      localBytes,
      dateRecorded: onDevice.dateCreated ?? undefined,
    })
  }
  return plan
}

export interface TruncatedRecoveryResult {
  plan: TruncatedRecoveryPlan
  /** Device filenames that entered the download queue. */
  queued: string[]
  skipped: DownloadSkip[]
}

/**
 * Build the plan again (never trust a list the renderer kept around) and put
 * every recoverable recording in the download queue as a replacement.
 */
export function queueTruncatedRecovery(activeRecording: string | null | undefined): TruncatedRecoveryResult {
  const plan = planTruncatedRecovery(activeRecording)
  if (plan.recoverable.length === 0) return { plan, queued: [], skipped: [] }

  const files: ReplacementDownload[] = plan.recoverable.map((r) => ({
    filename: r.deviceFilename,
    size: r.deviceBytes,
    dateCreated: r.dateRecorded ? new Date(r.dateRecorded) : undefined,
    replaces: { path: r.localPath, recordingId: r.recordingId },
  }))
  const { queued, skipped } = getDownloadService().queueReplacementDownloads(files)
  console.log(
    `[TruncatedRecovery] ${plan.truncated} truncated: queued ${queued.length}, ` +
      `${plan.deviceNotLarger} with no larger device copy, ${plan.notOnDevice} not on the device, ` +
      `${plan.heldBack} held back while the device records`
  )
  return { plan, queued, skipped }
}
