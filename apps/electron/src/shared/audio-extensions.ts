/**
 * The audio files HiDock treats as recordings: what import accepts, what the
 * recordings folder is scanned for, and what the integrity checks look at.
 * There were twelve lists, each a little different (settings inventory,
 * 28-sep-2026), so a .flac could be imported and then be invisible to the
 * folder watcher and to three of the integrity checks.
 *
 * Attachments are classified separately (sourceType.ts), with a wider list.
 */
export const RECORDING_AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.webm', '.hda'] as const

/** True when the file name ends in one of the recording extensions (any case). */
export function isRecordingAudioFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return (RECORDING_AUDIO_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase())
}
