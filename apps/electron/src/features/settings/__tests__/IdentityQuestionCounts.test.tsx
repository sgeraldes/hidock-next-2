import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { IdentityQuestionCounts } from '../IdentityQuestionCounts'

const getQuestionCounts = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.electronAPI = { identity: { getQuestionCounts } } as any
  getQuestionCounts.mockResolvedValue({
    success: true,
    data: {
      rows: [
        { kind: 'shared-first-names', pending: 412, automatic: 1203, owner: 37 },
        { kind: 'duplicate-people', pending: 377, automatic: 64, owner: 12 },
        { kind: 'speakers', pending: 2, automatic: 810, owner: 95 },
        { kind: 'voice-conflicts', pending: 3, automatic: 0, owner: 1 }
      ]
    }
  })
})

describe('IdentityQuestionCounts', () => {
  it('shows a small table: one row per kind of question, three counts, tabular numbers', async () => {
    render(<IdentityQuestionCounts />)
    const table = await screen.findByRole('table', { name: /identity questions/i })

    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Question', 'Pending', 'Decided automatically', 'Decided by you'])

    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'Shared first names',
      'Duplicate people',
      'Speakers',
      'Voice conflicts'
    ])
    const first = within(rows[0]).getAllByRole('cell')
    expect(first.map((c) => c.textContent)).toEqual(['412', '1,203', '37'])
    expect(first[1]).toHaveClass('tabular-nums')
  })

  it('shows placeholders while counting, never a sentence', () => {
    getQuestionCounts.mockReturnValue(new Promise(() => {}))
    render(<IdentityQuestionCounts />)
    expect(screen.getByRole('status', { name: /counting identity questions/i })).toBeInTheDocument()
    expect(screen.queryByText(/loading/i)).toBeNull()
  })

  it('says it in words when the counts cannot be read', async () => {
    getQuestionCounts.mockResolvedValue({
      success: false,
      error: { code: 'DATABASE_ERROR', message: 'The question counts could not be read. Reopen Settings to try again.' }
    })
    render(<IdentityQuestionCounts />)
    expect(await screen.findByRole('alert')).toHaveTextContent('The question counts could not be read. Reopen Settings to try again.')
  })
})
