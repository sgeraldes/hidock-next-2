import { describe, expect, it } from 'vitest'
import rec28 from '../../../../src/shared/__tests__/fixtures/rec28-timing'
import { openingVadActivity, vadActivity } from './fixtures/rec28-section-audio'
import {
  applyTimingReview, assessTimingEvidence, fixedRanges, NO_EVIDENCE, sectionRuns, spliceSection, type SpeechEvidence
} from '../transcript-timing-evidence'
import type { TimingSegment } from '../../../../src/shared/transcript-timing'

/** Evidence from VAD stretches, the way transcript-timing-store builds it. */
function fromSpans(spans: Array<{ start: number; end: number }>): SpeechEvidence {
  const inside = (a: number, b: number) => spans
    .map((s) => ({ start: Math.max(s.start, a), end: Math.min(s.end, b) })).filter((s) => s.end > s.start)
  return {
    hasAudio: (a, b) => inside(a, b).reduce((sum, s) => sum + s.end - s.start, 0) >= 0.15,
    spansIn: inside
  }
}

const segments = rec28 as TimingSegment[]
const audio = fromSpans([...openingVadActivity, ...vadActivity])

describe('assessTimingEvidence', () => {
  it('Rec28 8:14 "Hola, Manuel": the odd line, with speech at the opening, fixable to 0:04.9', () => {
    const [first] = assessTimingEvidence(segments, audio, 5119)
    expect(first).toMatchObject({ kind: 'odd_line', from: 0, to: 0, classification: 'out_of_place', impliedAudio: true })
    expect(first.windowStart).toBe(0)
    expect(first.windowEnd).toBe(13)
    expect(first.fix?.ok).toBe(true)
    expect(first.suggestedStart).toBeCloseTo(4.86, 1)
    expect(first.detail).toMatch(/does not recognise them/)
  })

  it('Rec28 55:49 "120 horas": the tangle is one section and the copy is flagged as written twice', () => {
    const findings = assessTimingEvidence(segments, audio, 5119)
    const run = findings.find((f) => f.kind === 'mistimed_run' && f.from >= 190 && f.to <= 198)
    expect(run).toBeDefined()
    expect(run!.windowStart).toBeGreaterThanOrEqual(3343)
    expect(run!.windowEnd).toBeLessThanOrEqual(3362)
    expect(run!.impliedAudio).toBe(true)
    const duplicate = findings.find((f) => f.kind === 'duplicate' && f.lines.includes(195))
    expect(duplicate).toMatchObject({ originals: [193], classification: 'duplicate' })
  })

  it('without audio evidence everything stays unsure and nothing is offered as a fix', () => {
    const [first] = assessTimingEvidence(segments, NO_EVIDENCE, 5119)
    expect(first.classification).toBe('unsure')
    expect(first.fix).toMatchObject({ ok: false })
    expect(first.suggestedStart).toBeNull()
  })

  it('calls a line probable hallucination when neither place has sound', () => {
    const silent: SpeechEvidence = { hasAudio: () => false, spansIn: () => [] }
    const [first] = assessTimingEvidence(segments, silent, 5119)
    expect(first.classification).toBe('probable_hallucination')
    expect(first.fix?.ok).toBe(false)
  })
})

