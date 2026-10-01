/**
 * The Jev harness of one job is configured only when Jev and that job's switch are on.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../jev-settings', () => ({
  jevKeyFor: (job: string) => (job === 'value' ? 'the-key' : null)
}))

import { jevHarnessFor } from '../jev-jobs'

describe('jevHarnessFor', () => {
  it('is configured for a job whose switch is on and not for one whose switch is off', () => {
    expect(jevHarnessFor('value').isConfigured()).toBe(true)
    expect(jevHarnessFor('meetingMatch').isConfigured()).toBe(false)
  })
})
