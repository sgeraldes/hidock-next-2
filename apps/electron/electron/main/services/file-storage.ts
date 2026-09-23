import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, renameSync } from 'fs'
import { join, basename, extname, resolve, normalize } from 'path'
import { getConfig, getDataPath } from './config'
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
}

export function getRecordingsPath(): string {
  const storage = getConfig().storage
  return storage.recordingsPath || join(getDataPath(), 'recordings')
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
   * file but BEFORE the atomic rename to the final path. When it returns true the
   * temp file is deleted and saveRecording resolves `null` — no final file is ever
   * created, and no pre-existing recording is touched (collisions get a numeric
   * suffix, so the final path is always a fresh name we own).
   */
  isCancelled?: () => boolean
}

export async function saveRecording(
  filename: string,
  data: Buffer,
  meetingSubject?: string,
  originalDate?: Date
): Promise<string>
export async function saveRecording(
  filename: string,
  data: Buffer,
  meetingSubject: string | undefined,
  originalDate: Date | undefined,
  options: SaveRecordingOptions
): Promise<string | null>
export async function saveRecording(
  filename: string,
  data: Buffer,
  _meetingSubject?: string,
  originalDate?: Date,
  options?: SaveRecordingOptions
): Promise<string | null> {
  const recordingsPath = getRecordingsPath()

  // Extract just the base filename without path
  const baseFilename = basename(filename)

  // Validate input filename to prevent any path traversal in the source
  validateFilename(baseFilename)

  // Preserve the original device filename, just change .hda to .wav
  // Device format: 2025Dec15-100105-Rec22.hda -> 2025Dec15-100105-Rec22.wav
  let cleanFilename = baseFilename
  const ext = extname(baseFilename).toLowerCase()
  const isHdaFile = ext === '.hda'
  if (isHdaFile) {
    cleanFilename = baseFilename.slice(0, -4) + '.wav'
  }

  // Validate the final path stays within recordings directory
  let filePath = validatePath(recordingsPath, cleanFilename)

  // Handle filename collision - add suffix if file already exists. This guarantees
  // the final path is ALWAYS a name we are about to create, so cleaning up on cancel
  // can never delete a pre-existing valid recording.
  if (existsSync(filePath)) {
    const nameWithoutExt = cleanFilename.slice(0, cleanFilename.lastIndexOf('.'))
    const extension = cleanFilename.slice(cleanFilename.lastIndexOf('.'))
    let counter = 1
    while (existsSync(filePath)) {
      cleanFilename = `${nameWithoutExt}-${counter}${extension}`
      filePath = validatePath(recordingsPath, cleanFilename)
      counter++
    }
  }

  // Atomic write: stage the bytes in a unique temp `.partial` file, then rename onto
  // the final path (rename is atomic on the same volume). A crash or cancel mid-write
  // leaves only the temp file — never a truncated recording at the real path. The
  // temp is cleaned up on any failure/cancel.
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.partial`

  try {
    writeFileSync(tempPath, data)

    // Cancellation checkpoint — after the bytes are staged, before we publish them.
    if (options?.isCancelled?.()) {
      try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch { /* best-effort */ }
      return null
    }

    renameSync(tempPath, filePath)
  } catch (error) {
    // Never leave a stray temp file behind on failure.
    try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch { /* best-effort */ }
    throw error
  }

  // Set the file's modification time to the original recording date
  // This ensures file explorer shows the correct date
  if (originalDate) {
    try {
      utimesSync(filePath, originalDate, originalDate)
    } catch (error) {
      console.warn('Failed to set file modification time:', error)
    }
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
  data: Buffer,
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

  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.partial`
  const discardTemp = (): void => {
    try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch { /* best-effort */ }
  }

  let seconds: number
  try {
    writeFileSync(tempPath, data)

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

    renameSync(tempPath, targetPath)
  } catch (error) {
    discardTemp()
    throw error
  }

  if (options?.originalDate) {
    try {
      utimesSync(targetPath, options.originalDate, options.originalDate)
    } catch (error) {
      console.warn('Failed to set file modification time:', error)
    }
  }

  return { filePath: targetPath, previousBytes, bytes: data.length, seconds }
}

export async function saveTranscript(
  recordingFilename: string,
  transcript: string,
  format: 'txt' | 'json' = 'txt'
): Promise<string> {
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
      return ['.wav', '.mp3', '.m4a', '.ogg', '.webm', '.hda'].includes(ext)
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
      const data = readFileSync(filePath)
      return data
    }
    return null
  } catch (error) {
    console.error('Error reading recording file:', error)
    return null
  }
}
