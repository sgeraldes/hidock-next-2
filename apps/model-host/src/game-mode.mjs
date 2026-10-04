/**
 * Game mode: the host steps aside when the machine is being played on.
 *
 * Every couple of seconds the probe reports what is running, whether Windows
 * thinks a full-screen app has the screen, and which programs hold a CUDA
 * context. If any of that looks like a game, a working host pauses (its job is
 * cancelled and the client runs the recording itself) and resumes a set time
 * after the last sign of the game, unless the person paused it themselves.
 *
 * Why these signals and not "anything on the GPU": on Windows every desktop
 * program with a window (explorer, the browser, Discord) holds a graphics
 * context, so nvidia-smi's process list is never empty. Games are recognised by
 * where they are installed, by a list the person keeps, and by taking the
 * screen; other CUDA work is recognised by its compute context.
 */

/** SHQueryUserNotificationState: 2 = busy (full-screen app), 3 = Direct3D full screen. */
const FULLSCREEN_STATES = new Set([2, 3])

export const GAME_MODE_DEFAULTS = Object.freeze({
  enabled: true,
  pauseOnGameFolders: true,
  /** A program whose path contains one of these is a game. */
  gameFolders: Object.freeze([
    'steamapps\\common',
    'XboxGames',
    'Epic Games',
    'GOG Galaxy\\Games',
    'GOG Games',
    'Riot Games',
    'EA Games',
    'Ubisoft Game Launcher\\games',
  ]),
  /**
   * Launchers and helpers that live in those folders and run all day. Pausing
   * for them would mean never working.
   */
  ignoreProcesses: Object.freeze([
    'EpicGamesLauncher.exe',
    'EpicWebHelper.exe',
    'EpicOnlineServicesHost.exe',
    'RiotClientServices.exe',
    'RiotClientUx.exe',
    'RiotClientUxRender.exe',
    'RiotClientCrashHandler.exe',
    'wallpaper32.exe',
    'wallpaper64.exe',
    'webwallpaper32.exe',
    'CrashReportClient.exe',
    'UnityCrashHandler64.exe',
  ]),
  pauseOnFullscreen: true,
  pauseOnOtherGpuWork: true,
  /** Programs that always pause the host, wherever they are installed. */
  alwaysPause: Object.freeze([]),
  /** CUDA programs that may share the GPU with the host. */
  ignoreGpu: Object.freeze([]),
  /** Minutes without any sign of a game before the host works again. */
  resumeAfterMinutes: 5,
})

/** The host's own worker runs from here; it never pauses the host. */
const OWN_RUNTIME = 'hidock model host'

