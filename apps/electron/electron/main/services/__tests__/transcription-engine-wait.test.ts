// @vitest-environment node

/**
 * A recording no engine can take waits; it does not fail (27-nov-2026).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CredentialRefusals,
  credentialFingerprint,
  fileRefusalStore,
  engineWaitReason,
  failedOnlyForLackOfEngine,
  noEngineCouldTakeJob,
} from '../transcription-engine-wait'
import { classifyTranscriptionError } from '../transcription-errors'

// The message five queue rows were stored with at launch on 27-nov-2026.
const LIVE_FAILURE = 'No transcription engine succeeded: configured:gemini #1 failed (credentials); ' +
  'remote:moondream/parakeet-ultra #1 failed (unavailable); remote:Qwen/Qwen3-ASR-1.7B #1 failed (unavailable). ' +
  'Last error: The worker has not advertised the selected ASR engine; automatic retry disabled'

describe('noEngineCouldTakeJob', () => {
  it('is true when every engine had a refused key or was not prepared', () => {
    expect(noEngineCouldTakeJob([
      { outcome: 'failed', errorClass: 'credentials' },
      { outcome: 'skipped-unavailable', errorClass: 'unavailable' },
      { outcome: 'failed', errorClass: 'unavailable' },
    ])).toBe(true)
  })

  it('is false when an engine ran and failed on the recording or the network', () => {
    for (const errorClass of ['transient', 'quota', 'incomplete', 'input', 'unknown'] as const) {
      expect(noEngineCouldTakeJob([{ outcome: 'failed', errorClass: 'credentials' }, { outcome: 'failed', errorClass }])).toBe(false)
    }
  })

  it('is false with no attempts', () => {
    expect(noEngineCouldTakeJob([])).toBe(false)
  })
})

describe('failedOnlyForLackOfEngine', () => {
  it('reads the stored message of the five rows that failed at launch', () => {
    expect(failedOnlyForLackOfEngine(LIVE_FAILURE)).toBe(true)
  })

  it('reads skipped engines', () => {
    expect(failedOnlyForLackOfEngine('No transcription engine succeeded: configured:gemini #1 failed (credentials); ' +
      'remote:moondream/parakeet-ultra #0 skipped-unavailable (unavailable). Last error: No Model Host is paired')).toBe(true)
  })

  it('leaves a row alone when it failed more than a day ago', () => {
    const now = Date.parse('2026-11-28T12:00:00Z')
    expect(failedOnlyForLackOfEngine(LIVE_FAILURE, '2026-11-27 15:48:58', now)).toBe(true)
    expect(failedOnlyForLackOfEngine(LIVE_FAILURE, '2026-11-26 15:48:58', now)).toBe(false)
    expect(failedOnlyForLackOfEngine(LIVE_FAILURE, null, now)).toBe(false)
  })

  it('leaves a row alone when one engine failed for another reason', () => {
    expect(failedOnlyForLackOfEngine('No transcription engine succeeded: configured:gemini #1 failed (quota); ' +
      'remote:moondream/parakeet-ultra #0 skipped-unavailable (unavailable)')).toBe(false)
    expect(failedOnlyForLackOfEngine('Recording file not found')).toBe(false)
    expect(failedOnlyForLackOfEngine(null)).toBe(false)
  })
})

describe('engineWaitReason', () => {
  it('names each engine once with why it cannot run', () => {
    expect(engineWaitReason([
      { engine: 'configured:gemini', message: 'Your prepayment credits are depleted.' },
      { engine: 'remote:Qwen/Qwen3-ASR-1.7B', message: 'The Model Host has not prepared Qwen/Qwen3-ASR-1.7B' },
      { engine: 'remote:Qwen/Qwen3-ASR-1.7B', message: 'again' },
    ])).toBe('Waiting for a transcription engine. configured:gemini: Your prepayment credits are depleted.; ' +
      'remote:Qwen/Qwen3-ASR-1.7B: The Model Host has not prepared Qwen/Qwen3-ASR-1.7B')
  })
})

describe('CredentialRefusals', () => {
  const key = credentialFingerprint('key-a')

  it('skips a refused engine while the key is the same', () => {
    const refusals = new CredentialRefusals(1000)
    refusals.record('configured:gemini', key, '402 credits depleted', 0)
    expect(refusals.reason('configured:gemini', key, 10)).toContain('refused this key')
    expect(refusals.reason('remote:x', key, 10)).toBeNull()
  })

  it('tries again with a new key, or once the refusal is old', () => {
    const refusals = new CredentialRefusals(1000)
    refusals.record('configured:gemini', key, '402', 0)
    expect(refusals.reason('configured:gemini', credentialFingerprint('key-b'), 10)).toBeNull()
    refusals.record('configured:gemini', key, '402', 0)
    expect(refusals.reason('configured:gemini', key, 1000)).toBeNull()
  })

  it('never keeps the key itself', () => {
    expect(credentialFingerprint('secret-key')).not.toContain('secret')
    expect(credentialFingerprint('')).toBeNull()
  })
})

describe('CredentialRefusals kept across a restart', () => {
  // Kept only in memory, every launch made one refused Gemini call with the same key.
  const rawKey = 'AIzaSyD-not-a-real-key-0123456789abcdefgh' // pragma: allowlist secret (test fixture)
  const key = credentialFingerprint(rawKey)
  let directory: string
  let path: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hidock-refusals-'))
    path = join(directory, 'credential-refusals.json')
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('skips the refused key after a restart without calling the provider', () => {
    new CredentialRefusals(1000, fileRefusalStore(() => path)).record('configured:gemini', key, '402 credits depleted', 0)
    const afterRestart = new CredentialRefusals(1000, fileRefusalStore(() => path))
    expect(afterRestart.reason('configured:gemini', key, 10)).toContain('refused this key')
  })

  it('tries the key again once the stored refusal is an hour old', () => {
    new CredentialRefusals(1000, fileRefusalStore(() => path)).record('configured:gemini', key, '402', 0)
    expect(new CredentialRefusals(1000, fileRefusalStore(() => path)).reason('configured:gemini', key, 1000)).toBeNull()
    // The expired entry is gone from the file too.
    expect(new CredentialRefusals(1000, fileRefusalStore(() => path)).reason('configured:gemini', key, 10)).toBeNull()
  })

  it('tries a different key at once', () => {
    new CredentialRefusals(1000, fileRefusalStore(() => path)).record('configured:gemini', key, '402', 0)
    expect(new CredentialRefusals(1000, fileRefusalStore(() => path)).reason('configured:gemini', credentialFingerprint('key-b'), 10)).toBeNull()
  })

  it('stores the fingerprint, never the key, even when the provider message quotes it', () => {
    new CredentialRefusals(1000, fileRefusalStore(() => path))
      .record('configured:gemini', key, `402 for https://generativelanguage.googleapis.com/v1?key=${rawKey} (${rawKey})`, 0)
    const stored = readFileSync(path, 'utf8')
    expect(stored).toContain(key!)
    expect(stored).not.toContain(rawKey)
    expect(stored).not.toContain('not-a-real-key')
  })

  it('does not store a bearer token or an x-goog-api-key a provider message quotes', () => {
    const token = 'ya29.not-a-real-token_0123456789' // pragma: allowlist secret (test fixture)
    new CredentialRefusals(1000, fileRefusalStore(() => path))
      .record('configured:gemini', key, `402 Authorization: Bearer ${token}; x-goog-api-key: plain-not-a-real-key-42`, 0)
    const stored = readFileSync(path, 'utf8')
    expect(stored).not.toContain(token)
    expect(stored).not.toContain('plain-not-a-real-key-42')
  })

  it('starts empty from a corrupt, unreadable or missing file, without throwing', () => {
    writeFileSync(path, '{not json')
    expect(new CredentialRefusals(1000, fileRefusalStore(() => path)).reason('configured:gemini', key, 10)).toBeNull()
    writeFileSync(path, JSON.stringify({ version: 1, refusals: { 'configured:gemini': { fingerprint: 7, at: 'x' } } }))
    expect(new CredentialRefusals(1000, fileRefusalStore(() => path)).reason('configured:gemini', key, 10)).toBeNull()
    // A directory where the file should be cannot be read or written.
    const blockedPath = join(directory, 'blocked')
    mkdirSync(blockedPath)
    const blocked = new CredentialRefusals(1000, fileRefusalStore(() => blockedPath))
    expect(() => blocked.record('configured:gemini', key, '402', 0)).not.toThrow()
    expect(blocked.reason('configured:gemini', key, 10)).toContain('refused this key')
    // The failed write leaves no temporary file beside the target.
    expect(readdirSync(directory).sort()).toEqual(['blocked', 'credential-refusals.json'])
    const noPath = new CredentialRefusals(1000, fileRefusalStore(() => { throw new Error('userData unavailable') }))
    expect(() => noPath.record('configured:gemini', key, '402', 0)).not.toThrow()
    expect(noPath.reason('configured:gemini', key, 10)).toContain('refused this key')
  })

  it('forgets the stored refusals when cleared', () => {
    const refusals = new CredentialRefusals(1000, fileRefusalStore(() => path))
    refusals.record('configured:gemini', key, '402', 0)
    refusals.clear()
    expect(new CredentialRefusals(1000, fileRefusalStore(() => path)).reason('configured:gemini', key, 10)).toBeNull()
  })
})

describe('a prepaid-credit refusal', () => {
  it('is a credentials problem even as a bare 402 with RESOURCE_EXHAUSTED (Kiro review)', () => {
    expect(classifyTranscriptionError(new Error('[402 Payment Required] RESOURCE_EXHAUSTED')).class).toBe('credentials')
    expect(classifyTranscriptionError(new Error('HTTP 4020 RESOURCE_EXHAUSTED')).class).toBe('quota')
  })

  it('is a credentials problem, not a rate limit to wait out', () => {
    const live = '{"error":{"code":402,"message":"Your prepayment credits are depleted. Please go to AI Studio","status":"RESOURCE_EXHAUSTED"}}'
    expect(classifyTranscriptionError(new Error(live)).class).toBe('credentials')
  })
})
