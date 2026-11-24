import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteDiarizationSettings } from '../RemoteDiarizationSettings'
import { useConfigStore } from '@/store/domain/useConfigStore'

const status = vi.fn()
const update = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  status.mockReset(); update.mockClear()
  window.electronAPI = { modelHost: { status } } as never
  useConfigStore.setState({ config: { transcription: { speakerEngine: 'model-host', modelHostUrl: 'https://host' } } as never, updateConfig: update })
})
describe('remote diarizer readiness gating (mock host)', () => {
  it('does not enable native segmentation when absent from advertised readiness', async () => {
    status.mockResolvedValue({ success: true, status: { health: { diarizationModels: ['pyannote/speaker-diarization-3.1'] } } })
    render(<RemoteDiarizationSettings />)
    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled())
    expect(screen.getByRole('option', { name: /Nemotron/ })).toBeDisabled()
  })
  it('saves an explicitly selected native model only when advertised', async () => {
    status.mockResolvedValue({ success: true, status: { health: { diarizationModels: ['nvidia/Nemotron-3-Diarization'] } } })
    render(<RemoteDiarizationSettings />)
    await waitFor(() => expect(screen.getByRole('option', { name: /Nemotron/ })).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('Remote diarization model'), { target: { value: 'nvidia/Nemotron-3-Diarization' } })
    await waitFor(() => expect(update).toHaveBeenCalledWith('transcription', { remoteDiarizationModel: 'nvidia/Nemotron-3-Diarization' }))
  })
})
