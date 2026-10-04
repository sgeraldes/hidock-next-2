import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// The real Python worker, against a stand-in for the model repo's
// joint_schema_model.py with the same two functions. No torch needed.
const worker = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'decide_worker.py')
const python = process.env.HIDOCK_TEST_PYTHON || 'python'

const STUB = `
LOADS = []

def load_release_model(path, device="cuda", **kwargs):
    if "quantization_config" in kwargs:
        raise RuntimeError("the stand-in does not quantize")
    LOADS.append(path)
    return {"path": path, "device": device, "loads": len(LOADS)}, "processor"

def systemone(model, processor, request, max_length=16384):
    questions = request.get("questions")
    if not questions:
        raise ValueError("at least one question is required")
    return {
        "model": request["model"],
        "answers": {key: {"type": "noul", "noul": 0.75} for key in questions},
        "usage": {"input_tokens": len(str(request["state"])), "output_tokens": 0},
        "seen": {"device": model["device"], "maxLength": max_length, "loads": model["loads"]},
    }
`

function startWorker() {
  const child = spawn(python, [worker], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const lines = createInterface({ input: child.stdout })
  const waiting = []
  lines.on('line', (line) => waiting.shift()?.(JSON.parse(line)))
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const ask = (message) =>
    new Promise((resolve, reject) => {
      waiting.push(resolve)
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error && reject(error))
    })
  return { child, ask, stderr: () => stderr }
}

describe('the decision worker', () => {
  let dir
  let modelDir

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hidock-decide-worker-'))
    modelDir = join(dir, 'clef-flash@17f0b0ad64ef')
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(modelDir, 'joint_schema_model.py'), STUB)
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('loads a model once and answers decisions with it, line by line', async () => {
    const { child, ask } = startWorker()
    try {
      const loaded = await ask({ id: 1, op: 'load', path: modelDir, quantize: 'none', device: 'cpu' })
      expect(loaded).toMatchObject({ id: 1, ok: true })
      expect(typeof loaded.seconds).toBe('number')

      const request = { model: 'clef-flash', state: 'the checkout is down', questions: { outage: { type: 'noul' } } }
      const first = await ask({ id: 2, op: 'decide', request })
      const second = await ask({ id: 3, op: 'decide', request })
      expect(first).toMatchObject({ id: 2, ok: true })
      expect(first.response.answers.outage).toEqual({ type: 'noul', noul: 0.75 })
      expect(first.response.seen).toEqual({ device: 'cpu', maxLength: 16384, loads: 1 })
      expect(second.response.seen.loads).toBe(1)
      expect(typeof first.ms).toBe('number')
    } finally {
      child.kill()
    }
  })

  it('says what was wrong with a request and keeps running', async () => {
    const { child, ask } = startWorker()
    try {
      const early = await ask({ id: 1, op: 'decide', request: { model: 'clef-flash', state: 'x', questions: {} } })
      expect(early).toMatchObject({ id: 1, ok: false })
      expect(early.error).toMatch(/no model is loaded/)

      await ask({ id: 2, op: 'load', path: modelDir, quantize: 'none', device: 'cpu' })
      const invalid = await ask({ id: 3, op: 'decide', request: { model: 'clef-flash', state: 'x', questions: {} } })
      expect(invalid).toMatchObject({ id: 3, ok: false, invalid: true })
      expect(invalid.error).toMatch(/at least one question/)

      const unknown = await ask({ id: 4, op: 'nonsense' })
      expect(unknown).toMatchObject({ id: 4, ok: false })

      const still = await ask({ id: 5, op: 'decide', request: { model: 'clef-flash', state: 'x', questions: { a: { type: 'noul' } } } })
      expect(still).toMatchObject({ id: 5, ok: true })
    } finally {
      child.kill()
    }
  })

  it('reports a load that fails and stays ready for the next one', async () => {
    const { child, ask } = startWorker()
    try {
      // nf4 needs transformers; on this machine, or with the stand-in, it fails.
      const failed = await ask({ id: 1, op: 'load', path: modelDir, quantize: 'nf4', device: 'cpu' })
      expect(failed).toMatchObject({ id: 1, ok: false })
      const loaded = await ask({ id: 2, op: 'load', path: modelDir, quantize: 'none', device: 'cpu' })
      expect(loaded).toMatchObject({ id: 2, ok: true })
    } finally {
      child.kill()
    }
    // Importing torch and transformers for nf4 takes seconds where they are installed.
  }, 60_000)

  it('exits by itself when the host closes its input', async () => {
    const { child } = startWorker()
    const code = await new Promise((resolve) => {
      child.on('close', resolve)
      child.stdin.end()
    })
    expect(code).toBe(0)
  })
})
