import { create } from 'zustand'
import { PcAudioCapture } from '@/lib/pc-audio-capture'

interface PcRecorderState {
  visible: boolean
  status: 'idle' | 'starting' | 'recording' | 'saving' | 'saved'
  error: string | null
  elapsed: number
  levels: number[]
  open(): void
  dismiss(): void
  start(): Promise<void>
  stop(): Promise<void>
}
let capture: PcAudioCapture | null = null
let timer: ReturnType<typeof setInterval> | null = null
let closing = false
let savedTimer: ReturnType<typeof setTimeout> | null = null
function clearSavedTimer() { if (savedTimer) clearTimeout(savedTimer); savedTimer = null }

export const usePcRecorderStore = create<PcRecorderState>((set, get) => ({
  visible: false, status: 'idle', error: null, elapsed: 0, levels: [0, 0],
  open: () => set({ visible: true }),
  dismiss: () => set({ visible: false }),
  start: async () => {
    if (get().status !== 'idle') return
    clearSavedTimer()
    set({ status: 'starting', error: null, elapsed: 0, levels: [0, 0] })
    try {
      capture = new PcAudioCapture(window.electronAPI.pcRecorder, (error) => {
        set({ error })
        void get().stop()
      })
      await capture.start()
      set({ status: 'recording' })
      if (get().error) { await get().stop(); return }
      const started = Date.now()
      timer = setInterval(() => set({ elapsed: Math.floor((Date.now() - started) / 1000), levels: capture?.levels() ?? [0, 0] }), 100)
    } catch (error) {
      capture = null
      set({ status: 'idle', error: error instanceof Error ? error.message : String(error) })
    }
  },
  stop: async () => {
    if (get().status !== 'recording') return
    set({ status: 'saving' })
    if (timer) clearInterval(timer)
    timer = null
    let saved = false
    try { await capture?.stop(); saved = !get().error }
    catch (error) { set({ error: error instanceof Error ? error.message : String(error) }) }
    finally {
      capture = null
      set({ status: saved ? 'saved' : 'idle', levels: [0, 0] })
      if (saved) {
        clearSavedTimer()
        savedTimer = setTimeout(() => { savedTimer = null; set({ visible: false, status: 'idle', elapsed: 0 }) }, 5000)
      }
    }
  }
}))

/** Stop flushes the final MediaRecorder chunk before normal window close/reload.
 * A hard crash is handled from synced chunks on the next app startup.
 */
export function installPcRecorderCloseGuard(): () => void {
  const flush = async () => {
    if (['starting', 'saving'].includes(usePcRecorderStore.getState().status)) {
      await new Promise<void>((resolve) => {
        const unsubscribe = usePcRecorderStore.subscribe((state) => {
          if (['recording', 'idle', 'saved'].includes(state.status)) { unsubscribe(); resolve() }
        })
      })
    }
    await usePcRecorderStore.getState().stop()
  }
  const unsubscribe = window.electronAPI?.pcRecorder?.onStopRequested?.(() => { void flush() })
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (closing || ['idle', 'saved'].includes(usePcRecorderStore.getState().status)) return
    event.preventDefault()
    event.returnValue = ''
    void flush().then(() => { closing = true; window.close() })
  }
  window.addEventListener('beforeunload', beforeUnload)
  return () => { window.removeEventListener('beforeunload', beforeUnload); unsubscribe?.() }
}
