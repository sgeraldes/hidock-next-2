import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlayerSection } from '../PlayerSection'
import { useConfigStore } from '@/store/domain/useConfigStore'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))

const updateConfig = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  updateConfig.mockClear()
  useConfigStore.setState({
    config: { ui: { playbackSpeeds: [0.5, 1, 1.5, 2], defaultPlaybackSpeed: 1.5 } } as never,
    updateConfig
  })
})

describe('PlayerSection', () => {
  it('saves the skip length and the notice time', () => {
    render(<PlayerSection />)
    fireEvent.change(screen.getByLabelText('Back and forward buttons jump'), { target: { value: '30' } })
    expect(updateConfig).toHaveBeenCalledWith('ui', { skipSeconds: 30 })
    fireEvent.change(screen.getByLabelText('Notices stay on screen for'), { target: { value: '8' } })
    expect(updateConfig).toHaveBeenCalledWith('ui', { toastSeconds: 8 })
  })

  it('removing the starting speed from the menu resets the start to 1x', () => {
    render(<PlayerSection />)
    fireEvent.click(screen.getByRole('button', { name: '1.5×' }))
    expect(updateConfig).toHaveBeenCalledWith('ui', { playbackSpeeds: [0.5, 1, 2], defaultPlaybackSpeed: 1 })
  })

  it('1x cannot be taken off the menu', () => {
    render(<PlayerSection />)
    expect(screen.getByRole('button', { name: '1×' })).toBeDisabled()
  })
})
