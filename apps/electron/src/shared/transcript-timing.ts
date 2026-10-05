export interface TimingSegment {
  start: number
  end?: number
  text: string
  speaker?: string
  timingHidden?: boolean
  timingOriginalStart?: number
  timingOriginalEnd?: number
  timingReviewed?: boolean
}
export interface TimingFinding {
  index: number
  claimedStart: number
  impliedStart: number | null
  suggestedStart: number | null
  classification: 'out_of_place' | 'probable_hallucination' | 'unsure'
  claimedAudio: boolean | null
  impliedAudio: boolean | null
  detail: string
}
export interface TimingAssessment {
  fingerprint: string
  findings: TimingFinding[]
  hiddenIndices: number[]
  reviewed: boolean
}
export type TimingReviewAction = 'move' | 'hide' | 'show' | 'undo_move'

export const TIMING_CLASSIFICATION_LABELS = { out_of_place: 'Out of place', probable_hallucination: 'Probable hallucination', unsure: 'Unsure' } as const

export interface TimingSummaryResult {
  summary: string
  actionItems: string[]
  keyPoints: string[]
}
