import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Working, BusyIcon, WorkingValue, WorkingBar } from '../working'

/**
 * Loading and working states look like work, never a sentence (owner, 2-oct-2026:
 * "That should NOT be a text... something that gives the idea of WORKING").
 */
describe('Working', () => {
  it('names the state for screen readers and the tooltip, and shows no sentence', () => {
    const { container } = render(<Working label="Loading the library" shape="list" />)
    const status = screen.getByRole('status', { name: 'Loading the library' })
    expect(status).toHaveAttribute('title', 'Loading the library')
    expect(container.textContent?.trim()).toBe('')
  })

  it('draws placeholder blocks in the shape of the coming content, with a moving shimmer and a spinner', () => {
    const { container } = render(<Working label="Loading transcript" shape="lines" rows={6} />)
    // Each line is a short time stub and a text bar.
    expect(container.querySelectorAll('[data-working-block]')).toHaveLength(12)
    // Animations sit behind the reduced-motion preference.
    expect(container.querySelector('[class*="motion-safe:animate-shimmer"]')).not.toBeNull()
    expect(container.querySelector('[class*="motion-safe:animate-spin"]')).not.toBeNull()
  })

  it('shows a pulsing clock instead of the spinner while the work only waits', () => {
    const { container } = render(<Working label="Waiting to be transcribed" waiting />)
    expect(container.querySelector('[class*="animate-spin"]')).toBeNull()
    expect(container.querySelector('.lucide-clock')).not.toBeNull()
  })

  it('adds a bar and the number when the progress is known', () => {
    render(<Working label="Transcribing" progress={42} />)
    expect(screen.getByRole('status', { name: 'Transcribing, 42%' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('every shape renders', () => {
    for (const shape of ['lines', 'list', 'cards', 'wave', 'page', 'block'] as const) {
      const { container, unmount } = render(<Working label={shape} shape={shape} />)
      expect(container.querySelectorAll('[data-working-block]').length, shape).toBeGreaterThan(0)
      unmount()
    }
  })
})

describe('WorkingValue and WorkingBar', () => {
  it('a value still coming is a shimmering bar named for screen readers, with no text', () => {
    const { container } = render(<WorkingValue label="Reading the battery" />)
    expect(screen.getByRole('status', { name: 'Reading the battery' })).toBeInTheDocument()
    expect(container.textContent).toBe('')
    expect(container.querySelector('[data-working-block]')).not.toBeNull()
  })

  it('a background job is a thin moving strip, with no text', () => {
    const { container } = render(<WorkingBar label="Syncing the calendar" />)
    expect(screen.getByRole('status', { name: 'Syncing the calendar' })).toBeInTheDocument()
    expect(container.textContent).toBe('')
    expect(container.querySelector('[class*="motion-safe:animate-shimmer"]')).not.toBeNull()
  })
})

describe('BusyIcon', () => {
  it('is a spinning icon hidden from screen readers', () => {
    const { container } = render(<BusyIcon />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveClass('motion-safe:animate-spin')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
  })
})
