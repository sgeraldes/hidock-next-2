import { cleanupInterruptedDownloads, validateStagedRecording, type StagedRecording } from './download-staging'
import { isOwnedResumedDownload } from './download-resume'
import { isRecoveryMode } from '../recovery-mode'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, renameSync, linkSync, openSync, readSync, closeSync } from 'fs'
import { randomUUID } from 'crypto'
import { RECORDING_AUDIO_EXTENSIONS } from '../../../src/shared/audio-extensions'
import { join, basename, extname, resolve, normalize } from 'path'
import { getConfig, getDataPath } from './config'
import { refuseWhileTranscriptsMove } from './storage-move-state'
import type { AppConfig } from './config'
import { readAudioDuration } from './audio-duration'

export class StorageInitializationError extends Error {
  constructor(
    readonly setting: 'dataPath' | 'recordingsPath' | 'transcriptsPath',
    readonly directory: string,
    cause: unknown
  ) {
    super(`Cannot access storage folder "${directory}": ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'StorageInitializationError'
  }
}

/**
 * Validate that a path stays within the allowed base directory.
 * Prevents path traversal attacks (e.g., "../../../etc/passwd").
 */
export function validatePath(basePath: string, userPath: string): string {
  // Normalize and resolve the paths
  const normalizedBase = normalize(resolve(basePath))
  const resolvedPath = normalize(resolve(basePath, userPath))

  // Check if the resolved path starts with the base path
  if (!resolvedPath.startsWith(normalizedBase)) {
    throw new Error(`Invalid path: path traversal detected. Path must stay within ${normalizedBase}`)
  }

  return resolvedPath
}

/**
 * Validate a filename to prevent path traversal and invalid characters.
 */
export function validateFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Invalid filename: filename is required')
  }

  // Remove any path separators and dangerous characters
  const sanitized = filename.replace(/[\\/:*?"<>|]/g, '')

  // Check for path traversal attempts
  if (filename.includes('..') || filename !== sanitized || !sanitized.length) {
    throw new Error('Invalid filename: contains illegal characters or path traversal attempt')
  }

  // Limit filename length
  if (sanitized.length > 255) {
    throw new Error('Invalid filename: exceeds maximum length of 255 characters')
  }

  return sanitized
}

export interface StorageInfo {
  dataPath: string
  recordingsPath: string
  transcriptsPath: string
  capturesPath: string
  cachePath: string
  databasePath: string
  totalSizeBytes: number
  recordingsCount: number
}

export async function initializeFileStorage(storage: AppConfig['storage'] = getConfig().storage): Promise<void> {
  const dataPath = storage.dataPath || getDataPath()

  const directories: [StorageInitializationError['setting'], string][] = [
    ['dataPath', dataPath],
    ['dataPath', join(dataPath, 'data')],
    [storage.recordingsPath ? 'recordingsPath' : 'dataPath', storage.recordingsPath || join(dataPath, 'recordings')],
    [storage.transcriptsPath ? 'transcriptsPath' : 'dataPath', storage.transcriptsPath || join(dataPath, 'transcripts')],
    ['dataPath', join(dataPath, 'cache')]
  ]

  for (const [setting, dir] of directories) {
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
        console.log(`Created directory: ${dir}`)
      }
      if (!statSync(dir).isDirectory()) throw new Error('Path is not a directory')
    } catch (error) {
      throw new StorageInitializationError(setting, dir, error)
    }
  }
  if (!isRecoveryMode()) await cleanupInterruptedDownloads(storage.recordingsPath || join(dataPath, 'recordings'))
}

export function getRecordingsPath(): string {
  const storage = getConfig().storage
  return storage.recordingsPath || join(getDataPath(), 'recordings')
}

/** Images and imported files (artifact-service): configured, or <dataPath>/artifacts as before. */
export function getCapturesPath(): string {
  const storage = getConfig().storage
  return storage.capturesPath || join(getDataPath(), 'artifacts')
}

export function getTranscriptsPath(): string {
  const storage = getConfig().storage
  return storage.transcriptsPath || join(getDataPath(), 'transcripts')
}

export function getCachePath(): string {
  return join(getDataPath(), 'cache')
}

export function getDatabasePath(): string {
  return join(getDataPath(), 'data', 'hidock.db')
}


/** Options for saveRecording. */
export interface SaveRecordingOptions {
  /**
   * Cancellation predicate. Checked AFTER the data is written to a temp `.partial`
   * file but BEFORE the exclusive publication to the final path. When it returns
   * true the temp file is deleted and saveRecording resolves `null` — no final file
   * is ever created, and no pre-existing recording is touched (collisions get a
   * numeric suffix, so the final path is always a fresh name we own).
   */
  isCancelled?: () => boolean
}

/**
 * The staged bytes could not be published without overwriting or without an
 * atomic operation (hard links unsupported, volume mismatch, name space
 * exhausted). The complete stage is intentionally left where it is.
 */
export class RecordingPublicationError extends Error {
  constructor(message: string, readonly code: string | undefined, cause?: unknown) {
    super(message, { cause })
    this.name = 'RecordingPublicationError'
  }
}

const MAX_PUBLISH_ATTEMPTS = 10_000

/** Bytes of the front of a download read to decide its container; nothing else is read. */
const FORMAT_SNIFF_BYTES = 16

/**
 * True when `head` opens on an ID3v2 tag or a valid MPEG Layer III frame header.
 * The device writes raw MPEG for some recordings, so an `.hda` is not always PCM.
 * A real RIFF/WAVE never matches, and anything unrecognised returns false so the
 * caller keeps the old `.wav` name.
 */
export function isRawMpegAudioHead(head: Buffer): boolean {
  if (head.length >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
    const sizeBytesValid = [6, 7, 8, 9].every((i) => (head[i] & 0x80) === 0)
    return head[3] >= 2 && head[3] <= 4 && head[4] !== 0xff && sizeBytesValid
  }
  if (head.length < 4 || head[0] !== 0xff || (head[1] & 0xe0) !== 0xe0) return false
  const version = (head[1] >> 3) & 3
  const layer = (head[1] >> 1) & 3
  const bitrateIndex = (head[2] >> 4) & 0xf
  const rateIndex = (head[2] >> 2) & 3
  return version !== 1 && layer === 1 && bitrateIndex !== 0 && bitrateIndex !== 15 && rateIndex !== 3
}

/** Extension for a downloaded `.hda`: `.mp3` for recognisable raw MPEG, `.wav` for everything else. */
function hdaExtensionFor(data: Buffer | StagedRecording): '.mp3' | '.wav' {
  try {
    let head: Buffer
    if (Buffer.isBuffer(data)) {
      head = data.subarray(0, FORMAT_SNIFF_BYTES)
    } else {
      const fd = openSync(data.path, 'r')
      try {
        head = Buffer.alloc(FORMAT_SNIFF_BYTES)
        head = head.subarray(0, readSync(fd, head, 0, FORMAT_SNIFF_BYTES, 0))
      } finally {
        closeSync(fd)
      }
    }
    return isRawMpegAudioHead(head) ? '.mp3' : '.wav'
  } catch {
    return '.wav'
  }
}

/**
 * Publish a complete staged file under the first free name, never replacing
 * anything. A hard link is created by the filesystem only if the name is
 * absent (EEXIST otherwise), so a file that appears between any check and this
 * call is never overwritten; only EEXIST moves on to the next numeric suffix.
 * Any other failure (hard links unsupported, other volume, ...) throws: there
 * is no fallback to an overwriting rename or to a non-atomic copy.
 * The caller removes the staging name once this returns.
 */
function publishExclusive(stagedPath: string, recordingsPath: string, cleanFilename: string): string {
  const extension = extname(cleanFilename)
  const stem = cleanFilename.slice(0, cleanFilename.length - extension.length)
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
    const candidate = validatePath(recordingsPath, attempt === 0 ? cleanFilename : `${stem}-${attempt}${extension}`)
    try {
      linkSync(stagedPath, candidate)
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      const reason = error instanceof Error ? error.message : String(error)
      throw new RecordingPublicationError(
        `Cannot publish "${cleanFilename}" atomically without overwriting (hard link failed: ${reason}); the complete staged file was kept`,
        code,
        error
      )
    }
  }
  throw new RecordingPublicationError(
    `Cannot publish "${cleanFilename}": ${MAX_PUBLISH_ATTEMPTS} numbered names are all taken`,
    'EEXIST'
  )
}

export async function saveRecording(
  filename: string,
  data: Buffer | StagedRecording,
  meetingSubject?: string,
  originalDate?: Date
): Promise<string>
export async function saveRecording(
  filename: string,
  data: Buffer | StagedRecording,
  meetingSubject: string | undefined,
  originalDate: Date | undefined,
  options: SaveRecordingOptions
): Promise<string | null>
export async function saveRecording(
  filename: string,
  data: Buffer | StagedRecording,
  _meetingSubject?: string,
  originalDate?: Date,
  options?: SaveRecordingOptions
): Promise<string | null> {
  const recordingsPath = getRecordingsPath()

  // Extract just the base filename without path
  const baseFilename = basename(filename)

  // Validate input filename to prevent any path traversal in the source
  validateFilename(baseFilename)

  // Staged paths are validated before anything reads them.
  if (!Buffer.isBuffer(data)) validateStagedRecording(data, recordingsPath)

  // Preserve the original device filename, just change .hda to .wav, or to .mp3
  // when the bytes are raw MPEG (the 16 front bytes decide; unknown stays .wav).
  // Device format: 2025Dec15-100105-Rec22.hda -> 2025Dec15-100105-Rec22.wav
  let cleanFilename = baseFilename
  const ext = extname(baseFilename).toLowerCase()
  const isHdaFile = ext === '.hda'
  if (isHdaFile) {
    cleanFilename = baseFilename.slice(0, -4) + hdaExtensionFor(data)
  }

  // Validate the final path stays within recordings directory
  validatePath(recordingsPath, cleanFilename)

  // Exclusive publication: stage the complete bytes in a unique temp `.partial`
  // file, then hard-link it under the first free name (a name that exists, or
  // appears at any moment before the link, gets a numeric suffix — the link
  // itself is the existence check, so nothing is ever overwritten) and drop the
  // staging name. A crash or cancel mid-write leaves only the temp file — never
  // a truncated recording at the real path. The final path is ALWAYS a name we
  // just created, so cleaning up on cancel can never delete a pre-existing
  // recording. The temp is cleaned up on any failure/cancel, except that a
  // caller-supplied stage is kept when publication itself is impossible.
  const tempPath = Buffer.isBuffer(data) ? join(recordingsPath, `.hidock-${randomUUID()}.partial`) : data.path
  const preserveResume = !Buffer.isBuffer(data) && isOwnedResumedDownload(data)
  let filePath: string

  try {
    if (Buffer.isBuffer(data)) writeFileSync(tempPath, data)

    // Cancellation checkpoint — after the bytes are staged, before we publish them.
    if (options?.isCancelled?.()) {
      try { if (!preserveResume && existsSync(tempPath)) unlinkSync(tempPath) } catch { /* best-effort */ }
      return null
    }

    if (originalDate) utimesSync(tempPath, originalDate, originalDate)
    filePath = publishExclusive(tempPath, recordingsPath, cleanFilename)
  } catch (error) {
    // Never leave a stray temp file behind on failure. A staged download that
    // could not be published is complete and the caller owns it: keep it.
    const keepStage = preserveResume || (!Buffer.isBuffer(data) && error instanceof RecordingPublicationError)
    try { if (!keepStage && existsSync(tempPath)) unlinkSync(tempPath) } catch { /* best-effort */ }
    throw error
  }

  // The recording is published. A staging name that cannot be removed is a
  // second link to the same bytes: report it, never undo the publication.
  try {
    unlinkSync(tempPath)
  } catch (error) {
    console.warn(`[file-storage] Published ${filePath} but could not remove staging file ${tempPath}:`, error)
  }

  return filePath
}

/** What replaceRecordingFile did, for the caller's log and the row update. */
export interface ReplacedRecordingFile {
  filePath: string
  previousBytes: number
  bytes: number
  seconds: number
}

/**
 * Put a complete copy of a recording in place of a truncated one, at the SAME
 * path.
 *
 * saveRecording never overwrites: a name that exists gets a numeric suffix.
 * That is the right rule for a new download and the wrong one here. A suffixed
 * copy would leave two files for one recording, and every row that points at
 * the old path (recordings.file_path, synced_files) would keep pointing at the
 * short one. The waveform cache notices on its own: it compares file sizes. So this writes beside the target and swaps
 * it in, deliberately, and only after the new bytes prove they are better:
 *
 * - the bytes are staged in a `.partial` next to the target (same volume, so
 *   the rename is atomic);
 * - the staged copy must be strictly larger than the file it replaces and must
 *   measure as longer audio (readAudioDuration, never the container header);
 * - the cancellation predicate is checked after staging, before the swap.
 *
 * Any failure, refusal or cancel deletes the `.partial` and leaves the original
 * file exactly as it was. A refusal throws; a cancel resolves null.
 */
export async function replaceRecordingFile(
  targetPath: string,
  data: Buffer | StagedRecording,
  options?: SaveRecordingOptions & { originalDate?: Date }
): Promise<ReplacedRecordingFile | null> {
  let previousBytes: number
  try {
    const stat = statSync(targetPath)
    if (!stat.isFile()) throw new Error('not a file')
    previousBytes = stat.size
  } catch {
    throw new Error(`Cannot replace "${targetPath}": the file to replace is not there`)
  }
  if (data.length <= previousBytes) {
    throw new Error(
      `Refusing to replace "${basename(targetPath)}": the new copy (${data.length} bytes) is not larger than the file on disk (${previousBytes} bytes)`
    )
  }

  if (!Buffer.isBuffer(data)) validateStagedRecording(data, getRecordingsPath())
  const tempPath = Buffer.isBuffer(data) ? join(getRecordingsPath(), `.hidock-${randomUUID()}.partial`) : data.path
  const preserveResume = !Buffer.isBuffer(data) && isOwnedResumedDownload(data)
  const discardTemp = (): void => {
    try { if (!preserveResume && existsSync(tempPath)) unlinkSync(tempPath) } catch { /* best-effort */ }
  }

  let seconds: number
  try {
    if (Buffer.isBuffer(data)) writeFileSync(tempPath, data)

    const staged = readAudioDuration(tempPath)
    const current = readAudioDuration(targetPath)
    if (!staged || staged.seconds <= 0) {
      throw new Error(`Refusing to replace "${basename(targetPath)}": the new copy is not readable audio`)
    }
    if (current && staged.seconds <= current.seconds) {
      throw new Error(
        `Refusing to replace "${basename(targetPath)}": the new copy holds ${staged.seconds.toFixed(1)} s, ` +
          `no more than the ${current.seconds.toFixed(1)} s already on disk`
      )
    }
    seconds = staged.seconds

    if (options?.isCancelled?.()) {
      discardTemp()
      return null
    }

    if (options?.originalDate) utimesSync(tempPath, options.originalDate, options.originalDate)
    renameSync(tempPath, targetPath)
  } catch (error) {
    discardTemp()
    throw error
  }

  return { filePath: targetPath, previousBytes, bytes: data.length, seconds }
}

export async function saveTranscript(
  recordingFilename: string,
  transcript: string,
  format: 'txt' | 'json' = 'txt'
): Promise<string> {
  // Settings > Storage may be moving this folder; a file written now would be left behind.
  refuseWhileTranscriptsMove()
  const transcriptsPath = getTranscriptsPath()

  // Extract just the filename without any path components
  const rawBaseName = basename(recordingFilename, extname(recordingFilename))

  // Validate the base name to prevent path traversal
  const safeName = validateFilename(rawBaseName)
  const filename = `${safeName}.${format}`

  // Validate the final path stays within transcripts directory
  const filePath = validatePath(transcriptsPath, filename)

  writeFileSync(filePath, transcript, 'utf-8')

  return filePath
}

export function readTranscript(filename: string): string | null {
  const transcriptsPath = getTranscriptsPath()

  // Validate filename to prevent path traversal
  const validFilename = validateFilename(filename)
  const filePath = validatePath(transcriptsPath, validFilename)

  if (existsSync(filePath)) {
    return readFileSync(filePath, 'utf-8')
  }

  return null
}

export function getRecordingFiles(): string[] {
  const recordingsPath = getRecordingsPath()

  if (!existsSync(recordingsPath)) {
    return []
  }

  return readdirSync(recordingsPath)
    .filter((file) => {
      const ext = extname(file).toLowerCase()
      return (RECORDING_AUDIO_EXTENSIONS as readonly string[]).includes(ext)
    })
    .map((file) => join(recordingsPath, file))
}

export function getStorageInfo(): StorageInfo {
  const dataPath = getDataPath()
  const recordingsPath = getRecordingsPath()
  const transcriptsPath = getTranscriptsPath()
  const cachePath = getCachePath()
  const databasePath = getDatabasePath()

  let totalSizeBytes = 0
  let recordingsCount = 0

  // Calculate recordings size
  if (existsSync(recordingsPath)) {
    const files = readdirSync(recordingsPath)

    // Count unique recordings by base filename (pair .hda + .wav = 1 recording)
    const recordingMap = new Set<string>()
    for (const file of files) {
      const filePath = join(recordingsPath, file)
      const stats = statSync(filePath)
      totalSizeBytes += stats.size

      // Extract base filename without extension to count unique recordings
      const baseName = file.replace(/\.(hda|wav|mp3|m4a|aac|ogg|flac|webm|pptx|docx|md|txt|pdf)$/i, '')
      recordingMap.add(baseName)
    }
    recordingsCount = recordingMap.size
  }

  // Add transcripts size
  if (existsSync(transcriptsPath)) {
    const files = readdirSync(transcriptsPath)
    for (const file of files) {
      const filePath = join(transcriptsPath, file)
      const stats = statSync(filePath)
      totalSizeBytes += stats.size
    }
  }

  // Add database size
  if (existsSync(databasePath)) {
    const stats = statSync(databasePath)
    totalSizeBytes += stats.size
  }

  return {
    dataPath,
    recordingsPath,
    transcriptsPath,
    capturesPath: getCapturesPath(),
    cachePath,
    databasePath,
    totalSizeBytes,
    recordingsCount
  }
}

export function deleteRecording(filePath: string): boolean {
  try {
    // Validate that the path is within allowed directories
    const recordingsPath = getRecordingsPath()
    const transcriptsPath = getTranscriptsPath()

    // Normalize the path for comparison
    const normalizedPath = normalize(resolve(filePath))
    const normalizedRecordings = normalize(resolve(recordingsPath))
    const normalizedTranscripts = normalize(resolve(transcriptsPath))

    // Only allow deletion of files within recordings or transcripts directories
    // Use case-insensitive comparison on Windows (paths are case-insensitive)
    const pathToCompare = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
    const recToCompare = process.platform === 'win32' ? normalizedRecordings.toLowerCase() : normalizedRecordings
    const transToCompare = process.platform === 'win32' ? normalizedTranscripts.toLowerCase() : normalizedTranscripts
    if (!pathToCompare.startsWith(recToCompare) && !pathToCompare.startsWith(transToCompare)) {
      console.error('Attempted to delete file outside allowed directories:', filePath)
      return false
    }

    if (existsSync(filePath)) {
      unlinkSync(filePath)
      // A live stream's note of its microphone channel goes with it (realtime-recorder.ts).
      const note = filePath.replace(/\.wav$/i, '.live.json')
      if (note !== filePath && existsSync(note)) unlinkSync(note)
      return true
    }
    return false
  } catch (error) {
    console.error('Error deleting recording:', error)
    return false
  }
}

/**
 * Delete all downloaded recordings with wrong naming format.
 * Wrong format: 2025-12-27_2252.wav (generated during download)
 * Correct format: 2025Dec15-100105-Rec22.wav (preserved from device)
 */
export function deleteWronglyNamedRecordings(): { deleted: string[]; kept: string[] } {
  const recordingsPath = getRecordingsPath()
  const deleted: string[] = []
  const kept: string[] = []

  if (!existsSync(recordingsPath)) {
    return { deleted, kept }
  }

  const files = readdirSync(recordingsPath)
  // Wrong format pattern: YYYY-MM-DD_HHMM (e.g., 2025-12-27_2252)
  const wrongFormatPattern = /^\d{4}-\d{2}-\d{2}_\d{4}/

  for (const file of files) {
    if (wrongFormatPattern.test(file)) {
      const filePath = join(recordingsPath, file)
      try {
        unlinkSync(filePath)
        deleted.push(file)
        console.log(`Deleted wrongly-named file: ${file}`)
      } catch (error) {
        console.error(`Failed to delete ${file}:`, error)
      }
    } else {
      kept.push(file)
    }
  }

  console.log(`Cleanup complete: deleted ${deleted.length} files, kept ${kept.length} files`)
  return { deleted, kept }
}

class PlaybackMemoryLimitError extends Error {}

export function readRecordingFile(filePath: string): Buffer | null {
  try {
    // Validate that the path is within allowed directories
    const recordingsPath = getRecordingsPath()
    const transcriptsPath = getTranscriptsPath()

    // Normalize the path for comparison
    const normalizedPath = normalize(resolve(filePath))
    const normalizedRecordings = normalize(resolve(recordingsPath))
    const normalizedTranscripts = normalize(resolve(transcriptsPath))

    // Only allow reading files within recordings or transcripts directories
    // Use case-insensitive comparison on Windows (paths are case-insensitive)
    const pathToCompare = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
    const recToCompare = process.platform === 'win32' ? normalizedRecordings.toLowerCase() : normalizedRecordings
    const transToCompare = process.platform === 'win32' ? normalizedTranscripts.toLowerCase() : normalizedTranscripts
    if (!pathToCompare.startsWith(recToCompare) && !pathToCompare.startsWith(transToCompare)) {
      console.error('Attempted to read file outside allowed directories:', filePath)
      return null
    }

    if (existsSync(filePath)) {
      // Check after path authorization and before allocating Buffer/base64 IPC copies.
      if (statSync(filePath).size > 64 * 1024 * 1024) {
        throw new PlaybackMemoryLimitError('Audio exceeds the 64MB in-memory playback limit')
      }
      const data = readFileSync(filePath)
      return data
    }
    return null
  } catch (error) {
    if (error instanceof PlaybackMemoryLimitError) throw error
    console.error('Error reading recording file:', error)
    return null
  }
}
