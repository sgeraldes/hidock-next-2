/**
 * The language each transcription engine gets from `transcription.language`.
 * A blank setting means "detect it", and each engine says that its own way:
 * Gemini takes "unknown", VibeVoice "auto", and the local ASR runner needs a
 * two-letter code, so it falls back to Spanish. The three fallbacks used to be
 * written inline in different places (settings inventory, 28-sep-2026).
 */
export type TranscriptionEngine = 'gemini' | 'vibevoice' | 'local-asr'

export const DETECT_LANGUAGE: Record<TranscriptionEngine, string> = {
  gemini: 'unknown',
  vibevoice: 'auto',
  'local-asr': 'es'
}

export function languageFor(engine: TranscriptionEngine, configured: string | null | undefined): string {
  const value = (configured ?? '').trim() || DETECT_LANGUAGE[engine]
  if (engine === 'local-asr') return value.slice(0, 2).toLowerCase()
  if (engine === 'vibevoice') return value.toLowerCase()
  return value
}
