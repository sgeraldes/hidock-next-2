/**
 * Changing where recordings or transcripts live (Settings > Storage). Saving a
 * new folder used to only create it: the files stayed, every recording row
 * kept its old absolute path, the folder watcher kept watching the old folder
 * (settings map, 28-sep-2026). A move now copies the files, checks each copy,
 * rewrites the stored paths in one transaction, switches the setting and
 * restarts the watcher. The originals stay where they were; deleting them is
 * the person's call.
 *
 * The data folder is not moved here: it holds the open database. Changing it
 * points HiDock at whatever library is in the new folder after a restart, and
 * the plan says so before anything changes.
 */
import { promises as fs, existsSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { getConfig, updateConfig } from './config'
import { getRecordingsPath, getTranscriptsPath, initializeFileStorage } from './file-storage'
import { runInTransaction, runNoSave } from './database'
import { startRecordingWatcher, stopRecordingWatcher } from './recording-watcher'
import { getDownloadService } from './download-service'
import { folderSize } from './storage-usage'

export type MovableFolder = 'recordings' | 'transcripts'

export interface MovePlan {
  folder: MovableFolder | 'data'
  from: string
  to: string
  /** Files and bytes that would be copied. */
  files: number
  bytes: number
  /** Free space on the target disk; null when it cannot be read. */
  targetFreeBytes: number | null
  /** The target already holds files (they are kept; same-size files are not copied again). */
  targetHasFiles: boolean
  /** For the data folder: the target already has a HiDock database. */
  targetHasDatabase?: boolean
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

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

function insidePath(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase()
  const p = resolve(parent).toLowerCase()
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

function currentPath(folder: MovableFolder | 'data'): string {
  if (folder === 'recordings') return getRecordingsPath()
  if (folder === 'transcripts') return getTranscriptsPath()
  return getConfig().storage.dataPath
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) out.push(full)
    }
  }
  return out
}

function downloadsRunning(): boolean {
  try {
    return getDownloadService().getState().queue.some((item) => item.status === 'downloading')
  } catch {
    // no download service yet: nothing running
  }
  return false
}

let moving: { folder: MovableFolder; cancel: boolean } | null = null

export async function planMove(folder: MovableFolder | 'data', to: string): Promise<MovePlan> {
  const from = currentPath(folder)
  const target = to.trim()
  const { bytes, files } = await folderSize(from)
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

  let blocker: string | null = null
  if (!target) blocker = 'Choose a folder.'
  else if (samePath(from, target)) blocker = 'That is already the folder in use.'
  else if (insidePath(target, from)) blocker = 'The new folder cannot be inside the current one.'
  else if (moving) blocker = `A move of ${moving.folder} is already running.`
  else if (folder !== 'data' && downloadsRunning()) blocker = 'Downloads are running. Wait for them to finish, or pause them, then move.'
  else if (folder !== 'data' && targetFreeBytes !== null && targetFreeBytes < bytes) blocker = 'The new disk does not have enough free space.'

  const plan: MovePlan = { folder, from, to: target, files, bytes, targetFreeBytes, targetHasFiles, blocker }
  if (folder === 'data') plan.targetHasDatabase = existsSync(join(target, 'data', 'hidock.db'))
  return plan
}

/** Rewrite every stored absolute path under `from` so it points under `to`. */
export function rewriteStoredPaths(from: string, to: string): number {
  const prefix = resolve(from)
  const next = resolve(to)
  const columns: Array<[string, string]> = [
    ['recordings', 'file_path'],
    ['synced_files', 'file_path'],
    ['audio_sources', 'local_path']
  ]
  let changed = 0
  runInTransaction(() => {
    for (const [table, column] of columns) {
      // Windows paths compare case-insensitively; the prefix keeps the separator
      // so F:\Rec does not also match F:\Recordings-old.
      runNoSave(
        `UPDATE ${table} SET ${column} = ? || substr(${column}, ?) WHERE lower(substr(${column}, 1, ?)) = lower(?)`,
        [next + sep, prefix.length + 2, prefix.length + 1, prefix + sep]
      )
      changed++
    }
  })
  return changed
}

export async function moveFolder(
  folder: MovableFolder,
  to: string,
  onProgress: (p: MoveProgress) => void
): Promise<{ copiedFiles: number; copiedBytes: number; cancelled: boolean }> {
  const plan = await planMove(folder, to)
  if (plan.blocker) throw new Error(plan.blocker)
  moving = { folder, cancel: false }
  const state = moving
  let copiedFiles = 0
  let copiedBytes = 0
  try {
    await fs.mkdir(plan.to, { recursive: true })
    const files = await listFiles(plan.from)
    for (const src of files) {
      if (state.cancel) return { copiedFiles, copiedBytes, cancelled: true }
      const dest = join(plan.to, relative(plan.from, src))
      const { size } = await fs.stat(src)
      const existing = await fs.stat(dest).catch(() => null)
      if (!existing || existing.size !== size) {
        await fs.mkdir(dirname(dest), { recursive: true })
        await fs.copyFile(src, dest)
        const copied = await fs.stat(dest)
        if (copied.size !== size) throw new Error(`Copy of ${relative(plan.from, src)} is incomplete; nothing was switched.`)
      }
      copiedFiles++
      copiedBytes += size
      if (copiedFiles % 25 === 0 || copiedFiles === files.length) {
        onProgress({ folder, copiedFiles, totalFiles: files.length, copiedBytes, totalBytes: plan.bytes })
      }
    }

    // Everything is copied: switch in one go.
    if (folder === 'recordings') {
      stopRecordingWatcher()
      rewriteStoredPaths(plan.from, plan.to)
    }
    await updateConfig('storage', { [folder === 'recordings' ? 'recordingsPath' : 'transcriptsPath']: plan.to })
    await initializeFileStorage()
    if (folder === 'recordings') startRecordingWatcher()
    return { copiedFiles, copiedBytes, cancelled: false }
  } finally {
    moving = null
  }
}

export function cancelMove(): boolean {
  if (!moving) return false
  moving.cancel = true
  return true
}

/**
 * Use the new folder as it is: files already recorded stay where they are (their
 * rows still point there), new files go to the new folder, and the watcher
 * follows it.
 */
export async function switchFolder(folder: MovableFolder, to: string): Promise<void> {
  const plan = await planMove(folder, to)
  if (plan.blocker && plan.blocker !== 'The new disk does not have enough free space.') throw new Error(plan.blocker)
  await updateConfig('storage', { [folder === 'recordings' ? 'recordingsPath' : 'transcriptsPath']: plan.to })
  await initializeFileStorage()
  if (folder === 'recordings') {
    stopRecordingWatcher()
    startRecordingWatcher()
  }
}
