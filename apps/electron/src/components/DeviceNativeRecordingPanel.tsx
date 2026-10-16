import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { DeviceNativeRecordingStatus, NativeRecordingDispatch } from '../shared/device-native-recording'

type Jensen = typeof window.electronAPI.jensen
type FormatValue = NonNullable<Awaited<ReturnType<Jensen['getCustomRecordingFormat']>>>
type ProfileValue = NonNullable<Awaited<ReturnType<Jensen['getCustomRecordingProfile']>>>
type RulesValue = NonNullable<Awaited<ReturnType<Jensen['getCustomMarkerRules']>>>
type WriteReply = Awaited<ReturnType<Jensen['setCustomRecordingFormat']>>

type Capability<T> =
  | { state: 'unknown' }
  | { state: 'supported'; value: T }
  | { state: 'unsupported'; error?: string }

interface Settings {
  format: Capability<FormatValue>
  profile: Capability<ProfileValue>
  rules: Capability<RulesValue>
}

interface Drafts {
  format: 'mp3' | 'wav'
  bitrate: 0 | 1 | 2 | 3
  gain1: string
  gain2: string
  rulesEnabled: boolean
  lane: 0 | 1 | 2
  threshold: string
}

interface ActionResult {
  tone: 'ok' | 'warn' | 'error'
  lines: string[]
}

const UNKNOWN_SETTINGS: Settings = { format: { state: 'unknown' }, profile: { state: 'unknown' }, rules: { state: 'unknown' } }
const BITRATES = [64, 96, 128, 160] as const
const UNITY_Q15 = 32768
const MAX_THRESHOLD = 32767

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const q15ToPercentText = (q15: number): string => String(Number(((q15 * 100) / UNITY_Q15).toFixed(4)))

function percentTextToQ15(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const percent = Number(trimmed)
  if (!Number.isFinite(percent) || percent > 200) return null
  return Math.round((percent * UNITY_Q15) / 100)
}

function thresholdTextToInt(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1 && value <= MAX_THRESHOLD ? value : null
}

async function readCapability<T>(read: () => Promise<T | null>): Promise<Capability<T>> {
  try {
    const value = await read()
    return value ? { state: 'supported', value } : { state: 'unsupported' }
  } catch (error) {
    return { state: 'unsupported', error: message(error) }
  }
}

// Sequential on purpose: the device handles one control request at a time.
async function readSettings(jensen: Jensen): Promise<Settings> {
  const format = await readCapability(() => jensen.getCustomRecordingFormat())
  const profile = await readCapability(() => jensen.getCustomRecordingProfile())
  const rules = await readCapability(() => jensen.getCustomMarkerRules())
  return { format, profile, rules }
}

function draftsFrom(settings: Settings, previous: Drafts): Drafts {
  const next = { ...previous }
  if (settings.format.state === 'supported') next.format = settings.format.value.format
  if (settings.profile.state === 'supported') {
    next.bitrate = settings.profile.value.profile
    next.gain1 = q15ToPercentText(settings.profile.value.gainLeftQ15)
    next.gain2 = q15ToPercentText(settings.profile.value.gainRightQ15)
  }
  if (settings.rules.state === 'supported') {
    next.rulesEnabled = settings.rules.value.enabled
    next.lane = settings.rules.value.lane
    next.threshold = String(settings.rules.value.meanMagnitudeThreshold)
  }
  return next
}

const EMPTY_DRAFTS: Drafts = { format: 'mp3', bitrate: 0, gain1: '100', gain2: '100', rulesEnabled: false, lane: 2, threshold: '1' }

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

function describeCapability(cap: Capability<unknown>): string | null {
  if (cap.state === 'unknown') return 'Not read yet.'
  if (cap.state === 'unsupported') return cap.error ? `Not available on this device (${cap.error}).` : 'Not available on this device (unsupported or unreadable).'
  return null
}

