import { queryAll, runInTransaction, runNoSave } from './database'

export interface StoredDiarizedSegment {
  recording_id: string
  run_id: string
  segment_index: number
  start: number
  end: number
  voice_label: string
}

/** Anonymous acoustic labels are preserved independently of transcript text or contact naming. */
export function storeDiarizedSegments(recordingId: string, runId: string,
  segments: Array<{ start: number; end: number; speaker: string }>): void {
  for (const segment of segments) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 ||
      segment.end <= segment.start || !segment.speaker) throw new Error('Invalid diarized segment')
  }
  runInTransaction(() => {
    runNoSave('DELETE FROM diarized_segments WHERE recording_id = ?', [recordingId])
    segments.forEach((segment, index) => runNoSave(`INSERT INTO diarized_segments
      (recording_id, run_id, segment_index, start, end, voice_label) VALUES (?, ?, ?, ?, ?, ?)`,
      [recordingId, runId, index, segment.start, segment.end, segment.speaker]))
  })
}

export function getDiarizedSegments(recordingId: string): StoredDiarizedSegment[] {
  return queryAll<StoredDiarizedSegment>('SELECT * FROM diarized_segments WHERE recording_id = ? ORDER BY segment_index', [recordingId])
}
