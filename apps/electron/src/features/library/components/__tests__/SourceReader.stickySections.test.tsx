/**
 * The reader is one scrolling column whose section strips stick to the top.
 *
 * What these cases are really defending is the two-layer split:
 * `readerSectionModes` is what the user chose and is the only thing persisted;
 * scrolling produces a presentation on top of it and must never write to it.
 * A previous version of this reader pinned by scroll, jumped around, and the
 * answer at the time was to forbid scroll-driven layout outright. The rule came
 * back on 2026-09-22 with the separation that makes it safe, so the tests that
 * matter most here are the ones that scroll a section and then check the store
 * did NOT move.
 *
 * Spec: docs/superpowers/specs/2026-09-22-reader-sticky-sections-design.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SourceReader } from '../SourceReader'
import { useLibraryStore } from '@/store/useLibraryStore'
import { useUIStore } from '@/store/useUIStore'
import {
  pinnedStackBudget,
  PINNED_STRIP_H,
  MAX_PINNED_FRACTION,
  SENTINEL_H
} from '../../hooks/useStickySectionPins'
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
vi.mock('../WaveformPlayer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../WaveformPlayer')>()
  return {
    ...actual,
    WaveformPlayer: (props: any) => <div data-testid={`waveform-player-${props.mode}`} />,
  }
})
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
}))

// ---------------------------------------------------------------------------
// An IntersectionObserver double. jsdom has none, and the real one needs real
// layout, so the crossings are driven by hand: `cross(el, ratio)` delivers one
// entry the way the browser would.
// ---------------------------------------------------------------------------
interface Watch {
  cb: IntersectionObserverCallback
  observer: IntersectionObserver
  targets: Set<Element>
  rootMargin: string
}
let watches: Watch[] = []

class FakeIntersectionObserver {
  private watch: Watch
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.watch = {
      cb,
      observer: this as unknown as IntersectionObserver,
      targets: new Set(),
      rootMargin: String(options?.rootMargin ?? '')
    }
    watches.push(this.watch)
  }
  observe(el: Element) { this.watch.targets.add(el) }
  unobserve(el: Element) { this.watch.targets.delete(el) }
  disconnect() {
    this.watch.targets.clear()
    watches = watches.filter((w) => w !== this.watch)
  }
  takeRecords() { return [] }
}

/** Deliver one crossing for `el`: ratio 1 = fully in view, 0 = fully past. */
function cross(el: Element, ratio: number) {
  act(() => {
    for (const w of watches) {
      if (!w.targets.has(el)) continue
      w.cb(
        [{
          target: el,
          isIntersecting: ratio > 0,
          intersectionRatio: ratio,
          boundingClientRect: {} as DOMRectReadOnly,
          intersectionRect: {} as DOMRectReadOnly,
          rootBounds: null,
          time: 0
        } as IntersectionObserverEntry],
        w.observer
      )
    }
  })
}

const sentinel = (section: string) => screen.getByTestId(`reader-sentinel-${section}`)
const strip = (section: string) => screen.getByTestId(`reader-${section}-controls`)

// ---------------------------------------------------------------------------

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
  action_items: JSON.stringify(['Exportar las tareas', 'Confirmar el presupuesto']),
  transcription_provider: 'gemini'
} as unknown as Transcript

function installElectronAPI() {
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
}

let rectSpy: ReturnType<typeof vi.spyOn> | null = null

/** Make every element report `height`, which is what drives the stack budget. */
function mockReaderHeight(height: number) {
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    height, width: 900, top: 0, left: 0, right: 900, bottom: height, x: 0, y: 0,
    toJSON: () => ({})
  } as DOMRect)
}

beforeEach(() => {
  vi.clearAllMocks()
  watches = []
  ;(globalThis as any).IntersectionObserver = FakeIntersectionObserver
  useUIStore.setState({ waveformLoadedForId: null, waveformLoadingId: null, playbackDuration: 0 })
  useLibraryStore.setState({
    readerSectionModes: {
      player: 'expanded', metadata: 'expanded', moments: 'expanded',
      summary: 'expanded', transcript: 'expanded'
    },
    readerMaximizedSection: null,
    listCollapsed: false
  })
  ;(window as any).__audioControls = { loadWaveformOnly: vi.fn() }
  installElectronAPI()
  mockReaderHeight(900)
})

afterEach(() => {
  rectSpy?.mockRestore()
  rectSpy = null
})

