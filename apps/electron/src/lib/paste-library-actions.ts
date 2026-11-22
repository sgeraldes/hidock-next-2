import { toast } from '@/components/ui/toaster'
import type { PasteResult, PasteSnapshot } from '@/shared/paste-to-library'
import type { NavigateFunction } from 'react-router-dom'

export function showPasteResults(results: PasteResult[], navigate: NavigateFunction): void {
  for (const result of results) {
    if (result.error) {
      toast.error(`Could not add ${result.title}`, result.error)
    } else {
      toast({ variant: result.connectorFallback || result.textUnreadable ? 'warning' : 'success',
        title: result.connectorFallback ? `Saved as a link: ${result.connectorFallback}`
          : result.textUnreadable ? 'Added, but its text could not be read' : `Added to Library: ${result.title}`,
        description: result.warning,
        action: result.connectorFallback
          ? { label: 'Connector settings', onClick: () => navigate('/settings/connectors') }
          : { label: 'Open', onClick: () => result.destination === 'note'
            ? navigate(`/notes?note=${encodeURIComponent(result.id!)}`)
            : navigate('/library', { state: { selectedId: result.id } }) } })
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
