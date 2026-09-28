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
