import { app } from 'electron'
import { join } from 'path'
import { acquireSingleInstanceLock, showRunningInstance } from './single-instance'
import { acquireMachineInstanceLock } from './machine-instance'
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
  // Nothing is drawn, so nothing needs a GPU. disableHardwareAcceleration alone
  // still leaves Chromium a software-compositing GPU process (45 MB measured);
  // these two switches stop it from starting at all.
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  // Keep Chromium's own files away from the app's. The headless brain and the
  // app share the profile directory — that is where config.json and the lock
  // live — and during a handoff both run at once. Chromium writes its session
  // data (disk cache, Local State, cookies, network state) there by default,
  // and two processes opening the same cache fight over it. The brain uses no
  // browser storage, so its session data goes to a folder of its own.
  app.setPath('sessionData', join(app.getPath('userData'), 'brain-only-session'))
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
    // One HiDock per user on this machine, whatever its profile. Electron's
    // lock above only covers this userData folder; a second profile (a dev or
    // benchmark run, a copied install) used to open a second window beside the
    // first. Checked before the splash, so the second launch shows nothing.
    const onlyInstance = await acquireMachineInstanceLock({
      onSecondLaunch: () =>
        showRunningInstance({
          getMainWindow: () => startup.mainWindow,
          getSplashWindow: () => startup.splashWindow
        })
    })
    if (!onlyInstance) {
      console.log('[Startup] Another HiDock is already running for this user; it was brought forward. Quitting.')
      startup.hasSingleInstanceLock = false
      app.quit()
      return
    }
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
