/**
 * Player and notification preferences (Settings > Player & notifications).
 * These were numbers inside the players and the toaster (settings inventory,
 * 28-sep-2026); the defaults are those numbers, so nothing changes until
 * someone picks another value.
 */
import { useMemo } from 'react'
import { useConfigStore } from '@/store/domain/useConfigStore'

export interface PlayerPreferences {
  /** Seconds the back and forward buttons jump. */
  skipSeconds: number
  /** Speeds offered in the speed menu, ascending. */
  playbackSpeeds: number[]
  /** Speed a recording starts at. */
  defaultPlaybackSpeed: number
  /** Seconds a notice stays on screen when it does not set its own time. */
  toastSeconds: number
}

export const DEFAULT_PLAYER_PREFERENCES: PlayerPreferences = {
  skipSeconds: 10,
  playbackSpeeds: [0.5, 1, 1.5, 2],
  defaultPlaybackSpeed: 1,
  toastSeconds: 5
}

/** Speeds a person can offer in the menu. */
export const ALLOWED_PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]

function inRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

export function playerPreferences(ui: Partial<Record<keyof PlayerPreferences, unknown>> | null | undefined): PlayerPreferences {
  const d = DEFAULT_PLAYER_PREFERENCES
  const speeds = Array.isArray(ui?.playbackSpeeds)
    ? [...new Set(ui!.playbackSpeeds.filter((s): s is number => ALLOWED_PLAYBACK_SPEEDS.includes(s as number)))].sort((a, b) => a - b)
    : d.playbackSpeeds
  const playbackSpeeds = speeds.includes(1) ? speeds : [...speeds, 1].sort((a, b) => a - b)
  const defaultPlaybackSpeed = inRange(ui?.defaultPlaybackSpeed, 0.5, 3, d.defaultPlaybackSpeed)
  return {
    skipSeconds: Math.round(inRange(ui?.skipSeconds, 1, 120, d.skipSeconds)),
    playbackSpeeds,
    defaultPlaybackSpeed: playbackSpeeds.includes(defaultPlaybackSpeed) ? defaultPlaybackSpeed : 1,
    toastSeconds: inRange(ui?.toastSeconds, 1, 60, d.toastSeconds)
  }
}

export function usePlayerPreferences(): PlayerPreferences {
  const ui = useConfigStore((s) => s.config?.ui)
  return useMemo(() => playerPreferences(ui as never), [ui])
}

/** Read outside React (the toaster, the audio hook). */
export function currentPlayerPreferences(): PlayerPreferences {
  return playerPreferences(useConfigStore.getState().config?.ui as never)
}

/** "1.5" → "1.5×" for the speed menu. */
export function speedLabel(speed: number): string {
  return `${speed}×`
}
