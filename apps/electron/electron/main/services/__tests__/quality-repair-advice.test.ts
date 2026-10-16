// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
vi.mock('../pipeline/decision-engines', () => ({ askDecision: vi.fn() }))
import { buildRepairAdvice, requestRepairAdvice, selectRepairSamples, type RepairEvidence } from '../quality-repair-advice'

const evidence = (over: Partial<RepairEvidence> = {}): RepairEvidence => ({
  recordingId: 'interview', sourceAudioHash: 'audio-hash', transcriptFingerprint: 'transcript-hash',
  durationSeconds: 600, turns: Array.from({ length: 30 }, (_, i) => ({ speaker: `Voice ${i % 5}`,
    start: i * 15, end: i * 15 + 10, text: `This is representative turn number ${i}`, speakerConfidence: i === 20 ? 0.1 : 0.8 })),
  reasons: [{ code: 'more_speakers_than_invited', detail: 'Five voice labels, two invitees' }],
  confirmedSpeakerCount: 2, invitedCount: 2, meetingKind: 'interview', acousticEvidence: null,
  availableActions: ['review_samples', 'compare_voices', 'diarize', 'transcribe_range', 'transcribe_recording'],
  remoteReady: true, stillCurrent: () => true, ...over
})

describe('contextual repair advice', () => {
  it('does not offer ASR for a speaker-only mismatch, even when available', () => {
    const plan = buildRepairAdvice(evidence())
    expect(plan.actions).toContain('diarize')
    expect(plan.actions).not.toContain('transcribe_recording')
    expect(plan.actions).not.toContain('transcribe_range')
    expect(plan.state.confirmedFacts.actualSpeakerCount).toBe(2)
    expect(plan.state.context.invitedCountIsNotAttendance).toBe(true)
    expect(plan.state.audioProvidedToThisEvaluator).toBe(false)
    expect(plan.state.acousticEvidence).toBeNull()
  })
  it('retains range ASR as an option when separate missing-content evidence exists', () => {
    expect(buildRepairAdvice(evidence({ reasons: [{ code: 'speech_after_the_end', detail: 'Missing speech' }] }))
      .actions).toContain('transcribe_range')
  })
  it('keeps timing-only and offline repairs from silently becoming transcription or local inference', () => {
    const plan = buildRepairAdvice(evidence({ remoteReady: false,
      reasons: [{ code: 'timestamps_consistently_wrong', detail: 'Repeated starts' }],
      availableActions: ['align_times', 'diarize', 'transcribe_recording'] }))
    expect(plan.actions).toEqual(['align_times', 'ask_user', 'defer', 'no_action'])
  })
  it('bounds clips, covers all voice labels, and supplies adjacent/global context', () => {
    const input = evidence()
    const clips = selectRepairSamples(input)
    expect(clips.length).toBeLessThanOrEqual(12)
    expect(new Set(clips.map(clip => clip.speaker)).size).toBe(5)
    expect(clips.some(clip => clip.target.turnIndex === 20 && clip.selection === 'uncertain')).toBe(true)
    expect(clips[0].context.turns.length).toBeGreaterThan(1)
    expect(clips.every(clip => clip.target.end - clip.target.start <= 12)).toBe(true)
    const plan = buildRepairAdvice(input)
    expect(plan.state.context.totalTurns).toBe(30)
    expect(plan.state.context.opening.length).toBe(4)
    expect(plan.state.context.closing.length).toBe(4)
  })
  it('does not execute or promote an evaluator recommendation regardless of its declared confidence', async () => {
    const decide = vi.fn().mockResolvedValue({ engine: 'clef', response: { model: 'clef',
      answers: { action: { type: 'choice', choice: 'diarize', confidence: 1 },
        sample: { type: 'choice', choice: 'turn-20', confidence: 0.9 } } } })
    const result = await requestRepairAdvice(evidence(), decide)
    expect(result.automaticPromotionAllowed).toBe(false)
    expect(result.confidence.source).toBe('model-reported-uncalibrated')
    expect(result.sample?.target.turnIndex).toBe(20)
    expect(decide).toHaveBeenCalledTimes(1)
  })
  it('prefers an informative outlier over a short acknowledgement or a sparse long timing span', () => {
    const clips = selectRepairSamples(evidence({ turns: [
      { speaker: 'Outlier', start: 0, end: 0.4, text: 'Yes', speakerConfidence: 0.01 },
      { speaker: 'Outlier', start: 10, end: 26, text: 'Two words', speakerConfidence: 0.02 },
      { speaker: 'Outlier', start: 30, end: 46, text: 'Here is a useful reference with several spoken words', speakerConfidence: 0.26 }
    ] }))
    expect(clips[0].target.turnIndex).toBe(2)
    expect(clips[0].referenceSuitability).toBe('usable-reference')
  })
  it('rejects a stale source and a forbidden model action', async () => {
    const decide = vi.fn().mockResolvedValue({ response: { answers: {
      action: { type: 'choice', choice: 'transcribe_recording', confidence: 0.99 },
      sample: { type: 'choice', choice: 'none', confidence: 1 } } } })
    await expect(requestRepairAdvice(evidence(), decide)).rejects.toThrow('unsupported')
    let current = true
    const changing = vi.fn().mockImplementation(async () => { current = false; return {} })
    await expect(requestRepairAdvice(evidence({ stillCurrent: () => current }), changing)).rejects.toThrow('changed')
    const never = vi.fn()
    await expect(requestRepairAdvice(evidence({ stillCurrent: () => false }), never)).rejects.toThrow('no longer current')
    expect(never).not.toHaveBeenCalled()
  })
})
