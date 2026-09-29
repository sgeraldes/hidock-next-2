/**
 * The naming backfill (29-sep-2026): a recording scanned for self-introductions
 * long ago still gets the roster asked once under the per-speaker rule, and is
 * not asked again. A recording that is not grounded in the audio is left alone.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const markers = new Map<string, string>()
let transcripts: Array<{ recording_id: string; speakers: string; diarization_quality: string | null }> = []
const mockInference = vi.fn(async (_id: string, _opts?: unknown) => ({ proposed: 0, bound: 0, skipped: false }))

vi.mock('../database', () => ({
  queryAll: vi.fn((sql: string) =>
    /FROM transcripts/i.test(sql) ? transcripts.map((t) => ({ recording_id: t.recording_id, speakers: t.speakers })) : []
  ),
  queryOne: vi.fn((sql: string, params?: unknown[]) => {
    if (/FROM config/i.test(sql)) return markers.has(String(params?.[0])) ? { key: params?.[0] } : undefined
    if (/FROM transcripts/i.test(sql)) {
      const t = transcripts.find((x) => x.recording_id === params?.[0])
      return t ? { speakers: t.speakers, diarization_quality: t.diarization_quality, q: t.diarization_quality } : undefined
    }
    return undefined
  }),
  run: vi.fn((sql: string, params?: unknown[]) => {
    if (/INTO config/i.test(sql)) markers.set(String(params?.[0]), String(params?.[1]))
  }),
  getRecordingById: () => ({ meeting_id: null }),
  getSpeakerMap: () => [],
  assignSpeaker: vi.fn(),
  resolveMention: vi.fn(),
  getQueueItems: () => [],
  isRecordingProcessable: () => true,
  getExcludedRecordingIds: () => ({ ids: new Set<string>(), failClosed: false }),
  getEligibleRecordingIds: (ids: Iterable<string>) => ({ eligible: new Set([...ids]), failClosed: false })
}))
vi.mock('../entity-resolver', () => ({ resolveContact: vi.fn() }))
vi.mock('../chat-llm', () => ({ getChatLLMService: () => ({ generate: vi.fn(async () => '[]') }) }))
vi.mock('../voice-identity-consolidation', () => ({ consolidateVoiceIdentityForSpeaker: vi.fn() }))
vi.mock('../speaker-inference', () => ({
  runSpeakerInference: (id: string, opts?: unknown) => mockInference(id, opts)
}))

import { backfillSelfIdentifications } from '../self-identification'

const TURNS = JSON.stringify(
  Array.from({ length: 6 }, (_, i) => ({ speaker: 'Speaker 1', text: `turno ${i}`, speakerAttribution: 'acoustic' }))
)
const GROUNDED = JSON.stringify({ status: 'degraded', coverageRatio: 1, groundingRatio: 1, mixedLabelSchemes: false })
const UNGROUNDED = JSON.stringify({ status: 'degraded', coverageRatio: 0.3, groundingRatio: 1, mixedLabelSchemes: false })

beforeEach(() => {
  vi.clearAllMocks()
  markers.clear()
  mockInference.mockResolvedValue({ proposed: 0, bound: 0, skipped: false })
  transcripts = []
})

describe('backfillSelfIdentifications — roster step', () => {
  it('asks the roster once for a recording scanned long ago, then never again', async () => {
    markers.set('self_id:scanned:rec-old', '2026-08-01T00:00:00Z')
    transcripts = [{ recording_id: 'rec-old', speakers: TURNS, diarization_quality: GROUNDED }]

    expect(await backfillSelfIdentifications(1)).toBe(1)
    expect(mockInference).toHaveBeenCalledTimes(1)
    expect(mockInference.mock.calls[0][0]).toBe('rec-old')
    expect([...markers.keys()].some((k) => k.startsWith('speaker_inference:backfill:v1:rec-old'))).toBe(true)

    expect(await backfillSelfIdentifications(1)).toBe(0)
    expect(mockInference).toHaveBeenCalledTimes(1)
  })

  it('runs both steps for a fresh recording and marks both', async () => {
    transcripts = [{ recording_id: 'rec-new', speakers: TURNS, diarization_quality: null }]

    await backfillSelfIdentifications(1)

    expect(markers.has('self_id:scanned:rec-new')).toBe(true)
    expect(mockInference).toHaveBeenCalledTimes(1)
    expect(markers.has('speaker_inference:backfill:v1:rec-new')).toBe(true)
  })

  it('asks again next time when the roster could not be asked', async () => {
    markers.set('self_id:scanned:rec-noroster', '2026-08-01T00:00:00Z')
    transcripts = [{ recording_id: 'rec-noroster', speakers: TURNS, diarization_quality: GROUNDED }]
    mockInference.mockResolvedValue({ proposed: 0, bound: 0, skipped: true })

    await backfillSelfIdentifications(1)
    expect(markers.has('speaker_inference:backfill:v1:rec-noroster')).toBe(false)

    await backfillSelfIdentifications(1)
    expect(mockInference).toHaveBeenCalledTimes(2)
  })

  it('leaves a recording that is not grounded in the audio alone', async () => {
    transcripts = [{ recording_id: 'rec-bad', speakers: TURNS, diarization_quality: UNGROUNDED }]

    await backfillSelfIdentifications(1)

    expect(mockInference).not.toHaveBeenCalled()
    expect(markers.size).toBe(0)
  })
})
