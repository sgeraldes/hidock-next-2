import { useAppStore } from '@/store/useAppStore'
import { useTranscriptionPaused } from '@/store/features/useTranscriptionStore'
import { pauseProcessing, resumeProcessing, toggleProcessing } from '@/services/processing-pause'

/**
 * Combined pause state of the pipeline. `paused` is true when either queue is
 * paused, so the control offers Resume until both run again.
 */
export function useProcessingPause() {
  const downloadsPaused = useAppStore((s) => s.downloadsPaused === true)
  const transcriptionPaused = useTranscriptionPaused()
  return {
    paused: downloadsPaused || transcriptionPaused,
    downloadsPaused,
    transcriptionPaused,
    pause: pauseProcessing,
    resume: resumeProcessing,
    toggle: toggleProcessing
  }
}