// ---------------------------------------------------------------------------
// 1. One column
// ---------------------------------------------------------------------------
describe('SourceReader — one scrolling column', () => {
  it('has a single scroll container and no vertical resize handle', () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    expect(screen.getAllByTestId('reader-scroll-body')).toHaveLength(1)
    expect(screen.queryByTestId('reader-vertical-resize-handle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('reader-compact-header')).not.toBeInTheDocument()
  })

  it('gives every section a sentinel that adds no height and is one hysteresis band tall', () => {
    // jsdom has no layout, so no test here can prove the 12px band actually
    // debounces a real scroll. What it CAN hold is the contract the band depends
    // on: the sentinel is exactly SENTINEL_H tall and cancels that height again,
    // so it costs the section nothing. Both are load-bearing — a sentinel that
    // kept its height would push every section down, and a zero-height one
    // removes the hysteresis entirely.
    //
    // It cancels with a negative margin rather than `absolute` because the
    // wrapper it used to position against no longer generates a box.
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    for (const section of ['player', 'metadata', 'moments']) {
      const el = sentinel(section)
      expect(el).toHaveStyle({ height: `${SENTINEL_H}px`, marginBottom: `${-SENTINEL_H}px` })
      expect(el.className).toContain('pointer-events-none')
      expect(el.className).not.toContain('absolute')
      expect(el.className).not.toContain('hidden')
    }
  })

  it('leaves no box between a section header and the scrolling column', () => {
    // The whole feature rests on this. A sticky element cannot leave its
    // containing block, so a header inside a section box pins only while that
    // box is on screen and then scrolls away with it. Measured in the running
    // app on 2026-09-22, four of the five strips sat at -1138, -1106, -863 and
    // -716 pixels when the design called for 0, 32, 64 and 96 — every one of
    // them trapped in its own <section>, and summary and transcript in three
    // more wrappers on top of that.
    //
    // jsdom computes no layout, so this cannot watch them stack. What it can
    // hold is the structural precondition: every element between a header and
    // reader-scroll-body generates no box.
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const column = screen.getByTestId('reader-scroll-body')

    for (const section of ['player', 'metadata', 'moments', 'summary', 'transcript']) {
      const el = screen.queryByTestId(`reader-section-${section}`)
      if (!el) continue
      const header = el.querySelector('[class*="sticky"], [class*="relative"]')
      expect(header, `${section} has no header strip`).not.toBeNull()

      for (let node = header!.parentElement; node && node !== column; node = node.parentElement) {
        expect(
          node.className.toString().split(/\s+/),
          `${section}: ${node.tagName}.${node.className} would trap the sticky header`
        ).toContain('contents')
      }
    }
  })

  it('puts the transcript in the same column as the player', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const column = screen.getByTestId('reader-scroll-body')
    expect(column).toContainElement(await screen.findByTestId('reader-section-transcript'))
    expect(column).toContainElement(screen.getByTestId('reader-section-player'))
  })
})

// ---------------------------------------------------------------------------
// 2. The two layers
// ---------------------------------------------------------------------------
describe('SourceReader — scrolling never writes the chosen mode', () => {
  it('pins the player strip without touching readerSectionModes', () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    expect(strip('player')).toHaveAttribute('data-pinned', 'false')

    cross(sentinel('player'), 0) // scrolled fully past the section's top edge

    expect(strip('player')).toHaveAttribute('data-pinned', 'true')
    expect(useLibraryStore.getState().readerSectionModes.player).toBe('expanded')
  })

  it('leaves a minimized section minimized after scrolling down and back up', () => {
    useLibraryStore.setState({
      readerSectionModes: {
        player: 'compact', metadata: 'expanded', moments: 'expanded',
        summary: 'expanded', transcript: 'expanded'
      }
    })
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)

    cross(sentinel('player'), 0)
    expect(useLibraryStore.getState().readerSectionModes.player).toBe('compact')

    cross(sentinel('player'), 1)
    expect(strip('player')).toHaveAttribute('data-pinned', 'false')
    expect(useLibraryStore.getState().readerSectionModes.player).toBe('compact')
  })

  it('never brings a hidden section back by scrolling', () => {
    useLibraryStore.setState({
      readerSectionModes: {
        player: 'expanded', metadata: 'hidden', moments: 'expanded',
        summary: 'expanded', transcript: 'expanded'
      }
    })
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    expect(screen.queryByTestId('reader-section-metadata')).not.toBeInTheDocument()

    cross(sentinel('player'), 0)
    cross(sentinel('player'), 1)

    expect(screen.queryByTestId('reader-section-metadata')).not.toBeInTheDocument()
    expect(useLibraryStore.getState().readerSectionModes.metadata).toBe('hidden')
  })

  it('reads a docked section as pinned whatever the scroll position is', () => {
    useLibraryStore.setState({
      readerSectionModes: {
        player: 'docked', metadata: 'expanded', moments: 'expanded',
        summary: 'expanded', transcript: 'expanded'
      }
    })
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    expect(strip('player')).toHaveAttribute('data-pinned', 'true')
    cross(sentinel('player'), 1)
    expect(strip('player')).toHaveAttribute('data-pinned', 'true')
  })

  it('observes a section that only mounts once the transcript arrives', async () => {
    // Summary and transcript are absent from the first render of a recording
    // whose transcript has not loaded. They register their sentinel AFTER the
    // observer effect has run, and were left unobserved for the life of the
    // reader — they simply never pinned, silently.
    const { rerender } = render(<SourceReader recording={makeRecording()} />)
    expect(screen.queryByTestId('reader-sentinel-transcript')).not.toBeInTheDocument()

    rerender(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const late = await screen.findByTestId('reader-sentinel-transcript')

    cross(late, 0)
    expect(strip('transcript')).toHaveAttribute('data-pinned', 'true')
    expect(useLibraryStore.getState().readerSectionModes.transcript).toBe('expanded')
  })
})

