/**
 * The model host's pairing token is a credential, so it is encrypted at rest.
 *
 * Whoever holds it can send audio to that host and read the result back. The
 * design spec listed "el token de pareo se guarda cifrado" under Testing and
 * nothing implemented or tested it until a QA pass against the spec noticed.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'

/** What safeStorage would do, reversibly, so the test can read both sides. */
const fakeCipher = {
  encryptString: (value: string) => Buffer.from(`CIPHER:${value}`, 'utf8'),
  decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^CIPHER:/, ''),
}

let encryptionAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => fakeCipher.encryptString(value),
    decryptString: (buffer: Buffer) => fakeCipher.decryptString(buffer),
  },
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
  closeSync: vi.fn(() => {}),
}))

vi.mock('../brains/brain-credential-store', () => ({
  getBrainCredentialStore: () => ({
    getApiKey: () => '',
    setApiKey: () => true,
    clearApiKey: () => true,
  }),
}))

import { saveConfig, initializeConfig, getConfig } from '../config'

/** The last config.json body saveConfig produced, parsed. */
function lastWrite(): Record<string, never> & { transcription: { modelHostToken?: string } } {
  return JSON.parse(written[written.length - 1])
}

beforeEach(() => {
  written.length = 0
  onDisk = '{}'
  encryptionAvailable = true
  vi.clearAllMocks()
})

describe('the model host pairing token', () => {
  it('is not written to disk in the clear', async () => {
    await saveConfig({ transcription: { modelHostToken: 'a-real-pairing-token' } } as never)
    const body = written[written.length - 1]
    expect(body).not.toContain('a-real-pairing-token')
  })

  it('is written encrypted, with the marker the loader looks for', async () => {
    await saveConfig({ transcription: { modelHostToken: 'a-real-pairing-token' } } as never)
    expect(lastWrite().transcription.modelHostToken).toMatch(/^__enc__/)
  })

  it('comes back in the clear when the config is loaded', async () => {
    await saveConfig({ transcription: { modelHostToken: 'a-real-pairing-token' } } as never)
    onDisk = written[written.length - 1]

    await initializeConfig()

    expect(getConfig().transcription.modelHostToken).toBe('a-real-pairing-token')
  })

  it('forgetting a host leaves nothing behind, not an encrypted nothing', async () => {
    // Forgetting writes an empty string on purpose, because the deep-merge in
    // saveConfig drops undefined. What matters is that the round trip gives
    // back an empty token: a marker with nothing in it would read as a token
    // that is there, and the client would try to pair with it.
    await saveConfig({ transcription: { modelHostToken: 'a-real-pairing-token' } } as never)
    await saveConfig({ transcription: { modelHostToken: '' } } as never)
    onDisk = written[written.length - 1]

    await initializeConfig()

    expect(lastWrite().transcription.modelHostToken).toBe('')
    expect(getConfig().transcription.modelHostToken).toBe('')
  })

  it('never writes the marker without a token behind it', async () => {
    await saveConfig({ transcription: { modelHostToken: '' } } as never)
    expect(lastWrite().transcription.modelHostToken).not.toMatch(/^__enc__/)
  })

  it('still saves the token when the platform has no encryption', async () => {
    // Losing the pairing is worse than storing it in the clear on a machine
    // whose OS cannot encrypt anything. safeStorage decides, not this code.
    encryptionAvailable = false
    await saveConfig({ transcription: { modelHostToken: 'a-real-pairing-token' } } as never)
    expect(lastWrite().transcription.modelHostToken).toBe('a-real-pairing-token')
  })

  it('reads a token written before this was encrypted', async () => {
    onDisk = JSON.stringify({ transcription: { modelHostToken: 'plain-old-token' } })
    await initializeConfig()
    expect(getConfig().transcription.modelHostToken).toBe('plain-old-token')
  })
})
