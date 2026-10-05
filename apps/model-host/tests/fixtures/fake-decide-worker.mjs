// Stands in for src/decide_worker.py: the same line protocol and the same --download mode.
import { createInterface } from 'readline'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

if (flag('--download')) {
  const dir = flag('--dir')
  const bytes = Number(process.env.FAKE_DOWNLOAD_BYTES || 1000)
  const delay = Number(process.env.FAKE_DOWNLOAD_MS || 0)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'model-00001.safetensors'), Buffer.alloc(Math.floor(bytes / 2)))
  setTimeout(() => {
    writeFileSync(join(dir, 'model-00002.safetensors'), Buffer.alloc(Math.ceil(bytes / 2)))
    writeFileSync(join(dir, 'revision.txt'), flag('--revision'))
    process.exit(Number(process.env.FAKE_DOWNLOAD_CODE || 0))
  }, delay)
} else {
  let loaded = null
  let loads = 0
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    const reply = (body) => process.stdout.write(`${JSON.stringify({ id: message.id, ...body })}\n`)
    if (message.op === 'load') {
      loads++
      loaded = { path: message.path, quantize: message.quantize, device: message.device }
      setTimeout(() => reply({ ok: true, seconds: 0.01, vramMiB: 100 }), Number(process.env.FAKE_LOAD_MS || 0))
      return
    }
    if (message.op === 'decide') {
      const state = String(message.request.state)
      if (state === 'hang') return
      if (state === 'die') process.exit(3)
      if (state === 'invalid') return reply({ ok: false, invalid: true, error: 'criteria must not be empty' })
      return reply({
        ok: true,
        ms: 1,
        response: { model: message.request.model, answers: {}, usage: {}, loaded, loads, pid: process.pid },
      })
    }
    reply({ ok: false, error: `unknown op ${message.op}` })
  })
}
