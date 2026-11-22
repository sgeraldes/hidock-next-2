import { ClipboardPaste, FilePlus, Mic, NotebookPen, Plus, Square, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from '@/components/ui/toaster'
import { pasteToLibrary, showPasteResults } from '@/lib/paste-library-actions'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

import { usePcRecorderStore } from '@/store/usePcRecorderStore'

const buttonClass = 'rounded-md px-3 py-1 text-sm hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
export function NewMenu() {
  const navigate = useNavigate()
  const open = usePcRecorderStore((state) => state.open)
  const actions = [
    { label: 'Paste', icon: ClipboardPaste, onSelect: () => void pasteToLibrary(navigate) },
    { label: 'Import file', icon: FilePlus, onSelect: () => {
      void window.electronAPI.pasteLibrary.pickFiles().then((results) => showPasteResults(results, navigate))
        .catch((error: unknown) => toast.error('Could not import file', error instanceof Error ? error.message : String(error)))
    } },
    { label: 'New note', icon: NotebookPen, onSelect: () => {
      void window.electronAPI.pasteLibrary.newNote().then((result) => {
        if (result.error) toast.error('Could not create note', result.error)
        else {
          window.dispatchEvent(new Event('hidock:downloads-completed'))
          navigate(`/notes?note=${encodeURIComponent(result.id!)}`)
        }
      }).catch((error: unknown) => toast.error('Could not create note', error instanceof Error ? error.message : String(error)))
    } },
    { label: 'Record', icon: Mic, onSelect: open }
  ]
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" className="titlebar-no-drag flex h-7 shrink-0 items-center gap-1 rounded-md border border-slate-600 px-2 text-xs hover:bg-slate-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400">
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />New
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      {actions.map(({ label, icon: Icon, onSelect }) => <DropdownMenuItem key={label} onSelect={onSelect}>
        <Icon className="mr-2 h-4 w-4" aria-hidden="true" />{label}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>
}

export function RecordingBar() {
  const navigate = useNavigate()
  const state = usePcRecorderStore()
  if (!state.visible) return null
  const busy = state.status === 'starting' || state.status === 'saving'
  const time = `${String(Math.floor(state.elapsed / 60)).padStart(2, '0')}:${String(state.elapsed % 60).padStart(2, '0')}`
  return <section aria-label="PC recording" className="shrink-0 border-b border-border bg-muted/40 px-4 py-2">
    <div className="flex flex-wrap items-center gap-4">
      {state.status === 'saved' ? <>
        <span className="text-sm font-medium" role="status">Saved to Library</span>
        <button type="button" className={buttonClass} onClick={() => navigate('/library')}>Open</button>
      </> : <>
      <span className="text-sm font-medium">Recording</span>
      {state.status === 'recording'
        ? <button type="button" className={`${buttonClass} flex items-center gap-1 text-destructive`} onClick={() => void state.stop()}><Square className="h-3 w-3" aria-hidden="true" />Stop</button>
        : <button type="button" className={buttonClass} disabled={busy} onClick={() => void state.start()}>{state.status === 'starting' ? 'Starting…' : state.status === 'saving' ? 'Saving…' : 'Record'}</button>}
      <span className="font-mono text-sm tabular-nums" aria-label="Elapsed time">{time}</span>
      {['Mic', 'System'].map((label, index) => <label key={label} className="flex items-center gap-2 text-xs text-muted-foreground">
        {label}<div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={state.levels[index] ?? 0} className="h-2 w-20 overflow-hidden rounded-full bg-slate-300 dark:bg-slate-700">
          <div className="h-full bg-emerald-600 dark:bg-emerald-400" style={{ width: `${Math.min(1, Math.max(0, state.levels[index] ?? 0)) * 100}%` }} />
        </div>
      </label>)}
      <span className="text-xs text-muted-foreground" role="status">{state.status === 'recording' ? 'Recording locally' : state.status === 'saving' ? 'Saving to Library' : 'Mic left · System right'}</span>
      </>}
      <button type="button" aria-label="Dismiss recording bar" className={`${buttonClass} ml-auto`} onClick={state.dismiss}><X className="h-4 w-4" aria-hidden="true" /></button>
    </div>
    {state.error && <p role="alert" className="mt-2 text-sm text-destructive">{state.error}</p>}
  </section>
}
