/**
 * What a second run of installer/setup.ps1 keeps from config.json.
 *
 * The real Merge-PreservedConfig and Save-HostConfig are cut out of the real setup.ps1
 * with PowerShell's own parser and run in Windows PowerShell 5.1, the shell the
 * installer uses, on a config.json made up here. Nothing else in setup.ps1 runs: no
 * download, no pip, no service, no production profile. The resulting file is then
 * read with the service's own loadConfig and handed to the service's own readiness
 * gates, over a synthetic host root whose fingerprints are computed by the real
 * fingerprint functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'
import { loadConfig } from '../src/config.mjs'
import { asrRuntimeFingerprint, readyAsrModels } from '../src/asr-readiness.mjs'
import { NATIVE_DIARIZATION_MODEL, nativeDiarizationFingerprint, readyNativeDiarization } from '../src/native-diarization.mjs'
import { SEMANTIC_MODEL, readySemanticEmbeddings, semanticFingerprint } from '../src/semantic-embeddings.mjs'
import { realtimeFingerprint, readyRealtime } from '../src/realtime-readiness.mjs'
import { REALTIME_MODEL } from '../src/realtime-gateway.mjs'

// Each case starts Windows PowerShell once, about a second on a quiet machine.
vi.setConfig({ testTimeout: 60_000 })

// HIDOCK_SETUP_UNDER_TEST points the same tests at a deliberately broken copy of
// setup.ps1, to show they fail when the behaviour they guard is removed.
const SETUP = process.env.HIDOCK_SETUP_UNDER_TEST || join(import.meta.dirname, '..', 'installer', 'setup.ps1')
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const COHERE = 'CohereLabs/cohere-transcribe-03-2026'
const TESTED_AT = '2026-10-11T16:16:50.073Z'

// The defaults setup.ps1 builds before it looks at the old file. Paths are what the
// new install would write; tlsCertPath and friends are added later by the real script.
const HARNESS = String.raw`
param(
  [Parameter(Mandatory = $true)] [string] $SetupScript,
  [Parameter(Mandatory = $true)] [string] $ConfigFile,
  [Parameter(Mandatory = $true)] [string] $Out,
  [Parameter(Mandatory = $true)] [string] $PythonPath
)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupScript, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "setup.ps1 does not parse: $($errors[0].Message)" }
$wanted = @('Merge-PreservedConfig', 'Save-HostConfig')
$found = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name }, $true))
if ($found.Count -ne $wanted.Count) { throw "setup.ps1 must define exactly: $($wanted -join ', ')" }
foreach ($function in $found) { Invoke-Expression $function.Extent.Text }

$config = [ordered]@{
  port = 8765
  cpuPercent = 50
  model = 'pyannote/speaker-diarization-3.1'
  fallbackModel = 'pyannote/speaker-diarization-3.1'
  minSpeechSeconds = 1.5
  timeoutMs = 3600000
  pythonPath = $PythonPath
  workerPath = 'NEW\worker.py'
  ffmpegPath = 'NEW\ffmpeg.exe'
  validated = $false
  stepAside = 'games'
  decideRuntime = $true
}
$result = [ordered]@{ error = $null; kept = @() }
# Same guard and same catch as the script.
if (Test-Path -LiteralPath $ConfigFile) {
  try { $result.kept = @(Merge-PreservedConfig -Config $config -ConfigFile $ConfigFile) }
  catch { $result.error = $_.Exception.Message }
}
Save-HostConfig -Config $config -ConfigFile $Out
[System.IO.File]::WriteAllText($Out + '.result.json', (ConvertTo-Json -InputObject $result -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
`

const DEFAULT_KEYS = ['port', 'cpuPercent', 'model', 'fallbackModel', 'minSpeechSeconds', 'timeoutMs', 'pythonPath',
  'workerPath', 'ffmpegPath', 'validated', 'stepAside', 'decideRuntime']

function write(root, relative, content) {
  const path = join(root, ...relative.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** A host root with just the files the four fingerprints read. */
