import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DecidedAutomaticallySection } from '../DecidedAutomaticallySection'
import type { DecisionView } from '@/shared/identity-review'

const listDecisions = vi.fn()
const undoDecision = vi.fn()

const decision = (patch: Partial<DecisionView>): DecisionView => ({
  id: 'd1',
  kind: 'speaker',
  method: 'one-on-one',
  createdAt: '2026-10-03T10:00:00.000Z',
  undoneAt: null,
  contactId: 'ana',
  personName: 'Ana Ruiz',
  subjectName: 'Speaker 2',
  recordingId: 'rec1',
  recordingTitle: 'rec1.wav',
  recordingDate: '2026-09-12T12:00:00Z',
  meetingSubject: 'Weekly sync',
  probability: null,
  votes: null,
  ...patch
})

const rows = [
  decision({ id: 'd1' }),
  decision({
    id: 'd2',
    kind: 'merge',
    method: 'exact-email',
    subjectName: 'Ana R.',
    recordingId: null,
    meetingSubject: null,
    recordingTitle: null,
    recordingDate: null,
    createdAt: '2026-10-02T10:00:00.000Z'
  })
]

beforeEach(() => {
  vi.clearAllMocks()
  window.electronAPI = { identity: { listDecisions, undoDecision } } as any
  listDecisions.mockResolvedValue({ success: true, data: rows })
  undoDecision.mockResolvedValue({ success: true, data: { restored: true } })
})

const header = () => screen.getByRole('button', { name: /decided automatically/i })

describe('DecidedAutomaticallySection', () => {
  it('is collapsed by default and shows the count', async () => {
    render(<DecidedAutomaticallySection />)
    await waitFor(() => expect(header()).toHaveTextContent('Decided automatically (2)'))
    expect(header()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/Weekly sync/)).toBeNull()
    expect(listDecisions).toHaveBeenCalledWith({ limit: 500 })
  })

  it('expanded, lists each decision in words, newest first, with an Undo each', async () => {
    render(<DecidedAutomaticallySection />)
    await waitFor(() => expect(header()).toHaveTextContent('(2)'))
    fireEvent.click(header())

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent(
      "Speaker 2 in 'Weekly sync' (12 Sep) is Ana Ruiz: Ana Ruiz was the only other person in this one-on-one"
    )
    expect(items[1]).toHaveTextContent("Merged 'Ana R.' into Ana Ruiz: same email")
    expect(within(items[0]).getByRole('button', { name: /undo/i })).toBeInTheDocument()
  })

  it('after Undo the row shows as undone, the count drops, and the page is told', async () => {
    const onChanged = vi.fn()
    render(<DecidedAutomaticallySection onChanged={onChanged} />)
    await waitFor(() => expect(header()).toHaveTextContent('(2)'))
    fireEvent.click(header())

    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: /undo/i }))

    await waitFor(() => expect(header()).toHaveTextContent('Decided automatically (1)'))
    expect(undoDecision).toHaveBeenCalledWith('d1')
    const first = screen.getAllByRole('listitem')[0]
    expect(first).toHaveTextContent(/Undone/)
    expect(within(first).queryByRole('button', { name: /undo/i })).toBeNull()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('says so when the name had changed since and stays as it is', async () => {
    undoDecision.mockResolvedValue({ success: true, data: { restored: false } })
    render(<DecidedAutomaticallySection />)
    await waitFor(() => expect(header()).toHaveTextContent('(2)'))
    fireEvent.click(header())
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: /undo/i }))

    await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(/changed since/i))
  })

  it('shows an undo error in words and keeps the Undo button', async () => {
    undoDecision.mockResolvedValue({
      success: false,
      error: { code: 'NOT_FOUND', message: 'This decision no longer exists. Reload People to see the current list.' }
    })
    render(<DecidedAutomaticallySection />)
    await waitFor(() => expect(header()).toHaveTextContent('(2)'))
    fireEvent.click(header())
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: /undo/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This decision no longer exists. Reload People to see the current list.')
    expect(header()).toHaveTextContent('(2)')
    expect(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: /undo/i })).toBeInTheDocument()
  })

  it('two Undo clicks before the page redraws make one call', async () => {
    let finish!: (v: unknown) => void
    undoDecision.mockReturnValue(new Promise((r) => (finish = r)))
    render(<DecidedAutomaticallySection />)
    await waitFor(() => expect(header()).toHaveTextContent('(2)'))
    fireEvent.click(header())
    const button = within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: /undo/i })

    act(() => {
      button.click()
      button.click()
    })

    expect(undoDecision).toHaveBeenCalledTimes(1)
    await act(async () => finish({ success: true, data: { restored: true } }))
    expect(header()).toHaveTextContent('Decided automatically (1)')
  })

  it('"already undone" from the app keeps the row as undone, not as an error', async () => {
    undoDecision.mockResolvedValue({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'This decision was already undone.' }
    })
    render(<DecidedAutomaticallySection />)
    await waitFor(() => expect(header()).toHaveTextContent('(2)'))
    fireEvent.click(header())
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: /undo/i }))

    await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(/Undone/))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(header()).toHaveTextContent('Decided automatically (1)')
  })

  it('a thrown undo reads as a sentence with an action', async () => {
    undoDecision.mockRejectedValue(new Error('ipc timeout'))
    render(<DecidedAutomaticallySection />)
    await waitFor(() => expect(header()).toHaveTextContent('(2)'))
    fireEvent.click(header())
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: /undo/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be undone\. try again/i)
  })

  it('shows a placeholder while loading, and nothing when there is nothing decided', async () => {
    let resolve!: (v: unknown) => void
    listDecisions.mockReturnValue(new Promise((r) => (resolve = r)))
    const { container } = render(<DecidedAutomaticallySection />)
    expect(screen.getByRole('status', { name: /loading automatic decisions/i })).toBeInTheDocument()

    resolve({ success: true, data: [] })
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('says it in words when the list cannot be read', async () => {
    listDecisions.mockResolvedValue({ success: false, error: { code: 'DATABASE_ERROR', message: 'The automatic decisions could not be read. Reload People to try again.' } })
    render(<DecidedAutomaticallySection />)
    expect(await screen.findByRole('alert')).toHaveTextContent('The automatic decisions could not be read. Reload People to try again.')
  })
})
