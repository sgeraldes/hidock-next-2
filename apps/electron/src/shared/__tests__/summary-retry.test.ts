import { describe, it, expect } from 'vitest'
import { DEFAULT_SUMMARY_RETRY, summaryRetrySettings } from '../summary-retry'

describe('summaryRetrySettings (28-oct-2026)', () => {
  it('keeps the earlier behaviour when nothing is saved', () => {
    expect(summaryRetrySettings(undefined)).toEqual(DEFAULT_SUMMARY_RETRY)
    expect(DEFAULT_SUMMARY_RETRY).toEqual({ auto: true, everyMinutes: 120, perPass: 3, maxPerWeek: 4 })
  })

  it('keeps every number inside its bounds and whole', () => {
    expect(summaryRetrySettings({ everyMinutes: 1, perPass: 999, maxPerWeek: 2.6 })).toEqual({
      auto: true, everyMinutes: 15, perPass: 20, maxPerWeek: 3,
    })
    expect(summaryRetrySettings({ auto: false, everyMinutes: Number.NaN })).toMatchObject({ auto: false, everyMinutes: 120 })
  })
})
