import type { BrowserWindow } from 'electron'
import type { ErrorLog } from './services/error-log'
import type { BackendTray } from './services/backend-tray'

export interface StartupState {
  earlyConfigurationApplied: boolean
  hasSingleInstanceLock: boolean | null
  runtimeDir: string | null
  splashWindow: BrowserWindow | null
  mainWindow: BrowserWindow | null
  /** A second launch requested UI while the backend was still starting. */
  uiRequested?: boolean
  /** Installed once services can attach the UI to the existing backend. */
  requestUi?: () => void
  backendTray?: BackendTray
  /** Warnings and errors on disk; null until the instance lock is held. */
  errorLog: ErrorLog | null
}

export function getStartupState(): StartupState {
  const root = globalThis as typeof globalThis & { __HIDOCK_STARTUP_STATE__?: StartupState }
  if (!root.__HIDOCK_STARTUP_STATE__) {
    root.__HIDOCK_STARTUP_STATE__ = {
      earlyConfigurationApplied: false,
      hasSingleInstanceLock: null,
      runtimeDir: null,
      splashWindow: null,
      mainWindow: null,
      errorLog: null
    }
  }
  return root.__HIDOCK_STARTUP_STATE__
}
