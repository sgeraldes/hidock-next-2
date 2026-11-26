/**
 * The header's media area: what plays or records right now, with its controls.
 *
 *  - A PC recording (usePcRecorderStore): red dot, elapsed time, Stop.
 *  - A live session from the HiDock (Device page): dot, elapsed time, Stop.
 *  - Playback: a recording through the shared player (useUIStore, driven by
 *    window.__audioControls) or a page video/sample (useMediaSessionStore):
 *    title, play/pause, position bar, elapsed and total time, Open, Stop.
 *  - Nothing of the above: the Record control only.
 *
 * Everything here reads and drives the same shared state the pages use, so
 * the header and an in-page player always show the same position.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, ExternalLink, Mic, Pause, Play, Radio, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/utils/formatters'
import { useUIStore } from '@/store/useUIStore'
import { useAppStore } from '@/store/useAppStore'
import { usePcRecorderStore } from '@/store/usePcRecorderStore'
import { pauseElementMedia, useMediaSessionStore } from '@/store/useMediaSessionStore'
import { useAudioControls } from '@/components/OperationController'
import { useDeviceConnection } from '@/hooks/useDeviceConnection'
import { isFeatureOffThisRun } from '@/lib/bootFeatures'
import { getDisplayTitle } from '@/features/library/utils/getDisplayTitle'
import type { DeviceAudioDiagnosticsState } from '@/shared/device-audio'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

const ICON_BUTTON =
  'titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-300 hover:bg-slate-700 hover:text-slate-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50'
const TEXT_BUTTON =
  'titlebar-no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-slate-600 px-2 text-[13px] text-slate-200 hover:bg-slate-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50'
const SEGMENT = 'flex h-7 min-w-0 items-center gap-1.5'
const CLOCK = 'font-mono text-[13px] tabular-nums text-slate-300'

/**
 * While a live session runs, the header also asks main every few seconds: a
 * session can end without a stop call (the Device page closing, an error).
 * While idle it only listens: main pushes the state on start, on stop and with
 * every packet.
 */
const LIVE_POLL_MS = 3000

/** The Device page's live streaming card (pages/Device.tsx). */
export const LIVE_SECTION_ID = 'device-live-streaming'

/** How long the header waits for the Device page to render its live card. */
const REVEAL_WAIT_MS = 5000

/**
 * Live capture runs on the Device page (it polls the device and stops when the
 * page closes), so the header takes the owner there and brings the live
 * controls into view once the page has rendered them.
 */
function useRevealLive(): () => void {
  const navigate = useNavigate()
  return () => {
    navigate('/sync')
    const deadline = Date.now() + REVEAL_WAIT_MS
    const reveal = () => {
      const section = document.getElementById(LIVE_SECTION_ID)
      if (section) {
        section.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
        section.focus({ preventScroll: true })
      } else if (Date.now() < deadline) {
        window.setTimeout(reveal, 100)
      }
    }
    window.setTimeout(reveal, 0)
  }
}

function RecordingDot({ paused = false }: { paused?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        paused ? 'bg-amber-400' : 'bg-red-500 animate-pulse motion-reduce:animate-none'
      )}
    />
  )
}

