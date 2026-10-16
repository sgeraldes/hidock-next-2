import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { RepairAction, RepairContext } from '@/shared/quality-repair'

type Context = RepairContext
type Role = 'owner' | 'other' | 'overlap' | 'unsure'
const actionLabels: Record<RepairAction, string> = {
  review_samples: 'Review the selected voice sample', compare_voices: 'Compare acoustic voices',
  diarize: 'Prepare independent speaker separation', align_times: 'Check timestamp alignment',
  inspect_overlap: 'Check overlapping speech', transcribe_range: 'Check words in a limited range',
  transcribe_recording: 'Review a full transcription request', ask_user: 'More information is needed',
  defer: 'Defer this repair', no_action: 'Keep the current version'
}

/** Bounded sample review; confirmations never silently rename an entire cluster. */
export function SpeakerReviewPanel({ recordingId }: { recordingId: string }) {
  const [open, setOpen] = useState(false)
  const [context, setContext] = useState<Context | null>(null)
  const [count, setCount] = useState('')
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [advice, setAdvice] = useState<{ action: RepairAction; confidence?: { action: number | null }; model: string } | null>(null)
  const intent = useRef<string | null>(null)
  const generation = useRef(0)
  const activeRecording = useRef(recordingId)
  activeRecording.current = recordingId
  const expanded = useRef(false)
  const ownedUrl = useRef<string | null>(null)
  const releaseAudio = () => {
    if (ownedUrl.current) URL.revokeObjectURL(ownedUrl.current)
    ownedUrl.current = null; setAudioUrl(null)
  }
  useEffect(() => {
    generation.current++
    setContext(null); setOpen(false); expanded.current = false; setBusy(false)
    setSelected(''); setCount(''); setAdvice(null); intent.current = null
    releaseAudio()
    // Counters and an owned object URL, not DOM nodes: the cleanup must see the latest values.
    const counter = generation, owned = ownedUrl
    return () => { counter.current++; if (owned.current) URL.revokeObjectURL(owned.current) }
  }, [recordingId])

  async function load() {
    const currentGeneration = generation.current
    if (typeof window.electronAPI.quality?.repairContext !== 'function') throw new Error('This running client needs the speaker-review update')
    const result = await window.electronAPI.quality.repairContext(recordingId)
    if (activeRecording.current !== recordingId || generation.current !== currentGeneration) throw new Error('Recording changed during review')
    if (!result.success) throw new Error(result.error || 'Could not prepare review')
    const data = result.data as Context
    setContext(data)
    setCount(data.state.confirmedFacts.actualSpeakerCount === null ? '' : String(data.state.confirmedFacts.actualSpeakerCount))
    setSelected(previous => data.samples.some(sample => sample.id === previous) ? previous : data.samples[0]?.id || '')
    return data
  }
  async function perform(action: (assertCurrent: () => void) => Promise<void>) {
    if (busy) return
    const currentGeneration = generation.current
    setBusy(true); setMessage('')
    try { await action(() => {
      if (activeRecording.current !== recordingId || generation.current !== currentGeneration) throw new Error('Recording changed during review')
    }) }
    catch (error) { if (generation.current === currentGeneration) setMessage(error instanceof Error ? error.message : 'Review failed') }
    finally { if (generation.current === currentGeneration) setBusy(false) }
  }
  const sample = context?.samples.find(row => row.id === selected)
  return <details open={open} className="mt-3 rounded-md border border-border p-3"
    onToggle={event => {
      const next = event.currentTarget.open
      expanded.current = next
      setOpen(next)
      if (next && !context) void perform(async () => { await load() })
      if (!next) releaseAudio()
    }}>
    <summary className="cursor-pointer text-sm font-medium">Review speaker evidence</summary>
    {open && <div className="mt-3 space-y-3 text-xs">
      <p className="text-muted-foreground">Review short passages with surrounding conversation. Words and speaker assignments stay unchanged.</p>
      {context && <>
        <p>{Object.keys(context.state.context.voiceLabelCounts).length} generated labels · {context.state.context.invitedCount ?? 'Unknown'} invited.
          {' '}Invitations do not establish who spoke.</p>
        <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
          event.preventDefault()
          void perform(async assertCurrent => {
            const value = Number(count)
            if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error('Confirm a count between 1 and 32')
            const result = await window.electronAPI.quality.confirmParticipation(recordingId, value)
            assertCurrent()
            if (!result.success) throw new Error(result.error || 'Could not save confirmation')
            intent.current = null; setAdvice(null); await load()
            setMessage('Actual speaker count saved for this audio. No labels were merged.')
          })
        }}>
          <label className="space-y-1">People you confirm actually spoke
            <input aria-label="Confirmed people who spoke" type="number" min={1} max={32} value={count}
              onChange={event => setCount(event.target.value)} className="ml-2 w-16 rounded border border-input bg-background p-1" />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={busy}>Save count</Button>
        </form>
        <label className="block">Passage to investigate
          <select aria-label="Speaker review passage" value={selected} disabled={busy}
            className="ml-2 max-w-full rounded border border-input bg-background p-1"
            onChange={event => { setSelected(event.target.value); releaseAudio() }}>
            {context.samples.map(row => <option key={row.id} value={row.id}>
              {row.speaker} · {Math.floor(row.target.start)}–{Math.ceil(row.target.end)} s · {row.selection}
            </option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !sample} onClick={() => void perform(async assertCurrent => {
            const result = await window.electronAPI.quality.repairSample(recordingId, selected, context.evidenceFingerprint)
            assertCurrent()
            if (!expanded.current) return
            if (!result.success) throw new Error(result.error || 'Could not extract audio')
            const bytes = Uint8Array.from(atob(result.data.base64), char => char.charCodeAt(0))
            releaseAudio()
            ownedUrl.current = URL.createObjectURL(new Blob([bytes], { type: result.data.mimeType }))
            setAudioUrl(ownedUrl.current)
          })}>Load short audio sample</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(async assertCurrent => {
            if (!intent.current) intent.current = crypto.randomUUID()
            const result = await window.electronAPI.quality.repairAdvice(recordingId, intent.current)
            assertCurrent()
            if (!result.success) throw new Error(result.error || 'Evaluator did not return a recommendation')
            setAdvice(result.data)
            if (result.data.sample) { setSelected(result.data.sample.id); releaseAudio() }
          })}>Recommend next check</Button>
        </div>
        {advice && <p role="status">{actionLabels[advice.action]} · {advice.model}.
          {' '}Recommendation only; model confidence has not been calibrated. No repair was applied.</p>}
        {audioUrl && sample && <div className="space-y-2">
          <p>Target: {Math.floor(sample.target.start)}–{Math.ceil(sample.target.end)} s.
            {' '}The audio includes surrounding turns, starting at {Math.floor(sample.context.start)} s.</p>
          {sample.referenceSuitability === 'short-reference' && <p className="text-amber-500">This target is very short. It is not a reliable reference for automatically identifying an entire voice.</p>}
          {sample.referenceSuitability === 'sparse-time-span' && <p className="text-amber-500">Few words span a long interval. Review timing and surrounding audio before interpreting this as a voice error.</p>}
          <audio controls preload="metadata" src={audioUrl} className="w-full" aria-label="Speaker sample with surrounding context" />
          <p>Who speaks in the target passage? This answer applies only to this interval.</p>
          <div className="flex flex-wrap gap-2">{([
            ['owner', 'Me'], ['other', 'Other participant'], ['overlap', 'Both speaking'], ['unsure', 'Not sure']
          ] as Array<[Role, string]>).map(([role, label]) => <Button key={role} size="sm" variant="outline" disabled={busy}
            onClick={() => void perform(async assertCurrent => {
              const result = await window.electronAPI.quality.confirmRepairSample(recordingId, selected, context.evidenceFingerprint, role)
              assertCurrent()
              if (!result.success) throw new Error(result.error || 'Could not save sample confirmation')
              intent.current = null; setAdvice(null); await load()
              setMessage('Sample confirmation saved for this audio interval. No entire voice label was reassigned.')
            })}>{label}</Button>)}</div>
          <div className="max-h-40 overflow-auto rounded border border-border p-2 text-muted-foreground">
            {sample.context.turns.map((turn, index) => <p key={index}>{turn.speaker || 'Unknown speaker'}: {turn.text}</p>)}
          </div>
        </div>}
      </>}
      {busy && <p role="status">Preparing review…</p>}
      {message && <p role="status">{message}</p>}
    </div>}
  </details>
}
