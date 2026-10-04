import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { RECORDING_KINDS, type RecordingKind, type ReferenceLabelItem, type ReferenceLabelSet } from '@/shared/decision-labels'

const KINDS = Object.entries(RECORDING_KINDS) as Array<[RecordingKind, string]>
const SHORTCUTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'Shift+1']
const kindName = (kind: string) => kind.split('_').map((word, i) => i ? word : word[0].toUpperCase() + word.slice(1)).join(' ')

export function ReferenceLabels() {
  const [set, setSet] = useState<ReferenceLabelSet | null>(null)
  const [index, setIndex] = useState(0)
  const [item, setItem] = useState<ReferenceLabelItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = useRef(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void window.electronAPI.pipeline.getLabelSet().then(next => {
      if (!active) return
      setSet(next)
      const first = next.items.findIndex(row => !row.answer)
      setIndex(first < 0 ? next.items.length : first)
    }).catch(e => { if (active) setError(`Could not load reference labels: ${String(e)}`) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [retry])

  const setId = set?.id
  const recordingId = set?.items[index]?.recordingId
  useEffect(() => {
    let active = true
    setItem(null)
    if (!setId || !recordingId) return
    setLoading(true)
    setError(null)
    void window.electronAPI.pipeline.getLabelItem({ setId, recordingId }).then(next => {
      if (active) setItem(next)
    }).catch(e => { if (active) setError(`Could not load this recording: ${String(e)}`) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [setId, recordingId]) // Only navigation reloads the excerpt, not a label change.

  const changeLabel = useCallback(async (answer: RecordingKind | null) => {
    if (!set || !item || loading || locked.current) return
    locked.current = true
    setSaving(true)
    setError(null)
    const args = { setId: set.id, recordingId: item.recordingId }
    try {
      if (answer) await window.electronAPI.pipeline.saveLabel({ ...args, answer })
      else await window.electronAPI.pipeline.clearLabel(args)
      setSet(previous => {
        if (!previous) return previous
        const items = previous.items.map(row => row.recordingId === args.recordingId ? { ...row, answer } : row)
        return { ...previous, items, labeled: items.filter(row => row.answer).length }
      })
      setItem(previous => previous ? { ...previous, answer } : null)
      if (answer) setIndex(previous => previous + 1)
    } catch (e) {
      setError(`Could not save this label: ${e instanceof Error ? e.message : String(e)}. Try again.`)
    } finally {
      locked.current = false
      setSaving(false)
    }
  }, [set, item, loading])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || target?.isContentEditable ||
        target?.closest('input, textarea, select, [role="textbox"]')) return
      const shortcut = event.key === '!' || (event.shiftKey && event.code === 'Digit1') ? 'Shift+1' : event.key
      const selected = SHORTCUTS.indexOf(shortcut)
      if (selected < 0 || !item || loading || saving) return
      event.preventDefault()
      void changeLabel(KINDS[selected][0])
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [changeLabel, item, loading, saving])

  return (
    <section aria-labelledby="pipeline-reference-labels" className="space-y-3">
      <h3 id="pipeline-reference-labels" className="text-sm font-semibold">Reference labels</h3>
      <p className="text-sm text-muted-foreground">Choose the recording kind from its opening. Your answers will be the reference for comparing decision engines.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!set && !loading && <Button variant="outline" onClick={() => setRetry(value => value + 1)}>Retry labels</Button>}
      {set && (
        <>
          <p role="status" className="text-sm tabular-nums">{set.labeled} of {set.items.length} labeled</p>
          {(set.counts.doubtful < 20 || set.counts.confident < 20) && <p className="text-sm text-muted-foreground">Only {set.counts.doubtful} doubtful and {set.counts.confident} confident recordings were available when this set was created (target: 20 each).</p>}
          {set.items.length === 0 ? <p className="text-sm">No eligible recordings with valid transcripts are available in this set.</p> : (
            <div className="space-y-4 rounded-lg border border-border bg-card p-4" aria-busy={loading || saving}>
              <p className="text-sm tabular-nums">{index < set.items.length ? `Recording ${index + 1} of ${set.items.length}` : 'You have reached the end of this set.'}</p>
              {loading ? <p className="text-sm">Loading recording…</p> : recordingId && !item ? <p className="text-sm">This recording is unavailable for labeling. You can skip it or go back.</p> : item && (
                <>
                  <p className="text-sm text-muted-foreground">{new Date(item.date).toLocaleString('en-US')}{item.durationSeconds !== null ? ` · ${Math.round(item.durationSeconds / 60)} min` : ''}</p>
                  {item.meetingSubject && <p className="text-sm">Calendar meeting: {item.meetingSubject}</p>}
                  <div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed" tabIndex={0} aria-label="Transcript opening">{item.excerpt}</div>
                  <p className="text-xs text-muted-foreground">Pick a kind with the number keys below. Use 0 for Device test and Shift+1 for Noise accidental. To change a label, go back and pick another kind.</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {KINDS.map(([kind, description], position) => (
                      <Button key={kind} variant={item.answer === kind ? 'default' : 'outline'} aria-pressed={item.answer === kind}
                        className="h-auto justify-start whitespace-normal p-3 text-left" disabled={saving}
                        onClick={() => void changeLabel(kind)}>
                        <span><span className="block font-medium">{SHORTCUTS[position]} · {kindName(kind)}</span><span className="block text-xs font-normal">{description}</span></span>
                      </Button>
                    ))}
                  </div>
                  {item.answer && <Button variant="outline" disabled={saving} onClick={() => void changeLabel(null)}>Clear label</Button>}
                </>
              )}
              <div className="flex gap-2">
                <Button variant="outline" disabled={index === 0 || saving || loading} onClick={() => setIndex(value => value - 1)}>Back</Button>
                <Button variant="outline" disabled={index >= set.items.length || saving || loading} onClick={() => setIndex(value => value + 1)}>Skip</Button>
              </div>
            </div>
          )}
        </>
      )}
      {loading && !set && <p className="text-sm">Loading reference labels…</p>}
    </section>
  )
}
