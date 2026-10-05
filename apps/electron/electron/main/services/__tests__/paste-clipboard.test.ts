// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { readPasteClipboard } from '../paste-clipboard'

it('reads file URI lists before bitmap and plain text without touching the OS clipboard', async () => {
  const read = vi.fn(async () => [{ types: ['text/uri-list', 'image/png', 'text/plain'], getType: vi.fn(async () => new Blob(['file:///C:/fixtures/photo.png\r\nfile:///C:/fixtures/video.mp4'])) }])
  expect(await readPasteClipboard({ read })).toEqual({ files: ['C:\\fixtures\\photo.png', 'C:\\fixtures\\video.mp4'] })
})
it('reads a screenshot and plain text from fake clipboard items', async () => {
  const snapshot = await readPasteClipboard({ read: async () => [{ types: ['image/png'], getType: async () => new Blob([new Uint8Array([1, 2])]) }] })
  expect(snapshot.png).toEqual(new Uint8Array([1, 2]))
  expect(await readPasteClipboard({ read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['hello']) }] })).toEqual({ text: 'hello' })
})
