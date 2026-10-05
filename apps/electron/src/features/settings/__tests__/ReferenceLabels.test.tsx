import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useUIStore } from '@/store/useUIStore'
import { ReferenceLabels } from '../pipeline/ReferenceLabels'
import type { ReferenceLabelSet, RecordingKind } from '@/shared/decision-labels'

let answers: Record<string, RecordingKind | null>
const getLabelSet = vi.fn(async (): Promise<ReferenceLabelSet> => ({
  id: 'set', question: 'kind', createdAt: '2026-10-04',
  size: 3, unavailable: 0, counts: { doubtful: 1, random: 2 }, labeled: Object.values(answers).filter(Boolean).length,
  items: ['a', 'b', 'c'].map((recordingId, position) => ({ recordingId, position, answer: answers[recordingId] ?? null }))
}))
const getLabelItem = vi.fn(async ({ recordingId }: { recordingId: string }) => ({
  recordingId, date: '2026-10-04T12:00:00Z', durationSeconds: 120, filePath: `/audio/${recordingId}.wav` as string | null,
  meetingSubject: 'Planning', minutes: 2, excerpt: `Opening ${recordingId}`, answer: answers[recordingId] ?? null
}))
const saveLabel = vi.fn(async ({ recordingId, answer }: { recordingId: string; answer: RecordingKind }) => { answers[recordingId] = answer })
const clearLabel = vi.fn(async ({ recordingId }: { recordingId: string }) => { answers[recordingId] = null })
beforeEach(() => {
  vi.clearAllMocks()
  answers = {}
  useUIStore.setState({ currentlyPlayingId: null, isPlaying: false, playbackCurrentTime: 0, playbackDuration: 0 })
  window.__audioControls = {
    play: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), seek: vi.fn(),
    setPlaybackRate: vi.fn(), loadWaveformOnly: vi.fn()
  }
  window.electronAPI = { pipeline: { getLabelSet, getLabelItem, saveLabel, clearLabel } } as never
})
describe('Reference labels', () => {
  it('plays the original audio and shows a seek bar, time and 15-second jumps', async () => {
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    expect(screen.getByRole('slider', { name: 'Seek audio' })).toHaveValue('0')
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(screen.getByText('2:00')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(window.__audioControls!.play).toHaveBeenCalledWith('a', '/audio/a.wav')
    act(() => useUIStore.setState({ currentlyPlayingId: 'a', isPlaying: true, playbackCurrentTime: 30, playbackDuration: 120 }))
    fireEvent.click(screen.getByRole('button', { name: 'Back 15 seconds' }))
    expect(window.__audioControls!.seek).toHaveBeenLastCalledWith(15)
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' }))
    expect(window.__audioControls!.seek).toHaveBeenLastCalledWith(45)
    fireEvent.change(screen.getByRole('slider', { name: 'Seek audio' }), { target: { value: '60' } })
    expect(window.__audioControls!.seek).toHaveBeenLastCalledWith(60)
  })
  it.each(['Skip', 'Back', 'kind'])('stops audio when navigating with %s', async navigation => {
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    if (navigation === 'Back') {
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
      await screen.findByText('Opening b')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    const stop = vi.mocked(window.__audioControls!.stop)
    stop.mockClear()
    fireEvent.click(screen.getByRole('button', { name: navigation === 'kind' ? /Interview/ : navigation }))
    await screen.findByText(navigation === 'Back' ? 'Opening a' : 'Opening b')
    expect(stop).toHaveBeenCalled()
  })
  it('keeps labeling available when local audio is missing', async () => {
    getLabelItem.mockResolvedValueOnce({ recordingId: 'a', date: '2026-10-04', durationSeconds: 120,
      filePath: null, meetingSubject: null as never, minutes: 2, excerpt: 'Opening a', answer: null })
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    expect(screen.getByText('Audio is not available locally (on the device or missing).')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument()
    const kind = screen.getByRole('button', { name: /Interview/ })
    kind.focus()
    expect(fireEvent.keyDown(kind, { key: ' ', code: 'Space' })).toBe(false)
    expect(saveLabel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Interview/ }))
    await screen.findByText('Opening b')
  })
  it('does not expose audio for an unavailable label item and stops on leaving the screen', async () => {
    getLabelItem.mockResolvedValueOnce(null as never)
    const { unmount } = render(<ReferenceLabels />)
    await screen.findByText(/This recording is unavailable/)
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    const stop = vi.mocked(window.__audioControls!.stop)
    stop.mockClear()
    unmount()
    expect(stop).toHaveBeenCalledOnce()
  })
  it('space toggles audio instead of activating a focused kind or navigation button; numbers still label', async () => {
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    const kind = screen.getByRole('button', { name: /Interview/ })
    kind.focus()
    expect(fireEvent.keyDown(kind, { key: ' ', code: 'Space' })).toBe(false)
    expect(window.__audioControls!.play).toHaveBeenCalledWith('a', '/audio/a.wav')
    expect(saveLabel).not.toHaveBeenCalled()
    act(() => useUIStore.setState({ currentlyPlayingId: 'a', isPlaying: true }))
    const skip = screen.getByRole('button', { name: 'Skip' })
    skip.focus()
    expect(fireEvent.keyDown(skip, { key: ' ', code: 'Space' })).toBe(false)
    expect(window.__audioControls!.pause).toHaveBeenCalledOnce()
    expect(screen.getByText('Opening a')).toBeInTheDocument()
    fireEvent.keyDown(skip, { key: '2' })
    await screen.findByText('Opening b')
    expect(saveLabel).toHaveBeenCalledWith({ setId: 'set', recordingId: 'a', answer: 'team_meeting' })
  })
  it('shows original size and unavailable count with a scrollable excerpt', async () => {
    getLabelSet.mockResolvedValueOnce({ id: 'set', question: 'kind', createdAt: '2026-10-04', size: 40, unavailable: 39,
      counts: { doubtful: 20, random: 20 }, labeled: 0, items: [{ recordingId: 'a', position: 0, answer: null }] })
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    expect(screen.getByText('0 of 40 labeled')).toBeInTheDocument()
    expect(screen.getByText('39 no longer available')).toBeInTheDocument()
    expect(screen.getByLabelText('Transcript opening')).toHaveClass('overflow-y-auto')
  })
  it('picks, advances, counts, skips, goes back, changes and clears', async () => {
    render(<ReferenceLabels />)
    expect(await screen.findByText('Opening a')).toBeInTheDocument()
    expect(screen.getByText('0 of 3 labeled')).toBeInTheDocument()
    expect(screen.getByText(/Only 3 usable recordings/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Interview/ }))
    expect(await screen.findByText('Opening b')).toBeInTheDocument()
    expect(screen.getByText('1 of 3 labeled')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(await screen.findByText('Opening c')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Opening b')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Opening a')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Interview/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Team meeting/ }))
    await screen.findByText('Opening b')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByText('Opening a')
    expect(screen.getByRole('button', { name: /Team meeting/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Clear label' }))
    await waitFor(() => expect(screen.getByText('0 of 3 labeled')).toBeInTheDocument())
    expect(saveLabel).toHaveBeenCalledTimes(2)
  })
  it('number shortcuts pick a kind and ignore modified or repeated keys', async () => {
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    fireEvent.keyDown(window, { key: '2', ctrlKey: true })
    fireEvent.keyDown(window, { key: '2', repeat: true })
    expect(saveLabel).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '2' })
    await screen.findByText('Opening b')
    expect(saveLabel).toHaveBeenCalledWith({ setId: 'set', recordingId: 'a', answer: 'team_meeting' })
  })
  it('shows completion after the last item and permits going back', async () => {
    render(<ReferenceLabels />)
    for (const id of ['a', 'b', 'c']) {
      await screen.findByText(`Opening ${id}`)
      fireEvent.click(screen.getByRole('button', { name: /Interview/ }))
    }
    expect(await screen.findByText('3 of 3 labeled')).toBeInTheDocument()
    expect(screen.getByText('You have reached the end of this set.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Opening c')).toBeInTheDocument()
  })
  it('keeps the current item and progress when a save fails', async () => {
    saveLabel.mockRejectedValueOnce(new Error('Disk unavailable'))
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    fireEvent.click(screen.getByRole('button', { name: /Interview/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk unavailable')
    expect(screen.getByText('Opening a')).toBeInTheDocument()
    expect(screen.getByText('0 of 3 labeled')).toBeInTheDocument()
  })
  it('supports the tenth and eleventh shortcuts', async () => {
    render(<ReferenceLabels />)
    await screen.findByText('Opening a')
    fireEvent.keyDown(window, { key: '0' })
    await screen.findByText('Opening b')
    fireEvent.keyDown(window, { key: '!', code: 'Digit1', shiftKey: true })
    await screen.findByText('Opening c')
    expect(saveLabel).toHaveBeenNthCalledWith(1, { setId: 'set', recordingId: 'a', answer: 'device_test' })
    expect(saveLabel).toHaveBeenNthCalledWith(2, { setId: 'set', recordingId: 'b', answer: 'noise_accidental' })
  })
  it('resumes the first unlabeled item and lets an unavailable item be skipped', async () => {
    answers.a = 'interview'
    getLabelItem.mockResolvedValueOnce(null as never)
    render(<ReferenceLabels />)
    expect(await screen.findByText(/This recording is unavailable/)).toBeInTheDocument()
    expect(getLabelItem).toHaveBeenCalledWith({ setId: 'set', recordingId: 'b' })
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(await screen.findByText('Opening c')).toBeInTheDocument()
  })
  it('retries a failed initial load', async () => {
    getLabelSet.mockRejectedValueOnce(new Error('Database unavailable'))
    render(<ReferenceLabels />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry labels' }))
    expect(await screen.findByText('Opening a')).toBeInTheDocument()
  })
})
