// @vitest-environment node

/**
 * Unit tests for saveRecording's atomic write + cancellation cleanup (Phase-1).
 *
 * Uses a REAL temporary recordings directory (config is mocked to point at it) so we
 * exercise the actual writeFileSync → rename path and can assert on files on disk.
 *
 * Verifies:
 *  - a normal save produces the final file and leaves NO `.partial` temp behind
 *  - a cancel between staging and rename produces NO final file and cleans the temp
 *  - a cancel never deletes a pre-existing valid recording (collision → suffix)
 *  - a write failure cleans up the temp and rethrows
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, linkSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

let recordingsDir: string

// linkSync passes through to the real filesystem; only the "unsupported hard links"
// tests swap in a failing implementation for a single call.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, linkSync: vi.fn(actual.linkSync) }
})

vi.mock('../config', () => ({
  getConfig: () => ({ storage: { recordingsPath: recordingsDir, transcriptsPath: join(recordingsDir, '..', 'transcripts') } }),
  getDataPath: () => recordingsDir,
}))

import { saveRecording, replaceRecordingFile, RecordingPublicationError } from '../file-storage'
import { downloadWithResume, releaseResumedDownload, forgetPublishedResume, type ResumeSource } from '../download-resume'

async function resumedBytes(bytes: Buffer) {
  const expected: ResumeSource = { deviceId: 'atomic-fixture', sessionId: 'one', model: 'H1E', firmware: '6.3.0', filename: 'rec.hda', size: bytes.length,
    signature: 'one', listingComplete: true, completed: true }
  return downloadWithResume({ directory: recordingsDir, expected, adapter: { snapshot: async () => expected,
    readRange: async (_name, _size, offset, count, onChunk) => { onChunk(bytes.subarray(offset, offset + count)); return { status: 'complete', offset, count, received: count, reason: null } } } })
}

describe('saveRecording — atomic write + cancellation cleanup', () => {
  beforeEach(async () => {
    recordingsDir = mkdtempSync(join(tmpdir(), 'hidock-atomic-'))
    const actual = await vi.importActual<typeof import('fs')>('fs')
    vi.mocked(linkSync).mockReset().mockImplementation(actual.linkSync)
  })

  afterEach(() => {
    rmSync(recordingsDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const partials = () => readdirSync(recordingsDir).filter((f) => f.includes('.partial'))

  it('owned resumed bytes/checkpoint survive cancellation before publication', async () => {
    const bytes = Buffer.from('committed-resume-bytes'), staged = await resumedBytes(bytes)
    try {
      expect(await saveRecording('rec.hda', staged, undefined, undefined, { isCancelled: () => true })).toBeNull()
      expect(readFileSync(staged.path)).toEqual(bytes)
      expect(readdirSync(recordingsDir).some(name => name.endsWith('.json'))).toBe(true)
      expect(existsSync(join(recordingsDir, 'rec.wav'))).toBe(false)
    } finally { releaseResumedDownload(staged) }
  })

  it('owned resumed bytes survive failed audio replacement without damaging the old recording', async () => {
    const old = join(recordingsDir, 'rec.wav'); writeFileSync(old, Buffer.from('old'))
    const bytes = Buffer.from('not-decodable-resumed-audio'), staged = await resumedBytes(bytes)
    try {
      await expect(replaceRecordingFile(old, staged)).rejects.toThrow('not readable audio')
      expect(readFileSync(old)).toEqual(Buffer.from('old'))
      expect(readFileSync(staged.path)).toEqual(bytes)
    } finally { releaseResumedDownload(staged) }
  })

  it('completed resumed publication keeps its exact bytes and releases its checkpoint/lease', async () => {
    const bytes = Buffer.from('committed-resume-bytes'), staged = await resumedBytes(bytes)
    const target = await saveRecording('rec.hda', staged)
    await forgetPublishedResume(staged)
    expect(readFileSync(target!)).toEqual(bytes)
    expect(partials()).toHaveLength(0)
    expect(readdirSync(recordingsDir).some(name => name.endsWith('.json'))).toBe(false)
  })

  it('writes the final file and leaves no .partial temp behind', async () => {
    const data = Buffer.from('hello world')
    const filePath = await saveRecording('2025Dec15-100105-Rec22.hda', data)

    expect(filePath).toBe(join(recordingsDir, '2025Dec15-100105-Rec22.wav'))
    expect(existsSync(filePath as string)).toBe(true)
    expect(readFileSync(filePath as string)).toEqual(data)
    expect(partials()).toHaveLength(0)
  })

  it('cancels between staging and rename: no final file, temp cleaned up, returns null', async () => {
    const data = Buffer.from('abc')
    const result = await saveRecording('rec.hda', data, undefined, undefined, {
      isCancelled: () => true, // cancel fires right after the temp is written
    })

    expect(result).toBeNull()
    expect(existsSync(join(recordingsDir, 'rec.wav'))).toBe(false)
    expect(partials()).toHaveLength(0) // temp cleaned up
    expect(readdirSync(recordingsDir)).toHaveLength(0)
  })

  it('never deletes a pre-existing valid recording on cancel (collision → suffix)', async () => {
    // Pre-existing valid recording at the target name.
    const existingPath = join(recordingsDir, 'rec.wav')
    writeFileSync(existingPath, Buffer.from('ORIGINAL'))

    // A cancelled save for the same device file must NOT touch the original.
    const result = await saveRecording('rec.hda', Buffer.from('NEW'), undefined, undefined, {
      isCancelled: () => true,
    })

    expect(result).toBeNull()
    expect(existsSync(existingPath)).toBe(true)
    expect(readFileSync(existingPath)).toEqual(Buffer.from('ORIGINAL')) // untouched
    expect(partials()).toHaveLength(0)
  })

  it('a completed save alongside an existing file gets a numeric suffix (no overwrite)', async () => {
    writeFileSync(join(recordingsDir, 'rec.wav'), Buffer.from('ORIGINAL'))

    const filePath = await saveRecording('rec.hda', Buffer.from('NEW'))
    expect(filePath).toBe(join(recordingsDir, 'rec-1.wav'))
    expect(readFileSync(join(recordingsDir, 'rec.wav'))).toEqual(Buffer.from('ORIGINAL'))
    expect(readFileSync(filePath as string)).toEqual(Buffer.from('NEW'))
    expect(partials()).toHaveLength(0)
  })

  describe('exclusive publication on the real filesystem', () => {
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
    const stagedFile = (bytes: Buffer, name = '.hidock-0a1b2c3d-1111-2222-3333-444455556666.partial') => {
      const path = join(recordingsDir, name)
      writeFileSync(path, bytes)
      return { path, length: bytes.length, sha256: sha(bytes) }
    }
    const failLinkOnce = (code: string) => {
      vi.mocked(linkSync).mockImplementationOnce(() => {
        throw Object.assign(new Error(`${code}: hard links are not supported here`), { code })
      })
    }

    it('a destination created between preflight and publication is never overwritten', async () => {
      const source = Buffer.from('SOURCE-BYTES-0123456789'), competing = Buffer.from('COMPETING-BYTES')
      const target = join(recordingsDir, 'race.wav')
      // isCancelled runs after staging and right before publication: the race window.
      const result = await saveRecording('race.hda', source, undefined, undefined, {
        isCancelled: () => { writeFileSync(target, competing); return false },
      })

      expect(result).toBe(join(recordingsDir, 'race-1.wav'))
      expect(readFileSync(target)).toEqual(competing)
      expect(sha(readFileSync(result!))).toBe(sha(source))
      expect(partials()).toHaveLength(0)
    })

    it('a staged download that loses the race publishes its exact bytes under a suffix and keeps the competitor', async () => {
      const source = Buffer.from('STAGED-SOURCE-BYTES-abcdef'), competing = Buffer.from('COMPETING-STAGED')
      const staged = stagedFile(source)
      const target = join(recordingsDir, 'staged.wav')
      const result = await saveRecording('staged.hda', staged, undefined, undefined, {
        isCancelled: () => { writeFileSync(target, competing); return false },
      })

      expect(result).toBe(join(recordingsDir, 'staged-1.wav'))
      expect(readFileSync(target)).toEqual(competing)
      expect(sha(readFileSync(result!))).toBe(staged.sha256)
      expect(existsSync(staged.path)).toBe(false)
    })

    it('EEXIST on several consecutive suffixes keeps walking and preserves every competitor', async () => {
      const source = Buffer.from('WALK-SOURCE')
      const result = await saveRecording('walk.hda', source, undefined, undefined, {
        isCancelled: () => {
          writeFileSync(join(recordingsDir, 'walk.wav'), 'c0')
          writeFileSync(join(recordingsDir, 'walk-1.wav'), 'c1')
          writeFileSync(join(recordingsDir, 'walk-2.wav'), 'c2')
          return false
        },
      })

      expect(result).toBe(join(recordingsDir, 'walk-3.wav'))
      expect(readFileSync(join(recordingsDir, 'walk.wav'), 'utf8')).toBe('c0')
      expect(readFileSync(join(recordingsDir, 'walk-1.wav'), 'utf8')).toBe('c1')
      expect(readFileSync(join(recordingsDir, 'walk-2.wav'), 'utf8')).toBe('c2')
      expect(readFileSync(result!)).toEqual(source)
    })

    it('HDA is published as WAV and keeps the device name, including its suffixed form', async () => {
      const name = '2025Dec15-100105-Rec22'
      writeFileSync(join(recordingsDir, `${name}.wav`), 'EARLIER')
      const result = await saveRecording(`${name}.hda`, Buffer.from('HDA-PAYLOAD'))

      expect(result).toBe(join(recordingsDir, `${name}-1.wav`))
      expect(readFileSync(join(recordingsDir, `${name}.wav`), 'utf8')).toBe('EARLIER')
      expect(readFileSync(result!, 'utf8')).toBe('HDA-PAYLOAD')
    })

    describe('HDA container naming follows the bytes', () => {
      // Rec07's real first bytes: MPEG-2 Layer III, 128 kbps, 16 kHz, stereo.
      const rawMp3 = () => Buffer.concat([Buffer.from([0xff, 0xf3, 0xc8, 0x04]), Buffer.alloc(2000, 0x55)])
      const trueWav = () => {
        const data = Buffer.alloc(3200, 1), header = Buffer.alloc(44)
        header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'latin1')
        header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
        header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
        header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40)
        return Buffer.concat([header, data])
      }

      it('raw MPEG bytes from a Buffer are published as .mp3 with the device stem', async () => {
        const bytes = rawMp3()
        const result = await saveRecording('2026Oct13-100306-Rec07.hda', bytes)

        expect(result).toBe(join(recordingsDir, '2026Oct13-100306-Rec07.mp3'))
        expect(readFileSync(result!)).toEqual(bytes)
        expect(partials()).toHaveLength(0)
      })

      it('raw MPEG bytes in a staged file are published as .mp3 with the exact bytes and no staging name left', async () => {
        const bytes = rawMp3()
        const staged = stagedFile(bytes)
        const result = await saveRecording('staged-mpeg.hda', staged)

        expect(result).toBe(join(recordingsDir, 'staged-mpeg.mp3'))
        expect(sha(readFileSync(result!))).toBe(staged.sha256)
        expect(existsSync(staged.path)).toBe(false)
      })

      it('an ID3-tagged stream is published as .mp3', async () => {
        const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64, 0)])
        const result = await saveRecording('tagged.hda', id3)

        expect(result).toBe(join(recordingsDir, 'tagged.mp3'))
      })

      it('a real RIFF/WAVE stays .wav', async () => {
        const result = await saveRecording('pcm.hda', trueWav())

        expect(result).toBe(join(recordingsDir, 'pcm.wav'))
      })

      it('unrecognised or too-short bytes keep the old .wav name', async () => {
        expect(await saveRecording('junk.hda', Buffer.from('hello world, not audio'))).toBe(join(recordingsDir, 'junk.wav'))
        expect(await saveRecording('tiny.hda', Buffer.from([0xff]))).toBe(join(recordingsDir, 'tiny.wav'))
        expect(await saveRecording('empty.hda', Buffer.alloc(0))).toBe(join(recordingsDir, 'empty.wav'))
        // sync bits set but a reserved layer: not an MPEG frame
        expect(await saveRecording('reserved.hda', Buffer.from([0xff, 0xf9, 0xc8, 0x04, 0, 0]))).toBe(join(recordingsDir, 'reserved.wav'))
      })

      it('files that are not .hda keep their own name whatever the bytes are', async () => {
        const result = await saveRecording('already.wav', rawMp3())

        expect(result).toBe(join(recordingsDir, 'already.wav'))
      })

      it('an existing .mp3 of the same stem is never overwritten (numeric suffix, same extension)', async () => {
        writeFileSync(join(recordingsDir, 'dup.mp3'), 'EARLIER')
        const result = await saveRecording('dup.hda', rawMp3())

        expect(result).toBe(join(recordingsDir, 'dup-1.mp3'))
        expect(readFileSync(join(recordingsDir, 'dup.mp3'), 'utf8')).toBe('EARLIER')
      })

      it('cancel still leaves nothing behind for a raw MPEG download', async () => {
        const result = await saveRecording('cancel-mpeg.hda', rawMp3(), undefined, undefined, { isCancelled: () => true })

        expect(result).toBeNull()
        expect(readdirSync(recordingsDir)).toHaveLength(0)
      })
    })

    it('a mapped HDA name collides with an existing WAV and two HDA saves of one name never share a file', async () => {
      const first = await saveRecording('same.wav', Buffer.from('ONE'))
      const second = await saveRecording('same.hda', Buffer.from('TWO'))
      const third = await saveRecording('same.hda', Buffer.from('THREE'))

      expect(first).toBe(join(recordingsDir, 'same.wav'))
      expect(second).toBe(join(recordingsDir, 'same-1.wav'))
      expect(third).toBe(join(recordingsDir, 'same-2.wav'))
      expect(readFileSync(first!, 'utf8')).toBe('ONE')
      expect(readFileSync(second!, 'utf8')).toBe('TWO')
      expect(readFileSync(third!, 'utf8')).toBe('THREE')
      expect(readdirSync(recordingsDir).sort()).toEqual(['same-1.wav', 'same-2.wav', 'same.wav'])
    })

    it('the original date is applied to the published file and the staging name is gone', async () => {
      const date = new Date('2025-12-15T10:01:05.000Z')
      const result = await saveRecording('dated.hda', Buffer.from('DATED'), undefined, date)

      expect(Math.abs(statSync(result!).mtime.getTime() - date.getTime())).toBeLessThan(2000)
      expect(partials()).toHaveLength(0)
    })

    it('unsupported hard links fail loudly, publish nothing and never fall back to an overwrite', async () => {
      const competing = join(recordingsDir, 'nolink.wav')
      writeFileSync(competing, 'EXISTING')
      failLinkOnce('EPERM')

      await expect(saveRecording('nolink.hda', Buffer.from('NEW'))).rejects.toBeInstanceOf(RecordingPublicationError)
      expect(readFileSync(competing, 'utf8')).toBe('EXISTING')
      expect(readdirSync(recordingsDir)).toEqual(['nolink.wav'])
      expect(vi.mocked(linkSync)).toHaveBeenCalledTimes(1)
    })

    it('a staged download keeps its complete stage when hard links are unsupported', async () => {
      const source = Buffer.from('COMPLETE-STAGE-BYTES')
      const staged = stagedFile(source)
      failLinkOnce('ENOTSUP')

      const failure = await saveRecording('kept.hda', staged).catch((error) => error)
      expect(failure).toBeInstanceOf(RecordingPublicationError)
      expect((failure as RecordingPublicationError).code).toBe('ENOTSUP')
      expect(sha(readFileSync(staged.path))).toBe(staged.sha256)
      expect(existsSync(join(recordingsDir, 'kept.wav'))).toBe(false)
    })

    it('an owned resumed download keeps bytes and checkpoint when hard links are unsupported', async () => {
      const bytes = Buffer.from('resume-bytes-no-link'), staged = await resumedBytes(bytes)
      try {
        failLinkOnce('EPERM')
        await expect(saveRecording('rec.hda', staged)).rejects.toBeInstanceOf(RecordingPublicationError)
        expect(readFileSync(staged.path)).toEqual(bytes)
        expect(readdirSync(recordingsDir).some((name) => name.endsWith('.json'))).toBe(true)
        expect(existsSync(join(recordingsDir, 'rec.wav'))).toBe(false)
      } finally { releaseResumedDownload(staged) }
    })

    it('an owned resumed download that loses the race is published exactly and its checkpoint is released', async () => {
      const bytes = Buffer.from('resume-bytes-race'), staged = await resumedBytes(bytes)
      const target = await saveRecording('rec.hda', staged, undefined, undefined, {
        isCancelled: () => { writeFileSync(join(recordingsDir, 'rec.wav'), 'COMPETITOR'); return false },
      })
      await forgetPublishedResume(staged)

      expect(target).toBe(join(recordingsDir, 'rec-1.wav'))
      expect(readFileSync(join(recordingsDir, 'rec.wav'), 'utf8')).toBe('COMPETITOR')
      expect(readFileSync(target!)).toEqual(bytes)
      expect(readdirSync(recordingsDir).some((name) => name.endsWith('.json') || name.includes('.partial'))).toBe(false)
    })

    it('only EEXIST is retried: any other link error is thrown on the first attempt', async () => {
      failLinkOnce('EXDEV')
      const failure = await saveRecording('once.hda', Buffer.from('X')).catch((error) => error)

      expect(failure).toBeInstanceOf(RecordingPublicationError)
      expect((failure as RecordingPublicationError).code).toBe('EXDEV')
      expect(vi.mocked(linkSync)).toHaveBeenCalledTimes(1)
      expect(readdirSync(recordingsDir)).toHaveLength(0)
    })

    it('replaceRecordingFile still replaces the same path on purpose', async () => {
      const wav = (samples: number) => {
        const data = Buffer.alloc(samples * 2, 1), header = Buffer.alloc(44)
        header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'latin1')
        header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
        header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
        header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40)
        return Buffer.concat([header, data])
      }
      const target = join(recordingsDir, 'replace.wav'), longer = wav(16000)
      writeFileSync(target, wav(4000))

      const replaced = await replaceRecordingFile(target, longer)

      expect(replaced?.filePath).toBe(target)
      expect(readFileSync(target)).toEqual(longer)
      expect(readdirSync(recordingsDir)).toEqual(['replace.wav'])
    })
  })

  it('rethrows when the write fails and leaves no partial behind', async () => {
    // Remove the recordings dir so writeFileSync(tempPath) fails with ENOENT — a real
    // failure that exercises the catch → cleanup → rethrow path without fragile mocks.
    rmSync(recordingsDir, { recursive: true, force: true })

    await expect(saveRecording('rec.hda', Buffer.from('data'))).rejects.toThrow()
    expect(existsSync(recordingsDir)).toBe(false) // nothing (re)created
  })
})
