/**
 * The Gemini key and the Hugging Face token are encrypted at rest, like the
 * Jev key and the model host token (28-sep-2026: the settings inventory found
 * both in plain text in config.json). And the window never receives a secret.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`CIPHER:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^CIPHER:/, '')
  }
}))

let onDisk = '{}'
const written: string[] = []
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => onDisk),
  writeFileSync: vi.fn((_path: string, data: string) => {
    written.push(data)
  }),
  mkdirSync: vi.fn(() => {}),
  renameSync: vi.fn(() => {}),
  unlinkSync: vi.fn(() => {}),
  openSync: vi.fn(() => 3),
  fsyncSync: vi.fn(() => {}),
  closeSync: vi.fn(() => {})
}))

vi.mock('../brains/brain-credential-store', () => ({
  getBrainCredentialStore: () => ({ getSecret: () => null, setSecret: () => true })
}))

import { saveConfig, initializeConfig, getConfig } from '../config'
import { SAVED_SECRET, redactSecrets, withoutSavedSecrets } from '../../../../src/shared/secret-fields'

beforeEach(() => {
  written.length = 0
  onDisk = '{}'
})

describe('secrets at rest', () => {
  it('writes the Gemini key and the Hugging Face token encrypted, and reads them back', async () => {
    await saveConfig({ transcription: { geminiApiKey: 'AIzaReal', localAsrHfToken: 'hf_real' } } as never) // pragma: allowlist secret
    const body = written[written.length - 1]
    expect(body).not.toContain('AIzaReal')
    expect(body).not.toContain('hf_real')
    onDisk = body
    await initializeConfig()
    expect(getConfig().transcription.geminiApiKey).toBe('AIzaReal') // pragma: allowlist secret
    expect(getConfig().transcription.localAsrHfToken).toBe('hf_real') // pragma: allowlist secret
  })

  it('reads a key written in plain text before this change', async () => {
    onDisk = JSON.stringify({ transcription: { geminiApiKey: 'AIzaOld', localAsrHfToken: 'hf_old' } }) // pragma: allowlist secret
    await initializeConfig()
    expect(getConfig().transcription.geminiApiKey).toBe('AIzaOld') // pragma: allowlist secret
    expect(getConfig().transcription.localAsrHfToken).toBe('hf_old') // pragma: allowlist secret
  })
})

describe('what the window receives', () => {
  it('gets a "saved" marker for every set secret, and empty stays empty', () => {
    const redacted = redactSecrets({
      calendar: { icsUrl: 'https://outlook/secret.ics', syncEnabled: true },
      transcription: { geminiApiKey: 'AIza', localAsrHfToken: '', jevApiKey: 'j', modelHostToken: 't', provider: 'gemini' } // pragma: allowlist secret
    })
    expect(redacted.calendar).toEqual({ icsUrl: SAVED_SECRET, syncEnabled: true })
    expect(redacted.transcription).toEqual({
      geminiApiKey: SAVED_SECRET,
      localAsrHfToken: '',
      jevApiKey: SAVED_SECRET,
      modelHostToken: SAVED_SECRET,
      provider: 'gemini'
    })
  })

  it('a save that sends the marker back keeps the stored value', () => {
    expect(withoutSavedSecrets({ geminiApiKey: SAVED_SECRET, provider: 'local-asr' })).toEqual({ provider: 'local-asr' })
  })
})
