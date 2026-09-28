/**
 * Changing where recordings or transcripts live (Settings > Storage).
 *
 * A move copies every file to the new folder, checks each copy, rewrites the
 * stored absolute paths, switches the setting and restarts the folder watcher.
 * The originals stay where they were; deleting them is the person's call.
 *
 * Safety rules, from the storage review (28-sep-2026):
 *  - One move at a time, taken before any await.
 *  - Downloads and transcription are paused, and the folder watcher stopped
 *    (with its delayed callbacks drained), for the whole move, so nothing new
 *    is written to the old folder while it is being copied.
 *  - The new folder must be empty (or not exist yet): nothing there is ever
 *    overwritten or mistaken for a copy.
 *  - Each file is copied to a .partial name, checked and only then renamed.
 *  - Any unreadable folder or file fails the move; nothing is switched.
 *  - Stop is honoured during a file and right before the switch; a stopped
 *    move deletes what it copied and switches nothing.
 *  - Paths are rewritten in code, not with SQL character offsets (drive roots,
 *    UNC shares and non-BMP characters all work); if the setting cannot be
 *    saved afterwards the paths are put back.
 *  - The move runs only if the folder still matches what the person confirmed.
 *
 * "Switch without moving" is allowed only while the current folder is empty:
 * playback reads files only under the configured folder, so switching with
 * files left behind would make them unplayable.
 *
 * The data folder is not moved: it holds the open database. Changing it points
 * HiDock at whatever library is in the new folder after a restart.
 */
import { promises as fs, createReadStream, createWriteStream, existsSync } from 'fs'
import { pipeline } from 'stream/promises'
import { dirname, join, relative, resolve, sep } from 'path'
import { getConfig, updateConfig } from './config'
import { getRecordingsPath, getTranscriptsPath, initializeFileStorage } from './file-storage'
import { queryAll, run, runInTransaction } from './database'
import { startRecordingWatcher, stopRecordingWatcher } from './recording-watcher'
import { getDownloadService } from './download-service'
import { getQueueState, pauseQueue, resumeQueue } from './transcription'
import { setMovingFolder } from './storage-move-state'

export type MovableFolder = 'recordings' | 'transcripts'

export interface MovePlan {
  folder: MovableFolder | 'data'
  from: string
  to: string
  files: number
  bytes: number
  targetFreeBytes: number | null
  /** The target already holds files (a move then refuses; a data folder may hold a library). */
  targetHasFiles: boolean
  targetHasDatabase?: boolean
  /** Only when the current folder is empty (see the header). */
  canSwitchWithoutMoving: boolean
  /** Why the move cannot start, in words; null when it can. */
  blocker: string | null
}

export interface MoveProgress {
  folder: MovableFolder
  copiedFiles: number
  totalFiles: number
  copiedBytes: number
  totalBytes: number
}

/** Delay of the watcher's per-file callback, plus margin (recording-watcher.ts). */
const WATCHER_DRAIN_MS = 1500
const BUSY_WAIT_STEP_MS = 500
const BUSY_WAIT_MAX_MS = 10 * 60_000

function key(p: string): string {
  return resolve(p).toLowerCase()
}

function withSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep
}

/** True when a and b are the same folder or one contains the other. */
function overlaps(a: string, b: string): boolean {
  const x = withSep(key(a))
  const y = withSep(key(b))
  return x.startsWith(y) || y.startsWith(x)
}

function currentPath(folder: MovableFolder | 'data'): string {
  if (folder === 'recordings') return getRecordingsPath()
  if (folder === 'transcripts') return getTranscriptsPath()
  return getConfig().storage.dataPath
}

