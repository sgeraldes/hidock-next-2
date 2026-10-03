/**
 * What People and Settings show about identity questions (spec 2026-10-03, Phase 4): each
 * automatic decision with what the page needs to say it in words, the voice conflicts still
 * open, and the counts per kind of question. Shared by the main process, the preload and the
 * renderer.
 */

export type DecisionKind = 'speaker' | 'mention' | 'merge' | 'voice-anchor'

/** One automatic decision from the journal (identity_decisions), ready to be put in words. */
export interface DecisionView {
  id: string
  kind: DecisionKind
  /** The rule that decided: 'voice', 'one-on-one', 'elimination', 'voice-presence', 'exact-email', ... */
  method: string
  createdAt: string
  undoneAt: string | null
  contactId: string | null
  /** The person decided on (the person kept, for a merge). Null when that contact is gone. */
  personName: string | null
  /** What was named: the speaker label, the spoken first name, or the name merged away. */
  subjectName: string | null
  recordingId: string | null
  /** The transcript's title, else the file name. */
  recordingTitle: string | null
  recordingDate: string | null
  /** The subject of the meeting the recording is linked to. */
  meetingSubject: string | null
  /** Jev's probability for its choice ('jev-tiebreak' only). */
  probability: number | null
  /** The recordings that taught a voice, by rule ('voice-anchor' learned by one-on-one or elimination). */
  votes: { oneOnOne: number; elimination: number } | null
}

/** A voice that disagrees with a speaker already named, still waiting for the owner. */
export interface VoiceConflictView {
  /** The identity suggestion's id. */
  id: string
  recordingId: string
  recordingTitle: string | null
  recordingDate: string | null
  meetingSubject: string | null
  speakerLabel: string
  /** The person the voice sounds like. */
  voiceContactId: string
  voiceContactName: string | null
  /** The person the speaker is named after now. */
  boundContactId: string
  boundContactName: string | null
  /** Who named the speaker: 'manual', 'self-identification', ... (null: before sources were kept). */
  boundSource: string | null
}

/** 'keep': the speaker stays as named. 'voice': the speaker is the voice's person. */
export type VoiceConflictChoice = 'keep' | 'voice'

export type QuestionKind = 'shared-first-names' | 'duplicate-people' | 'speakers' | 'voice-conflicts'

export interface QuestionCountRow {
  kind: QuestionKind
  pending: number
  automatic: number
  owner: number
}

export interface QuestionCounts {
  rows: QuestionCountRow[]
}
