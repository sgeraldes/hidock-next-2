import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { IdentitySuggestionsSection } from '../IdentitySuggestionsSection'
import { ToastProvider } from '@/components/ui/toaster'
import type { VoiceConflictView } from '@/shared/identity-review'

/**
 * People lists only what is still undecided (spec 2026-10-03, Phase 4), and voice conflicts get
 * their own card: keep the name, or name the speaker after the voice.
 */

const conflict: VoiceConflictView = {
  id: 'vc1',
  recordingId: 'rec1',
  recordingTitle: 'rec1.wav',
  recordingDate: '2026-09-12T12:00:00Z',
  meetingSubject: 'Weekly sync',
  speakerLabel: 'Speaker 2',
  voiceContactId: 'ana',
  voiceContactName: 'Ana Ruiz',
  boundContactId: 'bea',
  boundContactName: 'Bea Paz',
  boundSource: 'manual'
}

const identity = {
  getSuggestions: vi.fn(),
  acceptSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
  getAmbiguousBuckets: vi.fn(),
  getBucketResolution: vi.fn(),
  listVoiceConflicts: vi.fn(),
  resolveVoiceConflict: vi.fn(),
  getMentionSnippets: vi.fn(),
  getMergeImpact: vi.fn(),
  getPersonContext: vi.fn()
}

const renderSection = () =>
  render(
    <ToastProvider>
      <MemoryRouter>
        <IdentitySuggestionsSection />
      </MemoryRouter>
    </ToastProvider>
  )

beforeEach(() => {
  vi.clearAllMocks()
  window.electronAPI = { identity, contacts: { getById: vi.fn().mockResolvedValue({ success: false }) } } as any
  identity.getSuggestions.mockResolvedValue({ success: true, data: [] })
  identity.getAmbiguousBuckets.mockResolvedValue({ success: true, data: [] })
  identity.listVoiceConflicts.mockResolvedValue({ success: true, data: [conflict] })
  identity.resolveVoiceConflict.mockResolvedValue({ success: true, data: { status: 'rejected' } })
})

const card = async () => (await screen.findByText(/sounds like/)).closest('[data-testid="voice-conflict"]') as HTMLElement

describe('voice-conflict card', () => {
  it('says the conflict in words, with two answers, even when nothing else is waiting', async () => {
    renderSection()
    const el = await card()
    expect(el).toHaveTextContent(
      "In 'Weekly sync' (12 Sep), Speaker 2's voice sounds like Ana Ruiz, but it is named Bea Paz (named by you)"
    )
    expect(within(el).getByRole('button', { name: 'Keep Bea Paz' })).toBeInTheDocument()
    expect(within(el).getByRole('button', { name: 'It is Ana Ruiz' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /identity suggestions \(1\)/i })).toBeInTheDocument()
  })

  it('"Keep" answers through resolveVoiceConflict, never the alias accept or reject, and the card leaves', async () => {
    renderSection()
    fireEvent.click(within(await card()).getByRole('button', { name: 'Keep Bea Paz' }))

    await waitFor(() => expect(identity.resolveVoiceConflict).toHaveBeenCalledWith('vc1', 'keep'))
    await waitFor(() => expect(screen.queryByText(/sounds like/)).toBeNull())
    expect(identity.acceptSuggestion).not.toHaveBeenCalled()
    expect(identity.rejectSuggestion).not.toHaveBeenCalled()
  })

  it('"It is <voice person>" answers with the voice', async () => {
    identity.resolveVoiceConflict.mockResolvedValue({ success: true, data: { status: 'accepted' } })
    renderSection()
    fireEvent.click(within(await card()).getByRole('button', { name: 'It is Ana Ruiz' }))

    await waitFor(() => expect(identity.resolveVoiceConflict).toHaveBeenCalledWith('vc1', 'voice'))
    await waitFor(() => expect(screen.queryByText(/sounds like/)).toBeNull())
  })

  it('an error stays on the card in words, and the card stays', async () => {
    identity.resolveVoiceConflict.mockResolvedValue({
      success: false,
      error: { code: 'SUGGESTION_STALE', message: 'This question was already answered. Reload People to see what is left.' }
    })
    renderSection()
    fireEvent.click(within(await card()).getByRole('button', { name: 'Keep Bea Paz' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This question was already answered. Reload People to see what is left.')
    expect(screen.getByText(/sounds like/)).toBeInTheDocument()
  })

  it('a recording that left the library closes the card and says why', async () => {
    const message =
      'That recording is no longer in the library (trashed or marked personal), so its speaker cannot be changed.'
    identity.resolveVoiceConflict.mockResolvedValue({ success: false, error: { code: 'RECORDING_INELIGIBLE', message } })
    renderSection()
    fireEvent.click(within(await card()).getByRole('button', { name: 'It is Ana Ruiz' }))

    await waitFor(() => expect(screen.queryByText(/sounds like/)).toBeNull())
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('names who named the speaker in plain words', async () => {
    identity.listVoiceConflicts.mockResolvedValue({
      success: true,
      data: [{ ...conflict, boundSource: 'self-identification' }]
    })
    renderSection()
    expect(await card()).toHaveTextContent('(the speaker gave that name)')
  })
})

describe('only what is still undecided', () => {
  it('leaves out a shared first name whose recordings are all decided', async () => {
    identity.listVoiceConflicts.mockResolvedValue({ success: true, data: [] })
    identity.getAmbiguousBuckets.mockResolvedValue({
      success: true,
      data: [
        { contactId: 'b1', name: 'Sergio', candidates: [{ id: 'c1', name: 'Sergio Reyes' }], recordingCount: 2, resolvedCount: 2, pendingCount: 0 },
        { contactId: 'b2', name: 'Edu', candidates: [{ id: 'c2', name: 'Eduardo Paz' }], recordingCount: 3, resolvedCount: 1, pendingCount: 2 }
      ]
    })
    renderSection()

    expect(await screen.findByRole('button', { name: /identity suggestions \(1\)/i })).toBeInTheDocument()
    expect(screen.queryByText(/Sergio/)).toBeNull()
    expect(screen.getAllByText(/Edu/).length).toBeGreaterThan(0)
  })
})
