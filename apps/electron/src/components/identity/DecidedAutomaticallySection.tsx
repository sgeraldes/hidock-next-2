/**
 * People > "Decided automatically" (spec 2026-10-03, Phase 4): every identity decision the app
 * made by itself, newest first, each in one sentence with its reason and an Undo. Collapsed by
 * default with a count; hides itself when nothing was decided.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, CheckCircle2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BusyIcon, Working } from '@/components/ui/working'
import { cn } from '@/lib/utils'
import type { DecisionView } from '@/shared/identity-review'
import { decisionSentence, shortDate } from './decisionSentence'

/** How many decisions the list reads at once. The count shows "500+" when there are more. */
export const DECISIONS_LIMIT = 500

type RowState =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'undone'; restored: boolean }
  | { state: 'error'; message: string }

interface DecidedAutomaticallySectionProps {
  /** Called after an Undo, so the page can reload the questions it brought back. */
  onChanged?: () => void
  /** Start expanded (the owner's screenshots). */
  defaultExpanded?: boolean
}

export function DecidedAutomaticallySection({ onChanged, defaultExpanded = false }: DecidedAutomaticallySectionProps) {
  const [decisions, setDecisions] = useState<DecisionView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [rowState, setRowState] = useState<Record<string, RowState>>({})

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await window.electronAPI.identity.listDecisions?.({ limit: DECISIONS_LIMIT })
        if (!alive) return
        if (!res) setDecisions([])
        else if (res.success) setDecisions(res.data)
        else {
          setLoadError(res.error.message)
          setDecisions([])
        }
      } catch {
        if (!alive) return
        setLoadError('The automatic decisions could not be read. Reload People to try again.')
        setDecisions([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Rows with an Undo on its way or done. A ref, so a second click before the page redraws
  // (the button is not disabled yet) is refused without a second call.
  const undoing = useRef<Set<string>>(new Set())

  const undo = useCallback(
    async (id: string) => {
      if (undoing.current.has(id)) return
      undoing.current.add(id)
      setRowState((prev) => ({ ...prev, [id]: { state: 'busy' } }))
      let done = false
      try {
        const res = await window.electronAPI.identity.undoDecision(id)
        if (res.success) {
          done = true
          setRowState((prev) => ({ ...prev, [id]: { state: 'undone', restored: res.data.restored } }))
          onChanged?.()
        } else if (/already undone/i.test(res.error.message)) {
          // Undone elsewhere (another window, or an earlier click): the row is undone either way.
          done = true
          setRowState((prev) => ({ ...prev, [id]: { state: 'undone', restored: true } }))
        } else {
          setRowState((prev) => ({ ...prev, [id]: { state: 'error', message: res.error.message } }))
        }
      } catch {
        setRowState((prev) => ({
          ...prev,
          [id]: { state: 'error', message: 'The decision could not be undone. Try again; if it keeps failing, restart HiDock.' }
        }))
      } finally {
        // An error leaves the Undo usable again; an undone row stays guarded.
        if (!done) undoing.current.delete(id)
      }
    },
    [onChanged]
  )

  if (decisions === null) {
    return (
      <section className="mb-6" aria-label="Decided automatically">
        <Working label="Loading automatic decisions" shape="list" rows={2} />
      </section>
    )
  }

  if (loadError) {
    return (
      <section className="mb-6" aria-label="Decided automatically">
        <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">
          {loadError}
        </p>
      </section>
    )
  }

  if (decisions.length === 0) return null

  const active = decisions.filter((d) => rowState[d.id]?.state !== 'undone').length
  const countLabel = decisions.length >= DECISIONS_LIMIT ? `${active}+` : String(active)

  return (
    <section className="mb-6" aria-label="Decided automatically">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="mb-3 flex w-full items-center gap-2 text-left"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">
          Decided automatically (<span className="tabular-nums">{countLabel}</span>)
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          the app answered these by itself; undo any that are wrong
        </span>
      </button>

      {expanded && (
        <ul className="divide-y rounded-lg border">
          {decisions.map((d) => (
            <DecisionRow key={d.id} decision={d} state={rowState[d.id] ?? { state: 'idle' }} onUndo={undo} />
          ))}
        </ul>
      )}
    </section>
  )
}

function DecisionRow({
  decision,
  state,
  onUndo
}: {
  decision: DecisionView
  state: RowState
  onUndo: (id: string) => void
}) {
  const sentence = decisionSentence(decision)
  const undone = state.state === 'undone'
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm leading-snug', undone && 'text-muted-foreground line-through')}>{sentence}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {undone
            ? state.restored
              ? 'Undone.'
              : 'Undone. It was changed since, so it stays as it is now.'
            : `Decided ${shortDate(decision.createdAt)}`}
        </p>
        {state.state === 'error' && (
          <p role="alert" className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            {state.message}
          </p>
        )}
      </div>
      {!undone && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0"
          disabled={state.state === 'busy'}
          aria-busy={state.state === 'busy' || undefined}
          aria-label={`Undo: ${sentence}`}
          onClick={() => onUndo(decision.id)}
        >
          {state.state === 'busy' ? <BusyIcon className="mr-1 h-3.5 w-3.5" /> : <Undo2 className="mr-1 h-3.5 w-3.5" />}
          Undo
        </Button>
      )}
    </li>
  )
}

export default DecidedAutomaticallySection
