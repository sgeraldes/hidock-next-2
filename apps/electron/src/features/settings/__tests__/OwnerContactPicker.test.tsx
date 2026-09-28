import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { OwnerContactPicker } from '../OwnerContactPicker'
import { useConfigStore } from '@/store/domain/useConfigStore'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))

const updateConfig = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState({ config: { identity: {} } as never, updateConfig })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    contacts: {
      getById: vi.fn(async () => ({ success: true, data: { contact: { name: 'Sebastián Geraldes' } } })),
      getAll: vi.fn(async () => ({ success: true, data: { contacts: [{ id: 'c-1', name: 'Sebastián Geraldes', email: 'seba@example.com' }], total: 1 } }))
    }
  }
})

describe('This is you', () => {
  it('finds a contact by name and saves it as the owner', async () => {
    render(<OwnerContactPicker />)
    expect(screen.getByText('Not chosen yet')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Find yourself among the contacts'), { target: { value: 'seb' } })
    fireEvent.click(await screen.findByRole('button', { name: /Sebastián Geraldes/ }))
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('identity', { ownerContactId: 'c-1' }))
  })

  it('shows the chosen owner and clears it', async () => {
    useConfigStore.setState({ config: { identity: { ownerContactId: 'c-1' } } as never, updateConfig })
    render(<OwnerContactPicker />)
    expect(await screen.findByText('Sebastián Geraldes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('identity', { ownerContactId: '' }))
  })
})
