import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const updateConfig = vi.fn(async () => undefined)
let config: Record<string, unknown> = {}

vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: (selector: (s: unknown) => unknown) => selector({ config, updateConfig })
}))

import { DecisionsSection } from '../DecisionsSection'

beforeEach(() => {
  vi.clearAllMocks()
  config = {
    transcription: { jevApiKey: '__hidock_saved_secret__' }, // pragma: allowlist secret
    decisions: { jevEnabled: true, jevValue: true, jevMeetingMatch: true }
  }
})

describe('DecisionsSection', () => {
  it('says where the text goes and lists what each job sends and decides', () => {
    render(<DecisionsSection />)
    expect(screen.getByText('https://api.typesafe.ai/v1/systemone')).toBeInTheDocument()
    expect(screen.getByText(/Key saved/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Rate recordings and check transcripts' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Match recordings to calendar meetings' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Name the speakers' })).toBeInTheDocument()
  })

  it('turns one job off without touching the others', () => {
    render(<DecisionsSection />)
    fireEvent.click(screen.getByRole('switch', { name: 'Match recordings to calendar meetings' }))
    expect(updateConfig).toHaveBeenCalledWith('decisions', { jevEnabled: true, jevValue: true, jevMeetingMatch: false })
  })

  it('with Jev off, the job switches are disabled', () => {
    config.decisions = { jevEnabled: false, jevValue: true, jevMeetingMatch: true }
    render(<DecisionsSection />)
    expect(screen.getByRole('switch', { name: 'Use Jev for decisions' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Rate recordings and check transcripts' })).toBeDisabled()
  })
})
