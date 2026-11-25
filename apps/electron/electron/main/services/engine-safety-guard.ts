/**
 * The database engine version this app was written against.
 *
 * In November 2026 the app loaded a packages/database dist older than its
 * source. That engine predated the pre-migration snapshot, and the v72
 * migration ran on the owner's library without one. `@hidock/database` exports
 * ENGINE_SAFETY_VERSION (see the history next to it in engine.ts). The boot
 * that may migrate refuses an engine older than REQUIRED_ENGINE_SAFETY_VERSION;
 * the opens that never migrate only log it.
 *
 * Raise this together with the engine's constant when the app starts relying
 * on a new engine safety behaviour.
 */
export const REQUIRED_ENGINE_SAFETY_VERSION = 4

export type EngineSafetyCheck =
  | { ok: true; loaded: number; required: number }
  | { ok: false; loaded: number; required: number; message: string }

/**
 * Compare the loaded engine's exported version with the required one. A dist
 * from before the constant existed exports nothing: that reads as 0.
 */
export function checkEngineSafety(loadedExport: unknown, required: number = REQUIRED_ENGINE_SAFETY_VERSION): EngineSafetyCheck {
  const loaded = typeof loadedExport === 'number' && Number.isFinite(loadedExport) ? loadedExport : 0
  if (loaded >= required) return { ok: true, loaded, required }
  return {
    ok: false,
    loaded,
    required,
    message:
      `[Database] The loaded database engine has safety version ${loaded}; this app needs ${required}. ` +
      'It is older than the code this app was built with, so it may migrate the library without the ' +
      'safeguards the app expects (the pre-migration backup, the migration audit). ' +
      'Rebuild packages/database (npm --prefix packages/database run build) or rebuild the app.',
  }
}
