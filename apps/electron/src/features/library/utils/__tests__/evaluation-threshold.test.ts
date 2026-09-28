import { describe, it, expect, afterEach } from 'vitest'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { INVENTED_THRESHOLD, effectiveWarning, inventedThreshold, matchesWarningFilter } from '../evaluation'

afterEach(() => useConfigStore.setState({ config: null }))

describe('invented-transcript threshold (Settings > Quality checks)', () => {
  it('uses the constant until the config has loaded', () => {
    useConfigStore.setState({ config: null })
    expect(inventedThreshold()).toBe(INVENTED_THRESHOLD)
    expect(effectiveWarning({ evalTranscriptInvented: 0.85 })).toBe('possible_invented_transcript')
  })

  it('reads the saved value from the config store', () => {
    useConfigStore.setState({ config: { quality: { inventedProbability: 0.9 } } as never })
    expect(inventedThreshold()).toBe(0.9)
    expect(effectiveWarning({ evalTranscriptInvented: 0.85 })).toBeNull()
    expect(matchesWarningFilter({ evalTranscriptInvented: 0.85 }, 'any')).toBe(false)
    useConfigStore.setState({ config: { quality: { inventedProbability: 0.6 } } as never })
    expect(effectiveWarning({ evalTranscriptInvented: 0.65 })).toBe('possible_invented_transcript')
  })

  it('ignores a saved value that is not a probability', () => {
    useConfigStore.setState({ config: { quality: { inventedProbability: 3 } } as never })
    expect(inventedThreshold()).toBe(INVENTED_THRESHOLD)
  })

  it('a threshold passed by the caller wins over the store', () => {
    useConfigStore.setState({ config: { quality: { inventedProbability: 0.9 } } as never })
    expect(matchesWarningFilter({ evalTranscriptInvented: 0.85 }, 'possible_invented_transcript', 0.8)).toBe(true)
  })
})
