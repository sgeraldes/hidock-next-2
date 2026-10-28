import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SummaryRetrySettings } from '../SummaryRetrySettings'
import { useConfigStore } from '@/store/domain/useConfigStore'

const update = vi.fn(async (_section: string, values: Record<string, unknown>) => {
  const transcription = useConfigStore.getState().config?.transcription ?? {}
  useConfigStore.setState({ config: { transcription: { ...transcription, ...values } } as never })
})

function setTranscription(transcription: Record<string, unknown>) {
  useConfigStore.setState({ config: { transcription } as never, updateConfig: update })
}

beforeEach(() => {
  update.mockClear()
  setTranscription({ provider: 'gemini' })
})

describe('Settings: when every summary provider fails (28-oct-2026)', () => {
  it('shows the values in use, the earlier ones when nothing is saved', () => {
    render(<SummaryRetrySettings />)
    expect(screen.getByLabelText('Retry failed summaries automatically')).toBeChecked()
    expect(screen.getByLabelText('Wait before trying again')).toHaveValue(120)
    expect(screen.getByLabelText('Summaries per try')).toHaveValue(3)
    expect(screen.getByLabelText('Stop after this many failures a week')).toHaveValue(4)
  })

  it('saves a new wait, bounded, and the switch', async () => {
    render(<SummaryRetrySettings />)
    const wait = screen.getByLabelText('Wait before trying again')
    fireEvent.change(wait, { target: { value: '5' } })
    fireEvent.blur(wait)
    await waitFor(() => expect(update).toHaveBeenCalledWith('transcription', {
      summaryRetry: { auto: true, everyMinutes: 15, perPass: 3, maxPerWeek: 4 },
    }))

    fireEvent.click(screen.getByLabelText('Retry failed summaries automatically'))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('transcription', {
      summaryRetry: { auto: false, everyMinutes: 15, perPass: 3, maxPerWeek: 4 },
    }))
    expect(screen.getByLabelText('Wait before trying again')).toBeDisabled()
  })
})
