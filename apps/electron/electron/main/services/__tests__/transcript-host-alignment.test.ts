// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { dirname } from 'path'
import { fixTimesOnModelHost, memoryJobStore, type HostFixDeps } from '../transcript-host-alignment'
import { ModelHostUnavailableError } from '../model-host-client'

const lines = [{ text: 'Hola, Manuel.' }, { text: '¿Cómo estás?' }]
const window = { start: 100, end: 130 }

function deps(overrides: Partial<HostFixDeps> = {}): HostFixDeps & { clips: string[] } {
  const clips: string[] = []
  return {
    clips,
    settings: () => ({ url: 'https://gamestation:8766', token: 'test' }),
    audioExists: () => true,
    extract: vi.fn(async (_audio: string, _start: number, _seconds: number, out: string) => { clips.push(out); await writeFile(out, 'wav') }),
    // Times on the section's clock: the section starts one second before the window.
    align: vi.fn(async () => ({ modelVersion: 'parakeet-int8', words: [
      { word: 'hola', start: 5, end: 5.4 }, { word: 'manuel', start: 5.5, end: 5.9 },
      { word: 'como', start: 8, end: 8.4 }, { word: 'estas', start: 8.5, end: 8.9 }] })),
    store: () => ({ load: () => undefined, save: () => {} }),
    ...overrides
  }
}

describe('fixTimesOnModelHost', () => {
  it('cuts only the window with its padding, and places the lines on the heard words on the recording clock', async () => {
    const d = deps()
    const outcome = await fixTimesOnModelHost({ recordingId: 'rec-1', audioPath: 'F:/audio/rec.hda', lines, window, durationSeconds: 600 }, d)
    expect(outcome.used).toBe(true)
    if (!outcome.used) return
    expect(d.extract).toHaveBeenCalledWith('F:/audio/rec.hda', 99, 32, expect.stringMatching(/section\.wav$/))
    expect(outcome.alignment.starts[0]).toBeCloseTo(104, 2)
    expect(outcome.alignment.starts[1]).toBeCloseTo(107, 2)
    expect(outcome.modelVersion).toBe('parakeet-int8')
    // The temporary section is gone.
    expect(existsSync(dirname(d.clips[0]))).toBe(false)
  })

  it('does not touch the host when this computer is not paired with one', async () => {
    const d = deps({ settings: () => null })
    const outcome = await fixTimesOnModelHost({ recordingId: 'rec-1', audioPath: 'a.hda', lines, window, durationSeconds: 600 }, d)
    expect(outcome).toMatchObject({ used: false, reason: expect.stringMatching(/paired/) })
    expect(d.extract).not.toHaveBeenCalled()
  })

  it('falls back with the reason when the host does not answer, and still removes the section', async () => {
    const d = deps({ align: vi.fn(async () => { throw new ModelHostUnavailableError('The model host did not answer.') }) })
    const outcome = await fixTimesOnModelHost({ recordingId: 'rec-1', audioPath: 'a.hda', lines, window, durationSeconds: 600 }, d)
    expect(outcome).toEqual({ used: false, reason: 'The model host did not answer.' })
    expect(existsSync(dirname(d.clips[0]))).toBe(false)
  })

  it('falls back when the heard words do not match the lines', async () => {
    const d = deps({ align: vi.fn(async () => ({ modelVersion: 'p', words: [{ word: 'otra', start: 3, end: 3.3 }, { word: 'cosa', start: 3.4, end: 3.8 }] })) })
    const outcome = await fixTimesOnModelHost({ recordingId: 'rec-1', audioPath: 'a.hda', lines, window, durationSeconds: 600 }, d)
    expect(outcome).toMatchObject({ used: false, reason: expect.stringMatching(/heard only 0/) })
  })

  it('falls back when the audio is not on this computer or the window is too long for a section', async () => {
    const missing = deps({ audioExists: () => false })
    expect(await fixTimesOnModelHost({ recordingId: 'rec-1', audioPath: 'a.hda', lines, window, durationSeconds: 600 }, missing))
      .toMatchObject({ used: false, reason: expect.stringMatching(/audio file/) })
    const long = deps()
    expect(await fixTimesOnModelHost({ recordingId: 'rec-1', audioPath: 'a.hda', lines, window: { start: 0, end: 3600 }, durationSeconds: 7200 }, long))
      .toMatchObject({ used: false, reason: expect.stringMatching(/minutes/) })
    expect(long.extract).not.toHaveBeenCalled()
  })

  it('reports a failed section cut as a reason, not a crash', async () => {
    const d = deps({ extract: vi.fn(async () => { throw new Error('Section audio extraction exited 1') }) })
    expect(await fixTimesOnModelHost({ recordingId: 'rec-1', audioPath: 'a.hda', lines, window, durationSeconds: 600 }, d))
      .toMatchObject({ used: false, reason: expect.stringMatching(/extraction/) })
  })
})

describe('memoryJobStore', () => {
  it('keeps a job identity for the click only, apart from every other click', () => {
    const one = memoryJobStore()
    one.save('k', { key: 'a' })
    expect(one.load('k')).toEqual({ key: 'a' })
    expect(memoryJobStore().load('k')).toBeUndefined()
  })
})
