import { app } from 'electron'
import { join } from 'path'
import { acquireSingleInstanceLock } from './single-instance'
import { createSplashWindow } from './splash-screen'
import { configureEarlyStartup } from './startup-configuration'
import { getStartupState } from './startup-state'
import { createErrorLog, logWindow, teeMainConsole } from './services/error-log'

const startup = getStartupState()
startup.runtimeDir = __dirname
configureEarlyStartup()

// `--brain-only` is the headless second brain an agent's bridge starts when the
// app is closed: no window, no GPU, read-only database, exits when idle or when
// the app opens (see brain-host.ts). It must not keep the single-instance lock,
// or opening the app while it runs would only focus a process with no window.
// It holds that lock only while it upgrades an older database file, and opens
// the app afterwards if the owner tried to during the upgrade (brain-upgrade.ts).
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
  // Before anything else logs: warnings and errors also go to a dated file in
  // the profile, so a failure can be read back after the fact.
  try {
    startup.errorLog = createErrorLog(join(app.getPath('userData'), 'logs'))
    startup.errorLog.prune()
    teeMainConsole(startup.errorLog)
  } catch (err) {
    console.error('[error-log] could not start the log file:', err)
  }

  app.whenReady().then(async () => {
    // This entry intentionally imports no database, AI, graph, transcription,
    // or renderer application modules. Show a useful frame first; the splash's
    // renderer process stays responsive while the main process evaluates the
    // heavier application chunk.
    startup.splashWindow = await createSplashWindow(join(__dirname, '../preload/splash.js'))
    if (startup.errorLog && startup.splashWindow) logWindow(startup.errorLog, startup.splashWindow.webContents)
    await import('./index')
  }).catch((error) => {
    console.error('[Startup] Application bootstrap failed:', error)
    app.quit()
  })
}
