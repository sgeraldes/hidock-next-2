/**
 * The config the database process gets: every setting, no secret, and a new
 * copy after each save.
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
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^CIPHER:/, ''),
  },
}))

let onDisk = '{}'
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => onDisk),
  writeFileSync: vi.fn(() => {}),
  mkdirSync: vi.fn(() => {}),
  renameSync: vi.fn(() => {}),
  unlinkSync: vi.fn(() => {}),
  openSync: vi.fn(() => 3),
  fsyncSync: vi.fn(() => {}),
  closeSync: vi.fn(() => {}),
}))

vi.mock('../brains/brain-credential-store', () => ({
  getBrainCredentialStore: () => ({ getSecret: () => null, setSecret: () => true, getApiKey: () => '', setApiKey: () => true, clearApiKey: () => true }),
}))

import { applyConfigSnapshot, configSnapshotForDatabaseProcess, getConfig, initializeConfig, onConfigSaved, saveConfig } from '../config'

/** Fake values: each field gets `<name>-secret`, which the snapshot must not carry. */
const secretFields = ['jevApiKey', 'localAsrHfToken', 'modelHostToken', 'museVoiceApiKey', 'maiTranscribeApiKey']
const secrets = Object.fromEntries(secretFields.map((field) => [field, `${field}-secret`]))

beforeEach(() => {
  onDisk = JSON.stringify({ storage: { dataPath: 'D:/Library' }, calendar: { icsUrl: 'https://calendar.example/private.ics' }, transcription: secrets })
})

describe('the database process config snapshot', () => {
  it('keeps the settings and removes every secret', async () => {
    await initializeConfig({ persist: false })
    expect(getConfig().transcription.modelHostToken).toBe('modelHostToken-secret')
    const snapshot = configSnapshotForDatabaseProcess()
    expect(snapshot.storage.dataPath).toBe('D:/Library')
    expect(snapshot.calendar.icsUrl).toBe('')
    for (const key of [...Object.keys(secrets), 'geminiApiKey']) {
      expect((snapshot.transcription as unknown as Record<string, unknown>)[key] ?? '', key).toBe('')
    }
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private\.ics/)
    // The live config keeps its secrets.
    expect(getConfig().transcription.jevApiKey).toBe('jevApiKey-secret')
    expect(() => structuredClone(snapshot)).not.toThrow()
  })

  it('becomes the config when the process applies it', async () => {
    await initializeConfig({ persist: false })
    const snapshot = configSnapshotForDatabaseProcess()
    snapshot.storage.dataPath = 'E:/Moved'
    applyConfigSnapshot(snapshot)
    expect(getConfig().storage.dataPath).toBe('E:/Moved')
    expect(getConfig().transcription.modelHostToken).toBe('')
  })

  it('tells listeners after each save', async () => {
    await initializeConfig({ persist: false })
    const seen: string[] = []
    const stop = onConfigSaved(() => seen.push(getConfig().storage.dataPath))
    await saveConfig({ storage: { ...getConfig().storage, dataPath: 'F:/Elsewhere' } })
    stop()
    await saveConfig({ storage: { ...getConfig().storage, dataPath: 'F:/Again' } })
    expect(seen).toEqual(['F:/Elsewhere'])
  })
})
