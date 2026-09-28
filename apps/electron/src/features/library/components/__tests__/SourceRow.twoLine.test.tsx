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

describe('SourceRow compact — two-line Kiro Crew layout', () => {
  it('puts the recording time on line one, right of the title', () => {
    render(<SourceRow recording={base} compact />)
    const time = screen.getByTestId('row-time')
    // A start time (12h clock), not a date and not the filename.
    expect(time.textContent).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i)
    expect(time.textContent).not.toContain('.hda')
    expect(time.className).toContain('ml-auto')
  })

  it('shows a muted meta line of date, duration and kind — no time and no filename', () => {
    render(<SourceRow recording={{ ...base, evalKind: 'team_meeting' }} compact />)
    // date + duration + kind live together on the meta line.
    const meta = screen.getByText((c) => /Sep 24/.test(c) && /44m/.test(c) && /Team meeting/.test(c))
    expect(meta).toBeInTheDocument()
    // The time is NOT repeated on the meta line (it is on line one).
    expect(meta.textContent).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i)
    expect(meta.textContent).not.toContain('Rec49')
  })

  it('does not render a line-one time in card (non-compact) mode', () => {
    render(<SourceRow recording={base} />)
    expect(screen.queryByTestId('row-time')).not.toBeInTheDocument()
  })
})

describe('SourceRow compact — icons hidden until hover unless they need attention', () => {
  it('fades the calendar link, location and a clean transcription state until hover/focus', () => {
    const { container } = render(<SourceRow recording={base} meeting={meeting} compact />)
    const hoverGated = ['meeting', 'status', 'transcription']
    for (const name of hoverGated) {
      const slot = container.querySelector(`[data-slot="${name}"]`)
      expect(slot, name).not.toBeNull()
      expect(slot?.className, name).toContain('opacity-0')
      expect(slot?.className, name).toContain('group-hover:opacity-100')
    }
  })

  it('keeps the stars, the warning and the error icon always visible (never opacity-gated)', () => {
    const { container } = render(
      <SourceRow
        recording={{ ...base, evalStarLevel: 4, evalKind: 'team_meeting', evalAudioWarning: 'possible_invented_transcript' }}
        compact
      />
    )
    for (const name of ['labels', 'warning', 'error', 'value', 'integrity']) {
      const slot = container.querySelector(`[data-slot="${name}"]`)
      expect(slot, name).not.toBeNull()
      expect(slot?.className, name).not.toContain('opacity-0')
    }
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
