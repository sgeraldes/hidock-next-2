import { toast } from '@/components/ui/toaster'
import type { PasteResult, PasteSnapshot } from '@/shared/paste-to-library'
import type { NavigateFunction } from 'react-router-dom'

export function showPasteResults(results: PasteResult[], navigate: NavigateFunction): void {
  for (const result of results) {
    if (result.error) {
      toast.error(`Could not add ${result.title}`, result.error)
    } else {
      toast({ variant: 'success', title: `Added to Library: ${result.title}`, description: result.warning,
        action: { label: 'Open', onClick: () => navigate('/library', { state: { selectedId: result.id } }) } })
    }
  }
  if (results.some((result) => !result.error)) window.dispatchEvent(new Event('hidock:downloads-completed'))
}

export async function pasteToLibrary(navigate: NavigateFunction, snapshot?: PasteSnapshot): Promise<void> {
  try { showPasteResults(await window.electronAPI.pasteLibrary.paste(snapshot), navigate) }
  catch (error) { toast.error('Could not paste to Library', error instanceof Error ? error.message : String(error)) }
}

export function isPasteEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select')) return true
  const editable = target.closest('[contenteditable]')
  return !!editable && editable.getAttribute('contenteditable')?.toLowerCase() !== 'false'
}
