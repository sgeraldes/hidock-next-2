import { afterEach, expect, it } from 'vitest'
import { runDiarization } from '../src/diarize.mjs'

const previous = { encoding: process.env.PYTHONIOENCODING, utf8: process.env.PYTHONUTF8 }
afterEach(() => {
  for (const [key, value] of [['PYTHONIOENCODING', previous.encoding], ['PYTHONUTF8', previous.utf8]]) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it('preserves multilingual JSON across a real Python pipe despite inherited Windows encoding', async () => {
  process.env.PYTHONIOENCODING = 'cp1252'
  process.env.PYTHONUTF8 = '0'
  const expected = 'acción deberá niño français 日本語'
  const result = await runDiarization(Buffer.from('fixture'), {
    pythonPath: process.env.TEST_PYTHON || 'python',
    workerArgs: () => ['-c',
      'import json; print(json.dumps({"text": ' + JSON.stringify(expected) + '}, ensure_ascii=False))'],
    parseOutput: JSON.parse,
    cpuPercent: 1,
    timeoutMs: 10000,
  })
  expect(result.text).toBe(expected)
  expect(result.text).not.toContain('\uFFFD')
}, 15000)
