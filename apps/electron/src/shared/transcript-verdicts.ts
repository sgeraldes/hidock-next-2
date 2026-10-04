/** Lightweight verdict fields shared by the owner reader and preload bridge. */
export interface TranscriptVerdicts {
  integrity_status: 'ok' | 'suspect' | 'broken' | null
  integrity_json: string | null
  integrity_version: number | null
  integrity_accepted_at: string | null
  validity_status: 'audio' | 'invalid' | 'incomplete' | 'doubtful' | 'valid' | null
  validity_json: string | null
  validity_version: number | null
}
