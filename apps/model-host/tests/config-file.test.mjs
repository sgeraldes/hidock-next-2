import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { updateConfigFile, loadConfig, saveSecrets, loadSecrets, saveTokens, loadTokens } from '../src/config.mjs'

describe('files the service writes', () => {
  const dirs = []
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'hidock-config-test-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('a config patch keeps what setup wrote', () => {
    const file = join(dir(), 'config.json')
    writeFileSync(file, JSON.stringify({ pythonPath: 'C:\\p\\python.exe', port: 8765 }))
    updateConfigFile({ stepAside: 'any-use', validated: true }, file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      pythonPath: 'C:\\p\\python.exe',
      port: 8765,
      stepAside: 'any-use',
      validated: true,
    })
    expect(loadConfig(file).stepAside).toBe('any-use')
  })

  it('step aside defaults to games', () => {
    expect(loadConfig(join(dir(), 'missing.json')).stepAside).toBe('games')
  })

  it('refuses to replace a config it cannot read', () => {
    const file = join(dir(), 'config.json')
    writeFileSync(file, '{ not json')
    expect(() => updateConfigFile({ validated: true }, file)).toThrow(/could not be read/)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })

  it('the token goes to secrets.json, never to config.json', () => {
    const d = dir()
    saveSecrets('hf_abcdefghijklmnop', join(d, 'secrets.json'))
    expect(loadSecrets(join(d, 'secrets.json')).hfToken).toBe('hf_abcdefghijklmnop')
  })

  it('remembers that automatic pairing was cancelled', () => {
    const file = join(dir(), 'tokens.json')
    saveTokens(['a'], file, { autoPairingCancelled: true })
    expect(loadTokens(file)).toEqual({ tokens: ['a'], autoPairingCancelled: true })
  })
})
