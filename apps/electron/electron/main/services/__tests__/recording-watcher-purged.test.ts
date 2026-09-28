/**
 * A purged recording stays purged: the folder scan must not re-import a file
 * whose name (in any extension variant) carries a purge tombstone. On 25-sep
 * all 22 purged files still in the recordings folder were back in the library.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

const purged = new Set(['2025Dec17-212704-Rec50.hda', '2025Dec17-212704-Rec50.wav', '2025Dec17-212704-Rec50.mp3'])

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../file-storage', () => ({ getRecordingsPath: () => '' }))
vi.mock('../database', () => ({
  getRecordingByFilenameVariants: vi.fn(() => null),
  insertRecording: vi.fn(),
  isFilePurged: (name: string) => purged.has(name),
  getMeetings: vi.fn(() => []),
  linkRecordingToMeeting: vi.fn(),
  updateRecordingLifecycle: vi.fn()
}))

const { isPurgedFile } = await import('../recording-watcher')

describe('isPurgedFile', () => {
  it('matches a tombstone under any extension variant of the name', () => {
    expect(isPurgedFile('2025Dec17-212704-Rec50.hda')).toBe(true)
    expect(isPurgedFile('2025Dec17-212704-Rec50.wav')).toBe(true)
    expect(isPurgedFile('2025Dec17-212704-Rec50.mp3')).toBe(true)
  })

  it('leaves every other file alone', () => {
    expect(isPurgedFile('2026Sep24-110051-Rec52.hda')).toBe(false)
  })
})
