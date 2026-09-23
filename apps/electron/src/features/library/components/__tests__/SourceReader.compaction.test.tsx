/**
 * Second step of the reader redesign: the section chrome gets smaller.
 *
 * Asked for on 2026-09-22: no "Player" title above the player, no "Minimized"
 * label, an icon-only Layout button on the player's own row next to the 1x
 * speed selector, and next to it icons to minimize or expand, maximize and
 * hide. The other sections keep their label and get the same icon row. A
 * minimized "Actions & decisions" is its 32px strip and nothing else.
 *
 * The WaveformPlayer is NOT mocked here, unlike the other SourceReader suites:
 * "next to the speed selector" is only testable against the real player row.
 *
 * Spec: docs/superpowers/specs/2026-09-22-reader-sticky-sections-design.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import { useLibraryStore, type ReaderSectionModes } from '@/store/useLibraryStore'
import { useUIStore } from '@/store/useUIStore'
import { SENTINEL_H } from '../../hooks/useStickySectionPins'
import type { Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'

vi.mock('@radix-ui/react-portal', () => ({
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/toaster', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('@/components/RecordingLinkDialog', () => ({ RecordingLinkDialog: () => null }))
vi.mock('@/components/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('../TranscriptViewer', () => ({ TranscriptViewer: () => <div data-testid="transcript-viewer" /> }))
// Radix Select cannot open in jsdom. The trigger stays a real, labeled button,
// which is all "next to the speed selector" needs.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: any) => <button type="button" {...props}>{children}</button>,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}))

function makeRecording(overrides: Partial<UnifiedRecording> = {}): UnifiedRecording {
  return {
    id: 'rec-1',
    filename: 'meeting.wav',
    size: 1024 * 1024,
    duration: 125,
    dateRecorded: new Date('2026-09-20T10:00:00Z'),
    transcriptionStatus: 'complete',
    location: 'local-only',
    localPath: '/recordings/meeting.wav',
    syncStatus: 'synced',
    knowledgeCaptureId: 'kc-1',
    ...overrides
  } as UnifiedRecording
}

const TRANSCRIPT = {
  id: 'trans_rec-1',
  recording_id: 'rec-1',
  full_text: 'Hablamos del plan y acordamos empezar el lunes.',
  summary: 'Resumen del plan.',
  action_items: JSON.stringify(['Exportar las tareas']),
  transcription_provider: 'gemini'
} as unknown as Transcript

const ALL_EXPANDED: ReaderSectionModes = {
  player: 'expanded', metadata: 'expanded', moments: 'expanded', summary: 'expanded', transcript: 'expanded'
}

function setModes(overrides: Partial<ReaderSectionModes>) {
  useLibraryStore.setState({ readerSectionModes: { ...ALL_EXPANDED, ...overrides } })
}

let rectSpy: ReturnType<typeof vi.spyOn> | null = null

beforeEach(() => {
  vi.clearAllMocks()
  // Pinning is covered in the sticky-sections suite; here it only has to exist.
  ;(globalThis as any).IntersectionObserver = class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
    takeRecords = () => []
  }
  useUIStore.setState({
    isPlaying: false,
    currentlyPlayingId: null,
    playbackCurrentTime: 0,
    playbackDuration: 0,
    playbackWaveformData: null,
    waveformLoadedForId: null,
    waveformLoadingId: null,
    waveformLoadingError: null,
    waveformErrorForId: null
  })
  useLibraryStore.setState({ readerSectionModes: ALL_EXPANDED, readerMaximizedSection: null, listCollapsed: false })
  ;(window as any).__audioControls = {
    loadWaveformOnly: vi.fn(), play: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    stop: vi.fn(), seek: vi.fn(), setPlaybackRate: vi.fn()
  }
  Object.defineProperty(window, 'electronAPI', {
    value: {
      recordings: {
        reprocessWith: vi.fn().mockResolvedValue({ success: true }),
        reDiarize: vi.fn().mockResolvedValue({ success: true })
      },
      projects: {
        getForKnowledge: vi.fn().mockResolvedValue({ success: true, data: [] }),
        getAll: vi.fn().mockResolvedValue({ success: true, data: { projects: [], total: 0 } })
      }
    },
    writable: true,
    configurable: true
  })
  // A wide reader, so a minimized player is the pill rather than the scrubber.
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    height: 900, width: 900, top: 0, left: 0, right: 900, bottom: 900, x: 0, y: 0, toJSON: () => ({})
  } as DOMRect)
})

afterEach(() => {
  rectSpy?.mockRestore()
  rectSpy = null
})

/** Everything a keyboard user can reach, in DOM (tab) order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, [role="slider"], [role="combobox"], a[href], input'))
}

// ---------------------------------------------------------------------------
// 1. No "Player" title
// ---------------------------------------------------------------------------
describe('reader compaction — the player has no title', () => {
  it('shows no "Player" label anywhere in the player section', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const section = await screen.findByTestId('reader-section-player')
    // No word boundaries: textContent runs labels together ("PlayerMinimized").
    expect(section.textContent ?? '').not.toMatch(/Player/)
    expect(within(section).queryByText('Player')).not.toBeInTheDocument()
    // And no strip: the player's first rendered box is the player itself.
    expect(section.querySelector('[data-reader-pin]')).toBeNull()
  })

  it('stays untitled when minimized', async () => {
    setModes({ player: 'compact' })
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const section = await screen.findByTestId('reader-section-player')
    expect(section.textContent ?? '').not.toMatch(/Player/)
  })
})

// ---------------------------------------------------------------------------
// 2. No "Minimized" pill
// ---------------------------------------------------------------------------
describe('reader compaction — no mode pill', () => {
  it('shows no "Minimized" or "Docked" label with every section minimized or docked', async () => {
    setModes({ player: 'compact', metadata: 'compact', moments: 'compact', summary: 'docked', transcript: 'compact' })
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    await screen.findByTestId('reader-section-transcript')
    const column = screen.getByTestId('reader-scroll-body')
    expect(column.textContent ?? '').not.toMatch(/Minimized|Docked/)
    expect(screen.queryByText('Minimized')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 3. Layout: icon-only, on the player's own row, next to the 1x selector
// ---------------------------------------------------------------------------
describe('reader compaction — the player Layout control', () => {
  for (const mode of ['expanded', 'compact'] as const) {
    it(`is an icon with no text, immediately after the speed selector (${mode})`, async () => {
      setModes({ player: mode })
      render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
      const region = await screen.findByTestId('reader-player-region')
      const layout = within(region).getByRole('button', { name: 'Layout options for Player' })

      expect(layout.textContent?.trim()).toBe('')
      expect(layout.querySelector('svg')).not.toBeNull()

      // Immediately after the 1x selector in the player's row: nothing a user
      // can reach sits between the two.
      const reachable = focusables(region)
      const speed = within(region).getByRole('button', { name: 'Playback speed' })
      expect(reachable.indexOf(layout)).toBe(reachable.indexOf(speed) + 1)

      // Outside the player's own box, not in a header strip.
      const playerBox = screen.getByTestId(mode === 'expanded' ? 'waveform-player-full' : 'waveform-player-pill')
      expect(playerBox).not.toContainElement(layout)
      expect(layout.closest('[data-reader-pin]')).toBe(mode === 'compact' ? screen.getByTestId('reader-player-body') : null)
    })
  }

  it('has a tooltip that names it', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const layout = await screen.findByRole('button', { name: 'Layout options for Player' })
    fireEvent.focus(layout)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Layout options for Player')
  })

  it('still opens the full layout menu', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const layout = await screen.findByRole('button', { name: 'Layout options for Player' })
    fireEvent.pointerDown(layout, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByText('Dock small player'))
    expect(useLibraryStore.getState().readerSectionModes.player).toBe('docked')
  })
})

// ---------------------------------------------------------------------------
// 4. Section-mode icons next to Layout
// ---------------------------------------------------------------------------
describe('reader compaction — section-mode icons next to Layout', () => {
  it('sits right after Layout, each icon-only with a name', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const group = await screen.findByTestId('reader-player-controls')
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Layout options for Player', 'Minimize Player', 'Maximize Player', 'Hide Player'
    ])
    for (const b of buttons) expect(b.textContent?.trim()).toBe('')
  })

  it('minimizes and expands through the store', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Minimize Player' }))
    expect(useLibraryStore.getState().readerSectionModes.player).toBe('compact')
    expect(screen.getByTestId('waveform-player-pill')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand Player' }))
    expect(useLibraryStore.getState().readerSectionModes.player).toBe('expanded')
    expect(screen.getByTestId('waveform-player-full')).toBeInTheDocument()
  })

  it('maximizes, then returns to the reader, through the existing store actions', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Maximize Player' }))
    expect(useLibraryStore.getState().readerMaximizedSection).toBe('player')
    expect(screen.queryByTestId('reader-section-metadata')).not.toBeInTheDocument()

    const back = screen.getByRole('button', { name: 'Return Player to reader' })
    expect(back.textContent?.trim()).toBe('')
    fireEvent.click(back)
    expect(useLibraryStore.getState().readerMaximizedSection).toBeNull()
    expect(screen.getByTestId('reader-section-metadata')).toBeInTheDocument()
  })

  it('hides the player, which comes back from the hidden-sections bar', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide Player' }))
    expect(useLibraryStore.getState().readerSectionModes.player).toBe('hidden')
    expect(screen.queryByTestId('reader-section-player')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show Player' }))
    expect(useLibraryStore.getState().readerSectionModes.player).toBe('expanded')
  })

  it('names each icon in a tooltip', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    fireEvent.focus(await screen.findByRole('button', { name: 'Hide Player' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Hide Player')
  })
})

// ---------------------------------------------------------------------------
// 5. The other sections: label stays, controls go icon-only
// ---------------------------------------------------------------------------
describe('reader compaction — labeled sections', () => {
  const LABELED = [
    ['metadata', 'Metadata'],
    ['moments', 'Actions & decisions'],
    ['summary', 'Summary'],
    ['transcript', 'Full transcript']
  ] as const

  it('keeps the label in the strip and makes every control an icon', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    await screen.findByTestId('reader-section-transcript')

    for (const [section, label] of LABELED) {
      const strip = screen.getByTestId(`reader-${section}-controls`)
      // The strip reads as its label and nothing else: no "Layout" word, no pill.
      expect(strip.textContent, section).toBe(label)
      const actions = within(strip).getByTestId(`reader-${section}-actions`)
      expect(within(actions).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
        `Layout options for ${label}`, `Minimize ${label}`, `Maximize ${label}`, `Hide ${label}`
      ])
    }
  })

  it('offers Expand once a labeled section is minimized, with no pill', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Minimize Summary' }))
    expect(useLibraryStore.getState().readerSectionModes.summary).toBe('compact')
    expect(screen.getByTestId('reader-summary-controls').textContent).toBe('Summary')

    fireEvent.click(screen.getByRole('button', { name: 'Expand Summary' }))
    expect(useLibraryStore.getState().readerSectionModes.summary).toBe('expanded')
  })
})

// ---------------------------------------------------------------------------
// 6. A minimized Actions & decisions is its strip and nothing else
// ---------------------------------------------------------------------------
describe('reader compaction — minimized Actions & decisions', () => {
  it('renders only the zero-height sentinel and the 32px strip', async () => {
    setModes({ moments: 'compact' })
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const section = await screen.findByTestId('reader-section-moments')

    expect(section.className).toBe('contents')
    const children = Array.from(section.children) as HTMLElement[]
    expect(children).toHaveLength(2)

    const [sentinel, strip] = children
    expect(sentinel).toHaveStyle({ height: `${SENTINEL_H}px`, marginBottom: `${-SENTINEL_H}px` })

    // Exactly h-8, and nothing that could add height around it.
    const classes = strip.className.split(/\s+/)
    expect(classes).toContain('h-8')
    expect(classes.filter((c) => /^(p[tby]?|m[tby]?|min-h|space-y)-/.test(c))).toEqual([])
    expect(strip.textContent).toBe('Actions & decisions')
    expect(document.getElementById('reader-moments-content')).toBeNull()
    expect(screen.queryByTestId('timeline-events')).not.toBeInTheDocument()
  })
})
