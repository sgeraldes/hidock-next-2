/**
 * IPC for hand-written notes.
 *
 * Writing and reading a note never touches the network. The four AI channels
 * are separate on purpose: each one can fail, be slow, or be unavailable
 * without the editor noticing.
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  MAX_NOTE_BYTES,
  updateNote,
} from '../services/notes'
import {
  analyzeNote,
  findRelated,
  indexNote,
  meetingHappeningNow,
  suggestMeetings,
} from '../services/note-intelligence'

const IdSchema = z.object({ id: z.string().trim().min(1).max(64) })

const CreateSchema = z.object({
  content: z.string().max(MAX_NOTE_BYTES).optional(),
  /**
   * True when the person is writing during a recording. The main process
   * resolves which meeting that is; the renderer must not, because the
   * calendar lives here and a renderer clock can be wrong.
   */
  live: z.boolean().optional(),
})

const ListSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().min(0).optional(),
  search: z.string().max(500).optional(),
})

const UpdateSchema = z.object({
  id: z.string().trim().min(1).max(64),
  content: z.string().max(MAX_NOTE_BYTES).optional(),
  title: z.string().max(500).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  meetingId: z.string().max(64).nullable().optional(),
  recordingId: z.string().max(64).nullable().optional(),
  linkSource: z.enum(['live', 'user', 'suggested']).nullable().optional(),
})

export function registerNotesHandlers(): void {
  ipcMain.handle('notes:create', async (_event, raw: unknown) => {
    const parsed = CreateSchema.safeParse(raw ?? {})
    if (!parsed.success) return { success: false, error: 'invalid note' }
    const meetingId = parsed.data.live ? meetingHappeningNow() : null
    const note = createNote({
      content: parsed.data.content,
      meetingId,
      // No meeting covering this moment means no link, not a guess.
      linkSource: meetingId ? 'live' : null,
    })
    return { success: true, note }
  })

  ipcMain.handle('notes:list', async (_event, raw: unknown) => {
    const parsed = ListSchema.safeParse(raw ?? {})
    if (!parsed.success) return { success: false, error: 'invalid query' }
    return { success: true, notes: listNotes(parsed.data) }
  })

  ipcMain.handle('notes:get', async (_event, raw: unknown) => {
    const parsed = IdSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'invalid id' }
    const note = getNote(parsed.data.id)
    return note ? { success: true, note } : { success: false, error: 'no such note' }
  })

  ipcMain.handle('notes:update', async (_event, raw: unknown) => {
    const parsed = UpdateSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'invalid update' }
    const { id, ...update } = parsed.data
    const note = updateNote(id, update)
    if (!note) return { success: false, error: 'no such note' }
    // Re-index off the response path. A save must not wait on an embedder, and
    // a failed index is a stale search result, never a lost note.
    if (update.content !== undefined) {
      void indexNote(id).catch((error) => {
        console.warn('[Notes] could not index note:', (error as Error).message)
      })
    }
    return { success: true, note }
  })

  ipcMain.handle('notes:delete', async (_event, raw: unknown) => {
    const parsed = IdSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'invalid id' }
    return { success: deleteNote(parsed.data.id) }
  })

  ipcMain.handle('notes:analyze', async (_event, raw: unknown) => {
    const parsed = IdSchema.extend({ force: z.boolean().optional() }).safeParse(raw)
    if (!parsed.success) return { success: false, error: 'invalid id' }
    try {
      const note = await analyzeNote(parsed.data.id, { force: parsed.data.force })
      return note ? { success: true, note } : { success: false, error: 'no such note' }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('notes:related', async (_event, raw: unknown) => {
    const parsed = IdSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'invalid id' }
    try {
      return { success: true, items: await findRelated(parsed.data.id) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('notes:meetingSuggestions', async (_event, raw: unknown) => {
    const parsed = IdSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'invalid id' }
    try {
      return { success: true, suggestions: await suggestMeetings(parsed.data.id) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