function describeStorage(storage: 'stored' | 'fallback'): string {
  return storage === 'stored' ? 'Value stored on the device.' : 'The device reports its fallback value, not a stored one.'
}

function dispatchLine(label: string, dispatch: NativeRecordingDispatch): string {
  const detail = dispatch.error ? `: ${dispatch.error}` : ''
  const recording = dispatch.recording ? ` (${dispatch.recording})` : ''
  return `${label}: ${dispatch.status}${recording}${detail}`
}

export interface DeviceNativeRecordingPanelProps {
  connected: boolean
  /** Host has a live session or is busy; no device traffic is started while true. */
  disabled?: boolean
}

export function DeviceNativeRecordingPanel({ connected, disabled = false }: DeviceNativeRecordingPanelProps) {
  const [status, setStatus] = useState<DeviceNativeRecordingStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings>(UNKNOWN_SETTINGS)
  const [drafts, setDrafts] = useState<Drafts>(EMPTY_DRAFTS)
  const [readPending, setReadPending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [settingsSkipped, setSettingsSkipped] = useState(false)
  const [applyUncertain, setApplyUncertain] = useState(false)

  const lock = useRef(false)
  const readToken = useRef(0)
  const statusRef = useRef<DeviceNativeRecordingStatus | null>(null)
  statusRef.current = status

  const refresh = useCallback(async () => {
    if (lock.current) return
    lock.current = true
    const token = ++readToken.current
    setReadPending(true)
    try {
      const jensen = window.electronAPI.jensen
      let fresh: DeviceNativeRecordingStatus | null = null
      try {
        fresh = await jensen.getNativeRecordingStatus()
        if (token !== readToken.current) return
        setStatus(fresh)
        setStatusError(null)
      } catch (error) {
        if (token !== readToken.current) return
        setStatus(null)
        setStatusError(message(error))
      }
      if (!fresh || fresh.recording !== null) {
        setSettingsSkipped(Boolean(fresh))
        return
      }
      setSettingsSkipped(false)
      const next = await readSettings(jensen)
      if (token !== readToken.current) return
      setSettings(next)
      setDrafts(previous => draftsFrom(next, previous))
      if (next.format.state === 'supported' && next.profile.state === 'supported' && next.rules.state === 'supported') setApplyUncertain(false)
    } finally {
      lock.current = false
      if (token === readToken.current) setReadPending(false)
    }
  }, [])

  useEffect(() => {
    if (!connected) {
      readToken.current++
      setStatus(null)
      setStatusError(null)
      setSettings(UNKNOWN_SETTINGS)
      setDrafts(EMPTY_DRAFTS)
      setResult(null)
      setSettingsSkipped(false)
      setApplyUncertain(false)
      setReadPending(false)
      return
    }
    if (!disabled) void refresh()
  }, [connected, disabled, refresh])

  const recordingName = status?.recording ?? null
  const isRecording = recordingName !== null
  const idle = connected && !disabled && !busy && !readPending
  const settingsLocked = !idle || isRecording

  const gain1Q15 = percentTextToQ15(drafts.gain1)
  const gain2Q15 = percentTextToQ15(drafts.gain2)
  const thresholdInt = thresholdTextToInt(drafts.threshold)

  const formatDirty = settings.format.state === 'supported' && settings.format.value.format !== drafts.format
  const profileDirty =
    settings.profile.state === 'supported' &&
    (settings.profile.value.profile !== drafts.bitrate ||
      settings.profile.value.gainLeftQ15 !== gain1Q15 ||
      settings.profile.value.gainRightQ15 !== gain2Q15)
  const rulesDirty =
    settings.rules.state === 'supported' &&
    (settings.rules.value.enabled !== drafts.rulesEnabled ||
      settings.rules.value.lane !== drafts.lane ||
      settings.rules.value.meanMagnitudeThreshold !== thresholdInt)

  const profileValid = settings.profile.state !== 'supported' || (gain1Q15 !== null && gain2Q15 !== null)
  const rulesValid = settings.rules.state !== 'supported' || thresholdInt !== null
  const canApply = !settingsLocked && !applyUncertain && (formatDirty || profileDirty || rulesDirty) && profileValid && rulesValid

  const readStatusOnce = async (): Promise<DeviceNativeRecordingStatus> => {
    const fresh = await window.electronAPI.jensen.getNativeRecordingStatus()
    setStatus(fresh)
    setStatusError(null)
    return fresh
  }

  const apply = async () => {
    if (lock.current || !canApply) return
    lock.current = true
    setBusy(true)
    const lines: string[] = []
    let tone: ActionResult['tone'] = 'ok'
    try {
      const jensen = window.electronAPI.jensen
      const fresh = await readStatusOnce()
      if (fresh.recording !== null) {
        setResult({ tone: 'error', lines: [`Nothing was written: a native recording is active (${fresh.recording}).`] })
        return
      }

      let latest = settings
      const commitSettings = (patch: Partial<Settings>) => {
        latest = { ...latest, ...patch }
        setSettings(latest)
      }

      const steps: Array<{
        label: string
        run: () => Promise<WriteReply>
        verify: () => Promise<{ matches: boolean; cap: Capability<unknown>; commit: () => void }>
      }> = []

      if (formatDirty) {
        const wanted = drafts.format
        steps.push({
          label: 'Format',
          run: () => jensen.setCustomRecordingFormat(wanted),
          verify: async () => {
            const cap = await readCapability(() => jensen.getCustomRecordingFormat())
            return {
              cap,
              matches: cap.state === 'supported' && cap.value.storage === 'stored' && cap.value.format === wanted,
              commit: () => {
                if (cap.state === 'supported') commitSettings({ format: cap })
              }
            }
          }
        })
      }
      if (profileDirty && gain1Q15 !== null && gain2Q15 !== null) {
        const wanted = { profile: drafts.bitrate, gainLeftQ15: gain1Q15, gainRightQ15: gain2Q15 }
        steps.push({
          label: 'Bitrate and channel gains',
          run: () => jensen.setCustomRecordingProfile(wanted),
          verify: async () => {
            const cap = await readCapability(() => jensen.getCustomRecordingProfile())
            return {
              cap,
              matches:
                cap.state === 'supported' &&
                cap.value.storage === 'stored' &&
                cap.value.profile === wanted.profile &&
                cap.value.gainLeftQ15 === wanted.gainLeftQ15 &&
                cap.value.gainRightQ15 === wanted.gainRightQ15,
              commit: () => {
                if (cap.state === 'supported') commitSettings({ profile: cap })
              }
            }
          }
        })
      }
      if (rulesDirty && thresholdInt !== null) {
        const wanted = { enabled: drafts.rulesEnabled, lane: drafts.lane, meanMagnitudeThreshold: thresholdInt }
        steps.push({
          label: 'Automatic marker rules',
          run: () => jensen.setCustomMarkerRules(wanted),
          verify: async () => {
            const cap = await readCapability(() => jensen.getCustomMarkerRules())
            return {
              cap,
              matches:
                cap.state === 'supported' &&
                cap.value.storage === 'stored' &&
                cap.value.enabled === wanted.enabled &&
                cap.value.lane === wanted.lane &&
                cap.value.meanMagnitudeThreshold === wanted.meanMagnitudeThreshold,
              commit: () => {
                if (cap.state === 'supported') commitSettings({ rules: cap })
              }
            }
          }
        })
      }

      let stoppedAt = -1
      let verifiedCount = 0
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        let reply: WriteReply
        try {
          reply = await step.run()
        } catch (error) {
          setApplyUncertain(true)
          lines.push(`${step.label}: response unavailable; device state is unknown (${message(error)}). Refresh before applying again.`)
          stoppedAt = i
          break
        }
        if (!reply) {
          const check = await step.verify()
          check.commit()
          setApplyUncertain(true)
          lines.push(`${step.label}: no acknowledgement. ${check.matches ? 'Current readback matches the requested value.' : 'The requested value is not confirmed.'} Refresh before applying again.`)
          stoppedAt = i
          break
        }
        if (reply.result !== 'success') {
          lines.push(`${step.label}: device rejected the write, not saved.`)
          stoppedAt = i
          break
        }
        const check = await step.verify()
        check.commit()
        if (check.matches) {
          lines.push(`${step.label}: written and read back with exact match. Persistence across power cycles is not verified.`)
          verifiedCount++
        } else if (check.cap.state === 'supported') {
          lines.push(`${step.label}: written, but the readback differs from what was sent. Treat as not saved.`)
          stoppedAt = i
          break
        } else {
          lines.push(`${step.label}: written, but the readback failed. State unknown.`)
          stoppedAt = i
          break
        }
      }

      if (stoppedAt >= 0) {
        tone = verifiedCount > 0 ? 'warn' : 'error'
        for (let i = stoppedAt + 1; i < steps.length; i++) lines.push(`${steps[i].label}: not attempted.`)
        lines.unshift(verifiedCount > 0 ? 'Partial apply: remaining settings were not confirmed.' : 'Apply was not fully confirmed.')
      }
      setDrafts(previous => draftsFrom(latest, previous))
      setResult({ tone, lines })
    } catch (error) {
      setResult({ tone: 'error', lines: [...lines, `Apply stopped: ${message(error)}`] })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  const canOperate = idle && !statusError && status !== null

  const toggle = async () => {
    if (lock.current || !canOperate) return
    const displayed = statusRef.current?.recording ?? null
    lock.current = true
    setBusy(true)
    let lastDispatch: NativeRecordingDispatch | null = null
    try {
      const fresh = await readStatusOnce()
      if (fresh.recording !== displayed) {
        setResult({
          tone: 'warn',
          lines: [
            displayed === null
              ? `Start not sent: the device is already recording (${fresh.recording}).`
              : `Stop not sent: the recording changed (shown ${displayed}, now ${fresh.recording ?? 'none'}).`
          ]
        })
        return
      }
      const dispatch = await window.electronAPI.jensen.toggleNativeRecording({
        requestId: crypto.randomUUID(),
        expectedRecording: fresh.recording
      })
      lastDispatch = dispatch
      let after = await readStatusOnce()
      for (let attempt = 0; dispatch.status === 'acknowledged' && after.recording === displayed && attempt < 6; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200))
        after = await readStatusOnce()
      }
      const line = dispatchLine(displayed === null ? 'Start' : 'Stop', dispatch)
      const observed = after.recording ? `Device now reports recording ${after.recording}.` : 'Device now reports no native recording.'
      const matched = displayed === null ? after.recording !== null : after.recording === null
      setResult({ tone: dispatch.status === 'acknowledged' && matched ? 'ok' : 'warn', lines: [line, observed, ...(!matched ? ['The intended state change is not confirmed. Refresh before another control action.'] : [])] })
    } catch (error) {
      setStatus(null)
      setStatusError('Native state is unknown. Refresh before another recording control action.')
      setResult({ tone: 'warn', lines: [...(lastDispatch ? [dispatchLine('Toggle', lastDispatch)] : []), `The requested state change is not confirmed: ${message(error)}. No toggle was automatically retried.`] })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  const addMarker = async () => {
    if (lock.current || !canOperate) return
    const displayed = statusRef.current?.recording ?? null
    if (displayed === null) return
    lock.current = true
    setBusy(true)
    let lastDispatch: NativeRecordingDispatch | null = null
    try {
      const fresh = await readStatusOnce()
      if (fresh.recording !== displayed) {
        setResult({
          tone: 'warn',
          lines: [`Marker not sent: the recording changed (shown ${displayed}, now ${fresh.recording ?? 'none'}).`]
        })
        return
      }
      const dispatch = await window.electronAPI.jensen.addNativeMarker({
        requestId: crypto.randomUUID(),
        expectedRecording: fresh.recording
      })
      lastDispatch = dispatch
      await readStatusOnce()
      setResult({
        tone: dispatch.status === 'acknowledged' ? 'ok' : 'warn',
        lines: [
          dispatchLine('Marker', dispatch),
          dispatch.status === 'acknowledged'
            ? 'Acknowledged by the device, not confirmed as saved. Check the marker footer of the finished recording.'
            : 'Marker insertion is not confirmed. No command was automatically retried; check the finished recording.'
        ]
      })
    } catch (error) {
      setStatus(null)
      setStatusError('Native state is unknown. Refresh before another recording control action.')
      setResult({ tone: 'warn', lines: [...(lastDispatch ? [dispatchLine('Marker', lastDispatch)] : []), `Marker outcome or status is not confirmed: ${message(error)}. No marker command was automatically retried; check the finished recording.`] })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  const set = <K extends keyof Drafts>(key: K, value: Drafts[K]) => setDrafts(previous => ({ ...previous, [key]: value }))

  const formatNote = describeCapability(settings.format)
  const profileNote = describeCapability(settings.profile)
  const rulesNote = describeCapability(settings.rules)
  const toneClass = result?.tone === 'error' ? 'text-destructive' : result?.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'

  return (
    <Card data-testid="native-recording-panel">
      <CardHeader>
        <CardTitle>Native recording</CardTitle>
        <CardDescription>
          Recording format, source gains and automatic markers stored on the device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!connected && <p className="text-sm text-muted-foreground">Connect the device to read native recording settings.</p>}
        {connected && disabled && (
          <p className="text-sm text-muted-foreground">The device is in use by another operation. Native recording controls are paused.</p>
        )}

        <section aria-labelledby="native-status-heading" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 id="native-status-heading" className="text-sm font-medium">
              Status
            </h4>
            <Button type="button" variant="outline" size="sm" data-testid="native-refresh" onClick={() => void refresh()} disabled={!connected || disabled || busy || readPending}>
              {readPending ? 'Reading...' : 'Refresh'}
            </Button>
          </div>
          <p className="text-sm" aria-live="polite">
            {statusError
              ? `Status unavailable: ${statusError}`
              : status === null
                ? 'Status not read.'
                : isRecording
                  ? `Recording: ${recordingName} (${Math.round(status.duration)} s)`
                  : 'No native recording in progress.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" data-testid="native-toggle" onClick={() => void toggle()} disabled={!canOperate}>
              {isRecording ? 'Stop recording' : 'Start recording'}
            </Button>
            <Button type="button" variant="secondary" data-testid="native-marker" onClick={() => void addMarker()} disabled={!canOperate || !isRecording}>
              Add marker
            </Button>
          </div>
        </section>

        <section aria-labelledby="native-settings-heading" className="space-y-4">
          <h4 id="native-settings-heading" className="text-sm font-medium">
            Settings
          </h4>
          {isRecording && <p className="text-sm text-muted-foreground">Settings are locked while a native recording exists.</p>}
          {settingsSkipped && <p className="text-sm text-muted-foreground">Settings were not read because a recording is active. Refresh after it stops.</p>}
          {applyUncertain && <p className="text-sm text-amber-600">A setting change is uncertain. Refresh to read the device before applying again.</p>}

          <div className="space-y-1">
            <Label htmlFor="native-format">Format</Label>
            {settings.format.state === 'supported' ? (
              <>
                <select id="native-format" data-testid="native-format" className={selectClass} value={drafts.format} disabled={settingsLocked} onChange={e => set('format', e.target.value === 'wav' ? 'wav' : 'mp3')}>
                  <option value="mp3">MP3</option>
                  <option value="wav">WAV</option>
                </select>
                <p className="text-xs text-muted-foreground">{describeStorage(settings.format.value.storage)}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{formatNote}</p>
            )}
          </div>

          <div className="space-y-3">
            {settings.profile.state === 'supported' ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="native-bitrate">MP3 bitrate (total, both channels)</Label>
                  <select id="native-bitrate" data-testid="native-bitrate" className={selectClass} value={drafts.bitrate} disabled={settingsLocked} onChange={e => set('bitrate', Number(e.target.value) as Drafts['bitrate'])}>
                    {BITRATES.map((kbps, index) => (
                      <option key={kbps} value={index}>
                        {kbps} kb/s
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="native-gain-1">Microphone gain (%)</Label>
                    <Input id="native-gain-1" data-testid="native-gain-1" inputMode="decimal" value={drafts.gain1} disabled={settingsLocked} aria-invalid={gain1Q15 === null} onChange={e => set('gain1', e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="native-gain-2">System audio gain (%)</Label>
                    <Input id="native-gain-2" data-testid="native-gain-2" inputMode="decimal" value={drafts.gain2} disabled={settingsLocked} aria-invalid={gain2Q15 === null} onChange={e => set('gain2', e.target.value)} />
                  </div>
                </div>
                <p className={`text-xs ${profileValid ? 'text-muted-foreground' : 'text-destructive'}`}>
                  USB native recording: microphone is the left channel (Channel 1) and system audio is the right channel (Channel 2). Gain is 0 to 200 percent. 100 is unity, 0 mutes the source. {describeStorage(settings.profile.value.storage)}
                </p>
              </>
            ) : (
              <div className="space-y-1">
                <p className="text-sm font-medium">Bitrate and channel gains</p>
                <p className="text-sm text-muted-foreground">{profileNote}</p>
              </div>
            )}
          </div>

          <div className="space-y-3">
            {settings.rules.state === 'supported' ? (
              <>
                <div className="flex items-center gap-2">
                  <input id="native-rules-enabled" data-testid="native-rules-enabled" type="checkbox" className="h-4 w-4" checked={drafts.rulesEnabled} disabled={settingsLocked} onChange={e => set('rulesEnabled', e.target.checked)} />
                  <Label htmlFor="native-rules-enabled">Automatic native markers</Label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="native-rule-lane">Marker channel</Label>
                    <select id="native-rule-lane" data-testid="native-rule-lane" className={selectClass} value={drafts.lane} disabled={settingsLocked} onChange={e => set('lane', Number(e.target.value) as Drafts['lane'])}>
                      <option value={0}>Microphone</option>
                      <option value={1}>System audio</option>
                      <option value={2}>Either channel</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="native-rule-threshold">Mean magnitude threshold (1 to {MAX_THRESHOLD})</Label>
                    <Input id="native-rule-threshold" data-testid="native-rule-threshold" inputMode="numeric" value={drafts.threshold} disabled={settingsLocked} aria-invalid={thresholdInt === null} onChange={e => set('threshold', e.target.value)} />
                  </div>
                </div>
                <p className={`text-xs ${rulesValid ? 'text-muted-foreground' : 'text-destructive'}`}>
                  Threshold must be a whole number from 1 to {MAX_THRESHOLD}. {describeStorage(settings.rules.value.storage)}
                </p>
              </>
            ) : (
              <div className="space-y-1">
                <p className="text-sm font-medium">Automatic native markers</p>
                <p className="text-sm text-muted-foreground">{rulesNote}</p>
              </div>
            )}
          </div>

          <Button type="button" data-testid="native-apply" onClick={() => void apply()} disabled={!canApply}>
            {busy ? 'Working...' : 'Apply settings'}
          </Button>
        </section>

        <div role="status" aria-live="polite" className="space-y-1 text-sm">
          {result ? (
            <>
              <p className="font-medium">Last action</p>
              {result.lines.map((line, index) => (
                <p key={index} className={toneClass}>
                  {line}
                </p>
              ))}
            </>
          ) : (
            <p className="text-muted-foreground">No action taken yet.</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default DeviceNativeRecordingPanel
