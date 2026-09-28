/**
 * One source per default (settings inventory, 28-sep-2026): the Gemini model
 * ids, the language each engine gets when the setting is blank, and the audio
 * extensions HiDock treats as recordings.
 */
import { describe, it, expect } from 'vitest'
import { CURRENT_GEMINI_CHAT_MODEL, CURRENT_GEMINI_TRANSCRIPTION_MODEL } from '../gemini-model-ids'
import { DETECT_LANGUAGE, languageFor } from '../transcription-language'
import { RECORDING_AUDIO_EXTENSIONS, isRecordingAudioFile } from '../../../../src/shared/audio-extensions'

describe('Gemini model ids', () => {
  it('are the ids the app shipped with', () => {
    expect(CURRENT_GEMINI_TRANSCRIPTION_MODEL).toBe('gemini-3.5-transcribe')
    expect(CURRENT_GEMINI_CHAT_MODEL).toBe('gemini-3.8-flash')
  })
})

describe('languageFor', () => {
  it('passes a configured language through, in the form each engine needs', () => {
    expect(languageFor('gemini', 'es-AR')).toBe('es-AR')
    expect(languageFor('local-asr', 'EN-us')).toBe('en')
    expect(languageFor('vibevoice', 'ES')).toBe('es')
  })

  it('a blank setting asks each engine to detect, the way it always did', () => {
    expect(DETECT_LANGUAGE).toEqual({ gemini: 'unknown', vibevoice: 'auto', 'local-asr': 'es' })
    expect(languageFor('gemini', '')).toBe('unknown')
    expect(languageFor('vibevoice', undefined)).toBe('auto')
    expect(languageFor('local-asr', '  ')).toBe('es')
  })
})

describe('recording audio extensions', () => {
  it('match what import accepts, in any case', () => {
    expect(RECORDING_AUDIO_EXTENSIONS).toEqual(['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.webm', '.hda'])
    expect(isRecordingAudioFile('Meeting.FLAC')).toBe(true)
    expect(isRecordingAudioFile('2026Sep28-101500-Rec01.hda')).toBe(true)
    expect(isRecordingAudioFile('notes.txt')).toBe(false)
    expect(isRecordingAudioFile('no-extension')).toBe(false)
  })
})
