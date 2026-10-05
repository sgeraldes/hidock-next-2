import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/toaster'
import { ClipboardCapture } from '../useClipboardCapture'
import { NewMenu } from '@/components/layout/PcRecording'

vi.mock('@/store/ui/useUIStore', () => ({ useAutoCaptureScreenshots: () => false }))
const paste = vi.fn()
function Destination() {
  const location = useLocation()
  return <output data-testid="destination">{location.pathname}:{(location.state as { selectedId?: string } | null)?.selectedId}</output>
}
beforeEach(() => {
  vi.clearAllMocks()
  paste.mockResolvedValue([{ title: 'Pasted note', id: 'capture-fixture' }])
  window.electronAPI = {
    pasteLibrary: { paste }, clipboardCapture: { setAutoWatch: vi.fn().mockResolvedValue({ active: false }) }
  } as unknown as typeof window.electronAPI
})

it('renders the real success toast and Open navigates to its Library source', async () => {
  render(<MemoryRouter><ToastProvider><ClipboardCapture /><Destination /></ToastProvider></MemoryRouter>)
  fireEvent.paste(document.body, { clipboardData: { files: [], items: [], getData: () => 'Pasted note' } })
  expect(await screen.findByText('Added to Library: Pasted note')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  expect(screen.getByTestId('destination')).toHaveTextContent('/library:capture-fixture')
})

it('renders per-file successes and failures from the real New menu Paste action', async () => {
  paste.mockResolvedValue([{ title: 'Image.png', id: 'image' }, { title: 'Broken.mp4', error: 'No audio track' }])
  render(<MemoryRouter><ToastProvider><NewMenu /></ToastProvider></MemoryRouter>)
  fireEvent.pointerDown(screen.getByRole('button', { name: 'New' }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Paste' }))
  expect(await screen.findByText('Added to Library: Image.png')).toBeInTheDocument()
  expect(screen.getByText('Could not add Broken.mp4')).toBeInTheDocument()
  expect(screen.getByText('No audio track')).toBeInTheDocument()
})

it('opens pasted plain text in its note editor', async () => {
  paste.mockResolvedValue([{ title: 'My note', id: 'note-id', destination: 'note' }])
  render(<MemoryRouter><ToastProvider><ClipboardCapture /><Destination /></ToastProvider></MemoryRouter>)
  fireEvent.paste(document.body, { clipboardData: { files: [], items: [], getData: () => 'My note' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
  expect(screen.getByTestId('destination')).toHaveTextContent('/notes:')
})

it('explains a missing connector and opens connector settings', async () => {
  paste.mockResolvedValue([{ title: 'team · C123', id: 'link', connectorFallback: 'the Slack connector is not set up' }])
  render(<MemoryRouter><ToastProvider><ClipboardCapture /><Destination /></ToastProvider></MemoryRouter>)
  fireEvent.paste(document.body, { clipboardData: { files: [], items: [], getData: () => 'https://team.slack.com/archives/C123' } })
  expect(await screen.findByText('Saved as a link: the Slack connector is not set up')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Connector settings' }))
  expect(screen.getByTestId('destination')).toHaveTextContent('/settings/connectors:')
})

it('states that an unreadable PDF cannot be searched', async () => {
  paste.mockResolvedValue([{ title: 'broken.pdf', id: 'pdf', textUnreadable: true, warning: 'Search cannot find its contents.' }])
  render(<MemoryRouter><ToastProvider><ClipboardCapture /></ToastProvider></MemoryRouter>)
  fireEvent.paste(document.body, { clipboardData: { files: [], items: [], getData: () => 'fixture' } })
  expect(await screen.findByText('Added, but its text could not be read')).toBeInTheDocument()
  expect(screen.getByText('Search cannot find its contents.')).toBeInTheDocument()
})
