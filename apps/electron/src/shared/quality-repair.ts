/** Renderer/main contract. No Node, database or provider imports. */
export type RepairAction = 'review_samples' | 'compare_voices' | 'diarize' | 'align_times'
  | 'inspect_overlap' | 'transcribe_range' | 'transcribe_recording' | 'ask_user' | 'defer' | 'no_action'

export interface RepairTurn {
  speaker?: string | null; start?: number | null; end?: number | null; text?: string | null
  speakerConfidence?: number | null; sourceChannel?: number | null
}
export interface RepairSample {
  id: string; speaker: string
  target: { start: number; end: number; turnIndex: number }
  context: { start: number; end: number; turns: RepairTurn[] }
  selection: 'uncertain' | 'representative'
  referenceSuitability?: 'usable-reference' | 'short-reference' | 'sparse-time-span'
}
export interface RepairContext {
  evidenceFingerprint: string; samples: RepairSample[]; actions: RepairAction[]
  state: {
    confirmedFacts: { actualSpeakerCount: number | null }
    context: { voiceLabelCounts: Record<string, number>; invitedCount: number | null }
  }
}
