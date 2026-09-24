/**
 * One local voice job at a time: the short-recording lane must never put a second
 * pyannote/ONNX worker beside the main lane's (review of #42).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../database', () => ({
  queryAll: vi.fn(() => []),
  queryOne: vi.fn(),
  runInTransaction: vi.fn((fn: () => unknown) => fn()),
  runNoSave: vi.fn()
}))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {} }), getDataPath: () => '', updateConfig: vi.fn() }))

import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inVoiceSlot, isDirectMlFailure, voiceOnnxReady } from '../speaker-linking'

describe('inVoiceSlot', () => {
  it('runs voice jobs one after another, never together', async () => {
    let running = 0
    let most = 0
    const order: string[] = []
    const job = (name: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        running += 1
        most = Math.max(most, running)
        order.push(`start ${name}`)
        setTimeout(() => {
          running -= 1
          order.push(`end ${name}`)
          resolve(name)
        }, ms)
      })
    const results = await Promise.all([inVoiceSlot(job('main', 30)), inVoiceSlot(job('short', 5))])
    expect(results).toEqual(['main', 'short'])
    expect(most).toBe(1)
    expect(order).toEqual(['start main', 'end main', 'start short', 'end short'])
  })

  it('keeps going after a job fails', async () => {
    const failed = inVoiceSlot(() => Promise.reject(new Error('worker died')))
    await expect(failed).rejects.toThrow('worker died')
    await expect(inVoiceSlot(() => Promise.resolve('next'))).resolves.toBe('next')
  })
})

describe('isDirectMlFailure', () => {
  it('reruns on the CPU only for failures of DirectML itself', () => {
    expect(isDirectMlFailure(new Error("Non-zero status code returned while running Conv node. DmlExecutionProvider"))).toBe(true)
    expect(isDirectMlFailure(new Error('DirectML is not available in this Python environment'))).toBe(true)
    expect(isDirectMlFailure(new Error('speaker-linking timed out after 600 seconds'))).toBe(false)
    expect(isDirectMlFailure(new Error('speaker-linking cancelled because recording became ineligible'))).toBe(false)
    expect(isDirectMlFailure(new Error('invalid speaker-linking worker output: worker returned an incomplete result'))).toBe(false)
    expect(isDirectMlFailure(new Error('ffmpeg could not decode the audio'))).toBe(false)
    // An onnxruntime error that is not about DirectML (bad model, bad input) would fail on the CPU too.
    expect(isDirectMlFailure(new Error('onnxruntime: Invalid input shape for waveforms'))).toBe(false)
  })
})

describe('voiceOnnxReady', () => {
  it('accepts a folder only when every file in the manifest exists with its size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidock-voice-onnx-'))
    try {
      expect(voiceOnnxReady(dir)).toBe(false)
      writeFileSync(join(dir, 'wespeaker-resnet34-lm-masked.onnx'), 'abcd')
      writeFileSync(join(dir, 'segmentation-3.0.onnx'), 'xy')
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: { 'wespeaker-resnet34-lm-masked.onnx': 4, 'segmentation-3.0.onnx': 2 } }))
      expect(voiceOnnxReady(dir)).toBe(true)
      writeFileSync(join(dir, 'segmentation-3.0.onnx'), 'x') // truncated
      expect(voiceOnnxReady(dir)).toBe(false)
      rmSync(join(dir, 'segmentation-3.0.onnx'))
      expect(voiceOnnxReady(dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
