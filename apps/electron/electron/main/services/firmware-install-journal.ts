import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export type InstallState = 'prepared' | 'requesting' | 'awaiting-boot' | 'uncertain' | 'rejected' | 'confirmed'
export interface InstallPlan {
  id: string
  preparedAt: number
  expiresAt: number
  serialHash: string
  sourceVersion: number
  targetVersion: number
  imageSha256: string
  imageBytes: number
}
export interface InstallEvent { state: InstallState; at: number; reason: string }
export interface InstallAttempt { plan: InstallPlan; events: InstallEvent[]; state: InstallState }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digest = /^[0-9a-f]{64}$/
const transitions: Record<InstallState, InstallState[]> = {
  prepared: ['requesting'], requesting: ['awaiting-boot', 'uncertain', 'rejected', 'confirmed'],
  'awaiting-boot': ['confirmed', 'uncertain'], uncertain: ['confirmed', 'uncertain'],
  rejected: [], confirmed: []
}
function durableCreate(path: string, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  const fd = openSync(path, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) throw new Error('Firmware journal write made no progress')
      offset += written
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
function readJson(path: string): any {
  const bytes = readFileSync(path)
  if (bytes.length > 8192) throw new Error('Oversized firmware journal record')
  return JSON.parse(bytes.toString('utf8'))
}
/** Immutable records, fsynced before CMD8. Torn/corrupt records fail closed.
 * Device identity is hashed; no recordings, credentials or serial enter this journal. */
export class FirmwareInstallJournal {
  constructor(readonly folder: string) {}
  all(): InstallAttempt[] {
    if (!existsSync(this.folder)) return []
    const names = readdirSync(this.folder)
    if (names.length > 1024 || names.some(name => !uuid.test(name))) throw new Error('Invalid firmware journal directory')
    return names.map(id => this.read(id))
  }
  pending(): InstallAttempt[] { return this.all().filter(a => ['requesting', 'awaiting-boot', 'uncertain'].includes(a.state)) }
  read(id: string): InstallAttempt {
    if (!uuid.test(id)) throw new Error('Invalid firmware attempt ID')
    const folder = join(this.folder, id), plan = readJson(join(folder, 'plan.json')) as InstallPlan
    if (plan.id !== id || !digest.test(plan.serialHash) || !digest.test(plan.imageSha256) ||
      !Number.isSafeInteger(plan.preparedAt) || !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= plan.preparedAt ||
      !Number.isSafeInteger(plan.sourceVersion) || !Number.isSafeInteger(plan.targetVersion) ||
      !Number.isSafeInteger(plan.imageBytes) || plan.imageBytes <= 0 || plan.imageBytes > 4194304) throw new Error('Invalid firmware plan')
    const names = readdirSync(folder).filter(name => name !== 'plan.json').sort()
    if (names.length < 1 || names.length > 64 || names.some((name, index) => name !== `event-${String(index).padStart(4, '0')}.json`)) throw new Error('Incomplete firmware journal')
    const events = names.map(name => readJson(join(folder, name)) as InstallEvent)
    events.forEach((event, index) => {
      if (!Object.hasOwn(transitions, event.state) || !Number.isSafeInteger(event.at) || typeof event.reason !== 'string' || event.reason.length > 240 ||
        (index === 0 ? event.state !== 'prepared' : !transitions[events[index - 1].state].includes(event.state))) throw new Error('Invalid firmware journal transition')
    })
    return { plan, events, state: events[events.length - 1].state }
  }
  create(plan: InstallPlan): InstallAttempt {
    if (!uuid.test(plan.id) || this.pending().length) throw new Error('An unresolved firmware attempt must be observed first')
    const folder = join(this.folder, plan.id)
    mkdirSync(this.folder, { recursive: true })
    mkdirSync(folder)
    durableCreate(join(folder, 'plan.json'), plan)
    durableCreate(join(folder, 'event-0000.json'), { state: 'prepared', at: plan.preparedAt, reason: 'read-only-preparation' })
    return this.read(plan.id)
  }
  append(id: string, event: InstallEvent): InstallAttempt {
    const current = this.read(id)
    // Keep a slot for final confirmation during repeated read-only timeouts.
    if (event.state === 'uncertain' && current.state === 'uncertain' && current.events.length >= 63) return current
    if (current.events.length >= 64) throw new Error('Firmware journal event limit reached; existing attempt remains readable')
    if (!transitions[current.state].includes(event.state)) throw new Error('Forbidden firmware attempt transition')
    durableCreate(join(this.folder, id, `event-${String(current.events.length).padStart(4, '0')}.json`), event)
    return this.read(id)
  }
}