// ---------------------------------------------------------------------------
// 3. Hysteresis
// ---------------------------------------------------------------------------
describe('SourceReader — hysteresis', () => {
  it('holds the current state while the sentinel is only partly across', () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)

    cross(sentinel('player'), 0.5)
    expect(strip('player')).toHaveAttribute('data-pinned', 'false')

    cross(sentinel('player'), 0)
    expect(strip('player')).toHaveAttribute('data-pinned', 'true')

    // Back INTO the band, but not all the way out: still pinned.
    cross(sentinel('player'), 0.5)
    expect(strip('player')).toHaveAttribute('data-pinned', 'true')
  })
})

// ---------------------------------------------------------------------------
// 4. The stack budget
// ---------------------------------------------------------------------------
describe('pinnedStackBudget', () => {
  it('caps the stack at 30% of the reader height', () => {
    expect(pinnedStackBudget(900)).toBe(5)   // 900 * 0.3 / 32 = 8.4 → capped at 5
    expect(pinnedStackBudget(534)).toBe(5)   // the height where all five just fit
    expect(pinnedStackBudget(400)).toBe(3)   // 400 * 0.3 / 32 = 3.75
    expect(pinnedStackBudget(200)).toBe(1)   // floor is 1, never 0
    expect(pinnedStackBudget(0)).toBe(1)
  })

  it('keeps the strip height and the fraction in agreement with the maths', () => {
    expect(PINNED_STRIP_H).toBe(32)
    expect(MAX_PINNED_FRACTION).toBe(0.3)
    expect(Math.ceil((5 * PINNED_STRIP_H) / MAX_PINNED_FRACTION)).toBe(534)
  })
})

describe('SourceReader — stacking within the budget', () => {
  it('stacks the strips at 32px steps and lets the ones past the cap scroll away', async () => {
    mockReaderHeight(400) // budget of 3
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    await screen.findByTestId('reader-section-transcript')

    // player / metadata / moments participate; summary and transcript do not.
    expect(strip('player').parentElement).toHaveStyle({ top: '0px' })
    expect(strip('metadata').parentElement).toHaveStyle({ top: '32px' })
    expect(strip('moments').parentElement).toHaveStyle({ top: '64px' })
    expect(strip('summary').parentElement?.className).toContain('relative')
    expect(strip('summary').parentElement?.className).not.toContain('sticky')
  })

  it('gives a hidden section\'s slot to the section after it', async () => {
    mockReaderHeight(900)
    useLibraryStore.setState({
      readerSectionModes: {
        player: 'hidden', metadata: 'expanded', moments: 'expanded',
        summary: 'expanded', transcript: 'expanded'
      }
    })
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    await screen.findByTestId('reader-section-transcript')

    expect(strip('metadata').parentElement).toHaveStyle({ top: '0px' })
    expect(strip('moments').parentElement).toHaveStyle({ top: '32px' })
  })
})

// ---------------------------------------------------------------------------
// 5. Actions & decisions as its own section
// ---------------------------------------------------------------------------
describe('SourceReader — Actions & decisions section', () => {
  it('renders the list outside the player, with its own layout controls', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const section = await screen.findByTestId('reader-section-moments')
    expect(section).toContainElement(await screen.findByTestId('timeline-events'))
    expect(screen.getByTestId('reader-section-player')).not.toContainElement(
      screen.getByTestId('timeline-events')
    )
    expect(screen.getByRole('button', { name: 'Layout options for Actions & decisions' }))
      .toBeInTheDocument()
  })

  it('keeps the list when the player is minimized', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    await screen.findByTestId('timeline-events')

    fireEvent.click(screen.getByRole('button', { name: 'Player' }))

    expect(useLibraryStore.getState().readerSectionModes.player).toBe('compact')
    expect(screen.getByTestId('timeline-events')).toBeInTheDocument()
  })

  it('highlights the activated row, which is what the graph reads too', async () => {
    render(<SourceReader recording={makeRecording()} transcript={TRANSCRIPT} />)
    const list = await screen.findByTestId('timeline-events')
    const rows = list.querySelectorAll('li')
    expect(rows.length).toBeGreaterThan(0)

    const seekChip = rows[0].querySelector('button[title^="Seek to"]') as HTMLButtonElement
    fireEvent.click(seekChip)

    expect(seekChip).toHaveAttribute('aria-pressed', 'true')
  })
})
