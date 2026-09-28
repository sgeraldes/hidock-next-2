import { describe, it, expect } from 'vitest'
import { isEarlierFailure, splitBySession } from '../operationHistory'

describe('operationHistory', () => {
  it('puts only failures from an earlier session in the earlier group', () => {
    const items = [
      { id: 'old-fail', status: 'failed', fromPreviousSession: true },
      { id: 'new-fail', status: 'failed', fromPreviousSession: false },
      { id: 'queued', status: 'pending' },
      // A user cancel from an earlier session is the marker that stops the
      // file being queued again; a one-click Clear must never remove it.
      { id: 'old-cancel', status: 'cancelled', fromPreviousSession: true }
    ]

    const { current, earlier } = splitBySession(items)

    expect(earlier.map((i) => i.id)).toEqual(['old-fail'])
    expect(current.map((i) => i.id)).toEqual(['new-fail', 'queued', 'old-cancel'])
  })

  it('never treats queued or running work as earlier, even if the flag is set', () => {
    expect(isEarlierFailure({ status: 'pending', fromPreviousSession: true })).toBe(false)
    expect(isEarlierFailure({ status: 'downloading', fromPreviousSession: true })).toBe(false)
  })
})
