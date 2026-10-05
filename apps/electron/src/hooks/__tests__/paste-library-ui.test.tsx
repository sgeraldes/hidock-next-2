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
