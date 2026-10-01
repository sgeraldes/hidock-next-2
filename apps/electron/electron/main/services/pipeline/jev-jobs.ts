/**
 * The Jev harness of one job: configured only when Jev and that job's switch are on (Settings > Decisions).
 * Kept apart from jev-harness.ts so the harness, and every file that records a Jev call, imports no
 * configuration.
 */
import { jevKeyFor, type JevJob } from '../jev-settings'
import { createJevHarness, type JevHarness } from './jev-harness'

export function jevHarnessFor(job: JevJob): JevHarness {
  return createJevHarness({ getKey: () => jevKeyFor(job) })
}
