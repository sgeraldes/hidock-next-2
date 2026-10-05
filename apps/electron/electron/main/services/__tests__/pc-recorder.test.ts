/** @vitest-environment node */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PcRecorder } from '../pc-recorder'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true }) })
function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'pc-recorder-test-'))
  folders.push(folder)
  const imported = vi.fn(async (path: string) => {
    expect(readFileSync(path)).toEqual(Buffer.from([1, 2, 3, 4]))
    return { success: true, recording: { id: 'library-id' } }
  })
  return { folder, imported, recorder: new PcRecorder(folder, imported) }
}
describe('durable PC recording', () => {
  it('does not import twice when recovery calls overlap', async () => {
    const { recorder, imported } = setup()
    const id = recorder.start(); recorder.append(id, 0, new Uint8Array([1, 2, 3, 4])); recorder.close()
    let complete!: () => void
    imported.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { complete = resolve })
      return { success: true, recording: { id: 'library-id' } }
    })
    const first = recorder.recover()
    const second = recorder.recover()
    expect(imported).toHaveBeenCalledOnce()
    complete(); await Promise.all([first, second])
  })
  it('writes ordered chunks immediately and imports on stop', async () => {
    const { recorder, imported, folder } = setup()
    const id = recorder.start()
    recorder.append(id, 0, new Uint8Array([1, 2]))
    expect(readFileSync(join(folder, readdirSync(folder)[0]))).toEqual(Buffer.from([1, 2]))
    recorder.append(id, 1, new Uint8Array([3, 4]))
    expect(imported).not.toHaveBeenCalled()
    expect(await recorder.finish(id)).toMatchObject({ success: true })
    expect(imported).toHaveBeenCalledOnce()
    expect(readdirSync(folder)).toEqual([])
  })
  it('recovers persisted chunks after a crash without starting capture', async () => {
    const { recorder, folder, imported } = setup()
    const id = recorder.start()
    recorder.append(id, 0, new Uint8Array([1, 2, 3, 4]))
    recorder.close()
    await new PcRecorder(folder, imported).recover()
    expect(imported).toHaveBeenCalledOnce()
    expect(readdirSync(folder)).toEqual([])
  })
  it('keeps a partial on import failure and retries recovery', async () => {
    const { recorder, folder, imported } = setup()
    imported.mockResolvedValueOnce({ success: false, error: 'Disk full' } as never)
    const id = recorder.start()
    recorder.append(id, 0, new Uint8Array([1, 2, 3, 4]))
    expect(await recorder.finish(id)).toMatchObject({ success: false })
    expect(readdirSync(folder)).toHaveLength(1)
    await recorder.recover()
    expect(readdirSync(folder)).toEqual([])
  })
  it('rejects another session, out-of-order data and concurrent start', () => {
    const { recorder } = setup()
    const id = recorder.start()
    expect(() => recorder.start()).toThrow(/already/)
    expect(() => recorder.append('wrong', 0, new Uint8Array([1]))).toThrow(/session/)
    expect(() => recorder.append(id, 1, new Uint8Array([1]))).toThrow(/order/)
    recorder.close()
  })
})
