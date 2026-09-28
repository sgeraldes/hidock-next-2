import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LibrarySection } from '../LibrarySection'
import { useLibraryStore, DEFAULT_READER_SECTION_MODES } from '@/store/useLibraryStore'

beforeEach(() => {
  useLibraryStore.setState({ viewMode: 'compact', sortBy: 'date', sortOrder: 'desc', readerSectionModes: { ...DEFAULT_READER_SECTION_MODES } })
})

describe('Settings > Library', () => {
  it('changes the same values the Library header changes', () => {
    render(<LibrarySection />)
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: 'card' } })
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'quality' } })
    fireEvent.change(screen.getByLabelText('Sort order'), { target: { value: 'asc' } })
    fireEvent.change(screen.getByLabelText('Full transcript'), { target: { value: 'hidden' } })
    const s = useLibraryStore.getState()
    expect([s.viewMode, s.sortBy, s.sortOrder, s.readerSectionModes.transcript]).toEqual(['card', 'quality', 'asc', 'hidden'])
  })
})
