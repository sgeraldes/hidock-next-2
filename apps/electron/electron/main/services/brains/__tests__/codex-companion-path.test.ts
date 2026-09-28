/**
 * The Codex companion is found in the Claude plugin cache of whoever runs the
 * app, newest version first (it used to be one machine's path, pinned to 1.0.6).
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findCodexCompanion } from '../codex-companion'

const made: string[] = []
function home(versions: Record<string, boolean>): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'))
  made.push(dir)
  for (const [version, hasScript] of Object.entries(versions)) {
    const scripts = join(dir, '.claude', 'plugins', 'cache', 'openai-codex', 'codex', version, 'scripts')
    mkdirSync(scripts, { recursive: true })
    if (hasScript) writeFileSync(join(scripts, 'codex-companion.mjs'), '')
  }
  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('findCodexCompanion', () => {
  it('picks the newest version that has the script (1.0.10 is newer than 1.0.9)', () => {
    const dir = home({ '1.0.6': true, '1.0.9': true, '1.0.10': true, '1.1.0': false })
    expect(findCodexCompanion(dir)).toBe(
      join(dir, '.claude', 'plugins', 'cache', 'openai-codex', 'codex', '1.0.10', 'scripts', 'codex-companion.mjs')
    )
  })

  it('finds nothing without a plugin cache', () => {
    expect(findCodexCompanion(home({}))).toBeUndefined()
  })
})
