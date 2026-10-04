import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { stage } from '../scripts/build-installer.mjs'
import { resolveFfmpeg } from '../src/main.mjs'

describe('the installer payload', () => {
  let dir
  let fakes

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hidock-stage-test-'))
    fakes = mkdtempSync(join(tmpdir(), 'hidock-stage-fakes-'))
    writeFileSync(join(fakes, 'node.exe'), 'node')
    writeFileSync(join(fakes, 'ffmpeg.exe'), 'ffmpeg')
    writeFileSync(join(fakes, 'HiDockModelHost.exe'), 'tray')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(fakes, { recursive: true, force: true })
  })

  function build() {
    return stage(join(dir, 'stage'), {
      nodePath: join(fakes, 'node.exe'),
      ffmpegPath: join(fakes, 'ffmpeg.exe'),
      trayPath: join(fakes, 'HiDockModelHost.exe'),
    })
  }

  it('ships the tray icon, and no scripts or pages for the person to run', () => {
    const out = build()
    expect(readFileSync(join(out, 'HiDockModelHost.exe'), 'utf8')).toBe('tray')
    expect(existsSync(join(out, 'Start Model Host.cmd'))).toBe(false)
    expect(existsSync(join(out, 'Set up Model Host.cmd'))).toBe(false)
    expect(existsSync(join(out, 'src', 'pause-resume.ps1'))).toBe(false)
  })

  it('refuses to build without the tray icon', () => {
    expect(() =>
      stage(join(dir, 'stage'), {
        nodePath: join(fakes, 'node.exe'),
        ffmpegPath: join(fakes, 'ffmpeg.exe'),
        trayPath: join(fakes, 'missing.exe'),
      })
    ).toThrow(/tray icon/)
  })

  it('ships ffmpeg, because the worker decodes every file with it and the GPU machine has none', () => {
    const out = build()
    expect(readFileSync(join(out, 'ffmpeg.exe'), 'utf8')).toBe('ffmpeg')
  })

  it('ships the client versions as pip constraints, so the host runs the same packages', () => {
    const out = build()
    const constraints = readFileSync(join(out, 'constraints.txt'), 'utf8')
    expect(constraints).toMatch(/^torch==\d+\.\d+\.\d+$/m)
    expect(constraints).toMatch(/^pyannote-audio==4\./m)
    // A local tag (+cu126) is the torch index's business; PyPI never has it.
    expect(constraints).not.toMatch(/\+cu\d+/)
  })

  it('ships the worker the client runs', () => {
    const out = build()
    expect(existsSync(join(out, 'resources', 'speaker-linking', 'worker.py'))).toBe(true)
  })

  it('refuses to build without ffmpeg instead of shipping a host that fails every job', () => {
    expect(() =>
      stage(join(dir, 'stage'), {
        nodePath: join(fakes, 'node.exe'),
        ffmpegPath: join(fakes, 'missing.exe'),
        trayPath: join(fakes, 'HiDockModelHost.exe'),
      })
    ).toThrow(/ffmpeg/i)
  })
})

describe('resolveFfmpeg', () => {
  const exists = (present) => (path) => present.includes(path)

  it('uses the configured path first', () => {
    expect(resolveFfmpeg('C:\\x\\ffmpeg.exe', 'C:\\inst', {}, exists(['C:\\x\\ffmpeg.exe']))).toBe(
      'C:\\x\\ffmpeg.exe'
    )
  })

  it('falls back to the copy installed next to the host', () => {
    const bundled = join('C:\\inst', 'ffmpeg.exe')
    expect(resolveFfmpeg('', 'C:\\inst', {}, exists([bundled]))).toBe(bundled)
  })

  it('then to FFMPEG_PATH, then to nothing so the worker searches PATH', () => {
    expect(resolveFfmpeg('', 'C:\\inst', { FFMPEG_PATH: 'D:\\f.exe' }, exists([]))).toBe('D:\\f.exe')
    expect(resolveFfmpeg('', 'C:\\inst', {}, exists([]))).toBe('')
  })
})
