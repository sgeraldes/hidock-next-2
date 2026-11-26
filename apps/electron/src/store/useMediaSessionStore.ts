/**
 * Media session for page-owned <audio> and <video> elements.
 *
 * Recordings play through the one element owned by useAudioPlayback; its state
 * lives in useUIStore. A few pages also render their own media element (the
 * video of a captured clip, the speaker-review sample). Those register here so
 * that the app never plays two things at once:
 *  - an element that starts pauses every other registered element and stops
 *    the recording player;
 *  - the recording player calls pauseElementMedia() before it plays.
 *
 * The header's media area reads the active element session from this store.
 */

import { create } from 'zustand'

export type MediaKind = 'audio' | 'video'

export interface ElementMediaMeta {
  kind: MediaKind
  title: string
  /** Library source to open from the header, when the media belongs to one. */
  sourceId?: string
}

export interface ElementMediaSession extends ElementMediaMeta {
  element: HTMLMediaElement
}

interface MediaSessionState {
  active: ElementMediaSession | null
  isPlaying: boolean
  currentTime: number
  duration: number
}

const registered = new Set<HTMLMediaElement>()

export const useMediaSessionStore = create<MediaSessionState>(() => ({
  active: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0
}))

function finite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function isActive(element: HTMLMediaElement): boolean {
  return useMediaSessionStore.getState().active?.element === element
}

function endSession(): void {
  useMediaSessionStore.setState({ active: null, isPlaying: false, currentTime: 0, duration: 0 })
}

/**
 * Pause every registered element except `options.except`. The recording player
 * passes `endSession: true` so the header switches to the recording.
 */
export function pauseElementMedia(options: { except?: HTMLMediaElement; endSession?: boolean } = {}): void {
  for (const element of registered) {
    if (element !== options.except && !element.paused) element.pause()
  }
  if (options.endSession) endSession()
}

/** Registers a page-owned media element. Returns the unregister function. */
export function registerElementMedia(element: HTMLMediaElement, getMeta: () => ElementMediaMeta): () => void {
  registered.add(element)

  const progress = () => {
    if (!isActive(element)) return
    useMediaSessionStore.setState({ currentTime: finite(element.currentTime), duration: finite(element.duration) })
  }
  const onPlay = () => {
    pauseElementMedia({ except: element })
    // Starting here stops a recording that plays (or is still loading) elsewhere.
    window.__audioControls?.stop()
    useMediaSessionStore.setState({
      active: { ...getMeta(), element },
      isPlaying: true,
      currentTime: finite(element.currentTime),
      duration: finite(element.duration)
    })
  }
  const onPause = () => {
    if (isActive(element)) useMediaSessionStore.setState({ isPlaying: false })
  }
  const onEnded = () => {
    if (isActive(element)) endSession()
  }

  element.addEventListener('play', onPlay)
  element.addEventListener('pause', onPause)
  element.addEventListener('ended', onEnded)
  element.addEventListener('timeupdate', progress)
  element.addEventListener('durationchange', progress)
  element.addEventListener('loadedmetadata', progress)

  return () => {
    element.removeEventListener('play', onPlay)
    element.removeEventListener('pause', onPause)
    element.removeEventListener('ended', onEnded)
    element.removeEventListener('timeupdate', progress)
    element.removeEventListener('durationchange', progress)
    element.removeEventListener('loadedmetadata', progress)
    registered.delete(element)
    // A page that goes away takes its playback with it.
    if (!element.paused) element.pause()
    if (isActive(element)) endSession()
  }
}
