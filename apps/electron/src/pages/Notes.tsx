/**
 * Notes.
 *
 * The thing this competes with is Notepad. So the page opens on a list and a
 * textarea, a new note takes one click and no questions, and everything the AI
 * adds sits to the side of the writing rather than in front of it.
 */

import { useCallback, useEffect, useState } from 'react'
import { Plus, Sparkles, Trash2, Link2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { useNotes } from '@/features/notes/useNotes'
import { noteDisplayTitle, noteSubtitle } from '@/features/notes/noteTitle'

export default function Notes(): React.ReactElement {
  const {
    notes,
    selected,
    draft,
    saving,
    search,
    related,
    suggestions,
    setSearch,
    refresh,
    select,
    edit,
    create,
    remove,
    patch,
    analyzeNow,
    loadRelated,
    loadSuggestions,
  } = useNotes()

  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => void refresh(search), 250)
    return () => clearTimeout(timer)
  }, [search, refresh])

  /**
   * Start a note, and say it was started now.
   *
   * `live: true` is not a claim that a recording is running — the renderer
   * cannot know that, and a renderer clock can be wrong. It tells the main
   * process to look at the calendar for a meeting covering this moment and
   * attach the note to it. No meeting covering now means no link, not a guess.
   *
   * Every new note goes through here, because "I am writing this during the
   * meeting" is the case that cannot be reconstructed afterwards, and asking
   * the person to say so is exactly the friction this feature exists to avoid.
   */
  const startNote = useCallback(async () => {
    await create({ live: true })
  }, [create])

  // Ctrl+N / Cmd+N while the notes page is open. Not a system-wide accelerator:
  // one of those would pull focus out of whatever the person is doing, which on
  // this machine is a rule, not a preference.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // `code`, not `key`: on a layout where that physical key produces a
      // non-Latin character, `key` is that character and the shortcut dies.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === 'KeyN') {
        event.preventDefault()
        void startNote()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startNote])

  const withBusy = async (fn: () => Promise<{ success: boolean; error?: string }>, failure: string) => {
    setBusy(true)
    try {
      const result = await fn()
      if (!result.success) toast.error(failure, result.error)
      return result
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Input
            value={search}
            placeholder="Search notes"
            aria-label="Search notes"
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            size="icon"
            aria-label="New note"
            title="New note (Ctrl+N). A note started during a meeting is attached to it."
            onClick={() => void startNote()}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {notes.length === 0 && (
            <li className="p-4 text-sm text-muted-foreground">
              {search
                ? 'No note matches that.'
                : 'No notes yet. The plus button, or Ctrl+N, opens one with the cursor already in it.'}
            </li>
          )}
          {notes.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                onClick={() => select(note)}
                className={cn(
                  'w-full border-b border-border px-3 py-2 text-left hover:bg-accent',
                  selected?.id === note.id && 'bg-accent'
                )}
              >
                <p className="truncate text-sm font-medium">{noteDisplayTitle(note)}</p>
                <p className="truncate text-xs text-muted-foreground">{noteSubtitle(note)}</p>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {!selected ? (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          Pick a note, or start a new one.
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <Input
              value={selected.title ?? ''}
              placeholder={selected.suggestedTitle || 'Title (optional)'}
              aria-label="Note title"
              className="max-w-md"
              onChange={(event) => void patch(selected.id, { title: event.target.value })}
            />
            <span className="text-xs text-muted-foreground">{saving ? 'Saving…' : 'Saved'}</span>
            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void withBusy(() => analyzeNow(selected.id), 'Could not analyse this note')
                }
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Categorise and summarise
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void withBusy(() => loadRelated(selected.id), 'Could not look for related items')}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Find related
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void withBusy(() => loadSuggestions(selected.id), 'Could not suggest a meeting')
                }
              >
                <Link2 className="mr-2 h-4 w-4" />
                Suggest a meeting
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label="Delete note"
                onClick={() => void remove(selected.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            <textarea
              value={draft}
              aria-label="Note"
              spellCheck
              autoFocus
              placeholder="Write. Everything else happens afterwards."
              className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-sm outline-none"
              onChange={(event) => edit(event.target.value)}
            />

            <aside className="w-80 shrink-0 space-y-4 overflow-y-auto border-l border-border p-3 text-sm">
              {selected.aiStatus === 'failed' && (
                <p className="text-muted-foreground">
                  The last analysis did not work: {selected.aiError}
                </p>
              )}
              {selected.summary && (
                <section>
                  <h2 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Summary</h2>
                  <p>{selected.summary}</p>
                </section>
              )}
              {(selected.category || selected.tags.length > 0) && (
                <section>
                  <h2 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                    Category
                  </h2>
                  <Input
                    value={selected.category ?? ''}
                    aria-label="Category"
                    onChange={(event) => void patch(selected.id, { category: event.target.value })}
                  />
                  {selected.categorySource === 'user' && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      You set this, so re-analysing will not change it.
                    </p>
                  )}
                  {selected.tags.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">{selected.tags.join(' · ')}</p>
                  )}
                </section>
              )}

              {selected.meetingId && (
                <section>
                  <h2 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                    Meeting
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {selected.linkSource === 'live'
                      ? 'Attached while that meeting was happening.'
                      : selected.linkSource === 'user'
                        ? 'You chose this one.'
                        : 'You accepted a suggestion.'}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() =>
                      void patch(selected.id, { meetingId: null, linkSource: null })
                    }
                  >
                    Unlink
                  </Button>
                </section>
              )}

              {suggestions.length > 0 && (
                <section>
                  <h2 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                    Meetings this could belong to
                  </h2>
                  <ul className="space-y-2">
                    {suggestions.map((suggestion) => (
                      <li key={suggestion.meetingId} className="rounded border border-border p-2">
                        <p className="font-medium">{suggestion.subject}</p>
                        <p className="text-xs text-muted-foreground">{suggestion.reason}</p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2"
                          onClick={() =>
                            void patch(selected.id, {
                              meetingId: suggestion.meetingId,
                              // Picking one off a list IS choosing by hand. The
                              // only link this app calls 'suggested' is one it
                              // made itself, and it never makes one.
                              linkSource: 'user',
                            })
                          }
                        >
                          Link to this meeting
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {related.length > 0 && (
                <section>
                  <h2 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                    Related
                  </h2>
                  <ul className="space-y-2">
                    {related.map((item) => (
                      <li key={`${item.kind}-${item.id}`} className="rounded border border-border p-2">
                        <p className="font-medium">{item.title}</p>
                        <p className="text-xs text-muted-foreground">{item.excerpt}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </aside>
          </div>
        </div>
      )}
    </div>
  )
}