function list(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Settings as stored, with every gap filled and every value made sane. */
export function normalizeGameMode(raw = {}) {
  const d = GAME_MODE_DEFAULTS
  const minutes = Number(raw.resumeAfterMinutes)
  return {
    enabled: flag(raw.enabled, d.enabled),
    pauseOnGameFolders: flag(raw.pauseOnGameFolders, d.pauseOnGameFolders),
    gameFolders: list(raw.gameFolders, d.gameFolders),
    ignoreProcesses: list(raw.ignoreProcesses, d.ignoreProcesses),
    pauseOnFullscreen: flag(raw.pauseOnFullscreen, d.pauseOnFullscreen),
    pauseOnOtherGpuWork: flag(raw.pauseOnOtherGpuWork, d.pauseOnOtherGpuWork),
    alwaysPause: list(raw.alwaysPause, d.alwaysPause),
    ignoreGpu: list(raw.ignoreGpu, d.ignoreGpu),
    resumeAfterMinutes:
      raw.resumeAfterMinutes === undefined || raw.resumeAfterMinutes === '' || !Number.isFinite(minutes)
        ? d.resumeAfterMinutes
        : Math.min(120, Math.max(0, Math.round(minutes))),
  }
}

/** "C:\x\Game.EXE" and "game" are the same program. */
function programKey(nameOrPath) {
  const base = String(nameOrPath ?? '').split(/[\\/]/).pop() || ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

function baseName(nameOrPath) {
  return String(nameOrPath ?? '').split(/[\\/]/).pop() || String(nameOrPath ?? '')
}

function normalizePath(path) {
  return String(path ?? '').replace(/\//g, '\\').toLowerCase()
}

/**
 * Why this snapshot means a game is being played, in a sentence, or null.
 *
 * @param {{ notificationState?: number, processes?: {name: string, path?: string}[],
 *   gpuProcesses?: {pid: number, name: string}[] }} snapshot
 * @param {ReturnType<typeof normalizeGameMode>} settings
 */
export function decideGamePause(snapshot, settings) {
  const processes = snapshot.processes || []
  const ignored = new Set(settings.ignoreProcesses.map(programKey))

  const always = new Set(settings.alwaysPause.map(programKey))
  for (const p of processes) {
    if (always.has(programKey(p.name))) return `${baseName(p.name)} is running`
  }

  if (settings.pauseOnGameFolders) {
    const folders = settings.gameFolders.map((f) => `\\${normalizePath(f).replace(/^\\+|\\+$/g, '')}\\`)
    for (const p of processes) {
      if (!p.path || ignored.has(programKey(p.name))) continue
      const path = normalizePath(p.path)
      if (folders.some((folder) => path.includes(folder))) return `${baseName(p.name)} is running`
    }
  }

  if (settings.pauseOnOtherGpuWork) {
    const allowed = new Set(settings.ignoreGpu.map(programKey))
    // The host's own worker, by PID (any Python can run it) and by the
    // install folder (between its start and the PID being known).
    const own = new Set(snapshot.ownPids || [])
    for (const g of snapshot.gpuProcesses || []) {
      if (own.has(g.pid)) continue
      if (normalizePath(g.name).includes(OWN_RUNTIME)) continue
      if (allowed.has(programKey(g.name))) continue
      return `${baseName(g.name)} is using the GPU`
    }
  }

  if (settings.pauseOnFullscreen && FULLSCREEN_STATES.has(snapshot.notificationState)) {
    return 'A full-screen app is running'
  }
  return null
}

/**
 * Turns snapshots into pauses and resumes. Holds only the time the game was
 * last seen; the pause itself, and who made it, live in HostState.
 */
export class GameWatcher {
  /**
   * @param {object} deps
   * @param {() => ReturnType<typeof normalizeGameMode>} deps.settings read on every look
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.settings = deps.settings
    this.now = deps.now || Date.now
    this.lastSeen = null
    this.gameVisible = false
    this.pausedByGame = false
    /** The last sentence that explained a pause, for the control page. */
    this.lastReason = null
  }

  /** Look at one snapshot and pause or resume the host. Returns the reason, or null. */
  async observe(snapshot, state) {
    const settings = this.settings()
    if (!settings.enabled) {
      this.lastSeen = null
      this.gameVisible = false
      state.gameOverride = false
      state.gameResume()
      this.pausedByGame = false
      return null
    }

    const why = decideGamePause(snapshot, settings)
    this.gameVisible = Boolean(why)
    if (why) {
      this.lastSeen = this.now()
      this.lastReason = why
      await state.gamePause(why)
    } else {
      const quietFor = this.lastSeen === null ? Infinity : this.now() - this.lastSeen
      const gone = quietFor >= settings.resumeAfterMinutes * 60_000
      // The game the person resumed during is over; the next one pauses
      // again. "Over" means gone for the same wait as a resume: an alt-tab or
      // a loading screen drops the full-screen signal for a moment.
      if (gone) state.gameOverride = false
      if (
        state.pauseInfo()?.by === 'game' &&
        this.lastSeen !== null &&
        this.now() - this.lastSeen >= settings.resumeAfterMinutes * 60_000
      ) {
        state.gameResume()
        this.lastSeen = null
      }
    }
    this.pausedByGame = state.pauseInfo()?.by === 'game'
    return why
  }

  /** When a game pause will lift, or null while the game runs or nothing waits. */
  resumesAt() {
    if (!this.pausedByGame || this.gameVisible || this.lastSeen === null) return null
    return this.lastSeen + this.settings().resumeAfterMinutes * 60_000
  }
}
