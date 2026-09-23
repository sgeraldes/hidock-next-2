/**
 * Tests for TimelineEventList — the reader's Actions & decisions section.
 *
 * These cases came over from WaveformPlayer.test.tsx on 2026-09-22 with the list
 * itself. Everything they assert about the rows (full text, detail panel, edit,
 * mark complete, read-only) is unchanged behaviour; what changed is that the
 * list is now a component of its own, so the seek arrives through `onActivate`
 * instead of happening inside the player.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { TimelineEventList } from '../TimelineEventList'
import type { TimelineEvent } from '../WaveformPlayer'

vi.mock('@radix-ui/react-portal', () => ({
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

let onActivate: (event: TimelineEvent) => void

beforeEach(() => {
  vi.clearAllMocks()
  onActivate = vi.fn() as unknown as (event: TimelineEvent) => void
})

describe('TimelineEventList', () => {
  it('asks the reader to seek when the TIMESTAMP chip is clicked', () => {
    render(
      <TimelineEventList
        recordingId="rec-1"
        onActivate={onActivate}
        events={[{ id: 'e1', timeSec: 25, index: 1, label: 'Kickoff', kind: 'action' }]}
      />
    )
    const list = screen.getByTestId('timeline-events')
    // The timestamp chip is the seek affordance (the text click expands details).
    fireEvent.click(within(list).getByTitle('Seek to 0:25'))
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', timeSec: 25 }))
  })

  it('shows the FULL event text wrapped (no truncation) when details are provided', () => {
    const longText = 'Exportar todas las tareas de Cantata a un archivo de Excel para luego filtrar y clasificar por responsable antes del viernes'
    render(
      <TimelineEventList
        recordingId="rec-1"
        onActivate={onActivate}
        events={[{ id: 'e1', timeSec: 25, index: 1, label: 'Exportar todas las tareas de Cantata a un archivo de Ex…', kind: 'action', refId: 'row-1' }]}
        eventDetails={{ 'row-1': { kind: 'action', fullText: longText, editable: true, status: 'pending', assignee: 'Camilo' } }}
      />
    )
    const text = screen.getByText(longText)
    expect(text).toBeInTheDocument()
    expect(text.className).not.toContain('truncate')
    expect(text.className).toContain('whitespace-normal')
  })

  it('clicking the row text EXPANDS the detail panel (does not seek)', () => {
    render(
      <TimelineEventList
        recordingId="rec-1"
        onActivate={onActivate}
        events={[{ id: 'e1', timeSec: 25, index: 1, label: 'Kickoff', kind: 'action', refId: 'row-1' }]}
        eventDetails={{ 'row-1': { kind: 'action', fullText: 'Kickoff', editable: true, status: 'pending', assignee: 'Ana', priority: 'high' } }}
      />
    )
    fireEvent.click(screen.getByText('Kickoff'))
    expect(onActivate).not.toHaveBeenCalled()
    const detail = screen.getByTestId('event-detail-e1')
    expect(within(detail).getByText(/Ana/)).toBeInTheDocument()
    expect(within(detail).getByText(/pending/i)).toBeInTheDocument()
    // Collapse again.
    fireEvent.click(screen.getByText('Kickoff'))
    expect(screen.queryByTestId('event-detail-e1')).not.toBeInTheDocument()
  })

  it('edit mode saves the new content via onEventUpdate', async () => {
    const onEventUpdate = vi.fn().mockResolvedValue(true)
    render(
      <TimelineEventList
        recordingId="rec-1"
        onActivate={onActivate}
        events={[{ id: 'e1', timeSec: 25, index: 1, label: 'Old text', kind: 'action', refId: 'row-1' }]}
        eventDetails={{ 'row-1': { kind: 'action', fullText: 'Old text', editable: true, status: 'pending' } }}
        onEventUpdate={onEventUpdate}
      />
    )
    fireEvent.click(screen.getByText('Old text'))
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    const draft = screen.getByLabelText(/edit item 1 text/i)
    fireEvent.change(draft, { target: { value: 'Corrected action text' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await vi.waitFor(() => expect(onEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      { content: 'Corrected action text' }
    ))
  })

  it('mark complete toggles the action status via onEventUpdate', async () => {
    const onEventUpdate = vi.fn().mockResolvedValue(true)
    render(
      <TimelineEventList
        recordingId="rec-1"
        onActivate={onActivate}
        events={[{ id: 'e1', timeSec: 25, index: 1, label: 'Do it', kind: 'action', refId: 'row-1' }]}
        eventDetails={{ 'row-1': { kind: 'action', fullText: 'Do it', editable: true, status: 'pending' } }}
        onEventUpdate={onEventUpdate}
      />
    )
    fireEvent.click(screen.getByText('Do it'))
    fireEvent.click(screen.getByRole('button', { name: /mark complete/i }))
    await vi.waitFor(() => expect(onEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      { status: 'completed' }
    ))
  })

  it('read-only events (editable:false) show full text but no edit affordance', () => {
    render(
      <TimelineEventList
        recordingId="rec-1"
        onActivate={onActivate}
        events={[{ id: 'txa_0', timeSec: 25, index: 1, label: 'Short…', kind: 'action', refId: 'txa_0' }]}
        eventDetails={{ txa_0: { kind: 'action', fullText: 'Complete read-only text', editable: false } }}
      />
    )
    fireEvent.click(screen.getByText('Complete read-only text'))
    expect(screen.getByText(/read-only item/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument()
  })
  it('renders every event even when the recording duration is unknown', () => {
    // The graph's markers need a time axis and vanish without a duration. A list
    // of what was decided does not, and used to vanish with them.
    render(
      <TimelineEventList
        recordingId="rec-1"
        onActivate={onActivate}
        events={[{ id: 'e1', timeSec: 25, index: 1, label: 'Decidido', kind: 'decision' }]}
      />
    )
    expect(within(screen.getByTestId('timeline-events')).getByText('Decidido')).toBeInTheDocument()
  })

  it('says so plainly when there is nothing to show', () => {
    render(<TimelineEventList recordingId="rec-1" onActivate={onActivate} events={[]} />)
    expect(screen.getByTestId('timeline-events-empty')).toBeInTheDocument()
  })
})