describe('applyTimingReview', () => {
  const rows: TimingSegment[] = [
    { start: 0, end: 2, text: 'uno dos' },
    { start: 500, end: 502, text: 'tres cuatro' },
    { start: 501, end: 503, text: 'cinco seis' },
    { start: 6, end: 8, text: 'siete ocho' }
  ]

  it('hides and shows reversibly, keeping the text, without touching the input', () => {
    const hidden = applyTimingReview(rows, { action: 'hide', indices: [1] })
    expect(hidden[1]).toMatchObject({ timingHidden: true, text: 'tres cuatro' })
    expect(applyTimingReview(hidden, { action: 'show', indices: [1] })[1].timingHidden).toBe(false)
    expect(rows[1]).not.toHaveProperty('timingHidden')
  })

  it('fixes times keeping the transcriber\'s, and undo puts them back exactly', () => {
    const fixed = applyTimingReview(rows, { action: 'fix_times', indices: [1, 2], alignment: { starts: [2.5, 4], ends: [4, 5.5] } })
    expect(fixed.slice(1, 3).map((s) => [s.start, s.end, s.timingOriginalStart, s.timingOriginalEnd])).toEqual([[2.5, 4, 500, 502], [4, 5.5, 501, 503]])
    expect(fixedRanges(fixed)).toEqual([{ from: 1, to: 2 }])
    const again = applyTimingReview(fixed, { action: 'fix_times', indices: [1], alignment: { starts: [3], ends: [3.5] } })
    expect(again[1].timingOriginalStart).toBe(500)
    const undone = applyTimingReview(again, { action: 'undo_fix', range: { from: 1, to: 2 } })
    expect(undone.slice(1, 3).map((s) => [s.start, s.end])).toEqual([[500, 502], [501, 503]])
    expect(fixedRanges(undone)).toEqual([])
  })

  it('refuses a fix whose alignment does not match the lines', () => {
    expect(() => applyTimingReview(rows, { action: 'fix_times', indices: [1, 2], alignment: { starts: [1], ends: [2] } })).toThrow()
    expect(() => applyTimingReview(rows, { action: 'undo_fix', range: { from: 0, to: 3 } })).toThrow(/Nothing to undo/)
  })

  it('a section transcription replaces the range, and undoing it brings the old lines back', () => {
    const spliced = spliceSection(rows, 1, 2, [{ start: 2.4, end: 4, text: 'nuevo uno' }, { start: 4.1, end: 5.9, text: 'nuevo dos' }], 'run-1')
    expect(spliced.map((s) => [s.text, !!s.timingHidden])).toEqual([
      ['uno dos', false], ['tres cuatro', true], ['cinco seis', true], ['nuevo uno', false], ['nuevo dos', false], ['siete ocho', false]
    ])
    expect(sectionRuns(spliced)).toEqual([{ runId: 'run-1', from: 3, to: 4 }])
    const undone = applyTimingReview(spliced, { action: 'undo_section', runId: 'run-1' })
    expect(undone.map((s) => [s.start, s.end, s.text, !!s.timingHidden])).toEqual(rows.map((s) => [s.start, s.end, s.text, false]))
    expect(undone.some((s) => s.sectionReplacedBy || s.sectionRunId)).toBe(false)
  })
})

describe('CodeRabbit review of #195', () => {
  it('keeps an absent original end absent across repeated fixes, so Undo restores no end', () => {
    const rows: TimingSegment[] = [{ start: 0, end: 1, text: 'uno' }, { start: 500, text: 'sin fin' }, { start: 6, end: 7, text: 'tres' }]
    const once = applyTimingReview(rows, { action: 'fix_times', indices: [1], alignment: { starts: [2], ends: [3] } })
    const twice = applyTimingReview(once, { action: 'fix_times', indices: [1], alignment: { starts: [2.5], ends: [3.5] } })
    expect(twice[1]).not.toHaveProperty('timingOriginalEnd')
    const undone = applyTimingReview(twice, { action: 'undo_fix', range: { from: 1, to: 1 } })
    expect(undone[1]).toEqual({ start: 500, text: 'sin fin', timingReviewed: true })
  })

  it('refuses to undo a section run that a later run replaced, so one version stays active', () => {
    const rows: TimingSegment[] = [{ start: 0, end: 1, text: 'a b' }, { start: 500, end: 501, text: 'c d' }, { start: 6, end: 7, text: 'e f' }]
    const first = spliceSection(rows, 1, 1, [{ start: 2, end: 3, text: 'primera' }], 'run-1')
    const second = spliceSection(first, 2, 2, [{ start: 2, end: 3, text: 'segunda' }], 'run-2')
    expect(sectionRuns(second).map((r) => r.runId)).toEqual(['run-2'])
    expect(() => applyTimingReview(second, { action: 'undo_section', runId: 'run-1' })).toThrow(/later/)
    const back = applyTimingReview(second, { action: 'undo_section', runId: 'run-2' })
    expect(back.filter((s) => !s.timingHidden).map((s) => s.text)).toEqual(['a b', 'primera', 'e f'])
    expect(sectionRuns(back).map((r) => r.runId)).toEqual(['run-1'])
  })

  it('does not offer Fix times on a legacy line that holds its own timed turns', () => {
    const rows: TimingSegment[] = [
      { start: 0, end: 1, text: 'uno dos' },
      { start: 900, end: 960, text: '[15:00] Speaker 1: hola [15:30] Speaker 2: buen dia' },
      { start: 12, end: 13, text: 'tres cuatro' }
    ]
    const speech: SpeechEvidence = { hasAudio: () => true, spansIn: (a, b) => [{ start: a, end: b }] }
    const [finding] = assessTimingEvidence(rows, speech, 1000)
    expect(finding.from).toBe(1)
    expect(finding.fix?.ok).toBe(false)
    expect(finding.fix?.reason).toMatch(/own times/)
  })
})
