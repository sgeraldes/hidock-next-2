import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { saveGameMode, loadConfig } from '../src/config.mjs'
import { normalizeGameMode } from '../src/game-mode.mjs'

describe('saving game mode', () => {
  const dirs = []
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'hidock-config-test-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('keeps what setup wrote', () => {
    const file = join(dir(), 'config.json')
    writeFileSync(file, JSON.stringify({ validated: true, pythonPath: 'C:\\p\\python.exe', port: 8765 }))
    saveGameMode(normalizeGameMode({ resumeAfterMinutes: 9 }), file)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved).toMatchObject({ validated: true, pythonPath: 'C:\\p\\python.exe', port: 8765 })
    expect(saved.gameMode.resumeAfterMinutes).toBe(9)
    expect(loadConfig(file).gameMode.resumeAfterMinutes).toBe(9)
  })

  it('writes a config when there is none', () => {
    const file = join(dir(), 'config.json')
    saveGameMode(normalizeGameMode({}), file)
    expect(JSON.parse(readFileSync(file, 'utf8')).gameMode.enabled).toBe(true)
  })

  it('refuses to replace a config it cannot read', () => {
    const file = join(dir(), 'config.json')
    writeFileSync(file, '{ not json')
    expect(() => saveGameMode(normalizeGameMode({}), file)).toThrow(/could not be read/)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })
})
