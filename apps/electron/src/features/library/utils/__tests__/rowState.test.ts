import { describe, it, expect } from 'vitest'
import type { UnifiedRecording } from '@/types/unified-recording'
import { showsTranscriptProblem, statusRank, transcriptProblems, transcriptionRank } from '../rowState'

const base: UnifiedRecording = {
  id: 'r1',
  filename: 'rec.wav',
  dateRecorded: new Date('2026-09-24T10:00:00'),
  duration: 600,
  size: 1,
  location: 'local-only',
  syncStatus: 'synced',
  localPath: '/tmp/rec.wav',
  transcriptionStatus: 'complete'
}

const brokenTranscript = {
  id: 't1',
  integrity_status: 'broken',
  integrity_json: JSON.stringify([{ code: 'too_long_for_audio', detail: 'x' }])
} as never

describe('transcriptProblems', () => {
  it('is empty for a clean transcript', () => {
    expect(transcriptProblems(base)).toEqual([])
    expect(showsTranscriptProblem(base)).toBe(false)
  })

  it('lists the worst problem first: broken, then the audio warning', () => {
    const problems = transcriptProblems({ ...base, evalAudioWarning: 'possible_missed_transcription' }, brokenTranscript)
    expect(problems.map((p) => p.kind)).toEqual(['broken', 'missed'])
  })

  it('names the invented and the missed transcript by their own words', () => {
    expect(transcriptProblems({ ...base, evalAudioWarning: 'possible_invented_transcript' })[0]).toMatchObject({
      kind: 'invented',
      label: 'Transcript may be invented'
    })
    expect(transcriptProblems({ ...base, evalAudioWarning: 'possible_missed_transcription' })[0]).toMatchObject({
      kind: 'missed',
      label: 'Transcription may be missing'
    })
  })
})

describe('showsTranscriptProblem', () => {
  const warned = { ...base, evalAudioWarning: 'possible_invented_transcript' } as UnifiedRecording

  it('shows the problem of a finished transcript', () => {
    expect(showsTranscriptProblem(warned)).toBe(true)
    expect(showsTranscriptProblem({ ...warned, transcriptionStatus: 'no_speech' })).toBe(true)
  })

  it('leaves a run in flight and a failed run to say so', () => {
    for (const status of ['pending', 'processing', 'error'] as const) {
      expect(showsTranscriptProblem({ ...warned, transcriptionStatus: status }), status).toBe(false)
    }
  })
})

describe('sort ranks', () => {
  it('transcription: failed, then a problem, then in flight, queued, none, no speech, done', () => {
    const rank = (r: Partial<UnifiedRecording>) => transcriptionRank({ ...base, ...r } as UnifiedRecording)
    const order = [
      rank({ transcriptionStatus: 'error' }),
      rank({ evalAudioWarning: 'possible_invented_transcript' }),
      rank({ transcriptionStatus: 'processing' }),
      rank({ transcriptionStatus: 'pending' }),
      rank({ transcriptionStatus: 'none' }),
      rank({ transcriptionStatus: 'no_speech' }),
      rank({ transcriptionStatus: 'complete' })
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(order).size).toBe(order.length)
  })

  it('status: an error, then device only, then downloaded, then both', () => {
    const rank = (location: UnifiedRecording['location'], error = false) =>
      statusRank({ ...base, location, deviceFilename: 'x.hda' } as UnifiedRecording, error)
    expect(rank('both', true)).toBeLessThan(rank('device-only'))
    expect(rank('device-only')).toBeLessThan(rank('local-only'))
    expect(rank('local-only')).toBeLessThan(rank('both'))
  })
})
