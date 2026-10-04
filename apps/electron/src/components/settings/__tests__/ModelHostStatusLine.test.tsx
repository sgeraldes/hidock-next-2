import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ModelHostStatusLine, MODEL_HOST_STATUS_POLL_MS } from '../ModelHostStatusLine'

const status = vi.fn()

const answer = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  status: {
    configured: true,
    paired: true,
    usedForSpeakers: true,
    hasHfToken: true,
    address: 'gamestation:8765',
    health: { version: '0.2.0', state: 'ready', capabilities: ['diarize'] },
    ...overrides
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  status.mockResolvedValue(answer())
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { modelHost: { status } }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ModelHostStatusLine', () => {
  it('says the host is working', async () => {
    render(<ModelHostStatusLine />)
    expect(await screen.findByText('gamestation:8765 is working: speaker work goes there.')).toBeInTheDocument()
  })

  it('says the host is testing the voice model with the token it just got', async () => {
    status.mockResolvedValue(
      answer({
        health: { version: '0.3.0', state: 'ready', capabilities: [], setup: { status: 'validating' } }
      })
    )
    render(<ModelHostStatusLine />)
    expect(await screen.findByText(/is testing the voice model/)).toBeInTheDocument()
  })

  it('says the host is not answering: paused, in use or off', async () => {
    status.mockResolvedValue(answer({ health: null }))
    render(<ModelHostStatusLine />)
    expect(await screen.findByText(/is not answering: paused, in use or off/)).toBeInTheDocument()
  })

  it('asks again while it is on screen, so a game starting there shows up here', async () => {
    vi.useFakeTimers()
    render(<ModelHostStatusLine />)
    await act(async () => {})
    expect(status).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(MODEL_HOST_STATUS_POLL_MS)
    })
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('stays out of the way when no host is set and it was asked to', async () => {
    status.mockResolvedValue(answer({ configured: false, health: null, address: '' }))
    const { container } = render(<ModelHostStatusLine hideWhenNone />)
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing on a build without the channel', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {}
    const { container } = render(<ModelHostStatusLine />)
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })
})
