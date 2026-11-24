/**
 * The queue's reason for a Stop that came after the transcript was saved. The
 * main process writes it, and Operations reads it to offer Finish processing
 * instead of Retry; both sides use this constant so a wording change cannot
 * split them.
 */
export const SAVED_STOP_REASON = 'Stopped by you after the transcript was saved; summary/actions/search not updated'

export function isSavedTranscriptStop(reason: string | null | undefined): boolean {
  return reason === SAVED_STOP_REASON
}
