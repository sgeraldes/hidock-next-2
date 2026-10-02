import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LibraryColumnHeader } from '../LibraryColumnHeader'
import { COLUMN_HEADER_HEIGHT_PX, COLUMN_WIDTH, PLACE_WIDTH } from '../libraryColumns'

function renderHeader(sortBy: React.ComponentProps<typeof LibraryColumnHeader>['sortBy'] = 'date', sortOrder: 'asc' | 'desc' = 'desc') {
  const onSort = vi.fn()
  const view = render(<LibraryColumnHeader sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />)
  return { onSort, ...view }
}

describe('LibraryColumnHeader', () => {
  it('names every column of a wide row, in the order of the row', () => {
    const { container } = renderHeader()
    const keys = Array.from(container.querySelectorAll('[data-sort-key]')).map((el) => el.getAttribute('data-sort-key'))
    // Title, Date, Time (also the date), Length, Rating, then the three icon places.
    expect(keys).toEqual(['name', 'date', 'date', 'duration', 'stars', 'meeting', 'status', 'transcription'])
  })

  it('sits over the same widths the rows use', () => {
    const { container } = renderHeader()
    for (const width of [COLUMN_WIDTH.date, COLUMN_WIDTH.time, COLUMN_WIDTH.duration, COLUMN_WIDTH.chips]) {
      expect(container.querySelector(`span.${width}`), width).not.toBeNull()
    }
    expect((screen.getByTestId('library-column-header') as HTMLElement).style.height).toBe(`${COLUMN_HEADER_HEIGHT_PX}px`)
  })

  it('gives each icon cell the width of the place it names in the rows', () => {
    const { container } = renderHeader()
    for (const key of ['meeting', 'status', 'transcription'] as const) {
      expect(container.querySelector(`[data-sort-key="${key}"]`), key).toHaveClass(PLACE_WIDTH[key])
    }
  })

  it('sticks to the top of the list, above the rows', () => {
    renderHeader()
    const header = screen.getByTestId('library-column-header')
    expect(header).toHaveClass('sticky')
    expect(header).toHaveClass('top-0')
    expect(header.className).toMatch(/bg-background/)
  })

  it('sorts by the column that is clicked', () => {
    const { onSort } = renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Title' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Length' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Rating' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Calendar meeting' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by File status' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Transcript' }))
    expect(onSort.mock.calls.map((c) => c[0])).toEqual(['name', 'duration', 'stars', 'meeting', 'status', 'transcription'])
  })

  it('Date and Time both sort by date', () => {
    const { onSort } = renderHeader('duration', 'asc')
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Time' }))
    expect(onSort.mock.calls.map((c) => c[0])).toEqual(['date', 'date'])
  })

  it('marks the active column and shows the direction on it once', () => {
    const { container, rerender, onSort } = renderHeader('duration', 'asc')
    expect(screen.getByRole('button', { name: 'Sort by Length' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Sort by Title' })).toHaveAttribute('aria-pressed', 'false')
    expect(container.querySelectorAll('.lucide-chevron-up')).toHaveLength(1)
    rerender(<LibraryColumnHeader sortBy="duration" sortOrder="desc" onSort={onSort} />)
    expect(container.querySelectorAll('.lucide-chevron-down')).toHaveLength(1)
    // Date is active and has two cells, but only the first one carries the arrow.
    rerender(<LibraryColumnHeader sortBy="date" sortOrder="desc" onSort={onSort} />)
    expect(container.querySelectorAll('.lucide-chevron-down')).toHaveLength(1)
  })

  it('the three icon cells show the icons the rows use', () => {
    const { container } = renderHeader()
    expect(container.querySelector('[data-sort-key="meeting"] .lucide-calendar')).not.toBeNull()
    expect(container.querySelector('[data-sort-key="status"] .lucide-hard-drive')).not.toBeNull()
    expect(container.querySelector('[data-sort-key="transcription"] .lucide-file-text')).not.toBeNull()
  })
})