/** The HiDock's live session as main reports it, only while the device is connected. */
function useDeviceLiveSession(enabled: boolean): DeviceAudioDiagnosticsState | null {
  const [state, setState] = useState<DeviceAudioDiagnosticsState | null>(null)
  const active = enabled && state !== null && state.session.status !== 'idle'
  useEffect(() => {
    const api = window.electronAPI?.jensen
    if (!enabled || !api?.getAudioDiagnostics) return
    let cancelled = false
    const receive = (value: DeviceAudioDiagnosticsState) => {
      if (!cancelled) setState(value)
    }
    api.getAudioDiagnostics().then(receive, (error: unknown) => console.warn('[HeaderMedia] Live session read failed:', error))
    const unsubscribe = api.onAudioDiagnostics?.(receive)
    return () => {
      cancelled = true
      unsubscribe?.()
      setState(null)
    }
  }, [enabled])
  useEffect(() => {
    const api = window.electronAPI?.jensen
    if (!active || !api?.getAudioDiagnostics) return
    let cancelled = false
    let requesting = false
    const timer = window.setInterval(() => {
      if (requesting) return
      requesting = true
      api.getAudioDiagnostics()
        .then((value) => { if (!cancelled) setState(value) })
        .catch((error: unknown) => console.warn('[HeaderMedia] Live session read failed:', error))
        .finally(() => { requesting = false })
    }, LIVE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active])
  return enabled ? state : null
}

function PcRecordingSegment({ compact }: { compact: boolean }) {
  const status = usePcRecorderStore((s) => s.status)
  const elapsed = usePcRecorderStore((s) => s.elapsed)
  const stop = usePcRecorderStore((s) => s.stop)
  const open = usePcRecorderStore((s) => s.open)
  const saving = status === 'saving'
  return (
    <div role="group" aria-label="Recording on this PC" className={SEGMENT}>
      <button
        type="button"
        onClick={open}
        title="Show the recording levels"
        className="titlebar-no-drag flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-red-300 hover:bg-slate-800 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <RecordingDot />
        <span className="hidden @3xs:inline">{status === 'starting' ? 'Starting' : saving ? 'Saving' : 'Recording'}</span>
        <span className={cn(CLOCK, compact && 'hidden @3xs:inline')}>{formatDuration(elapsed)}</span>
      </button>
      <button
        type="button"
        aria-label="Stop recording"
        title="Stop recording"
        disabled={status !== 'recording'}
        onClick={() => void stop()}
        className={cn(ICON_BUTTON, 'text-red-300')}
      >
        <Square className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

function LiveSegment({ live, compact }: { live: DeviceAudioDiagnosticsState; compact: boolean }) {
  const revealLive = useRevealLive()
  const [stopping, setStopping] = useState(false)
  const label = live.session.transcribe ? 'Live transcription' : 'Live audio'
  const paused = live.session.status === 'paused'
  const stopLive = async () => {
    setStopping(true)
    try {
      const result = await window.electronAPI.jensen.stopRealtime()
      if (!result) console.warn('[HeaderMedia] The device did not confirm the live stop')
    } catch (error) {
      console.warn('[HeaderMedia] Live stop failed:', error)
    } finally {
      setStopping(false)
    }
  }
  return (
    <div role="group" aria-label={label} className={SEGMENT}>
      <button
        type="button"
        onClick={revealLive}
        title={`Open ${label.toLowerCase()} on the Device page`}
        className="titlebar-no-drag flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-red-300 hover:bg-slate-800 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <RecordingDot paused={paused} />
        <span className="hidden @3xs:inline">{paused ? `${label}, paused` : label}</span>
        <span className="sr-only @3xs:hidden">{paused ? 'paused' : ''}</span>
        <span className={cn(CLOCK, compact && 'hidden @3xs:inline')}>{formatDuration(live.diagnostics.sampleElapsedMs / 1000)}</span>
      </button>
      <button
        type="button"
        aria-label={`Stop ${label.toLowerCase()}`}
        title={`Stop ${label.toLowerCase()}`}
        disabled={stopping || live.owned === false}
        onClick={() => void stopLive()}
        className={cn(ICON_BUTTON, 'text-red-300')}
      >
        <Square className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

interface PlaybackView {
  key: unknown
  title: string
  isPlaying: boolean
  currentTime: number
  duration: number
  sourceId: string | null
  toggle(): void
  seek(time: number): void
  stop(): void
}

function useRecordingTitle(id: string | null, path: string | null): string {
  const recordings = useAppStore((s) => s.unifiedRecordings)
  return useMemo(() => {
    if (!id) return ''
    const recording = recordings.find((r) => r.id === id) ??
      recordings.find((r) => path && 'localPath' in r && r.localPath === path)
    return recording ? getDisplayTitle(recording).primaryText : 'Recording'
  }, [recordings, id, path])
}

/** The one playback the header shows: a page element session, else the shared recording player. */
function usePlaybackView(): PlaybackView | null {
  const controls = useAudioControls()
  const element = useMediaSessionStore((s) => s.active)
  const elementPlaying = useMediaSessionStore((s) => s.isPlaying)
  const elementTime = useMediaSessionStore((s) => s.currentTime)
  const elementDuration = useMediaSessionStore((s) => s.duration)
  const recordingId = useUIStore((s) => s.currentlyPlayingId)
  const recordingPath = useUIStore((s) => s.currentlyPlayingPath)
  const recordingPlaying = useUIStore((s) => s.isPlaying)
  const recordingTime = useUIStore((s) => s.playbackCurrentTime)
  const recordingDuration = useUIStore((s) => s.playbackDuration)
  const recordingTitle = useRecordingTitle(recordingId, recordingPath)
  // A recording shows here once it has played. Loading one to show a find
  // result (play with autoPlay false) does not take over the header.
  const [playedId, setPlayedId] = useState<string | null>(null)
  if (recordingId && recordingPlaying && playedId !== recordingId) setPlayedId(recordingId)
  // The playback ended (or was stopped): a later load of the same recording
  // must play before it shows here again.
  if (!recordingId && playedId !== null) setPlayedId(null)

  if (element) {
    const media = element.element
    return {
      key: media,
      title: element.title,
      isPlaying: elementPlaying,
      currentTime: elementTime,
      duration: elementDuration,
      sourceId: element.sourceId ?? null,
      toggle: () => {
        if (!media.paused) { media.pause(); return }
        media.play().catch((error: unknown) => console.warn('[HeaderMedia] Playback did not start:', error))
      },
      seek: (time) => { media.currentTime = time },
      stop: () => pauseElementMedia({ endSession: true })
    }
  }
  if (recordingId && playedId === recordingId) {
    return {
      key: recordingId,
      title: recordingTitle,
      isPlaying: recordingPlaying,
      currentTime: recordingTime,
      duration: recordingDuration,
      sourceId: recordingId,
      toggle: () => { if (recordingPlaying) controls.pause(); else controls.resume() },
      seek: (time) => controls.seek(time),
      stop: () => controls.stop()
    }
  }
  return null
}

function PlaybackSegment({ view }: { view: PlaybackView }) {
  const navigate = useNavigate()
  const location = useLocation()
  // The page a playback started from: Open goes back to it when it is the
  // recording's own page (a meeting), otherwise to the source in the Library.
  const [origin, setOrigin] = useState<{ key: unknown; pathname: string; search: string } | null>(null)
  useEffect(() => {
    setOrigin((current) => (current?.key === view.key ? current : { key: view.key, pathname: location.pathname, search: location.search }))
    // Only a new playback records its page; later navigation does not move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.key])

  const openSource = () => {
    const from = origin?.key === view.key ? origin : null
    if (from?.pathname.startsWith('/meeting/')) navigate(`${from.pathname}${from.search}`)
    else if (view.sourceId) navigate('/library', { state: { selectedId: view.sourceId } })
    else if (from) navigate(`${from.pathname}${from.search}`)
  }
  const canSeek = view.duration > 0
  return (
    <div role="group" aria-label={`Now playing: ${view.title}`} className={cn(SEGMENT, 'gap-1')}>
      <button
        type="button"
        aria-label={view.isPlaying ? 'Pause' : 'Play'}
        title={view.isPlaying ? 'Pause' : 'Play'}
        onClick={view.toggle}
        className={ICON_BUTTON}
      >
        {view.isPlaying ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
      </button>
      <span title={view.title} className="hidden min-w-0 max-w-[14rem] truncate text-[13px] text-slate-100 @md:block">
        {view.title}
      </span>
      <span className={cn(CLOCK, 'hidden @2xs:inline')}>{formatDuration(view.currentTime)}</span>
      <input
        type="range"
        aria-label="Playback position"
        aria-valuetext={`${formatDuration(view.currentTime)} of ${formatDuration(view.duration)}`}
        min={0}
        max={canSeek ? view.duration : 0}
        step={1}
        value={canSeek ? Math.min(view.currentTime, view.duration) : 0}
        disabled={!canSeek}
        onChange={(event) => view.seek(Number(event.target.value))}
        className="titlebar-no-drag hidden h-7 w-20 min-w-0 cursor-pointer accent-sky-400 disabled:cursor-default @xs:block @lg:w-36"
      />
      <span className={cn(CLOCK, 'hidden text-slate-400 @2xs:inline')}>{formatDuration(view.duration)}</span>
      <button
        type="button"
        aria-label={`Open ${view.title}`}
        title={`Open ${view.title}`}
        onClick={openSource}
        className={cn(ICON_BUTTON, 'hidden @3xs:flex')}
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" aria-label="Stop playback" title="Stop playback" onClick={view.stop} className={ICON_BUTTON}>
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}

function RecordControl({ deviceConnected }: { deviceConnected: boolean }) {
  const revealLive = useRevealLive()
  const open = usePcRecorderStore((s) => s.open)
  const start = usePcRecorderStore((s) => s.start)
  // After "Live transcription" the focus belongs to the Device page's live
  // card, so the closing menu must not hand it back to this trigger.
  const keepFocusAway = useRef(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={TEXT_BUTTON} aria-label="Record" title="Record">
          <Mic className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden @3xs:inline">Record</span>
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="titlebar-no-drag w-64"
        onCloseAutoFocus={(event) => {
          if (keepFocusAway.current) event.preventDefault()
          keepFocusAway.current = false
        }}
      >
        <DropdownMenuItem onSelect={() => { open(); void start() }}>
          <Mic className="mr-2 h-4 w-4" aria-hidden="true" />
          Record on this PC
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!deviceConnected}
          onSelect={() => { keepFocusAway.current = true; revealLive() }}
        >
          <Radio className="mr-2 h-4 w-4" aria-hidden="true" />
          <span className="flex flex-col">
            <span>Live transcription from the HiDock</span>
            {!deviceConnected && <span className="text-xs text-muted-foreground">Connect the HiDock first</span>}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function HeaderMedia() {
  const { status } = useDeviceConnection({ toastErrors: false })
  const deviceConnected = status === 'connected'
  const recorderStatus = usePcRecorderStore((s) => s.status)
  const live = useDeviceLiveSession(deviceConnected && !isFeatureOffThisRun('device-sync'))
  const playback = usePlaybackView()

  const recording = recorderStatus === 'starting' || recorderStatus === 'recording' || recorderStatus === 'saving'
  const liveActive = live !== null && live.session.status !== 'idle'
  const capturing = recording || liveActive
  const segments = Number(recording) + Number(liveActive) + Number(playback !== null)
  // Several segments at once drop their clocks below 16rem, so each keeps only
  // what controls it (a capture: dot and Stop; a playback: Play and Stop).
  const compact = segments > 1

  return (
    // The media cell: a size container that takes the free width between the
    // search and the right cluster. Details step aside by the width it really
    // has, and its floor is what must always fit, so nothing it holds is
    // clipped and nothing spills over the search, the right cluster or the
    // window controls. The padding keeps focus rings visible inside the clip.
    <div
      data-testid="header-media-cell"
      className="@container flex min-w-0 flex-1 justify-end"
      style={{ minWidth: mediaFloorPx(recording, liveActive, playback !== null) }}
    >
      <div className="flex min-w-0 shrink items-center justify-end gap-3 overflow-hidden p-0.5" aria-label="Media" role="region">
        {recording && <PcRecordingSegment compact={compact} />}
        {liveActive && <LiveSegment live={live} compact={compact} />}
        {playback && <PlaybackSegment view={playback} />}
        {/* Record is the whole area when nothing plays; next to a playback it
            shows only when there is room for both. */}
        {!capturing && (
          <div className={playback ? 'hidden @sm:flex' : 'flex'}>
            <RecordControl deviceConnected={deviceConnected} />
          </div>
        )}
      </div>
    </div>
  )
}

/** Widths of what never hides, in px (h-7 icon buttons are 28 px). */
const FLOOR = {
  /** p-0.5 on both sides. */
  padding: 4,
  /** gap-3 between segments. */
  gap: 12,
  /** A capture alone: dot button with its clock (up to h:mm:ss, about 84 px), gap, Stop. */
  capture: 84 + 6 + 28,
  /** A capture next to another segment: dot button without the clock, gap, Stop. */
  captureCompact: 20 + 6 + 28,
  /** Play or Pause, gap, Stop. */
  playback: 28 + 4 + 28,
  /** The Record button, icon and caret. */
  record: 52
}

/** The narrowest the media cell may get without clipping a control that stops or pauses. */
export function mediaFloorPx(recording: boolean, live: boolean, playback: boolean): number {
  const captures = Number(recording) + Number(live)
  const segments = captures + Number(playback)
  if (segments === 0) return FLOOR.padding + FLOOR.record
  const capture = segments > 1 ? FLOOR.captureCompact : FLOOR.capture
  return FLOOR.padding + captures * capture + (playback ? FLOOR.playback : 0) + (segments - 1) * FLOOR.gap
}