/** Every file under root with its size. Any unreadable folder or file throws. */
async function listFilesStrict(root: string): Promise<Array<{ path: string; size: number }>> {
  if (!existsSync(root)) return []
  const out: Array<{ path: string; size: number }> = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
      throw new Error(`Cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    })
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        const st = await fs.stat(full).catch((err: unknown) => {
          throw new Error(`Cannot read ${full}: ${err instanceof Error ? err.message : String(err)}`)
        })
        out.push({ path: full, size: st.size })
      }
    }
  }
  return out
}

function downloadsRunning(): boolean {
  try {
    return getDownloadService().getState().queue.some((item) => item.status === 'downloading')
  } catch {
    return false
  }
}

function transcriptionRunning(): boolean {
  try {
    const q = getQueueState()
    return q.isProcessing || q.shortLaneId !== null
  } catch {
    return false
  }
}

let lock: { folder: MovableFolder; cancel: boolean; abort: AbortController } | null = null

export async function planMove(folder: MovableFolder | 'data', to: string, ownLock = false): Promise<MovePlan> {
  const from = currentPath(folder)
  const target = to.trim()
  let files = 0
  let bytes = 0
  let blocker: string | null = null
  try {
    const list = folder === 'data' ? [] : await listFilesStrict(from)
    files = list.length
    bytes = list.reduce((sum, f) => sum + f.size, 0)
  } catch (err) {
    blocker = err instanceof Error ? err.message : String(err)
  }

  let targetFreeBytes: number | null = null
  let targetHasFiles = false
  try {
    const probe = existsSync(target) ? target : dirname(target)
    const s = await fs.statfs(probe)
    targetFreeBytes = s.bavail * s.bsize
    targetHasFiles = existsSync(target) && (await fs.readdir(target)).length > 0
  } catch {
    targetFreeBytes = null
  }

  if (blocker) {
    // unreadable source: keep that reason
  } else if (!target) blocker = 'Choose a folder.'
  else if (key(from) === key(target)) blocker = 'That is already the folder in use.'
  else if (overlaps(from, target)) blocker = 'The new folder cannot be inside the current one, or contain it.'
  else if (lock && !ownLock) blocker = `A move of ${lock.folder} is already running.`
  else if (folder !== 'data' && targetHasFiles) blocker = 'Choose an empty folder: the new folder already has files, and nothing there is overwritten.'
  else if (folder !== 'data' && targetFreeBytes !== null && targetFreeBytes < bytes) blocker = 'The new disk does not have enough free space.'

  const plan: MovePlan = {
    folder,
    from,
    to: target,
    files,
    bytes,
    targetFreeBytes,
    targetHasFiles,
    canSwitchWithoutMoving: folder !== 'data' && files === 0 && !blocker,
    blocker
  }
  if (folder === 'data') plan.targetHasDatabase = existsSync(join(target, 'data', 'hidock.db'))
  return plan
}

const PATH_COLUMNS: Array<[string, string]> = [
  ['recordings', 'file_path'],
  ['synced_files', 'file_path'],
  ['audio_sources', 'local_path']
]

/** Rewrite every stored absolute path under `from` to the same place under `to`. Returns rows changed. */
export function rewriteStoredPaths(from: string, to: string): number {
  const prefix = withSep(resolve(from))
  const next = withSep(resolve(to))
  const prefixKey = prefix.toLowerCase()
  let changed = 0
  runInTransaction(() => {
    for (const [table, column] of PATH_COLUMNS) {
      const rows = queryAll<{ rid: number; p: string }>(
        `SELECT rowid AS rid, ${column} AS p FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`
      )
      for (const row of rows) {
        if (!row.p.toLowerCase().startsWith(prefixKey)) continue
        run(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, [next + row.p.slice(prefix.length), row.rid])
        changed++
      }
    }
  })
  return changed
}

async function copyVerified(src: string, dest: string, size: number, signal: AbortSignal): Promise<void> {
  const partial = `${dest}.partial`
  await fs.mkdir(dirname(dest), { recursive: true })
  try {
    await pipeline(createReadStream(src), createWriteStream(partial, { flags: 'wx' }), { signal })
    const copied = await fs.stat(partial)
    if (copied.size !== size) throw new Error(`The copy of ${src} is incomplete; nothing was switched.`)
    await fs.rename(partial, dest)
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => undefined)
    throw err
  }
}

async function waitUntilIdle(state: { cancel: boolean }): Promise<void> {
  const started = Date.now()
  while (downloadsRunning() || transcriptionRunning()) {
    if (state.cancel) return
    if (Date.now() - started > BUSY_WAIT_MAX_MS) {
      throw new Error('A download or transcription is still running after 10 minutes; try the move again later.')
    }
    await new Promise((r) => setTimeout(r, BUSY_WAIT_STEP_MS))
  }
}

export async function moveFolder(
  folder: MovableFolder,
  to: string,
  expected: { files: number; bytes: number },
  onProgress: (p: MoveProgress) => void
): Promise<{ copiedFiles: number; copiedBytes: number; cancelled: boolean }> {
  // Taken before any await so two clicks cannot both start.
  if (lock) throw new Error(`A move of ${lock.folder} is already running.`)
  const state = { folder, cancel: false, abort: new AbortController() }
  lock = state
  setMovingFolder(folder)

  const downloads = getDownloadService()
  const downloadsWerePaused = downloads.getState().isPaused
  const transcriptionWasPaused = getQueueState().paused
  const copied: string[] = []
  let copiedBytes = 0
  let switched = false
  try {
    if (!downloadsWerePaused) downloads.pause()
    if (!transcriptionWasPaused) pauseQueue()
    if (folder === 'recordings') {
      stopRecordingWatcher()
      await new Promise((r) => setTimeout(r, WATCHER_DRAIN_MS))
    }
    await waitUntilIdle(state)

    // The folder must still be what the person confirmed.
    const plan = await planMove(folder, to, true)
    if (plan.blocker) throw new Error(plan.blocker)
    if (plan.files !== expected.files || plan.bytes !== expected.bytes) {
      throw new Error('The folder changed since you confirmed. Review the move again.')
    }

    const files = await listFilesStrict(plan.from)
    await fs.mkdir(plan.to, { recursive: true })
    for (const f of files) {
      if (state.cancel) break
      const dest = join(plan.to, relative(plan.from, f.path))
      try {
        await copyVerified(f.path, dest, f.size, state.abort.signal)
      } catch (err) {
        if (state.cancel) break
        throw err
      }
      copied.push(dest)
      copiedBytes += f.size
      if (copied.length % 25 === 0 || copied.length === files.length) {
        onProgress({ folder, copiedFiles: copied.length, totalFiles: files.length, copiedBytes, totalBytes: plan.bytes })
      }
    }

    // Last chance to stop before anything irreversible.
    if (state.cancel) {
      for (const p of copied) await fs.rm(p, { force: true }).catch(() => undefined)
      return { copiedFiles: 0, copiedBytes: 0, cancelled: true }
    }

    const configKey = folder === 'recordings' ? 'recordingsPath' : 'transcriptsPath'
    if (folder === 'recordings') rewriteStoredPaths(plan.from, plan.to)
    try {
      await updateConfig('storage', { [configKey]: plan.to })
    } catch (err) {
      if (folder === 'recordings') rewriteStoredPaths(plan.to, plan.from)
      throw err
    }
    switched = true
    await initializeFileStorage()
    return { copiedFiles: copied.length, copiedBytes, cancelled: false }
  } catch (err) {
    // Nothing switched: the copies are not in use, remove them.
    if (!switched) for (const p of copied) await fs.rm(p, { force: true }).catch(() => undefined)
    throw err
  } finally {
    if (folder === 'recordings') startRecordingWatcher() // follows whichever folder is configured now
    if (!transcriptionWasPaused) resumeQueue()
    if (!downloadsWerePaused) downloads.resume()
    setMovingFolder(null)
    lock = null
  }
}

export function cancelMove(): boolean {
  if (!lock) return false
  lock.cancel = true
  lock.abort.abort()
  return true
}

/** Use a new folder while the current one is empty (see the header). */
export async function switchFolder(folder: MovableFolder, to: string): Promise<void> {
  const plan = await planMove(folder, to)
  if (!plan.canSwitchWithoutMoving) {
    throw new Error(plan.blocker ?? 'The current folder has files. Move them, so they stay playable.')
  }
  await fs.mkdir(plan.to, { recursive: true })
  await updateConfig('storage', { [folder === 'recordings' ? 'recordingsPath' : 'transcriptsPath']: plan.to })
  await initializeFileStorage()
  if (folder === 'recordings') {
    stopRecordingWatcher()
    startRecordingWatcher()
  }
}
