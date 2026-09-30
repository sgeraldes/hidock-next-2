import { cn } from '@/lib/utils'
import { avatarColor, initialsOf, type CardPerson } from '../utils/cardInfo'

interface PersonAvatarsProps {
  people: readonly CardPerson[]
  /** Circles shown before the "+N" one. */
  max?: number
  className?: string
}

/**
 * The people of a recording as small overlapping circles with their initials, each in its own colour,
 * then "+N" for the rest. Someone who only got the invitation is drawn in a muted colour of theirs.
 * The full names are in the title of each circle and in the one of the group.
 */
export function PersonAvatars({ people, max = 4, className }: PersonAvatarsProps) {
  if (people.length === 0) return null
  const shown = people.slice(0, max)
  const more = people.length - shown.length
  return (
    <span
      className={cn('flex shrink-0 items-center -space-x-0.5', className)}
      title={people.map((p) => (p.spoke ? p.name : `${p.name} (invited)`)).join(', ')}
      data-testid="card-people"
    >
      {shown.map((p) => (
        <span
          key={p.key}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[8px] font-semibold leading-none text-white ring-1 ring-card"
          style={{ backgroundColor: avatarColor(p.name, p.spoke) }}
          data-spoke={p.spoke ? 'true' : 'false'}
          aria-label={p.spoke ? p.name : `${p.name}, invited`}
          role="img"
        >
          {initialsOf(p.name)}
        </span>
      ))}
      {more > 0 && (
        <span
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 text-[9px] font-semibold leading-none text-muted-foreground ring-1 ring-card"
          data-testid="card-people-more"
        >
          +{more}
        </span>
      )}
    </span>
  )
}
