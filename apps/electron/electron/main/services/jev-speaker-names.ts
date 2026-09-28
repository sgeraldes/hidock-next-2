/**
 * Jev names the speakers the transcript left anonymous (#27, 28-sep-2026).
 *
 * One `choice` question per unnamed speaker label: which person on the roster
 * is this, or none of them. The roster is the one speaker inference already
 * trusts (invite list, meeting contacts, names the analysis resolved), plus
 * the owner's organisation (contacts with the owner's email domain, most met
 * first) when the meeting gives fewer than three names.
 *
 * A name is taken only when Jev is sure (SPEAKER_NAME_MIN_PROBABILITY) and
 * clearly ahead of the next person (SPEAKER_NAME_MIN_MARGIN), and never for two
 * labels at once: if two labels pick the same person, only the surer one keeps
 * it. Pure module: the caller (speaker-inference.ts) supplies the roster and
 * writes the bindings with its existing rules.
 */
import type { JevQuestion, JevResponse, JevStructured } from './jev-client'

export const SPEAKER_NAME_MIN_PROBABILITY = 0.8
export const SPEAKER_NAME_MIN_MARGIN = 0.3
/** More people than this in one choice dilutes the answer; the first ones are the invitees. */
export const MAX_ROSTER = 20
const NONE_KEY = 'none'

export interface SpeakerSample {
  label: string
  samples: string[]
}

export interface SpeakerNameContext {
  meetingSubject: string | null
  title: string | null
  summary: string | null
  /** Speakers already named, as "label: name", so Jev can rule them out. */
  named: string[]
  /** Turns from other speakers that mention names (addresses are strong evidence). */
  addresses: string[]
}

export interface SpeakerNameRequest {
  state: JevStructured
  questions: Record<string, JevQuestion>
  /** question key -> speaker label */
  labels: Map<string, string>
  /** option key -> roster name */
  people: Map<string, string>
}

export function buildSpeakerNameRequest(speakers: SpeakerSample[], roster: string[], context: SpeakerNameContext): SpeakerNameRequest | null {
  const names = [...new Set(roster.map((n) => n.trim()).filter(Boolean))].slice(0, MAX_ROSTER)
  if (names.length === 0 || speakers.length === 0) return null
  const people = new Map<string, string>()
  const criteria: Record<string, JevStructured> = {}
  names.forEach((name, i) => {
    const key = `p${i + 1}`
    people.set(key, name)
    criteria[key] = name
  })
  criteria[NONE_KEY] = 'None of these people, or not enough in the transcript to tell.'

  const labels = new Map<string, string>()
  const questions: Record<string, JevQuestion> = {}
  const turns: Record<string, string[]> = {}
  speakers.forEach((s, i) => {
    const key = `s${i + 1}`
    labels.set(key, s.label)
    turns[s.label] = s.samples
    questions[key] = {
      type: 'choice',
      instructions:
        `Who is speaker "${s.label}"? Decide from what that speaker says in \`turns["${s.label}"]\`, how others address ` +
        'them in `addresses`, and the meeting. A person already in `named` is someone else. Answer `none` when the ' +
        'transcript does not show who it is.',
      criteria
    }
  })
  const state: JevStructured = {
    meeting: context.meetingSubject,
    title: context.title,
    summary: context.summary,
    named: context.named,
    addresses: context.addresses,
    turns
  }
  return { state, questions, labels, people }
}

export interface SpeakerNamePick {
  label: string
  name: string
  probability: number
  margin: number
}

/** The confident, non-conflicting picks: one person per label, one label per person. */
export function parseSpeakerNames(res: JevResponse, req: SpeakerNameRequest): SpeakerNamePick[] {
  const picks: SpeakerNamePick[] = []
  for (const [key, label] of req.labels) {
    const answer = res.answers?.[key]
    if (!answer || answer.type !== 'choice') continue
    const ranked = Object.entries(answer.probabilities ?? {})
      .filter(([, p]) => Number.isFinite(p))
      .sort((a, b) => b[1] - a[1])
    const [topKey, topP] = ranked[0] ?? [NONE_KEY, 0]
    const margin = topP - (ranked[1]?.[1] ?? 0)
    const name = req.people.get(topKey)
    if (!name || topP < SPEAKER_NAME_MIN_PROBABILITY || margin < SPEAKER_NAME_MIN_MARGIN) continue
    picks.push({ label, name, probability: topP, margin })
  }
  // One label per person: the surer label keeps the name, the other stays anonymous.
  const byName = new Map<string, SpeakerNamePick>()
  for (const p of picks) {
    const held = byName.get(p.name)
    if (!held || p.probability > held.probability) byName.set(p.name, p)
  }
  const kept = new Set(byName.values())
  return picks.filter((p) => kept.has(p))
}
