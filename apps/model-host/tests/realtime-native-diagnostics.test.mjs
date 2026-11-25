import { describe, expect, it } from 'vitest'
import { hasNativeCudaProcess, recordNativeReady, recordSupervisorEvent } from '../src/realtime-native-runtime.mjs'

describe('native realtime diagnostic provenance', () => {
  it('requires the exact native CUDA compute PID, including WDDM unknown memory', () => {
    expect(hasNativeCudaProcess('42, 1080 MiB\n99, 150 MiB', 42)).toBe(true)
    expect(hasNativeCudaProcess('42, [N/A]', 42)).toBe(true)
    expect(hasNativeCudaProcess('142, 1080 MiB', 42)).toBe(false)
    expect(hasNativeCudaProcess('42, 1080 MiB', null)).toBe(false)
    expect(hasNativeCudaProcess('No running processes found', 42)).toBe(false)
    expect(hasNativeCudaProcess('', 42)).toBe(false)
  })
  it('does not claim CUDA from requested /ready label or CLI echo', () => {
    const diagnostics = {}
    recordNativeReady(diagnostics, { ready: true, device: 'cuda:0' })
    recordSupervisorEvent(diagnostics, { nativeStderrTail: 'command --device cuda', observedDevice: 'cuda' })
    expect(diagnostics).toMatchObject({ nativeReady: true, requestedDeviceLabel: 'cuda:0', observedDevice: null })
  })
  it('keeps absent backend explicitly unknown', () => {
    const diagnostics = {}
    recordNativeReady(diagnostics, { ready: true })
    expect(diagnostics.observedDevice).toBeNull()
    expect(diagnostics.requestedDeviceLabel).toBeNull()
  })
  it('retains observed PID, resource enforcement and actual exit separately', () => {
    const diagnostics = {}
    recordSupervisorEvent(diagnostics, { nativePid: 42, resourcePolicy: { memoryMb: 8192, cpuPercent: 50 } })
    recordSupervisorEvent(diagnostics, { nativeExitCode: 1, nativeTerminatedOnStop: true, nativeStderrTail: 'x'.repeat(8000) })
    expect(diagnostics.nativePid).toBe(42)
    expect(diagnostics.nativeExitCode).toBe(1)
    expect(diagnostics.nativeTerminatedOnStop).toBe(true)
    expect(diagnostics.nativeStderrTail.length).toBe(4000)
    expect(diagnostics.resourcePolicy.memoryMb).toBe(8192)
    expect(diagnostics.observedDevice).toBeUndefined()
  })
})
