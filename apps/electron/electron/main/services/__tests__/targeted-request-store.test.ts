// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const paths = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({ app: { getPath: () => paths.profile } }))
import { requestFingerprint, findTargetedReceipt, saveTargetedReceipt } from '../targeted-request-store'
paths.profile = mkdtempSync(join(tmpdir(), 'hidock-targeted-receipt-test-'))
afterAll(() => {
  for (const file of readdirSync(paths.profile)) rmSync(join(paths.profile, file))
  rmdirSync(paths.profile)
})
describe('durable directed request receipts', () => {
  it('rereads a receipt from disk and rejects reuse with different parameters', () => {
    const fingerprint = requestFingerprint(['r2', 'r1'], 'gemini')
    expect(fingerprint).toBe(requestFingerprint(['r1', 'r2', 'r1'], 'gemini'))
    const receipt = { fingerprint, jobs: [{ recordingId: 'r1', queueItemId: 'q1', status: 'pending' }] }
    saveTargetedReceipt('fixture-request', receipt)
    expect(findTargetedReceipt('fixture-request', fingerprint)).toEqual(receipt)
    expect(() => findTargetedReceipt('fixture-request', requestFingerprint(['r3'], 'gemini'))).toThrow(/different parameters/)
  })
  it('treats object-prototype names as normal receipt IDs', () => {
    const fingerprint = requestFingerprint(['r1'], 'gemini')
    const receipt = { fingerprint, jobs: [{ recordingId: 'r1', status: 'already-transcribed' }] }
    saveTargetedReceipt('__proto__', receipt)
    saveTargetedReceipt('constructor', receipt)
    expect(findTargetedReceipt('__proto__', fingerprint)).toEqual(receipt)
    expect(findTargetedReceipt('constructor', fingerprint)).toEqual(receipt)
  })
})
