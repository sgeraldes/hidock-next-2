import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { VoiceBackfillPanel } from '../VoiceBackfillPanel'
import { useConfigStore } from '@/store/domain/useConfigStore'

// Settings > Speakers & voices: voice evidence for older recordings (spec 2026-10-03, 1b).

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))

const updateConfig = vi.fn().mockResolvedValue(undefined)
const getStatus = vi.fn()
const measureOne = vi.fn()
let domainListener: ((event: { type?: string }) => void) | null = null

const status = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    schedule: 'night',
    window: { start: '01:00', end: '07:00' },
    total: 2144,
    done: 181,
    skipped: 4,
    failed: 2,
    remaining: 1957,
    remainingAudioSeconds: 48_000,
    noAudio: 0,
    lastRunAt: null,
    lastError: null,
    running: false,
    lastMeasure: null,
    ...overrides
  }
})

function setSchedule(voiceBackfill?: Record<string, string>) {
  useConfigStore.setState({ config: { ui: { locale: 'en-US' }, transcription: { voiceBackfill } } as never, updateConfig })
}

beforeEach(() => {
  vi.clearAllMocks()
  domainListener = null
  getStatus.mockResolvedValue(status())
  setSchedule({ schedule: 'night', windowStart: '01:00', windowEnd: '07:00' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    voiceBackfill: { getStatus, measureOne },
    onDomainEvent: (cb: (event: { type?: string }) => void) => {
      domainListener = cb
      return () => {
        domainListener = null
      }
    }
  }
})

describe('VoiceBackfillPanel', () => {
  it('shows a working placeholder while the progress loads', () => {
    getStatus.mockReturnValue(new Promise(() => {}))
    render(<VoiceBackfillPanel />)
    expect(screen.getByRole('status', { name: 'Counting recordings' })).toBeInTheDocument()
  })

  it('shows how many recordings have voice evidence, the failures and the last problem', async () => {
    getStatus.mockResolvedValue(status({ lastError: 'speaker-linking timed out after 900 seconds' }))
    render(<VoiceBackfillPanel />)
    expect(await screen.findByText('181 of 2,144 recordings have voice evidence.')).toBeInTheDocument()
    expect(screen.getByText(/1,957 to go \(13 h 20 min of audio\), 2 failed, 4 with no voice long enough/)).toBeInTheDocument()
    expect(screen.getByText('Last problem: speaker-linking timed out after 900 seconds')).toBeInTheDocument()
  })

  it('saves the schedule and shows the window only for Night', async () => {
    render(<VoiceBackfillPanel />)
    await screen.findByText(/recordings have voice evidence/)
    expect(screen.getByLabelText('Starts at')).toHaveValue('01:00')
    expect(screen.getByLabelText('Ends at')).toHaveValue('07:00')

    fireEvent.change(screen.getByLabelText('When to compute voice evidence'), { target: { value: 'background' } })
    expect(updateConfig).toHaveBeenCalledWith('transcription', {
      voiceBackfill: { schedule: 'background', windowStart: '01:00', windowEnd: '07:00' }
    })

    act(() => setSchedule({ schedule: 'background', windowStart: '01:00', windowEnd: '07:00' }))
    expect(screen.queryByLabelText('Starts at')).not.toBeInTheDocument()
  })

  it('uses the defaults when the config has no schedule yet', async () => {
    setSchedule(undefined)
    render(<VoiceBackfillPanel />)
    await screen.findByText(/recordings have voice evidence/)
    expect(screen.getByLabelText('When to compute voice evidence')).toHaveValue('night')
    expect(screen.getByLabelText('Starts at')).toHaveValue('01:00')
  })

  // The app writes the window as 01:00 to 07:00; a native time field showed "01:00 AM" with a clock
  // icon that was dark on dark (screenshot review, 3-oct-2026).
  it('offers the window times in 24-hour form, every half hour, keeping a saved time that is not on one', async () => {
    act(() => setSchedule({ schedule: 'night', windowStart: '01:00', windowEnd: '06:45' }))
    render(<VoiceBackfillPanel />)
    await screen.findByText(/recordings have voice evidence/)
    const start = screen.getByLabelText('Starts at')
    expect(start.tagName).toBe('SELECT')
    const options = Array.from((start as HTMLSelectElement).options).map((o) => o.textContent)
    expect(options).toHaveLength(48)
    expect(options).toContain('13:30')
    expect(options.some((o) => /AM|PM/.test(o ?? ''))).toBe(false)
    expect(screen.getByLabelText('Ends at')).toHaveValue('06:45')
  })

  // Review of #129: the scheduled run is not a measurement; the bar named it wrong.
  it('names a scheduled run as computing voice evidence, and counts recordings without audio', async () => {
    getStatus.mockResolvedValue(status({ running: true, noAudio: 12 }))
    render(<VoiceBackfillPanel />)
    expect(await screen.findByLabelText('Computing voice evidence')).toBeInTheDocument()
    expect(screen.queryByLabelText('Measuring a recording now')).not.toBeInTheDocument()
    expect(screen.getByText(/12 without their audio on this computer/)).toBeInTheDocument()
  })

  it('saves a new window time', async () => {
    render(<VoiceBackfillPanel />)
    await screen.findByText(/recordings have voice evidence/)
    fireEvent.change(screen.getByLabelText('Ends at'), { target: { value: '06:30' } })
    expect(updateConfig).toHaveBeenCalledWith('transcription', {
      voiceBackfill: { schedule: 'night', windowStart: '01:00', windowEnd: '06:30' }
    })
  })

  it('measures one recording, spinning while it runs, then shows the time and the estimate', async () => {
    let finish: (value: unknown) => void = () => {}
    measureOne.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    render(<VoiceBackfillPanel />)
    await screen.findByText(/recordings have voice evidence/)

    const button = screen.getByRole('button', { name: 'Measure one recording' })
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('title', 'Measuring')
    expect(button).toBeDisabled()

    getStatus.mockResolvedValue(status({ remaining: 1956 }))
    await act(async () => {
      finish({ success: true, data: { recordingId: 'r', seconds: 90, audioSeconds: 1200, device: 'cpu' } })
    })

    // 90 s for 20 min of audio; 48,000 s left x 0.075 = 3,600 s.
    expect(screen.getByText('20 min of audio took 1 min 30 s on cpu. The rest would take about 1 h.')).toBeInTheDocument()
    expect(button).not.toHaveAttribute('aria-busy')
    expect(await screen.findByText(/1,956 to go/)).toBeInTheDocument()
  })

  it('shows the last measurement it was given by the status', async () => {
    getStatus.mockResolvedValue(
      status({ lastMeasure: { recordingId: 'r', seconds: 30, audioSeconds: 600, device: 'cuda' } })
    )
    render(<VoiceBackfillPanel />)
    expect(await screen.findByText('10 min of audio took 30 s on cuda. The rest would take about 40 min.')).toBeInTheDocument()
  })

  it('says why a measurement failed', async () => {
    measureOne.mockResolvedValue({ success: false, error: { code: 'INTERNAL_ERROR', message: 'No recording is waiting for voice evidence.' } })
    render(<VoiceBackfillPanel />)
    await screen.findByText(/recordings have voice evidence/)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Measure one recording' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('No recording is waiting for voice evidence.')
  })

  it('refreshes the progress when a recording finishes', async () => {
    render(<VoiceBackfillPanel />)
    await screen.findByText('181 of 2,144 recordings have voice evidence.')
    getStatus.mockResolvedValue(status({ done: 182, remaining: 1956 }))
    await act(async () => {
      domainListener?.({ type: 'voice-backfill:progress' })
    })
    expect(await screen.findByText('182 of 2,144 recordings have voice evidence.')).toBeInTheDocument()
  })
})
