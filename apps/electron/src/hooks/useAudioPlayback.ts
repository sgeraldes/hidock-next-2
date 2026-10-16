/**
 * useAudioPlayback - Manages audio playback, waveform generation, and exposes controls.
 *
 * Extracted from OperationController Phase 2+3A decomposition.
 * Owns the singleton HTMLAudioElement, Blob URL lifecycle, waveform abort controller,
 * and the window.__audioControls global registration.
 */

import { useEffect, useRef, useCallback } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { toast } from '@/components/ui/toaster'
import { parseError, getErrorMessage } from '@/features/library/utils/errorHandling'
import { getAudioMimeType } from '@/utils/audioUtils'
import { shouldLogQa } from '@/services/qa-monitor'
import { connectStereoPlayback } from '@/lib/stereo-playback'
import { currentPlayerPreferences } from '@/lib/player-preferences'
import { queueAudioWork } from '@/utils/audioWorkQueue'

/**
 * H5: Try to load precomputed waveform peaks from the disk cache.
 * Returns `{ peaks, duration }` on hit, or null on miss / unavailable.
 */
async function tryLoadCachedWaveform(
  recordingId: string,
  requestId?: string
): Promise<{ peaks: Float32Array; channels?: Float32Array[]; duration: number; coarse: boolean } | null> {
  try {
    const cache = window.electronAPI?.waveform
    if (!cache) return null
    const entry = await cache.getCache(recordingId, undefined, requestId)
    const validPeaks = (values: number[] | undefined) => Array.isArray(values) && values.length === 1000 &&
      values.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    if (!entry || entry.coarse || !Number.isFinite(entry.duration) || entry.duration <= 0 ||
      !validPeaks(entry.peaks) || !entry.channels || entry.channels.length < 1 || entry.channels.length > 8 ||
      !entry.channels.every(validPeaks)) return null
    return {
      channels: entry.channels.map(channel => Float32Array.from(channel)),
      peaks: Float32Array.from(entry.peaks),
      duration: entry.duration,
      coarse: false
    }
  } catch (err) {
    console.warn('[useAudioPlayback] Waveform cache read failed:', err)
  }
  return null
}

