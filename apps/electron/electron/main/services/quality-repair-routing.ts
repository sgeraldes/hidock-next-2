/**
 * Which kind of repair a stored validity doubt calls for. A doubt about who
 * said what (speaker labels against the calendar invitation) is not a doubt
 * about the words, the times or how much of the audio the text covers, and
 * transcribing audio again cannot settle it. The sampler reads this before it
 * buys any ASR (transcript-sampler.ts), and the Library reads the same copy.
 *
 * Owner, 13-oct-2026: an interview with two speakers was flagged
 * more_speakers_than_invited and queued for paid sampling. A speaker-label
 * problem never starts ASR by default.
 */

import type { ValidityReasonCode } from './transcript-validity'

export type IssueDomain = 'speaker' | 'timing' | 'text' | 'coverage' | 'unverified' | 'unknown'

/** Exhaustive on purpose: a new reason code does not compile until it has a domain. */
const DOMAIN_BY_CODE: Record<ValidityReasonCode, IssueDomain> = {
  more_speakers_than_invited: 'speaker',
  timestamps_consistently_wrong: 'timing',
  text_not_placeable_in_time: 'timing',
  no_times: 'timing',
  integrity: 'text',
  text_without_audio: 'text',
  much_text_without_audio: 'text',
  more_words_than_audio: 'text',
  sample_contradicts: 'text',
  speech_after_the_end: 'coverage',
  clock_compressed: 'coverage',
  audio_after_the_end: 'coverage',
  audio_not_checked: 'unverified'
}

export type RepairKind =
  /** No stored reasons to read: the old behavior (sampling) is kept. */
  | 'none'
  /** Every reason is about speaker assignments. */
  | 'speaker-only'
  /** Speaker reasons next to text, timing or coverage reasons. */
  | 'mixed'
  /** No speaker reason. */
  | 'non-speaker'

export interface RepairRouting {
  kind: RepairKind
  domains: IssueDomain[]
  /** The sampler may transcribe windows of the audio for this transcript. */
  allowsAsrSampling: boolean
  /** Transcribing the whole recording again may be the suggested action. */
  fullRetranscribeIsDefault: boolean
  /** Speaker assignments are in question and only the owner's review can settle them. */
  needsSpeakerReview: boolean
}

export function domainOfReasonCode(code: unknown): IssueDomain {
  return typeof code === 'string' && Object.hasOwn(DOMAIN_BY_CODE, code) ? DOMAIN_BY_CODE[code as ValidityReasonCode] : 'unknown'
}

function storedReasonCodes(validityJson: string | null | undefined): unknown[] {
  if (!validityJson) return []
  try {
    const reasons = (JSON.parse(validityJson) as { reasons?: unknown } | null)?.reasons
    return Array.isArray(reasons) ? reasons.map((reason) => (reason as { code?: unknown } | null)?.code) : []
  } catch {
    return []
  }
}

export function routeReasonCodes(codes: readonly unknown[]): RepairRouting {
  const domains = [...new Set(codes.map(domainOfReasonCode))]
  const speaker = domains.includes('speaker')
  const kind: RepairKind = codes.length === 0 ? 'none' : !speaker ? 'non-speaker' : domains.length === 1 ? 'speaker-only' : 'mixed'
  return {
    kind,
    domains,
    allowsAsrSampling: kind !== 'speaker-only',
    fullRetranscribeIsDefault: kind !== 'speaker-only',
    needsSpeakerReview: speaker
  }
}

/** The routing for a transcript's stored validity_json. */
export function routeValidityRepair(validityJson: string | null | undefined): RepairRouting {
  return routeReasonCodes(storedReasonCodes(validityJson))
}
