import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { SourceContainer } from '@hidock/connectors'
import { SourcePicker } from '../SourcePicker'

const channels: SourceContainer[] = [
  { externalId: 'C1', name: 'general', kind: 'channel', defaultEnabled: false, metadata: { isMember: true } },
  { externalId: 'C2', name: 'dfx5-delivery', kind: 'channel', defaultEnabled: false, metadata: { isMember: true } },
  { externalId: 'C3', name: 'random', kind: 'channel', defaultEnabled: false, metadata: { isMember: false } },
  { externalId: 'C4', name: 'hidock-dev', kind: 'private_channel', defaultEnabled: false, metadata: { isMember: true } }
]

describe('SourcePicker', () => {
  it('filters the list as you type', () => {
    render(<SourcePicker containers={channels} isEnabled={() => false} onToggle={vi.fn()} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter channels' }), { target: { value: 'dev' } })
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(1)
    expect(screen.getByRole('checkbox', { name: /hidock-dev/ })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter channels' }), { target: { value: 'nothing-like-this' } })
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.getByText(/No channel matches/)).toBeInTheDocument()
  })

  it('says nothing syncs until a channel is picked', () => {
    render(<SourcePicker containers={channels} isEnabled={() => false} onToggle={vi.fn()} />)
    expect(screen.getByText(/Nothing syncs until you pick one/)).toBeInTheDocument()
  })

  it('lists chosen channels first, as chips that can be removed', () => {
    const onToggle = vi.fn()
    const chosen = new Set(['C3'])
    render(<SourcePicker containers={channels} isEnabled={(c) => chosen.has(c.externalId)} onToggle={onToggle} />)
    expect(screen.getAllByRole('checkbox')[0]).toHaveAccessibleName(/random/)
    fireEvent.click(screen.getByRole('button', { name: 'Stop syncing random' }))
    expect(onToggle).toHaveBeenCalledWith('C3', false)
  })

  it('every channel is a real checkbox, so the keyboard can pick it', () => {
    const onToggle = vi.fn()
    render(<SourcePicker containers={channels} isEnabled={() => false} onToggle={onToggle} />)
    const general = screen.getByRole('checkbox', { name: /#general/ })
    expect(general.tagName).toBe('INPUT')
    fireEvent.click(general) // what Space does on a focused checkbox
    expect(onToggle).toHaveBeenCalledWith('C1', true)
  })
})
