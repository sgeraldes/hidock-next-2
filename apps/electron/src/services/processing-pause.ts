/**
 * One switch for the whole pipeline: downloads from the HiDock and the
 * transcription queue pause and resume together.
 *
 * Both queues keep their own main-process flag (DownloadService.state.isPaused
 * and the transcription processor's queuePaused); the stores mirror them. In
 * both, pausing stops new work from starting and lets the item in flight
 * finish. The Library header and the Operations panel call these same
 * functions, so the two controls can never disagree.
 */

import { useAppStore } from '@/store/useAppStore'
import { useTranscriptionStore } from '@/store/features/useTranscriptionStore'

export function isProcessingPaused(): boolean {
  return useAppStore.getState().downloadsPaused || useTranscriptionStore.getState().paused
}

export function pauseProcessing(): void {
  if (!useAppStore.getState().downloadsPaused) useAppStore.getState().pauseDownloads()
  if (!useTranscriptionStore.getState().paused) useTranscriptionStore.getState().pauseQueue()
}

export function resumeProcessing(): void {
  if (useAppStore.getState().downloadsPaused) useAppStore.getState().resumeDownloads()
  if (useTranscriptionStore.getState().paused) useTranscriptionStore.getState().resumeQueue()
}

/** Reads the state at call time, so a handler never acts on a stale render. */
export function toggleProcessing(): void {
  if (isProcessingPaused()) resumeProcessing()
  else pauseProcessing()
}
