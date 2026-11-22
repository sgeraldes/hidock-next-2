import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { ClipboardCapture } from '../useClipboardCapture'
import { NewMenu } from '@/components/layout/PcRecording'
import { toast } from '@/components/ui/toaster'

vi.mock('@/components/ui/toaster', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }))
vi.mock('@/store/ui/useUIStore', () => ({ useAutoCaptureScreenshots: () => false }))
const paste = vi.fn()
const pickFiles = vi.fn()
const newNote = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  paste.mockResolvedValue([{ id: 'capture', title: 'My note' }])
  pickFiles.mockResolvedValue([])
  newNote.mockResolvedValue({ id: 'note', title: 'New note' })
  window.electronAPI = { pasteLibrary: { paste, pickFiles, newNote }, clipboardCapture: { setAutoWatch: vi.fn(), getPathForFile: vi.fn(() => '') } } as unknown as typeof window.electronAPI
})
it('pastes anywhere and provides the exact toast with an Open action', async () => {
  render(<MemoryRouter><ClipboardCapture /><button>Surface</button></MemoryRouter>)
  fireEvent.paste(screen.getByText('Surface'), { clipboardData: { files: [], items: [], getData: () => 'My note' } })
  await waitFor(() => expect(paste).toHaveBeenCalledWith({ text: 'My note' }))
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Added to Library: My note', action: expect.objectContaining({ label: 'Open' }) }))
})
it.each(['input', 'textarea', 'editable'])('preserves normal paste in %s', async (kind) => {
  render(<MemoryRouter><ClipboardCapture /><input aria-label="input" /><textarea aria-label="textarea" /><div contentEditable aria-label="editable"><span>Child</span></div></MemoryRouter>)
  const target = kind === 'editable' ? screen.getByText('Child') : screen.getByLabelText(kind)
  screen.getByLabelText(kind).focus()
  fireEvent.paste(target, { clipboardData: { files: [], items: [], getData: () => 'text' } })
  expect(paste).not.toHaveBeenCalled()
})
it('shows import failures with their reason', async () => {
  paste.mockResolvedValue([{ title: 'video.mp4', error: 'No audio track' }])
  render(<MemoryRouter><ClipboardCapture /></MemoryRouter>)
  fireEvent.paste(document.body, { clipboardData: { files: [], items: [], getData: () => 'text' } })
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not add video.mp4', 'No audio track'))
})
it('offers Paste, Import file and New note using the recorder-compatible menu', async () => {
  render(<MemoryRouter><NewMenu /></MemoryRouter>)
  fireEvent.pointerDown(screen.getByRole('button', { name: 'New' }), { button: 0, ctrlKey: false })
  expect(await screen.findByRole('menuitem', { name: 'Paste' })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: 'Import file' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Paste' }))
  await waitFor(() => expect(paste).toHaveBeenCalledWith(undefined))
})

it('opens the picker through Import file and the empty editor through New note', async () => {
  render(<MemoryRouter><NewMenu /></MemoryRouter>)
  fireEvent.pointerDown(screen.getByRole('button', { name: 'New' }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Import file' }))
  await waitFor(() => expect(pickFiles).toHaveBeenCalled())
  fireEvent.pointerDown(screen.getByRole('button', { name: 'New' }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New note' }))
  await waitFor(() => expect(newNote).toHaveBeenCalled())
})
