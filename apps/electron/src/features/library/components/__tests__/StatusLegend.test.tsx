import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusLegend } from '../StatusLegend'

describe('StatusLegend', () => {
  it('exposes a discoverable, labelled trigger', () => {
    render(<StatusLegend />)
    expect(screen.getByRole('button', { name: /status icon legend/i })).toBeInTheDocument()
  })

  it('reveals the location and transcription meanings when opened', () => {
    render(<StatusLegend />)
    fireEvent.click(screen.getByRole('button', { name: /status icon legend/i }))

    // Location key
    expect(screen.getByText('On device only')).toBeInTheDocument()
    expect(screen.getByText('Downloaded to computer')).toBeInTheDocument()
    expect(screen.getByText('Synced (device + computer)')).toBeInTheDocument()

    // Transcription key
    expect(screen.getByText('Not transcribed')).toBeInTheDocument()
    expect(screen.getByText('Transcribed')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  // F16/spec-003 Part C
  it('reveals the value classification meanings when opened', () => {
    render(<StatusLegend />)
    fireEvent.click(screen.getByRole('button', { name: /status icon legend/i }))

    expect(screen.getByText('Value')).toBeInTheDocument()
    expect(screen.getByText('Low value')).toBeInTheDocument()
    expect(screen.getByText('Garbage')).toBeInTheDocument()
  })

  it('explains the places a problem takes over: an error for the location, a transcript problem for the transcription', () => {
    render(<StatusLegend />)
    fireEvent.click(screen.getByRole('button', { name: /status icon legend/i }))

    expect(screen.getByText('Linked to a calendar meeting')).toBeInTheDocument()
    expect(screen.getByText('Processing error (in place of the above)')).toBeInTheDocument()
    expect(screen.getByText('Transcript problems (in place of the above)')).toBeInTheDocument()
    for (const label of ['Text does not fit the audio', 'Text may be invented', 'Text may be missing', 'Timing is wrong']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })
})
