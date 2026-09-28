import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QualitySettings } from '../QualitySettings'
import { QUALITY_GROUPS, QUALITY_SETTINGS } from '../quality-settings'
import { SETTINGS_SECTIONS, searchSettingsSections } from '../sections'
import { useConfigStore } from '@/store/domain/useConfigStore'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))

const updateConfig = vi.fn().mockResolvedValue(undefined)
const quality = {
  quietSoundShare: 0.05,
  quietMinDurationSeconds: 60,
  meaningfulWords: 100,
  meaningfulStars: 3,
  maxWordsPerMinuteOfRecording: 250,
  busySoundSeconds: 300,
  minWordsPerMinuteOfSound: 20,
  inventedProbability: 0.8,
  reasonProbability: 0.5,
  lowValueMaxSeconds: 30,
  maxRetries: 3,
  retranscribeScore: 60,
  meetingAutoLinkProbability: 0.7,
  meetingAutoLinkMargin: 0.25,
  liveSilenceRms: 58
}

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState({ config: { quality: { ...quality, maxRetries: 5 } } as never, updateConfig })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    config: { getDefaults: vi.fn(async () => ({ success: true, data: { quality } })) }
  }
})

describe('Settings > Quality checks', () => {
  it('shows every quality key once, under its group, with the default from the main process', async () => {
    render(<QualitySettings />)
    const page = screen.getByTestId('settings-quality')
    expect(within(page).getByText('Quality checks')).toBeInTheDocument()
    expect(await screen.findAllByText(/^Default:/)).toHaveLength(QUALITY_SETTINGS.length)
    expect(new Set(QUALITY_SETTINGS.map((s) => s.key))).toEqual(new Set(Object.keys(quality)))
    for (const group of QUALITY_GROUPS) expect(screen.getByText(group)).toBeInTheDocument()
    for (const s of QUALITY_SETTINGS) expect(QUALITY_GROUPS).toContain(s.group)
  })

  it('offers Reset only where the value differs, and saves the default to the quality section', async () => {
    render(<QualitySettings />)
    const reset = await screen.findByRole('button', { name: 'Reset Transcription retries to its default' })
    expect(screen.queryByRole('button', { name: 'Reset Meeting link margin to its default' })).toBeNull()
    fireEvent.click(reset)
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('quality', { maxRetries: 3 }))
  })

  it('refuses a value out of range', async () => {
    render(<QualitySettings />)
    const field = await screen.findByLabelText('Invented transcript probability')
    fireEvent.change(field, { target: { value: '1.5' } })
    fireEvent.blur(field)
    expect(await screen.findByText('At most 1')).toBeInTheDocument()
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('is a page in the System group, after Maintenance, found by search', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id)
    expect(ids.indexOf('quality')).toBe(ids.indexOf('maintenance') + 1)
    expect(SETTINGS_SECTIONS.find((s) => s.id === 'quality')?.group).toBe('system')
    expect(searchSettingsSections('retries').map((s) => s.id)).toEqual(['quality'])
  })
})
