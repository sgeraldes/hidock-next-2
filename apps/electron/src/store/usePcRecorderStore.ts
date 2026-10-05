import { create } from 'zustand'
import { PcAudioCapture } from '@/lib/pc-audio-capture'

interface PcRecorderState {
  visible: boolean
  status: 'idle' | 'starting' | 'recording' | 'saving'
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

export const usePcRecorderStore = create<PcRecorderState>((set, get) => ({
  visible: false, status: 'idle', error: null, elapsed: 0, levels: [0, 0],
  open: () => set({ visible: true }),
  dismiss: () => { if (get().status === 'idle') set({ visible: false }) },
  start: async () => {
    if (get().status !== 'idle') return
    set({ status: 'starting', error: null, elapsed: 0, levels: [0, 0] })
    try {
      capture = new PcAudioCapture(window.electronAPI.pcRecorder, (error) => {
        set({ error })
        void get().stop()
      })
      await capture.start()
      set({ status: 'recording' })
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
    try { await capture?.stop() }
    catch (error) { set({ error: error instanceof Error ? error.message : String(error) }) }
    finally { capture = null; set({ status: 'idle', levels: [0, 0] }) }
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
          if (state.status === 'recording' || state.status === 'idle') { unsubscribe(); resolve() }
        })
      })
    }
    await usePcRecorderStore.getState().stop()
  }
  const unsubscribe = window.electronAPI?.pcRecorder?.onStopRequested?.(() => { void flush() })
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (closing || usePcRecorderStore.getState().status === 'idle') return
    event.preventDefault()
    event.returnValue = ''
    void flush().then(() => { closing = true; window.close() })
  }
  window.addEventListener('beforeunload', beforeUnload)
  return () => { window.removeEventListener('beforeunload', beforeUnload); unsubscribe?.() }
}
