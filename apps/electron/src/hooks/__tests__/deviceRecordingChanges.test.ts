import { describe, expect, it } from 'vitest'
import { createDeviceRecordingChangeTracker } from '../deviceRecordingChanges'

describe('device recording changes', () => {
  it('treats an empty cache followed by 507 filenames as the baseline', () => {
    const check = createDeviceRecordingChangeTracker()
    expect(check([])).toEqual({ changed: false, newCount: 0 })
    expect(check([])).toEqual({ changed: false, newCount: 0 })
    expect(check(Array.from({ length: 507 }, (_, i) => `${i}.hda`)))
      .toEqual({ changed: true, newCount: 0 })
  })

  it('counts only two added filenames after a populated baseline', () => {
    const check = createDeviceRecordingChangeTracker()
    expect(check(['a', 'b'])).toEqual({ changed: false, newCount: 0 })
    expect(check(['a', 'b', 'c', 'd'])).toEqual({ changed: true, newCount: 2 })
    expect(check(['d', 'c', 'b', 'a'])).toEqual({ changed: false, newCount: 0 })
  })

  it('refreshes removals without announcing new recordings, even with replacements', () => {
    const check = createDeviceRecordingChangeTracker()
    check(['a', 'b', 'c'])
    expect(check(['a', 'd'])).toEqual({ changed: true, newCount: 0 })
    expect(check([])).toEqual({ changed: true, newCount: 0 })
    expect(check(['e'])).toEqual({ changed: true, newCount: 1 })
  })

  it('detects new filenames when the count stays the same', () => {
    const check = createDeviceRecordingChangeTracker()
    check(['a', 'b'])
    expect(check(['a', 'c'])).toEqual({ changed: true, newCount: 1 })
    expect(check(['a', 'c'])).toEqual({ changed: false, newCount: 0 })
  })
})
