// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
}))

const db = vi.hoisted(() => ({
  addToQueue: vi.fn(),
  resolveRecordingId: vi.fn(),
  setTranscriptIntegrityAccepted: vi.fn(),
}))
vi.mock('../../services/database', () => db)

const transcription = vi.hoisted(() => ({ processQueueManually: vi.fn() }))
vi.mock('../../services/transcription', () => transcription)

import { registerTranscriptIntegrityHandlers } from '../transcript-integrity-handlers'

const call = (channel: string, payload: unknown) => handlers.get(channel)!({}, payload) as Promise<any>

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerTranscriptIntegrityHandlers()
  db.resolveRecordingId.mockImplementation((id: string) => (id.startsWith('missing') ? undefined : { id }))
})

describe('transcripts:retranscribeMany', () => {
  it('queues each recording once, counts what could not be queued, and starts the queue', async () => {
    db.addToQueue.mockImplementation((id: string) => (id === 'personal' ? '' : `q-${id}`))

    const result = await call('transcripts:retranscribeMany', { recordingIds: ['a', 'b', 'a', 'personal', 'missing-1'] })

    expect(result).toEqual({ success: true, data: { queued: 2, skipped: 2 } })
    expect(db.addToQueue).toHaveBeenCalledTimes(3)
    expect(transcription.processQueueManually).toHaveBeenCalledTimes(1)
  })

  it('does not start the queue when nothing was queued', async () => {
    db.addToQueue.mockReturnValue('')
    const result = await call('transcripts:retranscribeMany', { recordingIds: ['a'] })
    expect(result.data).toEqual({ queued: 0, skipped: 1 })
    expect(transcription.processQueueManually).not.toHaveBeenCalled()
  })

  it('refuses a malformed request', async () => {
    expect((await call('transcripts:retranscribeMany', { recordingIds: [] })).success).toBe(false)
    expect((await call('transcripts:retranscribeMany', { recordingIds: 'a' })).success).toBe(false)
    expect((await call('transcripts:retranscribeMany', null)).success).toBe(false)
    expect(db.addToQueue).not.toHaveBeenCalled()
  })
})

describe('transcripts:setIntegrityAccepted', () => {
  it('accepts and un-accepts through the resolved recording id', async () => {
    db.setTranscriptIntegrityAccepted.mockReturnValue(true)
    expect(await call('transcripts:setIntegrityAccepted', { recordingId: 'r1', accepted: true })).toEqual({
      success: true,
      data: { accepted: true },
    })
    expect(db.setTranscriptIntegrityAccepted).toHaveBeenCalledWith('r1', true)
  })

  it('reports a recording without a transcript, or one that does not exist', async () => {
    db.setTranscriptIntegrityAccepted.mockReturnValue(false)
    expect((await call('transcripts:setIntegrityAccepted', { recordingId: 'r1', accepted: true })).error.code).toBe('NOT_FOUND')
    expect((await call('transcripts:setIntegrityAccepted', { recordingId: 'missing-2', accepted: true })).error.code).toBe('NOT_FOUND')
    expect((await call('transcripts:setIntegrityAccepted', { recordingId: 'r1', accepted: 'yes' })).error.code).toBe('VALIDATION_ERROR')
  })
})
