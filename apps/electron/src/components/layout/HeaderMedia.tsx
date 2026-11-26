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

/** How often the header asks main for the live session while the HiDock is connected. */
const LIVE_POLL_MS = 2000

/** The Device page's live streaming card (pages/Device.tsx). */
export const LIVE_SECTION_ID = 'device-live-streaming'

/**
 * Live capture runs on the Device page (it polls the device and stops when the
 * page closes), so the header takes the owner there and brings the live
 * controls into view once the page has rendered them.
 */
function useRevealLive(): () => void {
  const navigate = useNavigate()
  return () => {
    navigate('/sync', { state: { focus: 'live' } })
    let attempts = 0
    const reveal = () => {
      const section = document.getElementById(LIVE_SECTION_ID)
      if (section) {
        section.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
        section.focus({ preventScroll: true })
      } else if (++attempts < 40) {
        window.setTimeout(reveal, 50)
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

/**
 * The HiDock's live session, as main reports it. Main pushes an update with
 * every packet but none on stop, so the header also asks every two seconds,
 * and only while the device is connected.
 */
function useDeviceLiveSession(enabled: boolean): DeviceAudioDiagnosticsState | null {
  const [state, setState] = useState<DeviceAudioDiagnosticsState | null>(null)
  useEffect(() => {
    const api = window.electronAPI?.jensen
    if (!enabled || !api?.getAudioDiagnostics) return
    let cancelled = false
    let requesting = false
    const receive = (value: DeviceAudioDiagnosticsState) => {
      if (!cancelled) setState(value)
    }
    const refresh = async () => {
      if (requesting || cancelled) return
      requesting = true
      try {
        receive(await api.getAudioDiagnostics())
      } catch (error) {
        console.warn('[HeaderMedia] Live session read failed:', error)
      } finally {
        requesting = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), LIVE_POLL_MS)
    const unsubscribe = api.onAudioDiagnostics?.(receive)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      unsubscribe?.()
      setState(null)
    }
  }, [enabled])
  return enabled ? state : null
}

function PcRecordingSegment() {
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
        <span className="hidden md:inline">{status === 'starting' ? 'Starting' : saving ? 'Saving' : 'Recording'}</span>
        <span className={CLOCK}>{formatDuration(elapsed)}</span>
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

function LiveSegment({ live }: { live: DeviceAudioDiagnosticsState }) {
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
        <span className="hidden md:inline">{paused ? `${label}, paused` : label}</span>
        <span className="sr-only md:hidden">{paused ? 'paused' : ''}</span>
        <span className={CLOCK}>{formatDuration(live.diagnostics.sampleElapsedMs / 1000)}</span>
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

  if (element) {
    const media = element.element
    return {
      key: media,
      title: element.title,
      isPlaying: elementPlaying,
      currentTime: elementTime,
      duration: elementDuration,
      sourceId: element.sourceId ?? null,
      toggle: () => { if (media.paused) void media.play(); else media.pause() },
      seek: (time) => { media.currentTime = time },
      stop: () => pauseElementMedia({ endSession: true })
    }
  }
  if (recordingId) {
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
      <span title={view.title} className="hidden min-w-0 max-w-[14rem] truncate text-[13px] text-slate-100 lg:block">
        {view.title}
      </span>
      <span className={cn(CLOCK, 'hidden sm:inline')}>{formatDuration(view.currentTime)}</span>
      <input
        type="range"
        aria-label="Playback position"
        aria-valuetext={`${formatDuration(view.currentTime)} of ${formatDuration(view.duration)}`}
        min={0}
        max={canSeek ? view.duration : 0}
        step={0.1}
        value={canSeek ? Math.min(view.currentTime, view.duration) : 0}
        disabled={!canSeek}
        onChange={(event) => view.seek(Number(event.target.value))}
        className="titlebar-no-drag hidden h-7 w-20 min-w-0 cursor-pointer accent-sky-400 disabled:cursor-default md:block xl:w-36"
      />
      <span className={cn(CLOCK, 'hidden text-slate-400 sm:inline')}>{formatDuration(view.duration)}</span>
      <button
        type="button"
        aria-label={`Open ${view.title}`}
        title={`Open ${view.title}`}
        onClick={openSource}
        className={ICON_BUTTON}
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
          <span className="hidden md:inline">Record</span>
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
  const nothing = !recording && !liveActive && !playback

  return (
    // min-w-0 + overflow-hidden: at narrow widths this area gives way before the
    // search (which keeps its 160px floor) and never spills over the right
    // cluster or the window controls. The padding keeps focus rings visible.
    <div className="flex min-w-0 shrink items-center justify-end gap-3 overflow-hidden p-0.5" aria-label="Media" role="region">
      {recording && <PcRecordingSegment />}
      {liveActive && <LiveSegment live={live} />}
      {playback && <PlaybackSegment view={playback} />}
      {nothing && <RecordControl deviceConnected={deviceConnected} />}
    </div>
  )
}
