/** Shared with kind-pick so reference labels and engine criteria cannot drift. */
export const RECORDING_KINDS = {
  interview: 'A job interview or candidate screening.',
  team_meeting: 'An internal team meeting, stand-up, sync or planning session.',
  project_meeting: 'A project, client or partner meeting about a specific engagement.',
  one_on_one: 'A one-on-one between two colleagues: feedback, coaching or a manager check-in.',
  sales_support_call: 'A sales, pre-sales, vendor or customer support call.',
  presentation_class: 'A presentation, class, training, webinar or talk where one person mostly speaks.',
  personal_call: 'A personal or family call or conversation.',
  gaming_entertainment: 'A gaming session, casual play or entertainment among friends.',
  media_playback: 'A TV show, video, podcast or music playing, not a live conversation.',
  device_test: 'Someone testing the device, the microphone or the transcription.',
  noise_accidental: 'Noise or an accidental recording with no real conversation.'
} as const
export type RecordingKind = keyof typeof RECORDING_KINDS
export type ReferenceLabelAnswer = RecordingKind | 'unknown'
export interface LabelItemArgs { setId: string; recordingId: string }
export interface SaveLabelArgs extends LabelItemArgs { answer: ReferenceLabelAnswer }
export interface ReferenceLabelSet {
  id: string
  question: 'kind'
  createdAt: string
  size: number
  unavailable: number
  items: Array<{ recordingId: string; displayIndex: number; answer: ReferenceLabelAnswer | null }>
  counts: { doubtful: number; random: number }
  labeled: number
  unknown: number
}
export interface ReferenceLabelItem {
  recordingId: string
  /** Existing local recording path, or null for device-only/missing audio. */
  filePath: string | null
  date: string
  durationSeconds: number | null
  minutes: number | null
  meetingSubject: string | null
  meetingTitle: string | null
  attendees: string[]
  summary: string | null
  transcript: string
  excerpt: string
  answer: ReferenceLabelAnswer | null
}
