import { describe, it, expect } from 'vitest'
import { DEFAULT_PLAYER_PREFERENCES, playerPreferences } from '../player-preferences'

describe('player preferences', () => {
  it('defaults to the numbers the players and the toaster used', () => {
    expect(playerPreferences(undefined)).toEqual({
      skipSeconds: 10,
      playbackSpeeds: [0.5, 1, 1.5, 2],
      defaultPlaybackSpeed: 1,
      toastSeconds: 5
    })
    expect(DEFAULT_PLAYER_PREFERENCES.skipSeconds).toBe(10)
  })

  it('keeps 1x on offer, drops unknown speeds, sorts and dedupes', () => {
    expect(playerPreferences({ playbackSpeeds: [2, 7, 1.25, 2] }).playbackSpeeds).toEqual([1, 1.25, 2])
  })

  it('a starting speed that is not on offer falls back to 1x', () => {
    expect(playerPreferences({ playbackSpeeds: [1, 2], defaultPlaybackSpeed: 1.5 }).defaultPlaybackSpeed).toBe(1)
    expect(playerPreferences({ playbackSpeeds: [1, 1.5], defaultPlaybackSpeed: 1.5 }).defaultPlaybackSpeed).toBe(1.5)
  })

  it('out-of-range numbers fall back to the defaults', () => {
    expect(playerPreferences({ skipSeconds: 0, toastSeconds: 600 })).toMatchObject({ skipSeconds: 10, toastSeconds: 5 })
  })
})
