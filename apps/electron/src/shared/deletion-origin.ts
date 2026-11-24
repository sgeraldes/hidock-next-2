/**
 * Who asked for a deletion (schema v74, deletion_journal and purged_files).
 *
 *  - user:   the owner did it in the app (Move to Trash, Delete permanently, Split).
 *  - system: the app decided on its own (a cleanup or a repair).
 *  - sync:   a device or connector reconciliation removed it.
 *
 * `requestedBy` names the caller or feature, for example 'library:move-to-trash'.
 */
export const DELETION_ORIGINS = ['user', 'system', 'sync'] as const
export type DeletionOrigin = (typeof DELETION_ORIGINS)[number]

export interface DeletionRequest {
  origin: DeletionOrigin
  requestedBy: string
}

/**
 * The renderer features that call recordings:deleteCascade. The IPC handler
 * accepts only these names, so a new caller has to add itself here.
 */
export const RENDERER_DELETION_FEATURES = [
  'library:move-to-trash',
  'library:bulk-move-to-trash',
  'library:delete-permanently',
  'library:bulk-delete-permanently',
  'calendar:move-to-trash',
] as const
export type RendererDeletionFeature = (typeof RENDERER_DELETION_FEATURES)[number]

/** The longest requestedBy the database accepts. */
export const MAX_REQUESTED_BY_LENGTH = 120

export function isDeletionOrigin(value: unknown): value is DeletionOrigin {
  return typeof value === 'string' && (DELETION_ORIGINS as readonly string[]).includes(value)
}
