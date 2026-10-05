import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from '@/components/ui/toaster'
import { useAutoCaptureScreenshots } from '@/store/ui/useUIStore'
import { isPasteEditable, pasteToLibrary } from '@/lib/paste-library-actions'

/** App-wide paste; editable surfaces keep their native paste behavior. */
export function useClipboardCapture(): void {
  const autoCapture = useAutoCaptureScreenshots()
  const navigate = useNavigate()
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (event.defaultPrevented || isPasteEditable(event.target) || isPasteEditable(document.activeElement)) return
      const data = event.clipboardData
      if (!data || !window.electronAPI?.pasteLibrary) return
      event.preventDefault()
      const files = Array.from(data.files ?? [])
      const paths = files.map((file) => {
        try { return window.electronAPI.clipboardCapture.getPathForFile(file) } catch { return '' }
      }).filter(Boolean)
      if (paths.length === files.length && paths.length) void pasteToLibrary(navigate, { files: paths })
      else if (files.length || Array.from(data.items ?? []).some((item) => item.type.startsWith('image/'))) {
        void pasteToLibrary(navigate)
      } else void pasteToLibrary(navigate, { text: data.getData('text/plain') })
    }
    document.addEventListener('paste', onPaste)
    const unsubscribe = window.electronAPI?.onClipboardCaptured?.((result) => {
      if (result.ok) {
        toast({ variant: 'success', title: `Added to Library: ${result.title ?? 'Screenshot'}`,
          action: { label: 'Open', onClick: () => navigate('/library', { state: { selectedId: result.captureId } }) } })
        window.dispatchEvent(new Event('hidock:downloads-completed'))
      }
    })
    return () => { document.removeEventListener('paste', onPaste); unsubscribe?.() }
  }, [navigate])
  useEffect(() => {
    const api = window.electronAPI?.clipboardCapture
    if (!api) return
    void api.setAutoWatch(autoCapture)
    return () => { void api.setAutoWatch(false) }
  }, [autoCapture])
}

export function ClipboardCapture(): null {
  useClipboardCapture()
  return null
}
