import { app, BrowserWindow } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'

/**
 * The folder the lock lives in: one for every profile of this OS user.
 *
 * Electron keys its lock to the userData folder in effect when the lock is
 * requested, so each profile (HIDOCK_DEV_USERDATA, a benchmark run, a copied
 * install) used to get its own lock, and a second HiDock opened beside the
 * first on 24-sep-2026. By design there is one HiDock per user.
 */
export function instanceLockDir(): string {
  return join(app.getPath('appData'), 'HiDock Next', 'instance-lock')
}

/**
 * Options for {@link acquireSingleInstanceLock}.
 *
 * The window accessors are read lazily (called only when a `second-instance`
 * event fires), so they safely return `null` during the window between lock
 * acquisition and window creation.
 */
export interface SingleInstanceOptions {
  /** Returns the primary application window, or `null` if not yet created. */
  getMainWindow: () => BrowserWindow | null
  /** Returns the splash window, or `null` if absent/destroyed. Optional. */
  getSplashWindow?: () => BrowserWindow | null
}

/**
 * Ask for the one lock every HiDock of this OS user competes for, without
 * acting on the answer. `true` means no other HiDock holds it right now.
 *
 * The app takes it for its whole life. The headless brain takes it only while
 * it upgrades the database file, as the proof that no app is running or
 * starting against that file, and gives it back with
 * `app.releaseSingleInstanceLock()` as soon as the upgrade ends.
 */
export function requestSharedInstanceLock(): boolean {
  // Request the lock with userData pointing at the shared lock folder, then put
  // the profile back at once. The lock keeps the folder it was created with
  // (Electron's ProcessSingleton reads it at construction), so every profile
  // competes for the same lock, and the OS arbitrates two launches at the same
  // moment. Nothing reads userData between these two lines.
  const profile = app.getPath('userData')
  const lockDir = instanceLockDir()
  // Electron creates the folder itself before it builds the lock; creating it
  // here too keeps the lock independent of that detail (on macOS and Linux the
  // lock files live in this folder and cannot be written without it).
  mkdirSync(lockDir, { recursive: true })
  try {
    app.setPath('userData', lockDir)
    return app.requestSingleInstanceLock()
  } finally {
    app.setPath('userData', profile)
  }
}

/**
 * Enforce a single running instance BEFORE the database engine is initialized.
 *
 * Now that the app runs on better-sqlite3 + WAL against a real on-disk file,
 * two concurrent main processes booting migrations / repair / self-heal
 * backfill / VACUUM against the same file is a data-integrity and
 * lock-contention hazard (WAL allows concurrent *readers*, not two independent
 * app boots each mutating schema). This guard MUST run before any window is
 * created and before {@link initializeDatabase} touches the file.
 *
 * @returns `true` if this process acquired the lock and should continue
 *   booting; `false` if another instance already owns it — in which case
 *   `app.quit()` has already been called and the caller MUST abort boot
 *   immediately (before opening the DB) without creating windows.
 */
export function acquireSingleInstanceLock(options: SingleInstanceOptions): boolean {
  const gotTheLock = requestSharedInstanceLock()

  if (!gotTheLock) {
    // Another instance already owns the DB. Quit before touching anything.
    // It was told to come forward; if it is busy (a long synchronous boot),
    // Chromium waits up to 20 s for its answer and may end it after that. The
    // database is WAL, so that end is a crash SQLite recovers from.
    console.log('[Startup] HiDock is already running for this user; asked it to come forward. Quitting.')
    app.quit()
    return false
  }

  // We are the primary. When a second launch is attempted, the OS delivers a
  // `second-instance` event here instead of starting a rival process — focus
  // our existing window so the user sees the app they already have running.
  app.on('second-instance', () => showRunningInstance(options))

  return true
}

/**
 * Bring this instance forward because the owner tried to start another one:
 * the main window, or the splash while the app is still starting.
 */
export function showRunningInstance(options: SingleInstanceOptions): void {
  const mainWindow = options.getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
    return
  }

  // Main window not created yet (still initializing) — surface the splash.
  const splashWindow = options.getSplashWindow?.()
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.show()
    splashWindow.focus()
  }
}
