/**
 * The Gemini model ids the app uses when none is configured. One place: the
 * ids were written out in 14 places across the main process (settings
 * inventory, 28-sep-2026). Pure module, so any service can import it without
 * pulling in the config or Electron.
 */

/** Transcription: the dedicated transcribe model. */
export const CURRENT_GEMINI_TRANSCRIPTION_MODEL = 'gemini-3.5-transcribe'

/** Chat, analysis, titles and summaries. */
export const CURRENT_GEMINI_CHAT_MODEL = 'gemini-3.8-flash'
