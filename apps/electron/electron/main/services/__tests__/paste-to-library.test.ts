// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { classifyPaste, importPaste, type PasteDeps } from '../paste-to-library'

function setup() {
  const deps: PasteDeps = {
    artifact: vi.fn(async (path) => ({ id: 'capture', title: path })),
    note: vi.fn(async (text) => ({ id: 'note', title: text.split('\n')[0].slice(0, 80) })),
    bitmap: vi.fn(async () => ({ id: 'image', title: 'Screenshot.png' })),
    audio: vi.fn(async () => ({ id: 'audio', title: 'Audio' })),
    video: vi.fn(async () => ({ id: 'video', title: 'Video' })),
    connector: vi.fn(async () => null),
    link: vi.fn(async (url) => ({ id: 'link', title: url }))
  }
  return deps
}
describe('paste classifier', () => {
  it.each([['photo.png', 'image'], ['doc.pdf', 'pdf'], ['song.MP3', 'audio'], ['clip.mp4', 'video'], ['notes.txt', 'note'], ['archive.zip', 'file']])('%s → %s', (file, kind) => {
    expect(classifyPaste({ files: [file], text: 'ignored' })[0]).toEqual({ kind, path: file })
  })
  it('prioritizes files, then bitmap, then URL or text', () => {
    expect(classifyPaste({ png: new Uint8Array([1]), text: 'ignored' })[0].kind).toBe('image')
    expect(classifyPaste({ text: ' https://example.com/x ' })[0].kind).toBe('url')
    expect(classifyPaste({ text: 'https://example.com\nmy note' })[0].kind).toBe('note')
    expect(classifyPaste({ text: '   ' })).toEqual([])
  })
})
describe('paste import paths', () => {
  it.each([
    ['https://team.slack.com/archives/C123', 'Slack'],
    ['https://team.atlassian.net/browse/ABC-1', 'Jira']
  ])('explains missing and failed connectors for %s', async (text, name) => {
    const deps = setup()
    expect((await importPaste({ text }, deps))[0].connectorFallback).toBe(`the ${name} connector is not set up`)
    vi.mocked(deps.connector).mockRejectedValueOnce(new Error('HTTP 403'))
    expect((await importPaste({ text }, deps))[0].connectorFallback).toBe(`the ${name} connector failed: HTTP 403`)
  })
  it('routes every file kind independently and continues after a failed file', async () => {
    const deps = setup()
    vi.mocked(deps.artifact).mockRejectedValueOnce(new Error('Unreadable PDF'))
    const results = await importPaste({ files: ['doc.pdf', 'shot.png', 'notes.txt', 'audio.wav', 'video.mov', 'archive.zip'] }, deps)
    expect(results).toHaveLength(6)
    expect(results[0].error).toContain('Unreadable PDF')
    expect(deps.artifact).toHaveBeenCalledWith('notes.txt')
    expect(deps.audio).toHaveBeenCalledWith('audio.wav')
    expect(deps.video).toHaveBeenCalledWith('video.mov')
  })
  it('imports bitmap and plain text without connector or URL fetch', async () => {
    const deps = setup()
    await importPaste({ png: new Uint8Array([1, 2]) }, deps)
    await importPaste({ text: 'first line\nbody' }, deps)
    expect(deps.bitmap).toHaveBeenCalled()
    expect(deps.note).toHaveBeenCalledWith('first line\nbody')
    expect(deps.connector).not.toHaveBeenCalled()
  })
  it('uses configured connector content and falls back when missing or failed', async () => {
    const deps = setup()
    vi.mocked(deps.connector).mockResolvedValueOnce({ id: 'slack', title: 'Thread' }).mockRejectedValueOnce(new Error('Forbidden'))
    expect((await importPaste({ text: 'https://team.slack.com/archives/C123/p1234567890123456' }, deps))[0].id).toBe('slack')
    expect(deps.link).not.toHaveBeenCalled()
    await importPaste({ text: 'https://team.atlassian.net/browse/ABC-1' }, deps)
    expect(deps.link).toHaveBeenCalledWith('https://team.atlassian.net/browse/ABC-1')
  })
  it('never passes arbitrary hosts to a credentialed connector', async () => {
    const deps = setup()
    await importPaste({ text: 'https://slack.com.evil.test/archives/C123' }, deps)
    expect(deps.connector).not.toHaveBeenCalled()
    expect(deps.link).toHaveBeenCalled()
  })
  it('reports empty clipboard and fetch errors clearly', async () => {
    const deps = setup()
    expect((await importPaste({}, deps))[0].error).toContain('empty')
    vi.mocked(deps.link).mockRejectedValue(new Error('HTTP 403'))
    expect((await importPaste({ text: 'https://example.com' }, deps))[0].error).toContain('HTTP 403')
  })
})
