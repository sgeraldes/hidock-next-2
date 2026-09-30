import { describe, it, expect } from 'vitest'
import type { Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { LibraryError } from '../errorHandling'
import { cardAction, cardCounts, cardNotice, hueOf, initialsOf, mergePeople, sameName } from '../cardInfo'

const local: UnifiedRecording = {
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

const deviceOnly = { ...local, location: 'device-only', localPath: undefined, deviceFilename: 'x.hda', transcriptionStatus: 'none' } as unknown as UnifiedRecording

const error = (type: LibraryError['type'], message = 'It failed', details?: string): LibraryError => ({
  type,
  message,
  details,
  recoverable: true,
  retryable: true
})

const ctx = { canTranscribe: true, downloading: false }

describe('cardCounts', () => {
  it('counts the action items and the key points of an analysed transcript', () => {
    const t = { id: 't', action_items: '["a","b","c"]', key_points: '["x","y"]' } as unknown as Transcript
    expect(cardCounts(t)).toEqual({ actions: 3, keyPoints: 2 })
  })

  it('keeps a zero (analysed, nothing found) apart from unknown (never analysed)', () => {
    expect(cardCounts({ id: 't', action_items: '[]', key_points: null } as unknown as Transcript)).toEqual({ actions: 0, keyPoints: null })
    expect(cardCounts(undefined)).toEqual({ actions: null, keyPoints: null })
  })

  it('ignores empty entries and JSON that is not a list', () => {
    expect(cardCounts({ id: 't', action_items: '["a","  ",""]', key_points: '{"a":1}' } as unknown as Transcript)).toEqual({
      actions: 1,
      keyPoints: null
    })
    expect(cardCounts({ id: 't', action_items: 'not json', key_points: '' } as unknown as Transcript)).toEqual({
      actions: null,
      keyPoints: null
    })
  })

  it('parses a transcript once, and again when its text changes in place', () => {
    const t = { id: 't', action_items: '["a"]', key_points: '[]' } as unknown as Transcript
    expect(cardCounts(t)).toBe(cardCounts(t))
    t.action_items = '["a","b","c"]'
    expect(cardCounts(t).actions).toBe(3)
  })
})

describe('cardNotice', () => {
  it('is null when nothing is wrong', () => {
    expect(cardNotice(local)).toBeNull()
  })

  it('says the error of the last attempt, with its details', () => {
    expect(cardNotice(local, undefined, error('download_failed', 'Download failed', 'The dock stopped sending.'))).toEqual({
      tone: 'error',
      text: 'Download failed. The dock stopped sending.'
    })
  })

  it('says a failed transcription even when no error was recorded', () => {
    expect(cardNotice({ ...local, transcriptionStatus: 'error' })).toEqual({ tone: 'error', text: 'The transcription failed.' })
  })

  it('names the worst problem of a finished transcript, warning or error by how bad it is', () => {
    const invented = cardNotice({ ...local, evalAudioWarning: 'possible_invented_transcript' } as UnifiedRecording)
    expect(invented?.tone).toBe('warning')
    expect(invented?.text).toContain('Transcript may be invented')
    const broken = {
      id: 't',
      integrity_status: 'broken',
      integrity_json: JSON.stringify([{ code: 'too_long_for_audio', detail: 'x' }])
    } as unknown as Transcript
    expect(cardNotice(local, broken)?.tone).toBe('error')
  })

  it('leaves a run in flight to say so, and puts an error before a transcript problem', () => {
    const warned = { ...local, evalAudioWarning: 'possible_invented_transcript' } as UnifiedRecording
    expect(cardNotice({ ...warned, transcriptionStatus: 'processing' })).toBeNull()
    expect(cardNotice(warned, undefined, error('unknown', 'Something broke'))?.text).toBe('Something broke')
  })
})

describe('cardAction', () => {
  it('offers Download for a recording that is only on the device, Transcribe for one that is not transcribed', () => {
    expect(cardAction(deviceOnly, undefined, ctx)).toMatchObject({ kind: 'download', label: 'Download', retry: false })
    expect(cardAction({ ...local, transcriptionStatus: 'none' }, undefined, ctx)).toMatchObject({
      kind: 'transcribe',
      label: 'Transcribe',
      retry: false
    })
    expect(cardAction({ ...local, transcriptionStatus: 'no_speech' }, undefined, ctx)?.label).toBe('Transcribe')
  })

  it('offers nothing for a recording that is done, or whose step is already running', () => {
    expect(cardAction(local, undefined, ctx)).toBeNull()
    expect(cardAction({ ...local, transcriptionStatus: 'processing' }, undefined, ctx)).toBeNull()
    expect(cardAction({ ...local, transcriptionStatus: 'pending' }, undefined, ctx)).toBeNull()
    expect(cardAction(deviceOnly, undefined, { ...ctx, downloading: true })).toBeNull()
  })

  it('offers a Retry of the download after a download error on the device', () => {
    for (const type of ['download_failed', 'download_interrupted', 'device_disconnected'] as const) {
      expect(cardAction(deviceOnly, error(type), ctx), type).toMatchObject({ kind: 'download', label: 'Retry', retry: true })
    }
  })

  it('offers a Retry of the transcription after a transcription error or a failed status', () => {
    for (const type of ['transcription_failed', 'transcription_timeout', 'transcription_rate_limit', 'network_error'] as const) {
      expect(cardAction({ ...local, transcriptionStatus: 'none' }, error(type), ctx), type).toMatchObject({
        kind: 'transcribe',
        label: 'Retry',
        retry: true
      })
    }
    expect(cardAction({ ...local, transcriptionStatus: 'error' }, undefined, ctx)).toMatchObject({ kind: 'transcribe', retry: true })
  })

  it('offers no retry over a finished transcript, whatever error is lying around', () => {
    for (const type of ['network_error', 'transcription_failed', 'transcription_timeout'] as const) {
      expect(cardAction(local, error(type), ctx), type).toBeNull()
    }
    // The same errors on a recording that has no transcript do offer it.
    expect(cardAction({ ...local, transcriptionStatus: 'none' }, error('network_error'), ctx)?.label).toBe('Retry')
  })

  it('never offers to transcribe a recording that is not on this machine', () => {
    expect(cardAction({ ...deviceOnly, transcriptionStatus: 'error' } as UnifiedRecording, undefined, ctx)?.kind).toBe('download')
    expect(cardAction(deviceOnly, undefined, { ...ctx, downloading: true })).toBeNull()
  })

  it('offers no transcription without a handler, and no retry for an error that a retry cannot fix', () => {
    expect(cardAction({ ...local, transcriptionStatus: 'none' }, undefined, { ...ctx, canTranscribe: false })).toBeNull()
    expect(cardAction(local, error('audio_not_found'), ctx)).toBeNull()
  })
})

describe('names and avatars', () => {
  it('takes initials from a name, a single word or an address', () => {
    expect(initialsOf('Ana Pérez')).toBe('AP')
    expect(initialsOf('sebastian')).toBe('SE')
    expect(initialsOf('ana.perez@dfx5.com')).toBe('AP')
    expect(initialsOf('  ')).toBe('?')
  })

  it('gives a person the same colour every time, in range', () => {
    expect(hueOf('Ana Pérez')).toBe(hueOf('ana pérez'))
    const hue = hueOf('Sebastián')
    expect(hue).toBeGreaterThanOrEqual(0)
    expect(hue).toBeLessThan(360)
  })

  it('recognises one person under two spellings, and two people under one first name', () => {
    expect(sameName('Ana Pérez', 'Ana Perez (DFX5)')).toBe(true)
    expect(sameName('Sebastián Geraldes', 'Geraldes, Sebastian')).toBe(true)
    expect(sameName('Ana Pérez', 'Ana Gómez')).toBe(false)
    expect(sameName('', 'Ana')).toBe(false)
  })

  it('does not merge a first name with a full name that contains it: they may be two people', () => {
    expect(sameName('Carlos', 'Carlos Ruiz')).toBe(false)
    expect(sameName('Ana', 'Ana Gomez')).toBe(false)
    expect(sameName('Luis', 'Luis')).toBe(true)
    expect(sameName('Luis', 'luis')).toBe(true)
    const people = mergePeople(['Carlos'], ['Carlos Ruiz', 'Ana'])
    expect(people.map((p) => p.name)).toEqual(['Carlos', 'Carlos Ruiz', 'Ana'])
  })

  it('lists who spoke first, then who was only invited, each person once', () => {
    const people = mergePeople(['Ana Pérez', 'Luis'], ['Ana Perez (DFX5)', 'Marta Ríos', 'luis'])
    expect(people.map((p) => [p.name, p.spoke])).toEqual([
      ['Ana Pérez', true],
      ['Luis', true],
      ['Marta Ríos', false]
    ])
    expect(new Set(people.map((p) => p.key)).size).toBe(people.length)
  })
})
