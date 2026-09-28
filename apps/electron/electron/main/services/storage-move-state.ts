/**
 * Which storage folder is being moved right now (storage-move.ts sets it).
 * Its own module so writers into those folders (file-storage, outputs, the
 * meeting wiki) can check it without importing the move and its dependencies.
 */
let movingFolder: 'recordings' | 'transcripts' | 'captures' | null = null

export function setMovingFolder(folder: 'recordings' | 'transcripts' | 'captures' | null): void {
  movingFolder = folder
}

export function storageMoveInProgress(folder: 'recordings' | 'transcripts' | 'captures'): boolean {
  return movingFolder === folder
}

/** Writers into the transcripts folder call this first. */
export function refuseWhileTranscriptsMove(): void {
  if (movingFolder === 'transcripts') {
    throw new Error('The transcripts folder is being moved; try again when the move finishes.')
  }
}

let liveRecording = false

/** The realtime recorder sets this while a stream is being written to the recordings folder. */
export function setLiveRecording(on: boolean): void {
  liveRecording = on
}

export function liveRecordingInProgress(): boolean {
  return liveRecording
}

/** Importers of images and files call this first (artifact-service). */
export function refuseWhileCapturesMove(): void {
  if (movingFolder === 'captures') {
    throw new Error('The captures folder is being moved; try again when the move finishes.')
  }
}

let capturesWriters = 0

/** An import is writing into the captures folder (artifact-service); pair with endCapturesWrite. */
export function beginCapturesWrite(): void {
  capturesWriters++
}

export function endCapturesWrite(): void {
  capturesWriters = Math.max(0, capturesWriters - 1)
}

/** A captures move waits for these: an import already past its check must finish first. */
export function capturesWritesInFlight(): boolean {
  return capturesWriters > 0
}