function buildHostRoot(base) {
  const root = join(base, 'host')
  const python = write(root, 'runtime/python/python.exe', 'python-1')
  write(root, 'runtime/python/Lib/site-packages/transformers/__init__.py', 'transformers-1')
  const bin = 'runtime/asr-nemotron/nemo-speech-0.2.0-windows-x86_64-cuda/bin'
  write(root, `${bin}/nemo-speech.exe`, 'nemo-1')
  write(root, `${bin}/cudart64.dll`, 'dll-1')
  write(root, 'models/nemotron-3-diarization-gguf/hidock-manifest.json', '{"v":1}')
  write(root, 'models/nemotron-3-diarization-gguf/Nemotron-3-Diarization.q8_0.gguf', 'diarization-weights-1')
  write(root, 'models/nemotron-3.5-asr-streaming-0.6b-gguf/hidock-manifest.json', '{"v":1}')
  write(root, 'models/nemotron-3.5-asr-streaming-0.6b-gguf/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf', 'realtime-weights-1')

  const modelDir = join(root, 'models', 'nemotron-3-embed-1b')
  const files = {}
  for (const name of ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model.onnx', 'onnx/model.onnx.data']) {
    const path = write(modelDir, name, `asset ${name}`)
    const stat = statSync(path, { bigint: true })
    files[name] = { bytes: Number(stat.size), mtimeNs: stat.mtimeNs.toString() }
  }
  const spaceId = `nemotron-import-sha256:${'a'.repeat(64)}`
  writeFileSync(join(modelDir, 'hidock-semantic-manifest.json'), JSON.stringify({ model: SEMANTIC_MODEL, spaceId, files }))
  const siteDir = join(root, 'runtime', 'semantic-embeddings', 'site')
  write(siteDir, 'onnxruntime/__init__.py', 'onnxruntime-1')
  write(siteDir, 'onnxruntime/capi/onnxruntime_pybind11_state.pyd', 'pyd-1')
  return { root, python, modelDir, siteDir, spaceId }
}

/** What an earlier host run wrote to config.json: one proof per kind, fingerprints from the real functions. */
function validatedState(host) {
  return {
    asrModels: [COHERE],
    asrValidation: { [COHERE]: { testedAt: TESTED_AT, modelVersion: 'cohere-é-1', device: 'cuda',
      fingerprint: asrRuntimeFingerprint(host.python, COHERE, host.root) } },
    diarizationValidation: { [NATIVE_DIARIZATION_MODEL]: { testedAt: TESTED_AT, modelVersion: 'nemotron-diarization-1',
      device: 'cuda', fingerprint: nativeDiarizationFingerprint(host.python, host.root) } },
    semanticEmbeddingValidation: { testedAt: TESTED_AT, modelVersion: host.spaceId, spaceId: host.spaceId, dimensions: 2048,
      device: 'cpu', runtimeVersion: '1.0', fingerprint: semanticFingerprint(host.python, host.modelDir, host.siteDir) },
    // Deeper than ConvertTo-Json's default depth of 2, and with a float.
    realtimeAsrValidation: { model: REALTIME_MODEL, device: 'cuda', testedAt: TESTED_AT, partialBeforeCommit: true,
      cleanShutdown: true, success: true, sourceHash: 'ab'.repeat(32), fingerprint: realtimeFingerprint(host.python, host.root),
      events: [{ type: 'delta', ms: 120.25, characters: 4 }],
      diagnostics: { resourcePolicy: { threads: 4, priority: 'below-normal', nested: { deeper: [{ level: 5 }] } } } },
  }
}

/** Ask the service's own gates, the way main.mjs does. */
function gates(config, host) {
  return {
    asr: readyAsrModels(config, config.pythonPath, (python, model) => asrRuntimeFingerprint(python, model, host.root)),
    diarization: readyNativeDiarization(config, config.pythonPath, host.root),
    semantic: readySemanticEmbeddings(config.semanticEmbeddingValidation,
      { pythonPath: config.pythonPath, modelDir: host.modelDir, siteDir: host.siteDir }),
    realtime: readyRealtime(config.realtimeAsrValidation, config.pythonPath, host.root),
  }
}

