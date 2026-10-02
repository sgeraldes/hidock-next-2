import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { AboutSection } from '../AboutSection'
import { OverviewSection } from '../OverviewSection'
import { StorageUsageLine } from '../StorageUsage'
import { StorageMoveConfirm } from '../StorageMoveConfirm'
import { ServiceList } from '../ServiceList'

// Loading and busy states are placeholders and spinners with the words in their
// name and tooltip, never text on screen (owner, 2-oct-2026).

beforeEach(() => {
  vi.clearAllMocks()
  global.window.electronAPI = {
    app: { info: vi.fn(() => new Promise(() => {})) },
    connectors: { list: vi.fn(() => new Promise(() => {})) },
    storage: {
      onMoveProgress: vi.fn(() => () => undefined),
      moveFolder: vi.fn(() => new Promise(() => {})),
      cancelMove: vi.fn()
    }
  } as never
})

describe('AboutSection while the values load', () => {
  it('shows a shimmering value per row instead of an ellipsis', () => {
    render(<AboutSection storageInfo={null} />)
    expect(screen.getByRole('status', { name: 'Reading the version' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Reading the data folder' })).toBeInTheDocument()
    expect(screen.queryByText('…')).not.toBeInTheDocument()
  })
})

describe('OverviewSection while the tiles load', () => {
  it('draws the connectors and storage values as shimmering values, not "…" or "Checking"', () => {
    render(<OverviewSection storageInfo={null} onNavigate={vi.fn()} />)
    expect(screen.getAllByRole('status', { name: 'Checking the connectors' })).toHaveLength(2)
    expect(screen.getAllByRole('status', { name: 'Measuring storage' })).toHaveLength(2)
    expect(screen.queryByText('…')).not.toBeInTheDocument()
    expect(screen.queryByText('Checking')).not.toBeInTheDocument()
  })
})

describe('StorageUsageLine while the folder is measured', () => {
  it('shows a placeholder line, never the old word', () => {
    render(<StorageUsageLine usage={undefined} onLimitSaved={vi.fn()} />)
    expect(screen.getByRole('status', { name: 'Measuring the folder' })).toBeInTheDocument()
    expect(screen.queryByText(/Measuring…/)).not.toBeInTheDocument()
  })
})

describe('StorageMoveConfirm while it moves', () => {
  it('keeps the move label, spins, and says Moving only in its tooltip', () => {
    const plan = {
      folder: 'recordings',
      from: 'C:/old',
      to: 'D:/new',
      files: 3,
      bytes: 3000,
      targetFreeBytes: null,
      blocker: null,
      canSwitchWithoutMoving: false,
      targetHasDatabase: false
    }
    render(<StorageMoveConfirm plan={plan as never} onDone={vi.fn()} onCancel={vi.fn()} />)
    const move = screen.getByRole('button', { name: /^Move 3 files/ })
    fireEvent.click(move)
    expect(move).toHaveAttribute('aria-busy', 'true')
    expect(move).toHaveAttribute('title', 'Moving')
    expect(move).toBeDisabled()
    expect(move).toHaveTextContent(/Move 3 files/)
    expect(screen.queryByText('Moving…')).not.toBeInTheDocument()
  })
})

describe('ServiceList busy rows', () => {
  it('draws a busy state as a spinner with the words in its label and tooltip', () => {
    render(
      <ServiceList
        label="Services"
        selected={null}
        onSelect={vi.fn()}
        items={[
          { id: 'a', label: 'Slack', status: 'Syncing', tone: 'busy', busy: true },
          { id: 'b', label: 'Mail', status: 'Connected', tone: 'ok' }
        ]}
      >
        <div />
      </ServiceList>
    )
    const listbox = screen.getByRole('listbox', { name: 'Services' })
    const busy = within(listbox).getByLabelText('Syncing')
    expect(busy).toHaveAttribute('title', 'Syncing')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(within(listbox).getByText('Slack')).toBeInTheDocument()
    expect(within(listbox).queryByText('Syncing')).not.toBeInTheDocument()
    expect(within(listbox).getByText('Connected')).toBeInTheDocument()
  })
})
