import { app } from 'electron'
import { createHash } from 'crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeFileSync } from 'fs'
import { basename, join } from 'path'

// A per-file intent record, never a global setting or a recording classification.
// The hashed stem matches the device .hda and saved .mp3/.wav variants exactly.
const protectedInProcess = new Set<string>()

function identity(filename: string): string {
  return basename(filename.replace(/\\/g, '/')).replace(/\.(mp3|wav|hda)$/i, '').toLowerCase()
}

function policyPath(stem: string): string {
  const digest = createHash('sha256').update(stem).digest('hex')
  return join(app.getPath('userData'), 'native-file-policies', `${digest}.manual-only.json`)
}

function entryExists(path: string, unreadableIsRestricted = true): boolean {
  try {
    lstatSync(path)
    return true // Corrupt content, directories and symlinks retain the restriction.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if (unreadableIsRestricted) return true
    throw error // Registration must never claim durable success from an I/O error.
  }
}

/** Persist before stopping or listing the newly created native test recording.
 * Only a strict basename is accepted; callers must obtain it from native status.
 * A failed write rejects, so the caller cannot treat protection as durable. */
export async function markNativeFileManualOnly(filename: string): Promise<void> {
  if (typeof filename !== 'string' || !filename || filename.length > 255 ||
      filename !== filename.trim() || /[\\/:]/.test(filename) || Array.from(filename).some(char => char.charCodeAt(0) < 32) || filename === '.' || filename === '..') {
    throw new Error('Native recording protection requires a filename basename')
  }
  const stem = identity(filename)
  if (!stem) throw new Error('Native recording filename has no identity')
  protectedInProcess.add(stem)
  const path = policyPath(stem)
  mkdirSync(join(app.getPath('userData'), 'native-file-policies'), { recursive: true })
  if (entryExists(path, false)) return
  const pending = `${path}.pending`
  // A crash during persistence is fail-closed on restart, including partial JSON.
  if (entryExists(pending, false)) {
    renameSync(pending, path)
    return
  }
  const fd = openSync(pending, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify({ schemaVersion: 1, filename, stem, manualOnly: true }) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(pending, path)
}

/** Restricts only automatic download/provider work. Explicit manual APIs retain
 * their authority. Matching intent-file presence is sufficient, so corrupt or
 * interrupted writes never silently enable automatic processing. */
export function isNativeFileManualOnly(filename: string): boolean {
  if (typeof filename !== 'string' || !filename) return false
  const stem = identity(filename)
  if (protectedInProcess.has(stem)) return true
  try {
    const path = policyPath(stem)
    return entryExists(path) || entryExists(`${path}.pending`)
  } catch {
    // No matching intent is known if Electron's userData path is unavailable.
    // Registration rejects in that state; existing policies cannot be registered
    // successfully under another or unavailable userData directory.
    return false
  }
}
