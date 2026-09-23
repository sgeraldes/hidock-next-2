/**
 * The brain's lock file: who is answering questions right now, and where.
 *
 * Two processes can serve the brain API — the app when it is open, and the
 * headless `--brain-only` process an agent starts when it is not. The owner's
 * rule is that there are never two, and that the app always wins: the moment
 * the app opens, the headless one has no reason to exist. This file is how
 * they agree. It lives in the profile directory beside config.json, which is
 * the same trust boundary as the database it guards, and it carries the token
 * a client needs, so reading it is the way in.
 *
 * Spec: docs/superpowers/specs/2026-09-22-brain-service-design.md
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { request } from 'http'
import { join } from 'path'

export type BrainKind = 'app' | 'service'

export interface BrainLock {
  /** Which process is serving. The app outranks the service. */
  kind: BrainKind
  pid: number
  /** Loopback port the API listens on. */
  port: number
  /** Bearer token every request must carry. */
  token: string
  /** Random per process; a health probe must echo it back to count as alive. */
  instanceId: string
  startedAt: string
  /** The executable that can start a headless brain, so a client need not guess. */
  exe: string
}

export const BRAIN_LOCK_FILENAME = 'brain.json'

export function brainLockPath(userDataDir: string): string {
  return join(userDataDir, BRAIN_LOCK_FILENAME)
}

/** The current lock, or null when there is none or it cannot be read. */
export function readBrainLock(path: string): BrainLock | null {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BrainLock>
    if (
      (parsed.kind !== 'app' && parsed.kind !== 'service') ||
      typeof parsed.port !== 'number' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.instanceId !== 'string'
    ) {
      return null
    }
    return parsed as BrainLock
  } catch {
    return null
  }
}

/**
 * Replace the lock in one step. Written beside the target and renamed over it,
 * so a reader sees the old lock or the new one and never half of either.
 */
export function writeBrainLock(path: string, lock: BrainLock): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(lock, null, 2), 'utf-8')
  renameSync(tmp, path)
}

/** Remove the lock only if it is still ours. A newer owner's lock is left alone. */
export function removeBrainLockIfOwned(path: string, instanceId: string): void {
  const current = readBrainLock(path)
  if (current && current.instanceId !== instanceId) return
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Best effort on the way out; a stale lock is detected by the next probe.
  }
}

/**
 * Is the process named in `lock` really there and really that process?
 *
 * A pid can be reused and a port can be taken by something else, so neither
 * alone proves anything. Alive means: something answers /health on that port,
 * accepts that token, and reports that instanceId.
 */
export function probeBrain(lock: BrainLock, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: lock.port,
        path: '/health',
        method: 'GET',
        headers: { authorization: `Bearer ${lock.token}` },
        timeout: timeoutMs,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(false)
          try {
            resolve((JSON.parse(body) as { instanceId?: string }).instanceId === lock.instanceId)
          } catch {
            resolve(false)
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/** Ask a running headless brain to finish what it is doing and exit. */
export function requestStepDown(lock: BrainLock, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: lock.port,
        path: '/step-down',
        method: 'POST',
        headers: { authorization: `Bearer ${lock.token}` },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode === 202))
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}
