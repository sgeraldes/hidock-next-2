/**
 * ui.unassignedTitleSource (2026-09-22): the setting that decides whether an
 * unassigned source is titled by its AI suggestion or by its filename.
 *
 * Executed rather than reasoned about, because all three questions are about
 * the real load/merge path: does an install that predates the key come back
 * with the default, does a write persist, and does writing it through
 * updateConfig('ui', …) clobber the rest of the ui section (theme, view,
 * start of week) the way a hand-written section object would.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'

function testUserDataDir(): string {
  return join(tmpdir(), `hidock-config-unassigned-title-test-${process.pid}`)
}

vi.mock('electron', () => {
  const dir = testUserDataDir()
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // An install from BEFORE the key existed: a ui section with the old fields
  // and nothing else. This is written before config.ts is imported, so the
  // module's own load is the thing under test.
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ ui: { theme: 'dark', defaultView: 'month', startOfWeek: 0 } }),
    'utf-8'
  )
  return {
    app: { getPath: () => testUserDataDir() },
    safeStorage: { isEncryptionAvailable: () => false },
  }
})

afterAll(() => {
  rmSync(testUserDataDir(), { recursive: true, force: true })
})

vi.mock('../brains/brain-credential-store', () => ({
  getBrainCredentialStore: () => ({
    hasSecret: () => false,
    getSecret: () => null,
    setSecret: () => true,
  }),
}))

import { getConfig, updateConfig, initializeConfig } from '../config'

const configPath = () => join(testUserDataDir(), 'config.json')

describe('ui.unassignedTitleSource', () => {
  // The boot path: initializeConfig is what actually reads config.json off
  // disk and merges it over the defaults.
  beforeAll(async () => {
    await initializeConfig()
  })

  it('a config saved before the key existed loads with the suggested default', () => {
    expect(getConfig().ui.unassignedTitleSource).toBe('suggested')
  })

  it('keeps the ui settings that config already had', () => {
    const ui = getConfig().ui
    expect(ui.theme).toBe('dark')
    expect(ui.defaultView).toBe('month')
    expect(ui.startOfWeek).toBe(0)
  })

  it('persists a change to disk without dropping the rest of the ui section', async () => {
    await updateConfig('ui', { unassignedTitleSource: 'filename' })

    expect(getConfig().ui.unassignedTitleSource).toBe('filename')
    const onDisk = JSON.parse(readFileSync(configPath(), 'utf-8'))
    expect(onDisk.ui.unassignedTitleSource).toBe('filename')
    // The Settings control writes the section directly instead of going
    // through that card's Save button; a section write must MERGE.
    expect(onDisk.ui.theme).toBe('dark')
    expect(onDisk.ui.defaultView).toBe('month')
    expect(onDisk.ui.startOfWeek).toBe(0)
  })

  it('takes the value back, so the preference is not one-way', async () => {
    await updateConfig('ui', { unassignedTitleSource: 'suggested' })
    expect(getConfig().ui.unassignedTitleSource).toBe('suggested')
    expect(JSON.parse(readFileSync(configPath(), 'utf-8')).ui.unassignedTitleSource).toBe('suggested')
  })
})
