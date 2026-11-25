import { MIN_MEETING_CONFIDENCE } from '../../../src/shared/meeting-confidence'
import { watch, existsSync, statSync, readdirSync, openSync, fstatSync, readSync, closeSync } from 'fs'
import { RECORDING_AUDIO_EXTENSIONS } from '../../../src/shared/audio-extensions'
import { isPcRecordingFilename } from '../../../src/shared/pc-recording'
import { join, extname, basename } from 'path'
import { randomUUID } from 'crypto'
import { getRecordingsPath } from './file-storage'
import { parseHiDockFilenameDateIso } from './hidock-filename'
import {
  getRecordingByFilenameVariants,
  insertRecording,
  isFilePurged,
  getMeetings,
  linkRecordingToMeeting,
  updateRecordingLifecycle,
  Recording
} from './database'
import { BrowserWindow } from 'electron'
import { queueTranscriptionIfEnabled } from './transcription'
import { profileNewRecording } from './audio-profile-store'
import { isNativeFileManualOnly } from './device-native-file-policy'

const AUDIO_EXTENSIONS: readonly string[] = RECORDING_AUDIO_EXTENSIONS

let watcher: ReturnType<typeof watch> | null = null
let mainWindow: BrowserWindow | null = null
let isWatching = false

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function startRecordingWatcher(): void {
  if (isWatching) {
    console.log('Recording watcher already running')
    return
  }

  const recordingsPath = getRecordingsPath()

  if (!existsSync(recordingsPath)) {
    console.log('Recordings path does not exist:', recordingsPath)
    return
  }

  console.log('Starting recording watcher at:', recordingsPath)

  // First, scan existing files that haven't been processed
  scanExistingRecordings()

  // Watch for new files
  watcher = watch(recordingsPath, { persistent: true }, (eventType, filename) => {
    if (eventType === 'rename' && filename) {
      const ext = extname(filename).toLowerCase()
      if (AUDIO_EXTENSIONS.includes(ext)) {
        const filePath = join(recordingsPath, filename)
        // Wait a moment for file to be fully written
        setTimeout(() => {
          if (existsSync(filePath)) {
            processNewRecording(filePath)
          }
        }, 1000)
      }
    }
  })

  isWatching = true
  console.log('Recording watcher started')
}

export function stopRecordingWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
    isWatching = false
    console.log('Recording watcher stopped')
  }
}

async function scanExistingRecordings(): Promise<void> {
  const recordingsPath = getRecordingsPath()

  if (!existsSync(recordingsPath)) return

  const files = readdirSync(recordingsPath)
  const audioFiles = files.filter(file => {
    const ext = extname(file).toLowerCase()
    return AUDIO_EXTENSIONS.includes(ext)
  })

  if (audioFiles.length === 0) return

  console.log(`[RecordingWatcher] Scanning ${audioFiles.length} existing recordings...`)

  // Batch check: which files need processing
  const filesToProcess: string[] = []

  for (const file of audioFiles) {
    const filePath = join(recordingsPath, file)

    // Check if already in database by filename (any extension variant).
    // Rows with missing file_path or stale on_local=0 flags are reprocessed
    // so processNewRecording can repair their lifecycle columns.
    const existing = getRecordingByFilenameVariants(file)
    if (!existing || !existing.file_path || !existing.on_local) {
      filesToProcess.push(filePath)
    }
  }

  if (filesToProcess.length === 0) {
    console.log('[RecordingWatcher] All recordings already in database')
    return
  }

  console.log(`[RecordingWatcher] Processing ${filesToProcess.length} new recordings...`)

  // Process files - this is the slow part, but we need to check meeting correlation
  // Process in batches to avoid blocking the event loop too long
  const batchSize = 50
  for (let i = 0; i < filesToProcess.length; i += batchSize) {
    const batch = filesToProcess.slice(i, i + batchSize)
    await Promise.all(batch.map(filePath => processNewRecording(filePath)))

    // Log progress for large batches
    if (filesToProcess.length > 100 && (i + batchSize) % 100 === 0) {
      console.log(`[RecordingWatcher] Processed ${Math.min(i + batchSize, filesToProcess.length)}/${filesToProcess.length} recordings...`)
    }
  }

  console.log(`[RecordingWatcher] Finished scanning ${filesToProcess.length} recordings`)
}

