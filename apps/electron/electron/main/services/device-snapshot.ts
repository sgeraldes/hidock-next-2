/** Authority stays in main: renderer/cached lists cannot establish absence. */
export interface DeviceSnapshotGuard {
  isCurrent: () => boolean
  complete: boolean
}

let session = 0
let scan = 0
let connected: () => boolean = () => false
let observed: { names: Set<string>; guard: DeviceSnapshotGuard } | undefined
export function setDeviceConnectionReader(reader: () => boolean): void { connected = reader }
export function connectedDeviceGuard(): () => boolean { return currentDeviceSession(connected).isCurrent }
export function invalidateDeviceSnapshots(): void { session++; scan++ }
export function currentDeviceSession(isConnected: () => boolean): DeviceSnapshotGuard {
  const captured = session
  return { isCurrent: () => captured === session && isConnected(), complete: false }
}
export function beginDeviceSnapshot(isConnected: () => boolean): DeviceSnapshotGuard {
  const captured = ++scan
  const guard = currentDeviceSession(isConnected)
  return { isCurrent: () => captured === scan && guard.isCurrent(), complete: false }
}

export function rememberDeviceSnapshot(guard: DeviceSnapshotGuard, names: string[]): void {
  if (guard.isCurrent()) observed = { guard, names: new Set(names.map((name) => name.toLowerCase())) }
}

/** Cached renderer lists may report presence only for files observed in the latest scan. */
export function deviceListGuard(names: string[], isConnected: () => boolean): DeviceSnapshotGuard {
  const latest = observed
  const sessionGuard = currentDeviceSession(isConnected)
  return {
    complete: false,
    isCurrent: () => sessionGuard.isCurrent() && !!latest && latest.guard.isCurrent()
      && names.every((name) => latest.names.has(name.toLowerCase()))
  }
}

export function isCompleteDeviceSnapshot(
  names: string[] | null, before: number | undefined, after: number | undefined
): boolean {
  return names !== null && before !== undefined && Number.isInteger(before) && before >= 0
    && before === after && names.length === before
    && names.every((name) => name.trim().length > 0)
    && new Set(names.map((name) => name.toLowerCase())).size === names.length
}