export function useAudioPlayback() {
  const stereoRef = useRef<ReturnType<typeof connectStereoPlayback> | null>(null)
  const playbackContextRef = useRef<AudioContext | null>(null)
  const measuredDurationRef = useRef(0)
  const releaseStereo = useCallback(() => {
    stereoRef.current?.disconnect()
    stereoRef.current = null
    const context = playbackContextRef.current
    playbackContextRef.current = null
    if (context) void context.close().catch(error => console.warn('[useAudioPlayback] AudioContext close failed:', error))
  }, [])
  const mediaDuration = useCallback(() => {
    const duration = audioRef.current?.duration ?? 0
    const measured = measuredDurationRef.current
    return Number.isFinite(duration) && duration > 0 ? duration : Number.isFinite(measured) && measured > 0 ? measured : 0
  }, [])
  const seekAudio = useCallback((time: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(time)) return
    const duration = mediaDuration()
    // MediaRecorder WebM may have no duration header. Only clamp to a known,
    // finite duration; never pass NaN/Infinity into the native media setter.
    audio.currentTime = Math.max(0, duration > 0 ? Math.min(duration, time) : time)
  }, [mediaDuration])
  const rateRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioBlobUrlRef = useRef<string | null>(null)
  const waveformAbortControllerRef = useRef<AbortController | null>(null)
  const waveformPendingRecordingRef = useRef<string | null>(null)
  const playbackLockRef = useRef<Promise<void> | null>(null)
  const playbackGenerationRef = useRef(0)
  const cancelPendingPlayback = useCallback(() => {
    playbackGenerationRef.current++
  }, [])

  const {
    setCurrentlyPlaying,
    setPlaybackProgress,
    setIsPlaying,
    setWaveformData
  } = useUIStore()

  // ---- Play Audio ----

  const playAudio = useCallback(async (recordingId: string, filePath: string, startTimeSec = 0) => {
    const generation = ++playbackGenerationRef.current
    // Keep a selected-row waveform request alive when the user presses Play
    // for that same recording. A different row still supersedes the old work.
    if (waveformPendingRecordingRef.current !== recordingId) waveformAbortControllerRef.current?.abort()
    const cancelled = () => generation !== playbackGenerationRef.current
    if (shouldLogQa()) console.log(`[QA-MONITOR][Operation] Playing: ${recordingId}, path: ${filePath}`)

    // Wait for any pending operation to complete to prevent race conditions
    if (playbackLockRef.current) {
      if (shouldLogQa()) console.log('[useAudioPlayback] Waiting for previous playback operation to complete')
      await playbackLockRef.current
    }
    if (cancelled()) return

    // Create new lock for this operation
    playbackLockRef.current = queueAudioWork(async () => {
      try {
        releaseStereo()
        measuredDurationRef.current = 0
        // Stop current playback
        if (audioRef.current) {
          // Clean up event listeners before stopping
          if ((audioRef.current as any)._eventCleanup) {
            ;(audioRef.current as any)._eventCleanup()
          }
          audioRef.current.pause()
          audioRef.current.src = ''
          audioRef.current = null // Clear the ref to allow recreation with fresh listeners
        }
        // Revoke previous Blob URL to prevent memory leaks
        if (audioBlobUrlRef.current) {
          URL.revokeObjectURL(audioBlobUrlRef.current)
          audioBlobUrlRef.current = null
        }
        setIsPlaying(false)
        setPlaybackProgress(0, 0)

        // Set currently playing immediately to show loading state in UI
        setCurrentlyPlaying(recordingId, filePath)

        // Load audio file via IPC
        if (shouldLogQa()) console.log(`[QA-MONITOR][Operation] Reading audio file: ${filePath}`)
        const response = await window.electronAPI.storage.readRecording(filePath)
        if (cancelled()) return
        if (!response.success || !response.data) {
          const errorMsg = response.error || 'Failed to load audio file'
          console.error(`[useAudioPlayback] readRecording failed:`, errorMsg)
          toast({ title: 'Error', description: errorMsg, variant: 'error' })
          setCurrentlyPlaying(null, null)
          return
        }
        const base64 = response.data
        if (shouldLogQa()) console.log(`[QA-MONITOR][Operation] Audio data loaded: ${(base64.length / 1024).toFixed(1)}KB base64`)

        // Create audio element if needed
        if (!audioRef.current) {
          if (shouldLogQa()) console.log('[useAudioPlayback] Creating new Audio element')
          audioRef.current = new Audio()
          // Each recording is a new element: carry the speed picked last (the
          // menu kept showing it while the new audio played at 1x), starting
          // from Settings > Player & notifications.
          audioRef.current.playbackRate = rateRef.current ?? currentPlayerPreferences().defaultPlaybackSpeed

          // Define event handlers as named functions so they can be properly removed
          const handleTimeUpdate = () => {
            if (audioRef.current) {
              setPlaybackProgress(audioRef.current.currentTime, mediaDuration())
            }
          }

          const handlePlay = () => {
            if (shouldLogQa()) console.log('[QA-MONITOR][Operation] Audio play event fired')
            setIsPlaying(true)
          }

          const handlePause = () => {
            setIsPlaying(false)
          }

          const handleEnded = () => {
            releaseStereo()
            setIsPlaying(false)
            setCurrentlyPlaying(null, null)
            setPlaybackProgress(0, 0)
            // Keep the decoded peaks: they belong to the (still-selected) recording
            // and must stay visible in the docked player after playback ends.
            // Clearing them here (while `waveformLoadedForId` still points at this
            // recording) is what left the reader stuck on "Press play to load the
            // waveform" — the load guards think it's loaded, but the data is gone.
          }

          const handleError = (e: ErrorEvent) => {
            releaseStereo()
            const mediaError = audioRef.current?.error
            console.error('[useAudioPlayback] Audio element error:', {
              code: mediaError?.code,
              message: mediaError?.message,
              event: e
            })
            const libraryError = parseError(e, 'audio playback')
            toast({
              title: 'Playback error',
              description: getErrorMessage(libraryError.type),
              variant: 'error'
            })
            setIsPlaying(false)
            setCurrentlyPlaying(null, null)
            setWaveformData(null)
          }

          // Add event listeners
          audioRef.current.addEventListener('timeupdate', handleTimeUpdate)
          audioRef.current.addEventListener('play', handlePlay)
          audioRef.current.addEventListener('pause', handlePause)
          audioRef.current.addEventListener('ended', handleEnded)
          audioRef.current.addEventListener('error', handleError)

          // Store cleanup functions for removal
          // We use a custom property to track the handlers for cleanup
          ;(audioRef.current as any)._eventCleanup = () => {
            const audio = audioRef.current
            if (audio) {
              audio.removeEventListener('timeupdate', handleTimeUpdate)
              audio.removeEventListener('play', handlePlay)
              audio.removeEventListener('pause', handlePause)
              audio.removeEventListener('ended', handleEnded)
              audio.removeEventListener('error', handleError)
            }
          }
        }

        const mimeType = getAudioMimeType(filePath, base64)

        // Generate waveform data for visualization (skip if already loaded)
        const { waveformLoadedForId } = useUIStore.getState()
        if (waveformLoadedForId !== recordingId || !useUIStore.getState().playbackWaveformChannels?.length) {
          // H5: prefer the disk cache — instant, no recompute.
          const cachedPeaks = await tryLoadCachedWaveform(recordingId)
          if (cancelled()) return
          if (cachedPeaks) {
            setWaveformData(cachedPeaks.peaks, cachedPeaks.channels, cachedPeaks.duration)
            measuredDurationRef.current = cachedPeaks.duration
            useUIStore.getState().setWaveformLoadedFor(recordingId)
            if (shouldLogQa()) console.log('[useAudioPlayback] Waveform loaded from cache during play')
          } else {
            // Playback streams through the media element. Never decode the whole
            // recording into PCM merely to draw a missing waveform.
            const playbackState = useUIStore.getState()
            setWaveformData(null)
            if (playbackState.waveformLoadingId !== recordingId) {
              playbackState.setWaveformLoadingError(recordingId, 'Waveform preview unavailable')
            }
          }
        } else {
          if (shouldLogQa()) console.log('[useAudioPlayback] Skipping waveform generation - already loaded')
        }

        const state = useUIStore.getState()
        if (state.waveformLoadedForId === recordingId) {
          measuredDurationRef.current = state.waveformDuration || measuredDurationRef.current
          if (state.playbackWaveformChannels?.length === 2) {
            const context = new AudioContext()
            playbackContextRef.current = context
            stereoRef.current = connectStereoPlayback(context, context.createMediaElementSource(audioRef.current), context.destination)
            if (state.mutedChannelsForId === recordingId) state.playbackMutedChannels.forEach((muted, channel) => stereoRef.current?.setMuted(channel, muted))
            let stereoDeadline: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                context.resume(),
                new Promise<never>((_, reject) => {
                  stereoDeadline = setTimeout(() => reject(new Error('Stereo context resume timed out')), 5000)
                })
              ])
            } finally {
              clearTimeout(stereoDeadline)
            }
            if (cancelled()) { releaseStereo(); return }
          }
        }
        setPlaybackProgress(0, measuredDurationRef.current)
        // Convert base64 to Blob URL (more reliable than data URI for larger files)
        const binaryData = atob(base64)
        const uint8Array = new Uint8Array(binaryData.length)
        for (let i = 0; i < binaryData.length; i++) {
          uint8Array[i] = binaryData.charCodeAt(i)
        }
        const blob = new Blob([uint8Array], { type: mimeType })
        audioBlobUrlRef.current = URL.createObjectURL(blob)

        if (shouldLogQa()) console.log(`[QA-MONITOR][Operation] Setting audio src (Blob URL), mime: ${mimeType}, size: ${blob.size} bytes`)
        audioRef.current.src = audioBlobUrlRef.current
        if (Number.isFinite(startTimeSec) && startTimeSec > 0) {
          if (audioRef.current.readyState < HTMLMediaElement.HAVE_METADATA) {
            await new Promise<void>((resolve, reject) => {
              const audio = audioRef.current
              if (!audio) return reject(new Error('Audio element was released before preview'))
              const onLoaded = () => {
                cleanup()
                resolve()
              }
              const onError = () => {
                cleanup()
                reject(new Error('Could not load audio metadata for preview'))
              }
              const cleanup = () => {
                audio.removeEventListener('loadedmetadata', onLoaded)
                audio.removeEventListener('error', onError)
                audio.removeEventListener('emptied', onLoaded)
                clearTimeout(deadline)
              }
              const deadline = setTimeout(onError, 5000)
              audio.addEventListener('emptied', onLoaded, { once: true })
              audio.addEventListener('loadedmetadata', onLoaded, { once: true })
              audio.addEventListener('error', onError, { once: true })
            })
          }
          if (cancelled()) return
          const duration = mediaDuration()
          seekAudio(startTimeSec)
          setPlaybackProgress(audioRef.current.currentTime, duration)
        }
        if (shouldLogQa()) console.log('[QA-MONITOR][Operation] Calling audio.play()')
        const audio = audioRef.current
        let playDeadline: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            audio.play(),
            new Promise<never>((_, reject) => {
              playDeadline = setTimeout(() => { audio.pause(); reject(new Error('Playback start timed out')) }, 5000)
            })
          ])
        } finally {
          clearTimeout(playDeadline)
        }
        if (shouldLogQa()) console.log('[QA-MONITOR][Operation] audio.play() resolved successfully')
      } catch (error) {
        if (cancelled()) return
        const libraryError = parseError(error, 'audio playback')
        console.error('[useAudioPlayback] Play error:', error)
        toast({
          title: 'Playback error',
          description: getErrorMessage(libraryError.type),
          variant: 'error'
        })
        releaseStereo()
        setIsPlaying(false)
        setCurrentlyPlaying(null, null)
        setWaveformData(null)
      } finally {
        // Always release the lock when done
        playbackLockRef.current = null
      }
    }, cancelled)

    return playbackLockRef.current
  }, [setCurrentlyPlaying, setPlaybackProgress, setIsPlaying, setWaveformData, releaseStereo, mediaDuration, seekAudio])

  // ---- Waveform-Only Load ----

  const loadWaveformOnly = useCallback(async (recordingId: string, filePath: string) => {
    if (shouldLogQa()) console.log('[QA-MONITOR][Operation] Loading waveform only: ' + recordingId)
    // Retain the existing controller signature; source bytes stay in main.
    void filePath

    if (waveformAbortControllerRef.current) waveformAbortControllerRef.current.abort()
    const controller = new AbortController()
    waveformAbortControllerRef.current = controller
    waveformPendingRecordingRef.current = recordingId
    const signal = controller.signal
    const { setWaveformLoading, setWaveformLoadingError, setWaveformLoadedFor, setWaveformData } = useUIStore.getState()
    setWaveformLoading(recordingId)
    const clearOwnedLoading = () => {
      if (waveformAbortControllerRef.current !== controller) return
      const state = useUIStore.getState()
      if (state.waveformLoadingId === recordingId) state.setWaveformLoading(null)
    }

    return queueAudioWork(async () => {
      const requestId = crypto.randomUUID()
      const cancelGeneration = () => {
        try {
          const cancellation = window.electronAPI?.waveform?.cancelGeneration?.(requestId)
          void cancellation?.catch((error) => {
            console.warn('[useAudioPlayback] Waveform cancellation failed:', error)
          })
        } catch (error) {
          console.warn('[useAudioPlayback] Waveform cancellation failed:', error)
        }
        clearOwnedLoading()
      }
      signal.addEventListener('abort', cancelGeneration, { once: true })
      if (signal.aborted) cancelGeneration()
      try {
        if (signal.aborted) return
        const cached = await tryLoadCachedWaveform(recordingId, requestId)
        if (signal.aborted) return
        if (!cached) {
          setWaveformLoadingError(recordingId, 'Waveform preview unavailable')
          setWaveformData(null)
          return
        }

        setWaveformData(cached.peaks, cached.channels, cached.duration)
        setWaveformLoadedFor(recordingId)
        if (!useUIStore.getState().currentlyPlayingId) {
          useUIStore.getState().setPlaybackProgress(0, cached.duration)
        }
        if (shouldLogQa()) console.log('[QA-MONITOR][Operation] Main-process waveform loaded: ' + recordingId)
      } catch (error) {
        if (signal.aborted) return
        const libraryError = parseError(error, 'waveform generation')
        console.error('[useAudioPlayback] Waveform load error:', error)
        setWaveformLoadingError(recordingId, getErrorMessage(libraryError.type))
        setWaveformData(null)
      } finally {
        signal.removeEventListener('abort', cancelGeneration)
      }
    }, () => signal.aborted).finally(() => {
      clearOwnedLoading()
      if (waveformAbortControllerRef.current === controller) {
        waveformAbortControllerRef.current = null
        waveformPendingRecordingRef.current = null
      }
    })
  }, [])
  // ---- Simple Controls ----

  const pauseAudio = useCallback(() => {
    if (audioRef.current) audioRef.current.pause()
  }, [])

  const resumeAudio = useCallback(() => {
    if (playbackContextRef.current) void playbackContextRef.current.resume()
    if (audioRef.current) void audioRef.current.play()
  }, [])

  const stopAudio = useCallback(() => {
    releaseStereo()
    // Navigation must also cancel reads/decodes that have not reached play yet.
    cancelPendingPlayback()
    if (audioRef.current) {
      // Clean up event listeners when stopping
      if ((audioRef.current as any)._eventCleanup) {
        ;(audioRef.current as any)._eventCleanup()
      }
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null // Clear the ref to allow recreation with fresh listeners
    }
    if (audioBlobUrlRef.current) {
      URL.revokeObjectURL(audioBlobUrlRef.current)
      audioBlobUrlRef.current = null
    }
    setIsPlaying(false)
    setCurrentlyPlaying(null, null)
    setPlaybackProgress(0, 0)
    // Intentionally do NOT clear the waveform peaks on stop. The reader's list
    // click calls stop() before (re)selecting, and the docked player should keep
    // showing the recording's waveform. Clearing here — while `waveformLoadedForId`
    // still names this recording — made the guarded reload a no-op, leaving the
    // reader on "Press play to load the waveform" until the user pressed Play.
  }, [cancelPendingPlayback, setCurrentlyPlaying, setIsPlaying, setPlaybackProgress, releaseStereo])

  const setPlaybackRate = useCallback((rate: number) => {
    rateRef.current = rate
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [])

  const setChannelMuted = useCallback((recordingId: string, channel: number, muted: boolean) => {
    if (channel !== 0 && channel !== 1) return
    const state = useUIStore.getState()
    const channels = state.mutedChannelsForId === recordingId ? [...state.playbackMutedChannels] : [false, false]
    channels[channel] = muted
    useUIStore.setState({ mutedChannelsForId: recordingId, playbackMutedChannels: channels })
    if (state.currentlyPlayingId === recordingId) stereoRef.current?.setMuted(channel, muted)
  }, [])

  // ---- Expose controls globally via window.__audioControls ----

  useEffect(() => {
    window.__audioControls = {
      play: playAudio,
      pause: pauseAudio,
      resume: resumeAudio,
      stop: stopAudio,
      seek: seekAudio,
      setChannelMuted,
      setPlaybackRate,
      loadWaveformOnly
    }

    return () => {
      delete window.__audioControls
    }
  }, [playAudio, pauseAudio, resumeAudio, stopAudio, seekAudio, setPlaybackRate, setChannelMuted, loadWaveformOnly])

  // ---- Cleanup on unmount ----

  useEffect(() => {
    return () => {
      releaseStereo()
      cancelPendingPlayback()
      // Clean up audio element
      if (audioRef.current) {
        // Remove event listeners first to prevent memory leaks
        if ((audioRef.current as any)._eventCleanup) {
          ;(audioRef.current as any)._eventCleanup()
        }
        audioRef.current.pause()
        audioRef.current.src = ''
      }
      // Clean up blob URL
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current)
        audioBlobUrlRef.current = null
      }
      // Abort any in-flight waveform generation
      if (waveformAbortControllerRef.current) {
        waveformAbortControllerRef.current.abort()
      }
    }
  }, [cancelPendingPlayback, releaseStereo])
}
