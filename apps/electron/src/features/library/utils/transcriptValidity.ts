/**
 * Renderer side of the transcript validity verdict (services/transcript-validity.ts):
 * what the Library calls a transcript that is in doubt, not valid or incomplete,
 * why, and what transcribing it again would cost.
 *
 * Plan: docs/superpowers/plans/2026-10-04-validation-order.md, PR 3.
 */

import type { Transcript } from '@/types'

export type HeldValidity = 'invalid' | 'incomplete' | 'doubtful'

type ValidityFields = Partial<Pick<Transcript, 'validity_status' | 'validity_json' | 'integrity_accepted_at'>>

/** The verdict when nothing may be built on the transcript, else null. An accepted transcript is never held. */
export function heldValidity(transcript: ValidityFields | null | undefined): HeldValidity | null {
  if (!transcript || transcript.integrity_accepted_at) return null
  const status = transcript.validity_status
  return status === 'invalid' || status === 'incomplete' || status === 'doubtful' ? status : null
}

export const VALIDITY_LABELS: Record<HeldValidity, { chip: string; label: string; detail: string }> = {
  invalid: {
    chip: 'Not categorized',
    label: 'Not categorized: the transcript does not match the audio',
    detail: 'Stars, kind and summary wait for a new transcript.'
  },
  incomplete: {
    chip: 'Transcript incomplete',
    label: 'Transcript incomplete: detected speech is missing from the text',
    detail: 'Some speech is missing. Transcribe again to recover it.'
  },
  doubtful: {
    chip: 'Transcript in doubt',
    label: 'Transcript in doubt: being checked against the audio',
    detail: 'A few minutes of the audio are transcribed again and compared. Until then nothing is built on it.'
  }
}

/** The reasons the check gave, in the owner's words, as stored. */
export function validityReasons(transcript: ValidityFields | null | undefined, coveredCodes: readonly string[] = []): string[] {
  if (!transcript?.validity_json) return []
  try {
    const parsed = JSON.parse(transcript.validity_json) as { reasons?: Array<{ code?: string; detail?: unknown }> }
    return (parsed.reasons ?? []).filter((r) => !r.code || !coveredCodes.includes(r.code))
      .map((r) => (typeof r.detail === 'string' ? r.detail : '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Cost of transcribing again, measured on gemini-3.5-transcribe on 3-oct-2026:
 * 0.0034 USD per minute of audio. An estimate shown before the owner queues
 * anything, never a charge.
 */
export const TRANSCRIBE_USD_PER_MINUTE = 0.0034

export function transcriptionCostUsd(totalSeconds: number): number {
  return (Math.max(0, totalSeconds) / 60) * TRANSCRIBE_USD_PER_MINUTE
}

/** "about 0.20 USD", or "under 0.01 USD" for a short clip. */
export function formatTranscriptionCost(totalSeconds: number): string {
  const usd = transcriptionCostUsd(totalSeconds)
  return usd < 0.01 ? 'under 0.01 USD' : `about ${usd.toFixed(2)} USD`
}
