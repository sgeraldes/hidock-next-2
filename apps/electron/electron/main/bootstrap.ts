import { app } from 'electron'
import { join } from 'path'
import { acquireSingleInstanceLock } from './single-instance'
import { createSplashWindow } from './splash-screen'
import { configureEarlyStartup } from './startup-configuration'
import { getStartupState } from './startup-state'

const startup = getStartupState()
startup.runtimeDir = __dirname
configureEarlyStartup()

// `--brain-only` is the headless second brain an agent's bridge starts when the
// app is closed: no window, no GPU, read-only database, exits when idle or when
// the app opens (see brain-host.ts). It must not take the single-instance lock,
// or opening the app while it runs would only focus a process with no window.
const brainOnly = process.argv.includes('--brain-only')

if (brainOnly) {
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const { runBrainOnly } = await import('./brain-host')
    await runBrainOnly()
  }).catch((error) => {
    console.error('[Brain] headless start failed:', error)
    app.exit(1)
  })
}

startup.hasSingleInstanceLock = brainOnly
  ? false
  : acquireSingleInstanceLock({
      getMainWindow: () => startup.mainWindow,
      getSplashWindow: () => startup.splashWindow
    })

if (startup.hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    // This entry intentionally imports no database, AI, graph, transcription,
    // or renderer application modules. Show a useful frame first; the splash's
    // renderer process stays responsive while the main process evaluates the
    // heavier application chunk.
    startup.splashWindow = await createSplashWindow(join(__dirname, '../preload/splash.js'))
    await import('./index')
  }).catch((error) => {
    console.error('[Startup] Application bootstrap failed:', error)
    app.quit()
  })
}
