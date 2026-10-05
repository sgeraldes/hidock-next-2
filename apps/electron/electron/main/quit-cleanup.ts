/** Hold every quit request until asynchronous recorder/device cleanup finishes. */
export function createQuitCleanup(cleanup: () => Promise<void>, quit: () => void): (event: { preventDefault(): void }) => void {
  let started = false
  let completed = false
  return (event) => {
    if (completed) return
    event.preventDefault()
    if (started) return
    started = true
    void cleanup().catch((error) => { console.error('[Quit] Cleanup failed:', error) }).finally(() => {
      completed = true
      quit()
    })
  }
}
