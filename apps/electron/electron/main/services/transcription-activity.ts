/**
 * Which recording this process is transcribing right now, if any.
 *
 * Startup repairs ("reset stuck transcriptions", "clear the stale lock") exist
 * for rows a crashed run left behind. They ran unconditionally, and on
 * 24-sep a new recording started the queue 29 seconds before the boot task
 * that runs those repairs: the repair cleared the live lock and put the
 * in-flight row back to pending. The dock then showed 25 waiting and nothing
 * processing while pyannote worked on that recording for ten minutes.
 *
 * A separate module so the database and the integrity service can ask without
 * importing the transcription service (which imports both of them).
 */
let activeRecordingId: string | null = null

export function setActiveTranscription(recordingId: string | null): void {
  activeRecordingId = recordingId
}

export function getActiveTranscription(): string | null {
  return activeRecordingId
}
