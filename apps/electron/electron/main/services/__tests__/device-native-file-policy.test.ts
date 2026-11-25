/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

const env = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => env.userData } }))
beforeEach(() => { vi.resetModules(); env.userData = mkdtempSync(join(tmpdir(), 'native-policy-')) })
afterEach(() => { expect(dirname(env.userData)).toBe(resolve(tmpdir())); rmSync(env.userData, { recursive: true, force: true }) })

describe('durable exact-file native verification policy', () => {
  it('writes a real flushed intent record and survives a fresh module with exact extension variants', async () => {
    const policy = await import('../device-native-file-policy')
    const name = '2026Oct11-120000-Rec01.hda'
    await policy.markNativeFileManualOnly(name)
    const dir = join(env.userData, 'native-file-policies')
    const entries = readdirSync(dir)
    expect(entries).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, entries[0]), 'utf8'))).toMatchObject({ filename: name, manualOnly: true })
    vi.resetModules()
    const restarted = await import('../device-native-file-policy')
    for (const ext of ['hda', 'mp3', 'wav']) {
      expect(restarted.isNativeFileManualOnly(`2026Oct11-120000-Rec01.${ext}`)).toBe(true)
      expect(restarted.isNativeFileManualOnly(`G:\\Recordings\\2026Oct11-120000-Rec01.${ext.toUpperCase()}`)).toBe(true)
    }
    expect(restarted.isNativeFileManualOnly('2026Oct11-120001-Rec01.mp3')).toBe(false)
    expect(restarted.isNativeFileManualOnly('2026Oct11-120000-Rec010.mp3')).toBe(false)
    expect(restarted.isNativeFileManualOnly('2026Oct11-120000-Rec01-2.mp3')).toBe(false)
  })

  it('fails closed only for a matching corrupt or interrupted registry entry after restart', async () => {
    const policy = await import('../device-native-file-policy')
    await policy.markNativeFileManualOnly('test-native.mp3')
    const dir = join(env.userData, 'native-file-policies')
    const path = join(dir, readdirSync(dir)[0])
    writeFileSync(path, '{broken')
    const pendingStem = 'interrupted-native'
    const pending = join(dir, `${createHash('sha256').update(pendingStem).digest('hex')}.manual-only.json.pending`)
    writeFileSync(pending, '')
    vi.resetModules()
    const restarted = await import('../device-native-file-policy')
    expect(restarted.isNativeFileManualOnly('test-native.wav')).toBe(true)
    expect(restarted.isNativeFileManualOnly('interrupted-native.hda')).toBe(true)
    expect(restarted.isNativeFileManualOnly('other-native.mp3')).toBe(false)
    await restarted.markNativeFileManualOnly('interrupted-native.mp3')
    expect(readdirSync(dir).some(name => name.endsWith('.pending'))).toBe(false)
  })

  it('rejects path registration and surfaces persistence failure without enabling automatic work', async () => {
    const policy = await import('../device-native-file-policy')
    for (const name of ['../test.mp3', 'G:\\test.mp3', '/test.mp3', ' test.mp3', '..', '', '.mp3']) {
      await expect(policy.markNativeFileManualOnly(name)).rejects.toThrow()
    }
    writeFileSync(join(env.userData, 'native-file-policies'), 'not a directory')
    await expect(policy.markNativeFileManualOnly('new-native.mp3')).rejects.toThrow()
    expect(policy.isNativeFileManualOnly('new-native.mp3')).toBe(true)
  })
})
