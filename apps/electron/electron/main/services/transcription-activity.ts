/**
 * Which recordings this process is transcribing right now.
 *
 * Startup repairs ("reset stuck transcriptions", "clear the stale lock") exist
 * for rows a crashed run left behind. They ran unconditionally, and on
 * 24-sep a new recording started the queue 29 seconds before the boot task
 * that runs those repairs: the repair cleared the live lock and put the
 * in-flight row back to pending. The dock then showed 25 waiting and nothing
 * processing while pyannote worked on that recording for ten minutes.
 *
 * A set because the queue has two lanes: the main one and the short-recording
 * lane that runs beside a long job (transcription.ts, `maybeStartShortLane`).
 *
 * A separate module so the database and the integrity service can ask without
 * importing the transcription service (which imports both of them).
 */
const active = new Set<string>()

export function addActiveTranscription(recordingId: string): void {
  active.add(recordingId)
}

export function removeActiveTranscription(recordingId: string): void {
  active.delete(recordingId)
}

export function getActiveTranscriptions(): string[] {
  return [...active]
}
