/**
 * Secrets in the app config never cross to the window (28-sep-2026, settings
 * inventory: `config:get` sent every key and token, decrypted, to the renderer).
 *
 * `config:get` replaces a saved secret with SAVED_SECRET; the renderer only
 * needs to know that one is set. When a save sends SAVED_SECRET back (a form
 * that did not change the field), the main process keeps the stored value.
 */

export const SAVED_SECRET = '__hidock_saved_secret__' // pragma: allowlist secret

/** [section, key] of every secret in AppConfig. */
export const SECRET_CONFIG_FIELDS = [
  ['transcription', 'geminiApiKey'],
  ['transcription', 'localAsrHfToken'],
  ['transcription', 'jevApiKey'],
  ['transcription', 'modelHostToken'],
  ['calendar', 'icsUrl']
] as const

export function isSavedSecret(value: unknown): boolean {
  return value === SAVED_SECRET
}

type AnyConfig = Record<string, unknown>

/** A copy of the config with every set secret replaced by SAVED_SECRET. */
export function redactSecrets<T extends object>(config: T): T {
  const copy: AnyConfig = { ...(config as AnyConfig) }
  for (const [section, key] of SECRET_CONFIG_FIELDS) {
    const current = copy[section] as AnyConfig | undefined
    if (!current || typeof current !== 'object') continue
    const value = current[key]
    if (typeof value === 'string' && value.trim() !== '') {
      copy[section] = { ...(copy[section] as AnyConfig), [key]: SAVED_SECRET }
    }
  }
  return copy as T
}

/** Section values without the fields that still carry SAVED_SECRET (unchanged in the form). */
export function withoutSavedSecrets<T extends AnyConfig>(values: T): T {
  const out: AnyConfig = {}
  for (const [key, value] of Object.entries(values)) {
    if (!isSavedSecret(value)) out[key] = value
  }
  return out as T
}