describe.runIf(process.platform === 'win32' && existsSync(POWERSHELL))('setup.ps1 keeps the validated state across a reinstall', () => {
  let base
  let host

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hidock-config-merge-'))
    host = buildHostRoot(base)
    writeFileSync(join(base, 'harness.ps1'), HARNESS)
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  /** Run the real helpers on `previous` (text or Buffer; null = no old file) and read back what they wrote. */
  function merge(previous) {
    const configFile = join(base, 'old-config.json')
    const out = join(base, 'new-config.json')
    if (previous !== null) writeFileSync(configFile, previous)
    const run = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(base, 'harness.ps1'),
      '-SetupScript', SETUP, '-ConfigFile', configFile, '-Out', out, '-PythonPath', host.python],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    const text = readFileSync(out, 'utf8').replace(/^\uFEFF/, '')
    return {
      raw: JSON.parse(text),
      text,
      config: loadConfig(out),
      result: JSON.parse(readFileSync(`${out}.result.json`, 'utf8')),
    }
  }

  const json = (value) => JSON.stringify(value)

  it('keeps the diarization proof the old whitelist dropped, and the service still accepts it', () => {
    const state = validatedState(host)
    const { config, result } = merge(json({ port: 8765, ...state }))
    expect(config.diarizationValidation).toEqual(state.diarizationValidation)
    expect(result.kept).toContain('diarizationValidation')
    expect(gates(config, host).diarization).toBe(true)
  })

  it('keeps every other proof exactly as written, nested events and non-ASCII text included, and every gate accepts', () => {
    const state = validatedState(host)
    const { config } = merge(json({ port: 8765, ...state }))
    for (const name of Object.keys(state)) expect(config[name]).toEqual(state[name])
    expect(gates(config, host)).toEqual({ asr: [COHERE], diarization: true, semantic: true, realtime: true })
  })

  it('reads a config with and without a byte order mark the same way', () => {
    const state = validatedState(host)
    const body = json({ port: 8765, ...state })
    const withBom = merge(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]))
    const withoutBom = merge(Buffer.from(body, 'utf8'))
    expect(withBom.config.asrValidation[COHERE].modelVersion).toBe('cohere-é-1')
    expect(withoutBom.config.asrValidation[COHERE].modelVersion).toBe('cohere-é-1')
    expect(withBom.raw).toEqual(withoutBom.raw)
  })

  // Each change is made to the runtime after the proofs were written and before the merge,
  // which is the order of a real upgrade: setup reinstalls packages, then writes config.json.
  const changes = {
    'the private Python': { change: () => write(host.root, 'runtime/python/python.exe', 'python-2'), rejects: ['asr', 'diarization', 'semantic', 'realtime'] },
    'the transformers package': { change: () => write(host.root, 'runtime/python/Lib/site-packages/transformers/__init__.py', 'transformers-2'), rejects: ['asr'] },
    'the diarization weights': { change: () => write(host.root, 'models/nemotron-3-diarization-gguf/Nemotron-3-Diarization.q8_0.gguf', 'diarization-weights-2-longer'), rejects: ['diarization'] },
    'the native speech runtime shared by diarization and realtime': { change: () => write(host.root, 'runtime/asr-nemotron/nemo-speech-0.2.0-windows-x86_64-cuda/bin/nemo-speech.exe', 'nemo-2'), rejects: ['diarization', 'realtime'] },
    'the realtime weights': { change: () => write(host.root, 'models/nemotron-3.5-asr-streaming-0.6b-gguf/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf', 'realtime-weights-2-longer'), rejects: ['realtime'] },
    'a semantic asset': { change: () => write(host.modelDir, 'onnx/model.onnx', 'a different model'), rejects: ['semantic'] },
  }

  it.each(Object.entries(changes))('keeps the proof but no gate trusts it after %s changed', (_name, { change, rejects }) => {
    const state = validatedState(host)
    change()
    const { config } = merge(json({ port: 8765, ...state }))
    // Kept untouched in the file: the decision belongs to the fingerprint check.
    for (const name of Object.keys(state)) expect(config[name]).toEqual(state[name])
    const verdict = gates(config, host)
    const expected = { asr: [COHERE], diarization: true, semantic: true, realtime: true }
    for (const gate of rejects) expected[gate] = gate === 'asr' ? [] : false
    expect(verdict).toEqual(expected)
  })

  it('does not turn a model on that never passed its test', () => {
    const { config } = merge(json({ port: 8765, asrModels: [COHERE], asrValidation: {} }))
    expect(config.asrModels).toEqual([COHERE])
    expect(gates(config, host).asr).toEqual([])
    const noFingerprint = merge(json({ port: 8765, asrModels: [COHERE],
      asrValidation: { [COHERE]: { testedAt: TESTED_AT, modelVersion: 'x', device: 'cuda' } } }))
    expect(gates(noFingerprint.config, host).asr).toEqual([])
  })

  it('keeps the owner\'s policy, takes paths and runtime detection from this install, and re-tests pyannote', () => {
    const { config, raw, result } = merge(json({
      port: 9100, stepAside: 'never', cpuPercent: 25, bindAddress: '127.0.0.1', timeoutMs: 600000, minSpeechSeconds: 2.5,
      model: 'pyannote/speaker-diarization-community-1', fallbackModel: 'pyannote/speaker-diarization-3.1',
      pythonPath: 'OLD\\python.exe', workerPath: 'OLD\\worker.py', ffmpegPath: 'OLD\\ffmpeg.exe', decideRuntime: false,
      validated: true, validatedDevice: 'cuda', tlsCertPath: 'OLD\\cert.pem', tlsKeyPath: 'OLD\\key.pem', tlsPort: 9101,
    }))
    expect(raw).toMatchObject({ port: 9100, stepAside: 'never', cpuPercent: 25, bindAddress: '127.0.0.1', timeoutMs: 600000,
      minSpeechSeconds: 2.5, model: 'pyannote/speaker-diarization-community-1', fallbackModel: 'pyannote/speaker-diarization-3.1' })
    expect(raw.pythonPath).toBe(host.python)
    expect(raw.workerPath).toBe('NEW\\worker.py')
    expect(raw.ffmpegPath).toBe('NEW\\ffmpeg.exe')
    expect(raw.decideRuntime).toBe(true)
    expect(raw.validated).toBe(false)
    for (const dropped of ['validatedDevice', 'tlsCertPath', 'tlsKeyPath', 'tlsPort']) expect(raw).not.toHaveProperty(dropped)
    expect(result.kept).toEqual(expect.arrayContaining(['port', 'stepAside', 'cpuPercent', 'bindAddress']))
    expect(config.validated).toBe(false)
  })

  it('does not carry secrets or unknown keys into the new file', () => {
    const secret = 'synthetic-secret-not-a-real-token'
    const { text, raw } = merge(json({ port: 8765, hfToken: secret, modelHostToken: secret, token: secret,
      asrValidation: { [COHERE]: { testedAt: TESTED_AT, modelVersion: 'x', device: 'cuda', fingerprint: 'f' } }, asrModels: [COHERE],
      somethingElse: { nested: secret } }))
    expect(text).not.toContain(secret)
    for (const name of ['hfToken', 'modelHostToken', 'token', 'somethingElse']) expect(raw).not.toHaveProperty(name)
  })

  it('adds nothing when the old file is from a version that kept only the port and step-aside', () => {
    const { raw, result } = merge(json({ port: 8765, stepAside: 'games' }))
    expect(Object.keys(raw)).toEqual(DEFAULT_KEYS)
    expect(result.kept).toEqual(['port', 'stepAside'])
  })

  it('leaves the defaults alone when there is no old file', () => {
    const { raw, result } = merge(null)
    expect(Object.keys(raw)).toEqual(DEFAULT_KEYS)
    expect(raw.port).toBe(8765)
    expect(result).toEqual({ error: null, kept: [] })
  })

  it.each([
    ['zero', 0], ['negative', -1], ['too high for port + 1', 65535], ['past the range', 70000],
    ['a fraction', 8765.5], ['text', 'abc'], ['an object', { n: 1 }], ['null', null],
  ])('falls back to port 8765 when the old port is %s', (_name, port) => {
    const { raw, result } = merge(json({ port, stepAside: 'never' }))
    expect(raw.port).toBe(8765)
    expect(result.kept).not.toContain('port')
    expect(raw.stepAside).toBe('never')
  })

  it('accepts a port written as text and the highest port that leaves room for the TLS port', () => {
    expect(merge(json({ port: '9100' })).raw.port).toBe(9100)
    expect(merge(json({ port: 65534 })).raw.port).toBe(65534)
  })

  it.each([
    ['not JSON', '{ this is not json'],
    ['an array', '[]'],
    ['a string', '"text"'],
    ['null', 'null'],
    ['an empty file', ''],
  ])('starts from the defaults and says why when the old file is %s', (_name, content) => {
    const { raw, result } = merge(content)
    expect(Object.keys(raw)).toEqual(DEFAULT_KEYS)
    expect(raw.port).toBe(8765)
    expect(result.kept).toEqual([])
    expect(result.error).toEqual(expect.any(String))
  })

  it('does not copy a value the old file left null', () => {
    const { raw } = merge(json({ port: 8765, asrValidation: null, diarizationValidation: null, bindAddress: null }))
    for (const name of ['asrValidation', 'diarizationValidation', 'bindAddress']) expect(raw).not.toHaveProperty(name)
  })
})
