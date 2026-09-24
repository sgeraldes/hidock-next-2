import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SpeakerSetupPanel, VOICE_OFF_WARNING } from '../SpeakerSetupPanel'
import { SpeakerSetupDialog } from '../SpeakerSetupDialog'
import type { SpeakerSetup } from '@/types/speakers'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const option = (engine: string, extra: Record<string, unknown> = {}) => ({
  engine,
  label: engine,
  description: `${engine} description`,
  where: 'this computer',
  available: true,
  recommended: false,
  idealForHardware: false,
  ...extra,
})

const SETUP = {
  hardware: { gpus: [], cpu: { model: 'Ryzen 9', logicalCores: 24 }, platform: 'win32' },
  fingerprint: 'amd:AMD Radeon RX 6600 XT',
  profile: 'gpu-directml',
  profileSummary: 'GPU without CUDA (AMD Radeon RX 6600 XT).',
  options: [
    option('onnx-local', { available: false, idealForHardware: true, unavailableReason: 'Not built yet.' }),
    option('pyannote-local', { recommended: true, measuredSpeedRatio: 1 / 3 }),
    option('off', { label: 'Turn voice recognition off' }),
  ],
  configuredEngine: 'auto',
  effectiveEngine: 'pyannote-local',
  needsConfirmation: true,
  lastConfirmedAt: null,
  voiceSpace: {
    model: 'pyannote/speaker-diarization-3.1',
    modelVersion: '4.0.7',
    clusters: 244,
    anchored: 6,
    otherModelClusters: 0,
    otherModelAnchored: 0,
  },
  detectionFailed: false,
} as unknown as SpeakerSetup

const getSetup = vi.fn()
const applySetup = vi.fn()
const dismissSetup = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  getSetup.mockResolvedValue({ success: true, data: SETUP })
  applySetup.mockImplementation(async (choice: { engine: string }) => ({
    success: true,
    data: { ...SETUP, needsConfirmation: false, configuredEngine: choice.engine },
  }))
  dismissSetup.mockResolvedValue({ success: true, data: null })
  global.window.electronAPI = { speakers: { getSetup, applySetup, dismissSetup } } as any
})

describe('SpeakerSetupPanel', () => {
  it('preselects the recommendation and shows the measured speed', async () => {
    render(<SpeakerSetupPanel initial={SETUP} />)
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    expect(screen.getByText('Best for this hardware')).toBeInTheDocument()
    expect(screen.getByText(/about 20 min per hour of audio/)).toBeInTheDocument()
    const radio = screen.getByDisplayValue('pyannote-local') as HTMLInputElement
    expect(radio.checked).toBe(true)
    expect((screen.getByDisplayValue('onnx-local') as HTMLInputElement).disabled).toBe(true)
  })

  it('saves the chosen engine', async () => {
    render(<SpeakerSetupPanel initial={SETUP} />)
    fireEvent.click(screen.getByRole('button', { name: 'Use this' }))
    await waitFor(() => expect(applySetup).toHaveBeenCalled())
    expect(applySetup.mock.calls[0][0]).toMatchObject({ engine: 'pyannote-local', fingerprint: SETUP.fingerprint })
  })

  it('shows the red warning and needs the checkbox before turning off', async () => {
    render(<SpeakerSetupPanel initial={SETUP} />)
    expect(screen.queryByTestId('voice-off-warning')).toBeNull()
    fireEvent.click(screen.getByDisplayValue('off'))
    expect(screen.getByRole('alert')).toHaveTextContent(VOICE_OFF_WARNING)
    const off = screen.getByRole('button', { name: 'Turn voice recognition off' })
    expect(off).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(off).toBeEnabled()
    fireEvent.click(off)
    await waitFor(() => expect(applySetup).toHaveBeenCalled())
    expect(applySetup.mock.calls[0][0]).toMatchObject({ engine: 'off', confirmOff: true })
  })

  it('keeps voice recognition off for an owner who had it off, instead of preselecting the recommendation', () => {
    render(<SpeakerSetupPanel initial={{ ...SETUP, effectiveEngine: 'off' } as SpeakerSetup} />)
    expect((screen.getByDisplayValue('off') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByDisplayValue('pyannote-local') as HTMLInputElement).checked).toBe(false)
  })

  it('says how many voices come from another model', () => {
    const voiceSpace = { ...SETUP.voiceSpace!, otherModelClusters: 12, otherModelAnchored: 2 }
    render(<SpeakerSetupPanel initial={{ ...SETUP, voiceSpace } as SpeakerSetup} />)
    expect(screen.getByText(/12 more voices \(2 linked to people\)/)).toBeInTheDocument()
  })

  it('clears the confirmation when the owner picks off again later', async () => {
    render(<SpeakerSetupPanel initial={SETUP} />)
    fireEvent.click(screen.getByDisplayValue('off'))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByDisplayValue('pyannote-local'))
    fireEvent.click(screen.getByDisplayValue('off'))
    expect(screen.getByRole('button', { name: 'Turn voice recognition off' })).toBeDisabled()
  })
})

describe('SpeakerSetupDialog', () => {
  it('opens when the hardware needs confirming', async () => {
    render(<SpeakerSetupDialog />)
    expect(await screen.findByText('Set up voice recognition')).toBeInTheDocument()
  })

  it('says the hardware changed when a setup was confirmed before', async () => {
    getSetup.mockResolvedValue({ success: true, data: { ...SETUP, lastConfirmedAt: '2026-09-01T00:00:00Z' } })
    render(<SpeakerSetupDialog />)
    expect(await screen.findByText('Your hardware changed')).toBeInTheDocument()
  })

  it('remembers "Decide later" for this hardware', async () => {
    render(<SpeakerSetupDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Decide later' }))
    await waitFor(() => expect(dismissSetup).toHaveBeenCalledOnce())
  })

  it('stays closed on an ordinary launch', async () => {
    getSetup.mockResolvedValue({ success: true, data: { ...SETUP, needsConfirmation: false } })
    render(<SpeakerSetupDialog />)
    await waitFor(() => expect(getSetup).toHaveBeenCalled())
    expect(screen.queryByTestId('speaker-setup-dialog')).toBeNull()
  })
})
