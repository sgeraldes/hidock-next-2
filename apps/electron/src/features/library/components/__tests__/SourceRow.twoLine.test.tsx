import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

import { SourceRow } from '../SourceRow'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { Meeting } from '@/types'

const base: UnifiedRecording = {
  id: 'r1',
  filename: '2026Sep24-190246-Rec49.hda',
  userTitle: 'Quarterly planning',
  dateRecorded: new Date('2026-09-24T19:02:46'),
  duration: 2680, // 44m 40s
  size: 1000,
  location: 'local-only',
  syncStatus: 'synced',
  localPath: '/tmp/rec.wav',
  transcriptionStatus: 'complete'
}

const meeting: Meeting = {
  id: 'm1',
  subject: 'Quarterly planning',
  start_time: '2026-09-24T18:30:00',
  end_time: '2026-09-24T19:30:00',
  location: null,
  organizer_name: null,
  organizer_email: null,
  attendees: null,
  description: null,
  is_recurring: 0,
  recurrence_rule: null,
  meeting_url: null,
  created_at: '',
  updated_at: ''
}

describe('SourceRow compact — two-line layout', () => {
  it('puts the title alone on the first line and truncates it to one line', () => {
    render(<SourceRow recording={base} compact />)
    const title = screen.getByText('Quarterly planning')
    expect(title).toHaveClass('truncate')
    // Nothing shares the title line: no time, no chips.
    expect(title.parentElement?.children).toHaveLength(1)
    expect(screen.queryByTestId('row-time')).not.toBeInTheDocument()
  })

  it('puts date, time and duration on the second line, with no filename', () => {
    render(<SourceRow recording={base} compact />)
    const meta = screen.getByTestId('row-meta')
    expect(meta.textContent).toMatch(/Sep 24/)
    expect(meta.textContent).toMatch(/7:02\s?PM/i)
    expect(meta.textContent).toMatch(/44m/)
    expect(meta.textContent).not.toContain('Rec49')
    expect(meta.textContent).not.toContain('.hda')
  })

  it('puts the chips on that second line, after the date', () => {
    const { container } = render(
      <SourceRow recording={{ ...base, evalKind: 'team_meeting', evalStarLevel: 4 }} compact />
    )
    const meta = screen.getByTestId('row-meta')
    const labels = container.querySelector('[data-slot="labels"]') as HTMLElement
    expect(labels.parentElement).toBe(meta.closest('div'))
    expect(Boolean(meta.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(labels).toHaveTextContent('Team meeting')
  })

  it('keeps the icons on the right, vertically centred beside both lines', () => {
    const { container } = render(<SourceRow recording={base} compact />)
    const row = screen.getByRole('option')
    expect(row).toHaveClass('h-11')
    expect(row).toHaveClass('items-center')
    for (const name of ['meeting', 'status', 'transcription']) {
      expect(container.querySelector(`[data-slot="${name}"]`), name).not.toBeNull()
    }
  })

  it('does not render a line-one time in card (non-compact) mode', () => {
    render(<SourceRow recording={base} />)
    expect(screen.queryByTestId('row-time')).not.toBeInTheDocument()
  })
})

describe('SourceRow compact narrow — three lines on a phone', () => {
  const rich = { ...base, evalKind: 'team_meeting', evalStarLevel: 4 } as UnifiedRecording

  it('is a 68px row', () => {
    render(<SourceRow recording={rich} compact narrow />)
    expect(screen.getByRole('option')).toHaveClass('h-[68px]')
  })

  it('title on line one, date and time on line two, chips on line three', () => {
    const { container } = render(<SourceRow recording={rich} compact narrow />)
    const title = screen.getByText('Quarterly planning')
    const meta = screen.getByTestId('row-meta')
    const labels = container.querySelector('[data-slot="labels"]') as HTMLElement
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(before(title, meta)).toBe(true)
    expect(before(meta, labels)).toBe(true)
    // The chips are a line of their own, not inside the date line.
    expect(meta.closest('div')?.contains(labels)).toBe(false)
    expect(labels).toHaveTextContent('Team meeting')
  })

  it('is ignored on a wide row', () => {
    render(<SourceRow recording={rich} compact wide narrow />)
    expect(screen.getByRole('option')).toHaveClass('h-8')
  })
})

describe('SourceRow compact — every icon is visible without hovering', () => {
  it('shows the calendar link, the location and the transcription state at rest', () => {
    const { container } = render(<SourceRow recording={base} meeting={meeting} compact />)
    for (const name of ['meeting', 'status', 'transcription']) {
      const slot = container.querySelector(`[data-slot="${name}"]`)
      expect(slot, name).not.toBeNull()
      expect(slot?.className, name).not.toContain('opacity-0')
    }
  })

  it('keeps the stars and the transcript warning always visible (never opacity-gated)', () => {
    const { container } = render(
      <SourceRow
        recording={{ ...base, evalStarLevel: 4, evalKind: 'team_meeting', evalAudioWarning: 'possible_invented_transcript' }}
        compact
      />
    )
    for (const name of ['labels', 'transcription']) {
      const slot = container.querySelector(`[data-slot="${name}"]`)
      expect(slot, name).not.toBeNull()
      expect(slot?.className, name).not.toContain('opacity-0')
    }
    expect(container.querySelector('[data-testid="transcript-problem"]')).not.toBeNull()
  })

  it('keeps a failed transcription visible without hover (it needs attention)', () => {
    const { container } = render(
      <SourceRow recording={{ ...base, transcriptionStatus: 'error' }} compact />
    )
    const slot = container.querySelector('[data-slot="transcription"]')
    expect(slot?.className).not.toContain('opacity-0')
  })
})

describe('SourceRow — row menu opens from the keyboard', () => {
  it('opens the overflow menu on Enter', async () => {
    render(<SourceRow recording={base} compact onAskAssistant={vi.fn()} />)
    fireEvent.keyDown(screen.getByLabelText(/more actions/i), { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: /ask assistant/i })).toBeInTheDocument()
  })

  it('opens the overflow menu on Space', async () => {
    render(<SourceRow recording={base} compact onAskAssistant={vi.fn()} />)
    fireEvent.keyDown(screen.getByLabelText(/more actions/i), { key: ' ' })
    expect(await screen.findByRole('menuitem', { name: /ask assistant/i })).toBeInTheDocument()
  })
})

describe('SourceRow compact wide — one line with aligned columns', () => {
  const rich = { ...base, evalKind: 'team_meeting', evalStarLevel: 4 } as UnifiedRecording

  it('shows date, time and duration as columns and drops the second line', () => {
    const { container } = render(<SourceRow recording={rich} compact wide />)
    expect(screen.getByTestId('row-date').textContent).toMatch(/Sep 24/)
    expect(screen.getByTestId('row-time').textContent).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i)
    expect(screen.getByTestId('row-duration').textContent).toMatch(/44m/)
    // Only one time, and no stacked meta line with date and duration together.
    expect(screen.getAllByTestId('row-time')).toHaveLength(1)
    expect(screen.queryByText((c) => /Sep 24/.test(c) && /44m/.test(c))).not.toBeInTheDocument()
    expect(container.querySelector('p.mt-0\\.5')).toBeNull()
  })

  it('is a 32px row, and 44px on two lines when not wide', () => {
    const { rerender } = render(<SourceRow recording={rich} compact wide />)
    expect(screen.getByRole('option')).toHaveClass('h-8')
    rerender(<SourceRow recording={rich} compact wide={false} />)
    expect(screen.getByRole('option')).toHaveClass('h-11')
  })

  it('does not repeat the kind: the label on the right already says it', () => {
    render(<SourceRow recording={rich} compact wide />)
    expect(screen.getAllByText('Team meeting')).toHaveLength(1)
    expect(screen.getByTestId('evaluation-label')).toBeInTheDocument()
  })

  it('puts the columns before the icon cluster, in the order date, time, duration', () => {
    const { container } = render(<SourceRow recording={rich} compact wide />)
    const date = screen.getByTestId('row-date')
    const time = screen.getByTestId('row-time')
    const duration = screen.getByTestId('row-duration')
    const labels = container.querySelector('[data-slot="labels"]') as HTMLElement
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(before(date, time)).toBe(true)
    expect(before(time, duration)).toBe(true)
    expect(before(duration, labels)).toBe(true)
  })

  it('highlights a search match in the date and duration columns, like the two-line meta line', () => {
    const { rerender } = render(<SourceRow recording={rich} compact wide searchQuery="44m" />)
    expect(screen.getByTestId('row-duration').querySelector('mark')?.textContent).toBe('44m')
    rerender(<SourceRow recording={rich} compact wide searchQuery="Sep" />)
    expect(screen.getByTestId('row-date').querySelector('mark')?.textContent).toBe('Sep')
  })

  it('keeps the duration column in place when a source has no duration', () => {
    render(<SourceRow recording={{ ...rich, duration: 0 }} compact wide />)
    expect(screen.getByTestId('row-duration').textContent).toBe('')
    expect(screen.getByTestId('row-duration').className).toContain('w-14')
  })
})

describe('SourceRow compact — menu button', () => {
  it('is compact, close to the icons', () => {
    render(<SourceRow recording={base} compact />)
    const button = screen.getByLabelText(/more actions/i)
    expect(button).toHaveClass('h-6')
    expect(button).toHaveClass('w-6')
  })
})
