/**
 * Tests for the integrated titlebar chrome (Wave: unified bar):
 *  - the brand lockup lives IN the bar (moved out of the sidebar);
 *  - the right cluster exposes notifications / activity / device / user-menu;
 *  - Settings lives at the bottom of the sidebar, not in the titlebar;
 *  - the native window-controls gutter is reserved on the right.
 *
 * The sidebar-collapse handle no longer lives in the titlebar (it moved to the
 * sidebar's right edge); its behaviour is covered by Layout's own tests.
 *
 * Device-pill Restart-in-all-states is covered by TitleBar.test.tsx.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TitleBar } from '../TitleBar'
import { mediaFloorPx } from '../HeaderMedia'
import { useDeviceConnection } from '@/hooks/useDeviceConnection'

vi.mock('@/hooks/useDeviceConnection', () => ({
  useDeviceConnection: vi.fn(),
}))

const mockUseDeviceConnection = vi.mocked(useDeviceConnection)

function setDisconnected() {
  mockUseDeviceConnection.mockReturnValue({
    status: 'disconnected',
    isConnected: false,
    isConnecting: false,
    isDisconnected: true,
    isFailed: false,
    deviceModel: null,
    label: 'Connect device',
    failedHint: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as ReturnType<typeof useDeviceConnection>)
}

function renderBar(props: Partial<React.ComponentProps<typeof TitleBar>> = {}) {
  return render(
    <MemoryRouter>
      <TitleBar sidebarOpen {...props} />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setDisconnected()
})

describe('Integrated titlebar — brand cell', () => {
  it('renders the two-line brand lockup inside the bar', () => {
    renderBar()
    expect(screen.getByTestId('app-brand')).toBeInTheDocument()
    expect(screen.getByText('ext')).toBeInTheDocument()
    expect(screen.queryByText('HiDock')).not.toBeInTheDocument()
  })
})

describe('Integrated titlebar — right cluster', () => {
  it('exposes notifications, activity, device and user-menu controls, with Settings in the sidebar', () => {
    renderBar()
    expect(screen.getByRole('button', { name: /notifications/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /activity log/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^settings$/i })).not.toBeInTheDocument()
    // Device status pill (disconnected → "Connect device") + its options caret.
    expect(screen.getByRole('button', { name: /connect device/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /device options/i })).toBeInTheDocument()
    // Avatar → app menu.
    expect(screen.getByRole('button', { name: /app menu/i })).toBeInTheDocument()
  })

  it('opens the app menu with Appearance (theme) + Developer (QA logs) controls', async () => {
    renderBar()
    fireEvent.keyDown(screen.getByRole('button', { name: /app menu/i }), { key: 'Enter' })
    expect(await screen.findByRole('menuitemradio', { name: /light/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /dark/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /system/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: /qa logs/i })).toBeInTheDocument()
  })
})

describe('Integrated titlebar — ⌘K search shortcut', () => {
  it('focuses the search input on Cmd/Ctrl+K', () => {
    renderBar()
    const searchbox = screen.getByRole('searchbox')
    expect(searchbox).not.toHaveFocus()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(searchbox).toHaveFocus()
  })

  it('does NOT hijack ⌘K while another text field is focused', () => {
    render(
      <MemoryRouter>
        <input data-testid="other" />
        <TitleBar sidebarOpen />
      </MemoryRouter>
    )
    const other = screen.getByTestId('other') as HTMLInputElement
    other.focus()
    expect(other).toHaveFocus()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    // Focus stays put; the titlebar search is not stolen.
    expect(other).toHaveFocus()
    expect(screen.getByRole('searchbox')).not.toHaveFocus()
  })

  it('renders a subtle keyboard hint on the search input', () => {
    renderBar()
    // ⌘K on mac, "Ctrl K" elsewhere — either way a <kbd> hint is present.
    expect(screen.getByText(/⌘K|Ctrl K/)).toBeInTheDocument()
  })

  it('keeps the search form from collapsing below its measured minimum width', () => {
    renderBar()
    const form = screen.getByRole('searchbox').closest('form')
    expect(form).toHaveClass('flex-1', 'min-w-[160px]')
    expect(form).not.toHaveClass('min-w-0')
  })
})

describe('Integrated titlebar — search left, media right', () => {
  it('puts the search first after the brand and the media area before the right cluster', () => {
    renderBar()
    const search = screen.getByRole('searchbox').closest('form')!
    const media = screen.getByRole('region', { name: 'Media' })
    const newMenu = screen.getByRole('button', { name: 'New' })
    const notifications = screen.getByRole('button', { name: /notifications/i })
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(search, newMenu)).toBe(true)
    expect(follows(newMenu, media)).toBe(true)
    expect(follows(media, notifications)).toBe(true)
    // Left-aligned: the search no longer centres itself.
    expect(search).not.toHaveClass('mx-auto')
    // The media cell is a size container whose floor is what must always fit;
    // the search keeps its own floor.
    const cell = screen.getByTestId('header-media-cell')
    expect(cell).toHaveClass('@container', 'flex-1')
    expect(cell.style.minWidth).toBe(`${mediaFloorPx(false, false, false)}px`)
    // Idle: the media area offers Record and nothing else.
    expect(within(media).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Record'])
  })
})

describe('Integrated titlebar — brand is a home affordance', () => {
  it('navigates home when the brand lockup is clicked', () => {
    renderBar()
    const home = screen.getByRole('button', { name: /go to home/i })
    expect(home).toHaveClass('titlebar-no-drag')
  })
})

describe('Integrated titlebar — native window controls gutter', () => {
  it('reserves the native-controls width on the right (where Electron draws — ▢ ✕)', () => {
    const { container } = renderBar()
    const header = container.querySelector('header')
    expect(header).not.toBeNull()
    // On Windows/Linux the overlay is ~138px; the bar reserves it so nothing hides.
    expect((header as HTMLElement).style.paddingRight).toBe('138px')
  })
})
