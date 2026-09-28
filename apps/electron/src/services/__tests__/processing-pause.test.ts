/**
 * The combined pipeline switch: downloads (useAppStore.downloadsPaused, mirror
 * of DownloadService.state.isPaused) and the transcription queue pause and
 * resume together, and the download pause reverts when its IPC fails.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAppStore } from '@/store/useAppStore'
import { useTranscriptionStore } from '@/store/features/useTranscriptionStore'
import {
  isProcessingPaused,
  pauseProcessing,
  resumeProcessing,
  toggleProcessing
} from '../processing-pause'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function queueState(paused: boolean) {
  return { paused, isProcessing: false, processingId: null, pendingCount: 0, processingCount: 0 }
}

describe('processing-pause', () => {
  beforeEach(() => {
    useAppStore.setState({ downloadsPaused: false })
    useTranscriptionStore.setState({ paused: false })
    ;(window as any).electronAPI = {
      downloadService: {
        pause: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn().mockResolvedValue(undefined)
      },
      recordings: {
        pauseTranscriptionQueue: vi.fn().mockResolvedValue(queueState(true)),
        resumeTranscriptionQueue: vi.fn().mockResolvedValue(queueState(false))
      }
    }
  })

  it('pauses downloads and transcriptions in one call', async () => {
    pauseProcessing()

    expect(useAppStore.getState().downloadsPaused).toBe(true)
    expect(useTranscriptionStore.getState().paused).toBe(true)
    expect(window.electronAPI.downloadService.pause).toHaveBeenCalledOnce()
    expect(window.electronAPI.recordings.pauseTranscriptionQueue).toHaveBeenCalledOnce()
    await flush()
    expect(isProcessingPaused()).toBe(true)
  })

  it('resumes both queues in one call', async () => {
    pauseProcessing()
    await flush()

    resumeProcessing()

    expect(useAppStore.getState().downloadsPaused).toBe(false)
    expect(useTranscriptionStore.getState().paused).toBe(false)
    expect(window.electronAPI.downloadService.resume).toHaveBeenCalledOnce()
    expect(window.electronAPI.recordings.resumeTranscriptionQueue).toHaveBeenCalledOnce()
  })

  it('treats either queue paused as paused, and toggle resumes only the paused one', () => {
    useTranscriptionStore.setState({ paused: true })
    expect(isProcessingPaused()).toBe(true)

    toggleProcessing()

    expect(window.electronAPI.recordings.resumeTranscriptionQueue).toHaveBeenCalledOnce()
    expect(window.electronAPI.downloadService.resume).not.toHaveBeenCalled()
    expect(isProcessingPaused()).toBe(false)
  })

  it('toggle pauses when nothing is paused', () => {
    toggleProcessing()
    expect(isProcessingPaused()).toBe(true)
    expect(window.electronAPI.downloadService.pause).toHaveBeenCalledOnce()
  })

  it('reverts the optimistic download pause when the IPC rejects', async () => {
    ;(window.electronAPI.downloadService.pause as any) = vi.fn().mockRejectedValue(new Error('nope'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    useAppStore.getState().pauseDownloads()
    expect(useAppStore.getState().downloadsPaused).toBe(true)
    await flush()

    expect(useAppStore.getState().downloadsPaused).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
