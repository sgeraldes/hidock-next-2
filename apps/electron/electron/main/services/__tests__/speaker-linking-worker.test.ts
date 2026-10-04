import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { join } from 'path'

// The real worker.py, imported without pyannote: the speaker list it prints is built by a pure
// function, and HiDock parses that output with JSON.parse.
const workerDir = join(__dirname, '..', '..', '..', '..', 'resources', 'speaker-linking')
const python = process.env.HIDOCK_TEST_PYTHON || 'python'

function voicedSpeakers(input: unknown): string {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(workerDir)})`,
    'from worker import voiced_speakers, result_json',
    'args = json.loads(sys.stdin.read())',
    'nan = float("nan")',
    'rows = [[nan if v == "nan" else v for v in row] for row in args["rows"]]',
    'print(result_json({"speakers": voiced_speakers(args["labels"], rows, args["seconds"], args["min"])}))',
  ].join('\n')
  return execFileSync(python, ['-c', script], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true })
}

describe('the speakers the diarization worker reports', () => {
  it('keeps every speaker with enough speech and a usable voiceprint', () => {
    const out = JSON.parse(
      voicedSpeakers({ labels: ['A', 'B'], rows: [[0.1, 0.2], [0.3, 0.4]], seconds: { A: 12.5, B: 3 }, min: 1.5 })
    )
    expect(out.speakers).toEqual([
      { label: 'A', embedding: [0.1, 0.2], speechSeconds: 12.5 },
      { label: 'B', embedding: [0.3, 0.4], speechSeconds: 3 },
    ])
  })

  it('leaves out a speaker whose voiceprint came back NaN, so the output stays valid JSON', () => {
    // On the gamestation, 4-oct: [NaN,NaN,...] for one speaker, and JSON.parse refused the whole result.
    const raw = voicedSpeakers({ labels: ['A', 'B'], rows: [[0.1, 0.2], ['nan', 'nan']], seconds: { A: 12.5, B: 4 }, min: 1.5 })
    expect(raw).not.toMatch(/NaN/)
    expect(JSON.parse(raw).speakers.map((s: { label: string }) => s.label)).toEqual(['A'])
  })

  it('leaves out a speaker below the minimum speech, as before', () => {
    const out = JSON.parse(voicedSpeakers({ labels: ['A'], rows: [[0.1]], seconds: { A: 1 }, min: 1.5 }))
    expect(out.speakers).toEqual([])
  })
})
