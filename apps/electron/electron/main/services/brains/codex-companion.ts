import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Codex-companion setup script (structured auth probe): the newest version in
 * the Claude plugin cache of whoever runs the app. It used to be one machine's
 * path, pinned to 1.0.6 (settings inventory, 28-sep-2026). The CodexBrain falls
 * back to a plain `codex --version` presence probe when none is found, so a
 * missing companion never breaks auth detection.
 */
export function findCodexCompanion(home: string = homedir()): string | undefined {
  const base = join(home, '.claude', 'plugins', 'cache', 'openai-codex', 'codex')
  try {
    const versions = readdirSync(base)
      .filter((v) => /^\d+(\.\d+)*$/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const v of versions) {
      const script = join(base, v, 'scripts', 'codex-companion.mjs')
      if (existsSync(script)) return script
    }
  } catch {
    // No plugin cache on this machine: the presence probe covers it.
  }
  return undefined
}
