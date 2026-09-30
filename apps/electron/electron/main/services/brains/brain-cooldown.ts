/**
 * A brain that says it is out of quota is skipped until its stated reset.
 *
 * Without this, every call walked to the first configured brain, waited for its
 * CLI to start and fail, and only then fell back: on 29-sep the Codex plan was at
 * its limit until 4-oct, and each note waited for `codex exec` to say so before
 * the next brain answered. The CLI prints the reset in words ("try again at Oct
 * 4th, 2026 1:38 AM"); when it does not, the brain rests for an hour.
 *
 * Kept in memory on purpose: a restart tries the brain again, which costs one
 * failed call and picks up a plan that was topped up in the meantime.
 */

import type { BrainId } from './types'

/** How long a brain rests when the CLI gives no reset time. */
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000
/** A stated reset further away than this is not trusted (a misread date must not disable a brain for months). */
export const MAX_COOLDOWN_MS = 10 * 24 * 60 * 60 * 1000
/** Never rest for less than this, so a reset in the past or the next second does not loop. */
export const MIN_COOLDOWN_MS = 60 * 1000

const coolingUntil = new Map<BrainId, number>()

const USAGE_LIMIT = /usage limit|out of credits|quota (?:exceeded|exhausted)|RESOURCE_EXHAUSTED/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** True when the text says the account is out of quota or credits. */
export function isUsageLimitMessage(text: string): boolean {
  return USAGE_LIMIT.test(text)
}

/**
 * The reset time a usage-limit message states, in epoch ms, or null.
 * Understands "try again at Oct 4th, 2026 1:38 AM" (Codex, local time) and
 * "usage limit reached|1759000000" (Claude Code, epoch seconds).
 */
export function parseUsageLimitReset(text: string): number | null {
  const epoch = /usage limit reached\|(\d{10})/i.exec(text)
  if (epoch) return Number(epoch[1]) * 1000

  const words =
    /try again (?:at|on) ([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}):(\d{2}) ?([AP]M)/i.exec(text)
  if (!words) return null
  const month = MONTHS.indexOf(words[1].slice(0, 3).toLowerCase())
  if (month < 0) return null
  let hour = Number(words[4]) % 12
  if (words[6].toUpperCase() === 'PM') hour += 12
  const at = new Date(Number(words[3]), month, Number(words[2]), hour, Number(words[5]))
  return Number.isNaN(at.getTime()) ? null : at.getTime()
}

/**
 * If a failed CLI run says the account is out of quota, rest the brain until the
 * stated reset (bounded), and say so once in the log. Returns whether it did.
 */
export function noteBrainFailure(id: BrainId, message: string, now = Date.now()): boolean {
  if (!isUsageLimitMessage(message)) return false
  const stated = parseUsageLimitReset(message)
  const wait = stated === null ? DEFAULT_COOLDOWN_MS : stated - now
  const until = now + Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, wait))
  const alreadyResting = (coolingUntil.get(id) ?? 0) > now
  coolingUntil.set(id, until)
  if (!alreadyResting) {
    console.warn(`[Brains] ${id} is out of quota; skipping it until ${new Date(until).toISOString()}`)
  }
  return true
}

/** True while the brain is resting after an out-of-quota failure. */
export function isBrainCoolingDown(id: BrainId, now = Date.now()): boolean {
  const until = coolingUntil.get(id)
  if (until === undefined) return false
  if (until <= now) {
    coolingUntil.delete(id)
    return false
  }
  return true
}

export function _resetBrainCooldownsForTests(): void {
  coolingUntil.clear()
}
