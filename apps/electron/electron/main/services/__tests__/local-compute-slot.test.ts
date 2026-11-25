// @vitest-environment node
import { expect, it, vi } from 'vitest'
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {} }) }))
import { resourcePauseReason } from '../local-compute-slot'
const base = { freeBytes: 8 * 1024 ** 3, totalBytes: 64 * 1024 ** 3, cpuPercent: 20,
  onBattery: false, pauseOnBattery: true, pauseWhenBusy: true }
it('pauses for real pressure and obeys battery/busy choices without disabling the memory floor', () => {
  expect(resourcePauseReason(base)).toBeNull()
  expect(resourcePauseReason({ ...base, cpuPercent: 80 })).toContain('CPU')
  expect(resourcePauseReason({ ...base, cpuPercent: 99, pauseWhenBusy: false })).toBeNull()
  expect(resourcePauseReason({ ...base, onBattery: true })).toContain('battery')
  expect(resourcePauseReason({ ...base, onBattery: true, pauseOnBattery: false })).toBeNull()
  expect(resourcePauseReason({ ...base, freeBytes: 512 * 1024 ** 2, pauseWhenBusy: false })).toContain('memory')
  expect(resourcePauseReason({ ...base, freeBytes: 4 * 1024 ** 3 })).toContain('memory')
  expect(resourcePauseReason({ ...base, totalBytes: 8 * 1024 ** 3, freeBytes: 2 * 1024 ** 3 })).toBeNull()
})
