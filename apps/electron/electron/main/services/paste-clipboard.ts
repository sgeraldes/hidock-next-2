import { fileURLToPath } from 'url'
import type { PasteSnapshot } from '../../../src/shared/paste-to-library'

interface ClipboardReader {
  read: () => Promise<Array<{ types: string[]; getType: (type: string) => Promise<Blob | Electron.ClipboardBookmark> }>>
}

/** Electron 44 maps Explorer's CF_HDROP to text/uri-list in the main process. */
export async function readPasteClipboard(reader: ClipboardReader): Promise<PasteSnapshot> {
  const items = await reader.read()
  const files: string[] = []
  for (const item of items) {
    if (!item.types.includes('text/uri-list')) continue
    const payload = await item.getType('text/uri-list')
    if (!(payload instanceof Blob)) continue
    for (const line of (await payload.text()).split(/\r?\n/)) {
      if (!line.startsWith('file://')) continue
      files.push(fileURLToPath(line))
    }
  }
  if (files.length) return { files }
  for (const item of items) {
    if (!item.types.includes('image/png')) continue
    const payload = await item.getType('image/png')
    if (payload instanceof Blob) return { png: new Uint8Array(await payload.arrayBuffer()) }
  }
  for (const item of items) {
    if (!item.types.includes('text/plain')) continue
    const payload = await item.getType('text/plain')
    if (payload instanceof Blob) return { text: await payload.text() }
  }
  return {}
}
