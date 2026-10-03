import { describe, expect, it } from 'vitest'
import { decisionSentence, shortDate } from '../decisionSentence'
import type { DecisionView } from '@/shared/identity-review'

const base: DecisionView = {
  id: 'd1',
  kind: 'speaker',
  method: 'voice',
  createdAt: '2026-10-03T10:00:00.000Z',
  undoneAt: null,
  contactId: 'ana',
  personName: 'Ana Ruiz',
  subjectName: 'Speaker 2',
  recordingId: 'rec1',
  recordingTitle: 'rec1.wav',
  recordingDate: '2026-09-12T12:00:00Z',
  meetingSubject: 'Weekly sync',
  probability: null,
  votes: null
}

const d = (patch: Partial<DecisionView>): DecisionView => ({ ...base, ...patch })

describe('shortDate', () => {
  it('reads as day and short month', () => {
    expect(shortDate('2026-09-12T12:00:00Z')).toBe('12 Sep')
  })
})

describe('decisionSentence', () => {
  it('a speaker named by a voice', () => {
    expect(decisionSentence(d({ method: 'voice' }))).toBe(
      "Speaker 2 in 'Weekly sync' (12 Sep) is Ana Ruiz: the voice matches Ana Ruiz's known voice"
    )
  })

  it('a speaker named in a one-on-one, and by elimination', () => {
    expect(decisionSentence(d({ method: 'one-on-one' }))).toBe(
      "Speaker 2 in 'Weekly sync' (12 Sep) is Ana Ruiz: Ana Ruiz was the only other person in this one-on-one"
    )
    expect(decisionSentence(d({ method: 'elimination' }))).toBe(
      "Speaker 2 in 'Weekly sync' (12 Sep) is Ana Ruiz: Ana Ruiz was the only attendee left without a known voice"
    )
  })

  it('a voice learned from two one-on-ones, and from a mix', () => {
    const anchor = { kind: 'voice-anchor' as const, recordingId: null, meetingSubject: null, recordingTitle: null, recordingDate: null, subjectName: null }
    expect(decisionSentence(d({ ...anchor, method: 'one-on-one', votes: { oneOnOne: 2, elimination: 0 } }))).toBe(
      'A voice heard in two recordings is Ana Ruiz: Ana Ruiz was the only other person in two one-on-ones'
    )
    expect(decisionSentence(d({ ...anchor, method: 'one-on-one', votes: { oneOnOne: 1, elimination: 1 } }))).toBe(
      'A voice heard in two recordings is Ana Ruiz: Ana Ruiz was the only other person in a one-on-one and the only attendee left without a known voice in one other meeting'
    )
    expect(decisionSentence(d({ ...anchor, method: 'elimination', votes: { oneOnOne: 0, elimination: 3 } }))).toBe(
      'A voice heard in three recordings is Ana Ruiz: Ana Ruiz was the only attendee left without a known voice in three meetings'
    )
  })

  it('a first name resolved by voice presence, the owner, the invite, the attendees', () => {
    const mention = d({
      kind: 'mention',
      subjectName: 'Sebas',
      personName: 'Sebastian Geraldes',
      meetingSubject: 'Planning',
      recordingDate: '2026-10-03T09:00:00Z'
    })
    expect(decisionSentence({ ...mention, method: 'voice-presence' })).toBe(
      "'Sebas' in 'Planning' (3 Oct) is Sebastian Geraldes: Sebastian Geraldes's voice is the only candidate's voice in the recording"
    )
    expect(decisionSentence({ ...mention, method: 'owner-presence' })).toBe(
      "'Sebas' in 'Planning' (3 Oct) is Sebastian Geraldes: you speak in the recording and no other Sebas was there"
    )
    expect(decisionSentence({ ...mention, method: 'attendee-email' })).toBe(
      "'Sebas' in 'Planning' (3 Oct) is Sebastian Geraldes: Sebastian Geraldes was invited to the meeting"
    )
    expect(decisionSentence({ ...mention, method: 'attendee-context' })).toBe(
      "'Sebas' in 'Planning' (3 Oct) is Sebastian Geraldes: Sebastian Geraldes was the only Sebas in the meeting"
    )
  })

  it("Jev's tiebreak carries its probability", () => {
    expect(
      decisionSentence(d({ kind: 'mention', subjectName: 'Edu', method: 'jev-tiebreak', probability: 0.87 }))
    ).toBe("'Edu' in 'Weekly sync' (12 Sep) is Ana Ruiz: Jev chose Ana Ruiz among the people who were there (87% sure)")
    expect(
      decisionSentence(d({ kind: 'merge', subjectName: 'Ana R.', method: 'jev-tiebreak', probability: 0.91 }))
    ).toBe("Merged 'Ana R.' into Ana Ruiz: Jev judged them the same person (91% sure)")
  })

  it('the live channel', () => {
    expect(decisionSentence(d({ method: 'live-channel', personName: 'Sebastian Geraldes' }))).toBe(
      "Speaker 2 in 'Weekly sync' (12 Sep) is Sebastian Geraldes: the voice came through your microphone in a Live recording"
    )
  })

  it('merges by email and by voice', () => {
    const merge = d({ kind: 'merge', subjectName: 'Ana R.', recordingId: null, meetingSubject: null, recordingTitle: null, recordingDate: null })
    expect(decisionSentence({ ...merge, method: 'exact-email' })).toBe("Merged 'Ana R.' into Ana Ruiz: same email")
    expect(decisionSentence({ ...merge, method: 'voice' })).toBe("Merged 'Ana R.' into Ana Ruiz: same voice")
  })

  it('falls back to the recording title, and to plain words for a gone person or an unknown rule', () => {
    expect(decisionSentence(d({ meetingSubject: null, method: 'something-new' }))).toBe(
      "Speaker 2 in 'rec1.wav' (12 Sep) is Ana Ruiz: decided by the app"
    )
    expect(decisionSentence(d({ personName: null, method: 'elimination' }))).toBe(
      "Speaker 2 in 'Weekly sync' (12 Sep) is a person no longer in People: they were the only attendee left without a known voice"
    )
  })
})
