import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { RELEASES, type Release } from './releases'

/**
 * Releases: the list of builds on the left, the selected one's notes on the
 * right. The newest is marked as the one installed.
 */
export function ReleasesSection({ releases = RELEASES }: { releases?: Release[] }) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const selected = releases.find((r) => r.date === selectedDate) ?? releases[0]

  if (!selected) return <p className="text-sm text-muted-foreground">No release notes yet.</p>

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start" data-testid="settings-releases">
      <ul role="listbox" aria-label="Releases" className="flex flex-col gap-1 lg:w-56 lg:shrink-0">
        {releases.map((r, i) => {
          const active = r.date === selected.date
          return (
            <li key={r.date}>
              <button
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => setSelectedDate(r.date)}
                className={cn(
                  'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                  active ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-muted'
                )}
              >
                <span className={cn('block text-sm tabular-nums', active && 'font-medium text-primary')}>
                  {r.date}
                  {i === 0 && <span className="ml-2 rounded bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary">Installed</span>}
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{r.title}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <article className="min-w-0 flex-1 space-y-3" aria-label={`Release ${selected.date}`}>
        <header>
          <h3 className="text-lg font-semibold">{selected.title}</h3>
          <p className="text-xs tabular-nums text-muted-foreground">{selected.date}</p>
        </header>
        <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:text-base prose-li:my-0.5">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.body}</ReactMarkdown>
        </div>
      </article>
    </div>
  )
}
