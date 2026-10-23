import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SettingsNav } from '../SettingsNav'

describe('SettingsNav', () => {
  it('names the narrow-window section picker without a visually hidden label', () => {
    // An sr-only label is position:absolute and, with no positioned ancestor,
    // can stretch the document and let the whole window scroll (23-oct-2026).
    const { container } = render(<SettingsNav active="transcription" onSelect={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Settings section' })).toBeInTheDocument()
    expect(container.querySelector('.sr-only')).toBeNull()
  })
})
