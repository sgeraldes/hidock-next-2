/**
 * Thread budget for the diarization worker (2026-09-21).
 *
 * pyannote on a CPU-only box (this machine: Ryzen 9 7900X3D, 24 logical CPUs,
 * AMD GPU so torch's CUDA build never activates) sized its pools from the CPU
 * count and pinned half the machine per recording, for the whole run, with a
 * 6-hour timeout and a 154-recording backlog. diarizationThreadEnv turns the
 * configured share into the variables every layer of the stack reads.
 *
 * The arithmetic is what these pin: a 0, negative or NaN thread count makes
 * OpenMP fall back to "all cores" — the exact failure this exists to prevent.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  // The budget follows the process's effective affinity, not the machine's
  // CPU count — this is what the perf harness restricts.
  availableParallelism: () => 24,
}))
vi.mock('../database', () => ({
  queryAll: vi.fn(), queryOne: vi.fn(), runInTransaction: vi.fn(), runNoSave: vi.fn(),
}))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {} }) }))

import { diarizationThreadEnv } from '../speaker-linking'

const VARS = ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'TORCH_NUM_THREADS', 'HIDOCK_DIARIZATION_THREADS']

describe('diarizationThreadEnv', () => {
  it('turns the configured share of 24 CPUs into a thread count on every variable', () => {
    const env = diarizationThreadEnv(40)
    for (const v of VARS) expect(env[v]).toBe('10') // round(24 * 0.40) = 10
  })

  it('defaults to 40% when the config says nothing', () => {
    expect(diarizationThreadEnv(undefined).OMP_NUM_THREADS).toBe('10')
  })

  it('never emits fewer than one thread', () => {
    expect(diarizationThreadEnv(1).OMP_NUM_THREADS).toBe('1')     // round(0.24) = 0 → clamped
  })

  it('never emits more threads than the machine has', () => {
    expect(diarizationThreadEnv(100).OMP_NUM_THREADS).toBe('24')
    expect(diarizationThreadEnv(500).OMP_NUM_THREADS).toBe('24')  // >100 clamps to 100
  })

  it('treats garbage as the default rather than as "all cores"', () => {
    expect(diarizationThreadEnv(0).OMP_NUM_THREADS).toBe('10')
    expect(diarizationThreadEnv(-5).OMP_NUM_THREADS).toBe('10')
    expect(diarizationThreadEnv(Number.NaN).OMP_NUM_THREADS).toBe('10')
  })
})
