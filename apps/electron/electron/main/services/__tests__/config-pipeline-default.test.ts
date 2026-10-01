/**
 * AppConfig.pipeline: empty by default, so every step is Automatic and the app behaves as before; saved
 * with replaceConfigSection, because updateConfig merges deeply and can never remove a profile.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'

// Isolated per-process userData dir, as in config-features-default.test.ts.
function testUserDataDir(): string {
  return join(tmpdir(), `hidock-config-pipeline-test-${process.pid}`)
}

vi.mock('electron', () => {
  const dir = testUserDataDir()
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return {
    app: { getPath: () => testUserDataDir() },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})

afterAll(() => {
  rmSync(testUserDataDir(), { recursive: true, force: true })
})

vi.mock('../brains/brain-credential-store', () => ({
  getBrainCredentialStore: () => ({
    hasSecret: () => false,
    getSecret: () => null,
    setSecret: () => true
  })
}))

import { getConfig, replaceConfigSection, updateConfig } from '../config'
import { emptyPipelineConfig, type PipelineConfig } from '../../../../src/shared/pipeline-config'

const WITH_NOTES: PipelineConfig = {
  version: 1,
  profiles: { 'ollama-qwen3-8b': { harness: 'ollama', model: 'qwen3:8b' } },
  steps: { notes: { passes: [{ calls: [{ profile: 'ollama-qwen3-8b', tasks: '*', role: 'produce' }] }] } }
}

describe('config.pipeline', () => {
  it('is empty by default, so every step is Automatic', () => {
    expect(getConfig().pipeline).toEqual(emptyPipelineConfig())
  })

  it('keeps a saved plan and drops it when the section is replaced by an empty one', async () => {
    await replaceConfigSection('pipeline', WITH_NOTES)
    expect(getConfig().pipeline).toEqual(WITH_NOTES)
    await replaceConfigSection('pipeline', emptyPipelineConfig())
    expect(getConfig().pipeline).toEqual(emptyPipelineConfig())
  })

  it('removes a profile that the new section no longer holds, which updateConfig cannot do', async () => {
    await replaceConfigSection('pipeline', WITH_NOTES)
    await updateConfig('pipeline', emptyPipelineConfig())
    // The deep merge kept the profile: this is why the Pipeline page saves with replaceConfigSection.
    expect(getConfig().pipeline.profiles['ollama-qwen3-8b']).toBeDefined()
    await replaceConfigSection('pipeline', emptyPipelineConfig())
    expect(getConfig().pipeline.profiles).toEqual({})
    expect(getConfig().pipeline.steps).toEqual({})
  })

  it('leaves the other sections as they were', async () => {
    const before = getConfig().features
    await replaceConfigSection('pipeline', WITH_NOTES)
    expect(getConfig().features).toEqual(before)
    await replaceConfigSection('pipeline', emptyPipelineConfig())
  })
})
