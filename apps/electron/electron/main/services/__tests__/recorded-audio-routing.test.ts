// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { combineChannelActivity, recordedAudioRemoteMap, recordedAudioStageFingerprint,
  withAudioEligibility } from '../recorded-audio-routing'
import { parseAudioPreflightOutput } from '../audio-preflight'

describe('recorded source channel routing', () => {
  it('unions overlapping source activity without doubling the shared clock', () => {
    const first = parseAudioPreflightOutput('mean_volume: -20 dB\nmax_volume: -5 dB\nsilence_start: 4\nsilence_end: 10', 10)
    const second = parseAudioPreflightOutput('mean_volume: -25 dB\nmax_volume: -8 dB\nsilence_start: 0\nsilence_end: 2\nsilence_start: 7\nsilence_end: 10', 10)
    const combined = combineChannelActivity([first, second])
    expect(combined.activityIntervals).toEqual([{ start: 0, end: 7, duration: 7 }])
    expect(combined.nonSilentSeconds).toBe(7)
    expect(combined.nonSilentRatio).toBe(0.7)
    expect(combined.status).toBe('speech_present')
  })

  it('retains legacy fingerprints and changes separate identity when role evidence changes', () => {
    expect(recordedAudioStageFingerprint('hash', false)).toBe('hash')
    const unknown = recordedAudioStageFingerprint('hash', true)
    const mapping = recordedAudioRemoteMap({ evidence: 'user-confirmed', evidenceId: 'recording-confirmation',
      roles: ['microphone', 'system'] })
    expect(mapping[0]).toEqual({ sourceChannel: 0, role: 'microphone', evidence: 'user-confirmed' })
    expect(recordedAudioStageFingerprint('hash', true, mapping)).not.toBe(unknown)
  })

  it('never starts preparation after cancellation', async () => {
    let invoked = false
    await expect(withAudioEligibility(() => false, async () => { invoked = true })).rejects.toThrow()
    expect(invoked).toBe(false)
  })

  it('aborts an active preparation and rejects its late result', async () => {
    let eligible = true
    const pending = withAudioEligibility(() => eligible, signal => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve('late output'), { once: true })
      setTimeout(() => { eligible = false }, 10)
    }))
    await expect(pending).rejects.toThrow()
  })
})
