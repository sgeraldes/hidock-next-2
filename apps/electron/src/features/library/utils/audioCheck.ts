/**
 * Labels and filters for the audio check (recording checks, phase 1).
 * Spec: docs/superpowers/specs/2026-09-24-recording-checks-design.md
 *
 * The category comes from the main process's audio profile: 'speech' shows
 * nothing, the others are labels the owner can filter on. Null means the
 * recording has not been profiled yet.
 */

export type AudioCategory = 'too_short' | 'silent' | 'noise' | 'speech'

/** Filter values: one category, or every recording with no usable sound. */
export type AudioFilter = 'no_sound' | 'silent' | 'noise' | 'too_short' | 'unchecked'

export const AUDIO_LABELS: Record<Exclude<AudioCategory, 'speech'>, { label: string; detail: string }> = {
  silent: { label: 'Silent', detail: 'The audio holds no sound. Any transcript it has was invented.' },
  noise: { label: 'Noise only', detail: 'Only short bursts of sound (a knock, a cough), no speech.' },
  too_short: { label: 'Too short', detail: 'Under 10 seconds: not processed automatically.' },
}

export const AUDIO_FILTERS: { value: AudioFilter; label: string }[] = [
  { value: 'no_sound', label: 'No usable sound' },
  { value: 'silent', label: 'Silent' },
  { value: 'noise', label: 'Noise only' },
  { value: 'too_short', label: 'Too short' },
  { value: 'unchecked', label: 'Not checked yet' },
]

export function isAudioFilter(value: string): value is AudioFilter {
  return AUDIO_FILTERS.some((f) => f.value === value)
}

export function audioLabel(category: AudioCategory | null | undefined): { label: string; detail: string } | null {
  if (!category || category === 'speech') return null
  return AUDIO_LABELS[category] ?? null
}

export function matchesAudioFilter(category: AudioCategory | null | undefined, filter: AudioFilter): boolean {
  switch (filter) {
    case 'no_sound':
      return category === 'silent' || category === 'noise' || category === 'too_short'
    case 'unchecked':
      return !category
    default:
      return category === filter
  }
}
