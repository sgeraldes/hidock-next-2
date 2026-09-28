/**
 * Space used by each storage location, the free space on the disk it lives
 * on, and its optional limit (Settings > Storage, owner 28-sep-2026). Each
 * location can sit on a different disk, so each gets its own disk numbers.
 * The data folder does not count the recordings or transcripts folders when
 * they sit inside it.
 */
import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import { getConfig, getDataPath } from './config'
import { getRecordingsPath, getTranscriptsPath } from './file-storage'

export type StorageLocationId = 'recordings' | 'transcripts' | 'data'

export interface StorageLocationUsage {
  id: StorageLocationId
  path: string
  bytes: number
  files: number
  /** Optional limit in bytes; null means no limit. */
  limitBytes: number | null
  overLimit: boolean
  /** The disk the location is on; null when it cannot be read. */
  disk: { totalBytes: number; freeBytes: number } | null
}

const GB = 1024 ** 3

function inside(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase()
  const p = resolve(parent).toLowerCase()
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** Total size and file count under a folder, skipping the excluded folders. */
export async function folderSize(root: string, exclude: string[] = []): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue // missing or unreadable: nothing to count there
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!exclude.some((e) => inside(full, e))) stack.push(full)
      } else if (entry.isFile()) {
        try {
          bytes += (await fs.stat(full)).size
          files++
        } catch {
          // removed while counting
        }
      }
    }
  }
  return { bytes, files }
}

async function diskOf(path: string): Promise<StorageLocationUsage['disk']> {
  try {
    const s = await fs.statfs(path)
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }
  } catch {
    return null
  }
}

export function limitBytesFor(id: StorageLocationId): number | null {
  const gb = getConfig().storage.limitsGB?.[id]
  return typeof gb === 'number' && Number.isFinite(gb) && gb > 0 ? gb * GB : null
}

export async function getStorageUsage(): Promise<StorageLocationUsage[]> {
  const recordings = getRecordingsPath()
  const transcripts = getTranscriptsPath()
  const data = getDataPath()
  const locations: Array<{ id: StorageLocationId; path: string; exclude: string[] }> = [
    { id: 'recordings', path: recordings, exclude: [] },
    { id: 'transcripts', path: transcripts, exclude: [] },
    // Recordings and transcripts inside the data folder are counted on their own rows.
    { id: 'data', path: data, exclude: [recordings, transcripts].filter((p) => inside(p, data) && resolve(p) !== resolve(data)) }
  ]
  return Promise.all(
    locations.map(async ({ id, path, exclude }) => {
      const [{ bytes, files }, disk] = await Promise.all([folderSize(path, exclude), diskOf(path)])
      const limitBytes = limitBytesFor(id)
      return { id, path, bytes, files, limitBytes, overLimit: limitBytes !== null && bytes >= limitBytes, disk }
    })
  )
}

const OVER_LIMIT_CACHE_MS = 60_000
let overLimitCache: { at: number; value: boolean } | null = null

/**
 * True when a recordings limit is set and the recordings folder has reached
 * it. Asked on every download cycle, so the answer is kept for a minute.
 */
export async function recordingsOverLimit(now = Date.now()): Promise<boolean> {
  const limit = limitBytesFor('recordings')
  if (limit === null) return false
  if (overLimitCache && now - overLimitCache.at < OVER_LIMIT_CACHE_MS) return overLimitCache.value
  const { bytes } = await folderSize(getRecordingsPath())
  overLimitCache = { at: now, value: bytes >= limit }
  return overLimitCache.value
}

/** Forget the cached answer (a limit changed). */
export function resetStorageLimitCache(): void {
  overLimitCache = null
}