function generateRecordingId(_filePath: string): string {
  return randomUUID()
}

/**
 * Was this file permanently deleted in the app? A purge removes the recording
 * and leaves filename tombstones (every name variant, see purgeRecording), but
 * it keeps the audio file in the recordings folder. Without this check the
 * folder scan re-imported every purged file on the next start: on 25-sep all
 * 22 purged files still on disk were back in the library.
 */
export function isPurgedFile(filename: string): boolean {
  const variants = new Set([
    filename,
    filename.replace(/\.hda$/i, '.wav'),
    filename.replace(/\.wav$/i, '.hda'),
    filename.replace(/\.(hda|wav)$/i, '.mp3'),
  ])
  return [...variants].some((v) => isFilePurged(v))
}

/** New captures default to manual offline transcription, independently of the
 * global auto-transcribe setting. Filename identity survives missing/corrupt
 * manifests and crash recovery. Legacy device/live files keep their policy. */
export function shouldAutomaticallyTranscribeRecording(filePath: string): boolean {
  if (isNativeFileManualOnly(filePath)) return false
  if (!/\.wav$/i.test(filePath)) return true
  const newCapture = /-Capture-Live(?:-\d+)?(?:\.channel-\d+)?\.wav$/i.test(basename(filePath))
  const sidecar = filePath.replace(/\.wav$/i, '.live.json')
  if (!existsSync(sidecar)) return !newCapture
  let fd: number | null = null
  try {
    fd = openSync(sidecar, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024) return !newCapture
    const bytes = Buffer.alloc(stat.size)
    let read = 0
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read)
      if (!count) return !newCapture
      read += count
    }
    const note: unknown = JSON.parse(bytes.toString('utf8'))
    if (!note || typeof note !== 'object' || Array.isArray(note)) return !newCapture
    const metadata = note as Record<string, unknown>
    const capture = metadata.capture && typeof metadata.capture === 'object' && !Array.isArray(metadata.capture)
      ? metadata.capture as Record<string, unknown> : null
    const owned = newCapture || typeof metadata.captureSessionId === 'string' || typeof capture?.sessionId === 'string'
    if (!owned) return true
    // Only an explicit, internally consistent owner policy can enable automatic
    // offline work. Live AI opt-in does not imply a second offline provider run.
    return capture?.schemaVersion === 1 && capture.automaticTranscription === true &&
      typeof metadata.captureSessionId === 'string' && metadata.captureSessionId.length > 0 &&
      capture.sessionId === metadata.captureSessionId
  } catch {
    return !newCapture
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

async function processNewRecording(filePath: string): Promise<void> {
  try {
    const filename = basename(filePath)
    // PC files belong exclusively to the shared import/recovery path. An orphaned
    // copy from a failed insert must never become a duplicate device row.
    if (isPcRecordingFilename(filename)) return
    const stats = statSync(filePath)

    // Match any extension variant of the same base name — device rows are .hda
    // while downloads are saved as .wav/.mp3 (the old .mp3-only check missed
    // .wav downloads and created duplicate rows).
    const existing = getRecordingByFilenameVariants(filename)

    if (existing) {
      if (!existing.file_path) {
        updateRecordingLifecycle(existing.id, {
          file_path: filePath,
          on_local: 1,
          location: existing.on_device ? 'both' : 'local-only'
        })
      } else if (!existing.on_local) {
        // Repair rows left mislabeled by earlier bugs: file exists locally but
        // lifecycle flags still say device-only.
        updateRecordingLifecycle(existing.id, {
          on_local: 1,
          location: existing.on_device ? 'both' : 'local-only'
        })
      }
      return
    }

    // The HiDock filename carries the AUTHORITATIVE recording start
    // (2026Jul23-190839-…). mtime is only the ARRIVAL time (copy/download) —
    // using it silently shifts the recording's timeline and breaks meeting
    // correlation (the 2026-07-23 Rec39a-d mp3 incident). Fall back to mtime
    // only for names that carry no date.
    // A purged recording stays purged even though its file is still here.
    if (isPurgedFile(filename)) return

    const dateRecorded = parseHiDockFilenameDateIso(filename) ?? stats.mtime.toISOString()

    const recordingId = generateRecordingId(filePath)

    const recording: Omit<Recording, 'created_at'> = {
      id: recordingId,
      filename: filename,
      original_filename: filename,
      file_path: filePath,
      file_size: stats.size,
      duration_seconds: undefined,
      date_recorded: dateRecorded,
      meeting_id: undefined,
      correlation_confidence: undefined,
      correlation_method: undefined,
      status: 'none',
      location: 'local-only',
      on_device: 0,
      on_local: 1,
      transcription_status: 'none',
      source: 'hidock',
      is_imported: 0
    }

    insertRecording(recording)

    correlateWithMeeting(recordingId, new Date(dateRecorded))

    // The Library hears of the recording before its queue entry (the lazy
    // import used to give this order by accident; now it is on purpose).
    notifyRenderer('recording:new', { recording })

    try {
      if (shouldAutomaticallyTranscribeRecording(filePath)) queueTranscriptionIfEnabled(recordingId)
    } catch (err) {
      console.error('[RecordingWatcher] Failed to queue transcription:', err)
    }

    // The audio check (silent, noise only, too short, where the sound is) for
    // the new file now, rather than at the next launch.
    profileNewRecording(recordingId)
      .catch((err) => console.error('[RecordingWatcher] The audio check failed:', err))
  } catch (error) {
    console.error('Error processing recording:', error)
  }
}

function correlateWithMeeting(recordingId: string, recordingDate: Date): void {
  try {
    // Get meetings around the recording time (within 2 hours before/after)
    const startRange = new Date(recordingDate.getTime() - 2 * 60 * 60 * 1000)
    const endRange = new Date(recordingDate.getTime() + 2 * 60 * 60 * 1000)

    const meetings = getMeetings(startRange.toISOString(), endRange.toISOString())

    if (meetings.length === 0) {
      console.log('No meetings found for correlation')
      return
    }

    // Find the best matching meeting
    let bestMatch: { meetingId: string; confidence: number; method: string } | null = null

    for (const meeting of meetings) {
      const meetingStart = new Date(meeting.start_time)
      const meetingEnd = new Date(meeting.end_time)

      // Check if recording falls within meeting time
      if (recordingDate >= meetingStart && recordingDate <= meetingEnd) {
        // Recording is during meeting - high confidence
        const confidence = 0.9
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = {
            meetingId: meeting.id,
            confidence,
            method: 'time_overlap'
          }
        }
      } else {
        // Check if recording is close to meeting start/end
        const timeDiff = Math.min(
          Math.abs(recordingDate.getTime() - meetingStart.getTime()),
          Math.abs(recordingDate.getTime() - meetingEnd.getTime())
        )

        // Within 15 minutes of meeting
        if (timeDiff <= 15 * 60 * 1000) {
          const confidence = 0.7 - timeDiff / (30 * 60 * 1000) * 0.3
          if (!bestMatch || confidence > bestMatch.confidence) {
            bestMatch = {
              meetingId: meeting.id,
              confidence,
              method: 'time_proximity'
            }
          }
        }
      }
    }

    if (bestMatch && bestMatch.confidence >= MIN_MEETING_CONFIDENCE) {
      const linked = linkRecordingToMeeting(
        recordingId,
        bestMatch.meetingId,
        bestMatch.confidence,
        bestMatch.method
      )
      if (linked) {
        console.log(
          `Linked recording ${recordingId} to meeting ${bestMatch.meetingId} (confidence: ${bestMatch.confidence})`
        )
      }
    }
  } catch (error) {
    console.error('Error correlating recording with meeting:', error)
  }
}

function notifyRenderer(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

export function getWatcherStatus(): { isWatching: boolean; path: string } {
  return {
    isWatching,
    path: getRecordingsPath()
  }
}
