import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig, loadSecrets, loadTokens } from '../src/config.mjs'

// setup.ps1 runs under Windows PowerShell 5.1, whose `Set-Content -Encoding
// utf8` writes a byte-order mark. JSON.parse rejects it, and the host then
// started unvalidated and without its Hugging Face token.
const BOM = '﻿'

describe('files written by setup.ps1', () => {
  const dirs = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const file = (name, text) => {
    const d = mkdtempSync(join(tmpdir(), 'hidock-bom-test-'))
    dirs.push(d)
    const path = join(d, name)
    writeFileSync(path, text, 'utf8')
    return path
  }

  it('reads a config.json with a byte-order mark', () => {
    const config = loadConfig(file('config.json', `${BOM}{"validated":true,"port":8765}`))
    expect(config.validated).toBe(true)
  })

  it('reads a secrets.json with a byte-order mark', () => {
    expect(loadSecrets(file('secrets.json', `${BOM}{"hfToken":"hf_test"}`)).hfToken).toBe('hf_test')
  })

  it('reads a tokens.json with a byte-order mark', () => {
    expect(loadTokens(file('tokens.json', `${BOM}{"tokens":["a"]}`)).tokens).toEqual(['a'])
  })
})
