import { describe, it, expect } from 'vitest'
import { jevStatus, transcriptionReady } from '../OverviewSection'

const base = {
  provider: 'local-asr',
  geminiApiKey: '',
  localAsrPath: 'C:/asr/run.py',
  localAsrDiarize: true,
  localAsrHfToken: '',
  jevApiKey: 'saved'
}

describe('Overview transcription tile', () => {
  it('is not ready for Local ASR with speaker labels on and no Hugging Face token', () => {
    expect(transcriptionReady(base as never)).toBe(false)
    expect(transcriptionReady({ ...base, localAsrHfToken: 'saved' } as never)).toBe(true)
    expect(transcriptionReady({ ...base, localAsrDiarize: false } as never)).toBe(true)
  })

  it('needs a key for Gemini and a path for the local providers', () => {
    expect(transcriptionReady({ ...base, provider: 'gemini' } as never)).toBe(false)
    expect(transcriptionReady({ ...base, provider: 'gemini', geminiApiKey: 'k' } as never)).toBe(true)
    expect(transcriptionReady({ ...base, provider: 'vibevoice', localAsrPath: '' } as never)).toBe(false)
  })
})

describe('Overview Jev tile', () => {
  const withDecisions = (decisions: object, key = 'saved') =>
    ({ transcription: { ...base, jevApiKey: key }, decisions }) as never

  it('says Off when Jev is switched off, even with a key saved', () => {
    expect(jevStatus(withDecisions({ jevEnabled: false, jevValue: true, jevMeetingMatch: true })).value).toBe('Off')
    expect(jevStatus(withDecisions({ jevEnabled: true, jevValue: false, jevMeetingMatch: false })).value).toBe('Off')
  })

  it('names the jobs that are on', () => {
    const on = jevStatus(withDecisions({ jevEnabled: true, jevValue: true, jevMeetingMatch: false }))
    expect(on).toMatchObject({ value: 'On', tone: 'ok', detail: 'Rates recordings' })
  })

  it('asks for a key when none is saved', () => {
    expect(jevStatus(withDecisions({}, '')).detail).toBe('Add a key to turn it on')
  })
})
