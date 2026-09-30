/**
 * Jev evaluation of recent recordings that have none (30-sep-2026): the
 * recordings after the last Settings scan showed no "4★ Team meeting" chip.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

let pending: string[] = []
let jevActive = true
let scanRunning = false
let killSwitchOff = false
const blocked = new Set<string>()
const queryAll = vi.fn((_sql: string, _params?: unknown[]) => pending.map((id) => ({ id })))
const classifyCaptureValue = vi.fn(async (_id: string) => ({ changed: false }))

class AuthError extends Error {}

vi.mock('../database', () => ({ queryAll: (sql: string, params?: unknown[]) => queryAll(sql, params) }))
vi.mock('../value-classification', () => ({
  getValueClassifierKind: () => (jevActive ? 'jev' : null),
  lowValueMaxSeconds: () => 60,
  classifyCaptureValue: (id: string) => classifyCaptureValue(id)
}))
vi.mock('../value-backfill', () => ({
  isCapturePrivacyBlocked: (id: string) => blocked.has(id),
  isClassifierAuthError: (e: unknown) => e instanceof AuthError,
  isValueBackfillRunning: () => scanRunning
}))
vi.mock('../jev-evaluation', () => ({ EVALUATION_VERSION: 3 }))
vi.mock('../config', () => ({
  getConfig: () => ({ transcription: { valueClassificationEnabled: killSwitchOff ? false : undefined } })
}))

import {
  CATCHUP_LIMIT,
  CATCHUP_WINDOW_DAYS,
  _resetEvaluationCatchupForTests,
  evaluateRecentUnevaluated,
  scheduleEvaluationCatchup
} from '../evaluation-catchup'

beforeEach(() => {
  vi.clearAllMocks()
  _resetEvaluationCatchupForTests()
  pending = []
  jevActive = true
  scanRunning = false
  killSwitchOff = false
  blocked.clear()
  classifyCaptureValue.mockResolvedValue({ changed: false })
})

describe('evaluateRecentUnevaluated', () => {
  it('evaluates the pending recent recordings in the order the query returns them', async () => {
    pending = ['cap-new', 'cap-mid', 'cap-old']

    const result = await evaluateRecentUnevaluated()

    expect(result).toEqual({ evaluated: 3, failed: 0 })
    expect(classifyCaptureValue.mock.calls.map((c) => c[0])).toEqual(['cap-new', 'cap-mid', 'cap-old'])
  })

  it('asks only for recent captures without an evaluation at the current version, bounded', async () => {
    pending = ['cap-1']
    const before = Date.now()

    await evaluateRecentUnevaluated()

    const [sql, params] = queryAll.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/NOT EXISTS[\s\S]*recording_evaluations[\s\S]*re\.version >= \?/)
    expect(sql).toMatch(/COALESCE\(r\.personal, 0\) = 0/)
    expect(sql).toMatch(/r\.deleted_at IS NULL/)
    expect(sql).toMatch(/ORDER BY r\.date_recorded DESC/)
    const since = new Date(String(params[0])).getTime()
    expect(before - since).toBeGreaterThanOrEqual(CATCHUP_WINDOW_DAYS * 86_400_000 - 1000)
    expect(before - since).toBeLessThan(CATCHUP_WINDOW_DAYS * 86_400_000 + 5000)
    expect(params[1]).toBe(3)
    expect(params[2]).toBe(CATCHUP_LIMIT)
  })

  it('does nothing when Jev is not the value classifier', async () => {
    jevActive = false
    pending = ['cap-1']

    const result = await evaluateRecentUnevaluated()

    expect(result).toEqual({ evaluated: 0, failed: 0, stopped: 'not-jev' })
    expect(queryAll).not.toHaveBeenCalled()
    expect(classifyCaptureValue).not.toHaveBeenCalled()
  })

  it('does nothing when value classification is switched off, like the rating at the end of a transcript', async () => {
    killSwitchOff = true
    pending = ['cap-1']

    const result = await evaluateRecentUnevaluated()

    expect(result).toEqual({ evaluated: 0, failed: 0, stopped: 'disabled' })
    expect(queryAll).not.toHaveBeenCalled()
    expect(classifyCaptureValue).not.toHaveBeenCalled()
  })

  it('waits while the Settings scan is running', async () => {
    scanRunning = true
    pending = ['cap-1']

    const result = await evaluateRecentUnevaluated()

    expect(result.stopped).toBe('busy')
    expect(classifyCaptureValue).not.toHaveBeenCalled()
  })

  it('does not run twice at once', async () => {
    pending = ['cap-1']
    let release: () => void = () => undefined
    classifyCaptureValue.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ changed: false }) })
    )

    const first = evaluateRecentUnevaluated()
    const second = await evaluateRecentUnevaluated()
    release()

    expect(second.stopped).toBe('busy')
    expect((await first).evaluated).toBe(1)
  })

  it('skips a capture that became personal or deleted after the list was read', async () => {
    pending = ['cap-1', 'cap-private', 'cap-3']
    blocked.add('cap-private')

    const result = await evaluateRecentUnevaluated()

    expect(result.evaluated).toBe(2)
    expect(classifyCaptureValue.mock.calls.map((c) => c[0])).toEqual(['cap-1', 'cap-3'])
  })

  it('stops at the first authentication failure', async () => {
    pending = ['cap-1', 'cap-2', 'cap-3']
    classifyCaptureValue.mockRejectedValueOnce(new AuthError('401'))

    const result = await evaluateRecentUnevaluated()

    expect(result).toEqual({ evaluated: 0, failed: 1, stopped: 'auth' })
    expect(classifyCaptureValue).toHaveBeenCalledTimes(1)
  })

  it('tries the capture again after a rejected key, since the key said nothing about the transcript', async () => {
    pending = ['cap-1']
    classifyCaptureValue.mockRejectedValueOnce(new AuthError('401'))
    await evaluateRecentUnevaluated()

    const second = await evaluateRecentUnevaluated()

    expect(second.evaluated).toBe(1)
    expect(classifyCaptureValue).toHaveBeenCalledTimes(2)
  })

  it('stops after three failures in a row, and a success resets the count', async () => {
    pending = ['a', 'b', 'c', 'd', 'e', 'f']
    classifyCaptureValue
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ changed: false })
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))

    const result = await evaluateRecentUnevaluated()

    expect(result).toEqual({ evaluated: 1, failed: 5, stopped: 'failures' })
    expect(classifyCaptureValue).toHaveBeenCalledTimes(6)
  })

  it('does not retry a capture that failed earlier in the same session', async () => {
    pending = ['bad', 'good']
    classifyCaptureValue.mockRejectedValueOnce(new Error('unreadable transcript'))

    await evaluateRecentUnevaluated()
    classifyCaptureValue.mockClear()
    const second = await evaluateRecentUnevaluated()

    expect(classifyCaptureValue.mock.calls.map((c) => c[0])).toEqual(['good'])
    expect(second.evaluated).toBe(1)
    // the query asks for the failed ones on top of the limit, so they cannot crowd the rest out
    expect((queryAll.mock.calls[1] as [string, unknown[]])[1][2]).toBe(CATCHUP_LIMIT + 1)
  })
})

describe('scheduleEvaluationCatchup', () => {
  it('never throws or rejects into the caller', async () => {
    queryAll.mockImplementationOnce(() => {
      throw new Error('database closed')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(() => scheduleEvaluationCatchup()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(warn).toHaveBeenCalledWith('[Evaluation] catch-up error:', 'database closed')
    warn.mockRestore()
  })
})
