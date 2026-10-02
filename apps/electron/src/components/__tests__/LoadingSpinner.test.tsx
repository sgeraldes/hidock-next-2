import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoadingSpinner } from '../LoadingSpinner'

describe('LoadingSpinner (page fallback while a page loads)', () => {
  it('draws the shape of a page with a spinner and keeps the message out of sight (owner, 2-oct-2026)', () => {
    const { container } = render(<LoadingSpinner message="Loading library..." />)
    expect(screen.getByRole('status', { name: 'Loading library' })).toBeInTheDocument()
    expect(container.textContent?.trim()).toBe('')
    expect(container.querySelectorAll('[data-working-block]').length).toBeGreaterThan(3)
  })
})
