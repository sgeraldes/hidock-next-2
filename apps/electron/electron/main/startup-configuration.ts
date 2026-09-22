import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { getStartupState } from './startup-state'

/** Apply switches and profile overrides before Electron's ready event. */
export function configureEarlyStartup(): void {
  const state = getStartupState()
  if (state.earlyConfigurationApplied) return
  state.earlyConfigurationApplied = true

  const devUserDataOverride = process.env.HIDOCK_DEV_USERDATA
  if (devUserDataOverride) {
    app.setPath('userData', devUserDataOverride)
    console.warn(`[DEV] userData overridden to ${devUserDataOverride}`)
  } else {
    // Keep the established profile across the 2.0 package/product rename.
    // This must happen before the single-instance lock, Chromium session,
    // configuration, credentials, and database are initialized. Reuse the
    // entire profile so encrypted credentials and browser state stay together.
    const existingProfile = join(app.getPath('appData'), 'hidock-universal-knowledge-hub')
    if (existsSync(join(existingProfile, 'config.json'))) {
      app.setPath('userData', existingProfile)
      console.info(`[Startup] Using existing HiDock profile: ${existingProfile}`)
    }
  }

  // Electron/Chromium device access switches must be registered before ready.
  app.commandLine.appendSwitch('disable-usb-blocklist')
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('disable-usb-device-event-log')
    app.commandLine.appendSwitch('device-event-log-level', '3')
  }

  const enableRemoteDebugging = is.dev || process.env.ENABLE_REMOTE_DEBUGGING === 'true'
  if (enableRemoteDebugging) {
    const cdpPort = process.env.HIDOCK_DEV_CDP_PORT || '9222'
    app.commandLine.appendSwitch('remote-debugging-port', cdpPort)
    console.warn(`[SECURITY] Remote debugging enabled on port ${cdpPort}`)
  }
}
