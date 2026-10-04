import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectDiagnostics, repairRuntime, stageUpdate, UPDATE_EXIT_CODE } from '../src/maintenance.mjs'
import { HostSetup } from '../src/host-setup.mjs'

const dirs = []
const tempRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'hidock-maint-'))
  dirs.push(d)
  mkdirSync(join(d, 'logs'), { recursive: true })
  return { root: d, logs: join(d, 'logs') }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('diagnostics HiDock can read over the paired connection', () => {
  it('returns the end of both logs and what torch says about CUDA', async () => {
    const d = tempRoot()
    writeFileSync(join(d.logs, 'setup.log'), 'old line\n'.repeat(5000) + '== This machine\n  GPU: NVIDIA GeForce RTX 4090\n')
    writeFileSync(join(d.logs, 'service.log'), '[host] listening on 8765\n')
    const run = async (file, args) => {
      expect(file).toBe('C:\\rt\\python.exe')
      expect(args[0]).toBe('-c')
      return { stdout: '{"torch":"2.13.0+cpu","cudaBuild":null,"cudaAvailable":false,"device":null}\n' }
    }
    const report = await collectDiagnostics({ dirs: d, pythonPath: 'C:\\rt\\python.exe', run })
    expect(report.setupLog.length).toBeLessThanOrEqual(16 * 1024)
    expect(report.setupLog).toMatch(/RTX 4090\n$/)
    expect(report.serviceLog).toMatch(/listening/)
    expect(report.torch).toEqual({ torch: '2.13.0+cpu', cudaBuild: null, cudaAvailable: false, device: null })
  })

  it('says what failed instead of failing, when a log or Python is missing', async () => {
    const d = tempRoot()
    const run = async () => {
      throw new Error('spawn python.exe ENOENT')
    }
    const report = await collectDiagnostics({ dirs: d, pythonPath: 'x', run })
    expect(report.setupLog).toBe('')
    expect(report.torch).toEqual({ error: 'spawn python.exe ENOENT' })
  })
})

describe('repairing the runtime', () => {
  it('reinstalls the pinned torch from the CUDA index, then checks CUDA', async () => {
    const d = tempRoot()
    const constraints = join(d.root, 'constraints.txt')
    writeFileSync(constraints, 'numpy==2.4.6\ntorch==2.13.0\ntorchaudio==2.11.0\n')
    const calls = []
    const run = async (file, args) => {
      calls.push(args)
      if (args[0] === '-c') return { stdout: '{"torch":"2.13.0+cu126","cudaBuild":"12.6","cudaAvailable":true,"device":"NVIDIA GeForce RTX 4090"}\n' }
      return { stdout: '' }
    }
    const result = await repairRuntime({ pythonPath: 'py', constraintsPath: constraints, logFile: join(d.logs, 'repair.log'), run })
    expect(calls[0]).toEqual([
      '-m', 'pip', 'install', '--no-warn-script-location', '--force-reinstall', '--no-deps',
      '--index-url', 'https://download.pytorch.org/whl/cu126', 'torch==2.13.0', 'torchaudio==2.11.0',
    ])
    expect(result).toMatchObject({ cudaAvailable: true, device: 'NVIDIA GeForce RTX 4090' })
    expect(readFileSync(join(d.logs, 'repair.log'), 'utf8')).toMatch(/cuda/i)
  })

  it('refuses to guess the versions when constraints.txt does not pin them', async () => {
    const d = tempRoot()
    const constraints = join(d.root, 'constraints.txt')
    writeFileSync(constraints, 'numpy==2.4.6\n')
    await expect(repairRuntime({ pythonPath: 'py', constraintsPath: constraints, logFile: join(d.logs, 'r.log'), run: async () => ({ stdout: '' }) })).rejects.toThrow(/pin/)
  })

  it('setup reports repairing, then proves the model again', async () => {
    const statuses = []
    let release
    const setup = new HostSetup({
      validated: true,
      hfToken: 'hf_abcdefghijklmnop', // pragma: allowlist secret
      diarize: async () => ({ model: 'm', modelVersion: '1', device: 'cuda', segments: [], speakers: [] }),
      jobOptions: () => ({}),
      saveToken: () => {},
      saveValidated: () => {},
      repair: () => new Promise((r) => (release = r)),
    })
    const pending = setup.repair()
    statuses.push(setup.report().status)
    release({ cudaAvailable: true })
    await pending
    await setup.idle()
    statuses.push(setup.report().status)
    expect(statuses).toEqual(['repairing', 'ready'])
    expect(setup.report().device).toBe('cuda')
  })
})

describe('an update sent by HiDock', () => {
  it('keeps a Windows executable where the tray icon runs it from, and nothing else', () => {
    const d = tempRoot()
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096)])
    const path = stageUpdate({ root: d.root }, exe)
    expect(path).toBe(join(d.root, 'update', 'HiDock-Model-Host-Setup.exe'))
    expect(readFileSync(path).subarray(0, 2).toString()).toBe('MZ')
    expect(() => stageUpdate({ root: d.root }, Buffer.from('#!/bin/sh\nrm -rf /'))).toThrow(/not a Windows program/)
  })

  it('exits with the code the tray icon reads as "run the update"', () => {
    expect(UPDATE_EXIT_CODE).toBe(75)
  })
})
