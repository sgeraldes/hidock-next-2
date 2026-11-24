import { useRef, useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BusyIcon } from '@/components/ui/working'

export type ServiceTone = 'ok' | 'attention' | 'error' | 'off' | 'busy'

export interface ServiceListItem {
  id: string
  label: string
  /** State in words under the name: "Connected", "Needs setup", "In use". */
  status: string
  tone: ServiceTone
  icon?: LucideIcon
  /** The state is running (connecting, syncing): a spinner, the words go to the tooltip. */
  busy?: boolean
}

const TONE_DOT: Record<ServiceTone, string> = {
  ok: 'bg-emerald-500',
  attention: 'bg-amber-500',
  error: 'bg-red-500',
  busy: 'bg-blue-500',
  off: 'bg-muted-foreground/40'
}

/**
 * Services as a list and a detail pane (the Messaging Channels pattern): every
 * service with its state on the left, the selected one on the right. On a
 * narrow window the list sits above the detail.
 */
export function ServiceList({
  items,
  selected,
  onSelect,
  footer,
  children,
  label
}: {
  items: ServiceListItem[]
  selected: string | null
  onSelect: (id: string) => void
  /** Under the list, e.g. "Add account". */
  footer?: ReactNode
  /** The detail pane for the selected item. */
  children: ReactNode
  label: string
}) {
  const [focusedId, setFocusedId] = useState<string | null>(selected)
  const options = useRef(new Map<string, HTMLButtonElement>())
  const tabStop = items.some(item => item.id === focusedId) ? focusedId
    : items.some(item => item.id === selected) ? selected : items[0]?.id
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="lg:w-64 lg:shrink-0">
        <ul role="listbox" aria-label={label} className="flex flex-col gap-1">
          {items.map((item, index) => {
            const Icon = item.icon
            const active = item.id === selected
            return (
              <li key={item.id} role="presentation">
                <button
                  ref={node => { if (node) options.current.set(item.id, node); else options.current.delete(item.id) }}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={item.id === tabStop ? 0 : -1}
                  onFocus={() => setFocusedId(item.id)}
                  onKeyDown={event => {
                    let next: number
                    switch (event.key) {
                      case 'ArrowDown': next = Math.min(items.length - 1, index + 1); break
                      case 'ArrowUp': next = Math.max(0, index - 1); break
                      case 'Home': next = 0; break
                      case 'End': next = items.length - 1; break
                      default: return
                    }
                    event.preventDefault()
                    options.current.get(items[next].id)?.focus()
                  }}
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                    active ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-muted'
                  )}
                >
                  {Icon && <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-sm', active && 'font-medium text-primary')}>{item.label}</span>
                    {item.busy ? (
                      <span
                        className="flex items-center gap-1.5 text-xs text-muted-foreground"
                        title={item.status}
                        aria-label={item.status}
                        aria-busy={true}
                      >
                        <BusyIcon className="h-3 w-3" />
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[item.tone])} aria-hidden="true" />
                        {item.status}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {footer && <div className="mt-2">{footer}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
