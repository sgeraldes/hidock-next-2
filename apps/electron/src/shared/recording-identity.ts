/** Shared by discovery and Library projection; filenames alone are not provenance. */
export interface RecordingIdentity {
  id: string
  filename: string
  original_filename?: string | null
  source?: string | null
  is_imported?: number | null
  date_recorded?: string | null
  on_local?: number | null
  deleted_at?: string | null
}

export const recordingStem = (name: string): string =>
  name.replace(/\.(hda|wav|mp3|m4a|aac|ogg|flac)$/i, '').toLowerCase()

export function isHiDockIdentity(row: RecordingIdentity): boolean {
  return row.source === 'hidock' && row.is_imported !== 1
}

function stemTimestamp(name: string): string | undefined {
  const match = /^(\d{4})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{2})-(\d{2})(\d{2})(\d{2})-Rec\d+$/i.exec(recordingStem(name))
  if (!match) return undefined
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[2].toLowerCase()) + 1
  return `${match[1]}-${String(month).padStart(2, '0')}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`
}

function inferredVariant(row: RecordingIdentity, name: string): boolean {
  const timestamp = stemTimestamp(name)
  const recorded = row.date_recorded
  const dateMatches = !!timestamp && !!recorded && (
    recorded === timestamp.slice(0, 10)
    || recorded.slice(0, 19) === timestamp
    || Math.abs(new Date(recorded).getTime() - new Date(timestamp).getTime()) <= 1000
  )
  return isHiDockIdentity(row) && dateMatches
    && [row.filename, row.original_filename ?? ''].some((alias) => recordingStem(alias) === recordingStem(name))
}

/** Explicit identities win; only a unique, verified local conversion may represent a shadow. */
export function resolveDeviceRecording<T extends RecordingIdentity>(name: string, rows: readonly T[]): T | undefined {
  const lower = name.toLowerCase()
  const exact = rows.filter((row) => row.filename.toLowerCase() === lower || row.original_filename?.toLowerCase() === lower)
  // An external import is never a device alias, even if its basename is identical.
  const deviceExact = exact.filter((row) => (row.source == null || row.source === 'hidock') && row.is_imported !== 1)
  const variants = rows.filter((row) => inferredVariant(row, name))
  const local = variants.filter((row) => row.on_local === 1 && !row.deleted_at)
  const explicitLocal = deviceExact.filter((row) => row.on_local === 1)
  if (explicitLocal.length === 1) return explicitLocal[0]
  if (explicitLocal.length > 1) return undefined
  if (deviceExact.length === 1) {
    const identity = deviceExact[0]
    if (!identity.deleted_at && isHiDockIdentity(identity) && inferredVariant(identity, name)
      && local.length === 1) return local[0]
    return identity
  }
  if (deviceExact.length > 1) return undefined
  return variants.length === 1 ? variants[0] : undefined
}

/** Rows remain durable; this maps only verified device shadows to their displayed local identity. */
export function recordingAliases<T extends RecordingIdentity>(rows: readonly T[]): Map<string, T> {
  const aliases = new Map<string, T>()
  for (const row of rows) {
    const name = /\.hda$/i.test(row.original_filename ?? '') ? row.original_filename! : row.filename
    if (!/\.hda$/i.test(name) || !isHiDockIdentity(row)) continue
    const canonical = resolveDeviceRecording(name, rows)
    if (canonical && canonical.id !== row.id && canonical.on_local === 1 && !row.deleted_at) aliases.set(row.id, canonical)
  }
  return aliases
}
