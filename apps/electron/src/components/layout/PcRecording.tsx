import { ClipboardPaste, FilePlus, NotebookPen, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from '@/components/ui/toaster'
import { pasteToLibrary, showPasteResults } from '@/lib/paste-library-actions'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** Same file, component name and zero-prop API as feat/recorder-phase1. */
export function NewMenu() {
  const navigate = useNavigate()
  const actions = [
    { label: 'Paste', icon: ClipboardPaste, onSelect: () => void pasteToLibrary(navigate) },
    { label: 'Import file', icon: FilePlus, onSelect: () => {
      void window.electronAPI.pasteLibrary.pickFiles().then((results) => showPasteResults(results, navigate))
        .catch((error: unknown) => toast.error('Could not import file', error instanceof Error ? error.message : String(error)))
    } },
    { label: 'New note', icon: NotebookPen, onSelect: () => {
      void window.electronAPI.pasteLibrary.newNote().then((result) => {
        if (result.error) toast.error('Could not create note', result.error)
        else navigate(`/notes?note=${encodeURIComponent(result.id!)}`)
      }).catch((error: unknown) => toast.error('Could not create note', error instanceof Error ? error.message : String(error)))
    } }
  ]
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" className="titlebar-no-drag flex h-7 shrink-0 items-center gap-1 rounded-md border border-slate-600 px-2 text-xs hover:bg-slate-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400">
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />New
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      {actions.map(({ label, icon: Icon, onSelect }) => <DropdownMenuItem key={label} onSelect={onSelect}>
        <Icon className="mr-2 h-4 w-4" aria-hidden="true" />{label}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>
}
