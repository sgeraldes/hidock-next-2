/**
 * Speaker setup IPC: read the hardware and engine options, and save the
 * owner's choice. Gated with transcription (the `speakers:` namespace).
 *
 * Spec: docs/superpowers/specs/2026-09-24-speaker-engines-design.md
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import { applySpeakerSetup, getSpeakerSetup, SpeakerSetupError, type SpeakerSetup } from '../services/speaker-setup'
import { success, error, type Result } from '../types/api'

const EngineSchema = z.enum(['auto', 'pyannote-local', 'onnx-local', 'signatures-from-turns', 'model-host', 'pyannoteai', 'off'])

const ApplySchema = z.object({
  engine: EngineSchema,
  fingerprint: z.string().min(1).max(2000),
  confirmOff: z.boolean().optional(),
})

const GetSchema = z.object({ refresh: z.boolean().optional() }).optional()

export function registerSpeakerSetupHandlers(): void {
  ipcMain.handle('speakers:getSetup', async (_, payload: unknown): Promise<Result<SpeakerSetup>> => {
    const parsed = GetSchema.safeParse(payload)
    if (!parsed.success) return error('VALIDATION_ERROR', 'Invalid request')
    try {
      return success(await getSpeakerSetup({ refresh: parsed.data?.refresh }))
    } catch (e) {
      console.error('[speakers:getSetup]', e)
      return error('INTERNAL_ERROR', e instanceof Error ? e.message : 'Could not read the hardware')
    }
  })

  ipcMain.handle('speakers:applySetup', async (_, payload: unknown): Promise<Result<SpeakerSetup>> => {
    const parsed = ApplySchema.safeParse(payload)
    if (!parsed.success) return error('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request')
    try {
      return success(await applySpeakerSetup(parsed.data))
    } catch (e) {
      if (e instanceof SpeakerSetupError) return error('VALIDATION_ERROR', e.message)
      console.error('[speakers:applySetup]', e)
      return error('INTERNAL_ERROR', e instanceof Error ? e.message : 'Could not save the setup')
    }
  })
}
