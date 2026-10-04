/**
 * IPC for the HiDock Model Host, the machine with the GPU.
 *
 * Two channels, both for Settings: ask a host whether it is there, and trade a
 * code shown on its screen for a token this machine keeps. Diarization itself
 * never comes through here — it is decided inside speaker-linking, where the
 * fall back to the local worker lives.
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  checkModelHost,
  pairWithModelHost,
  resetModelHostHealthCache,
} from '../services/model-host-client'
import { getConfig, saveConfig } from '../services/config'
import { resolveSpeakerEngine } from '../services/speaker-engines'
import type { ModelHostStatus } from '../../../src/shared/model-host-status'

const AddressSchema = z.object({
  url: z.string().trim().min(1).max(2048),
})

const PairSchema = AddressSchema.extend({
  // Eight digits, as the host prints them.
  code: z.string().trim().regex(/^\d{4,12}$/),
})

export function registerModelHostHandlers(): void {
  ipcMain.handle('model-host:check', async (_event, raw: unknown) => {
    const parsed = AddressSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'Enter the host address.' }
    const config = getConfig().transcription
    const health = await checkModelHost(
      {
        url: parsed.data.url,
        token: config.modelHostToken || '',
      },
      fetch,
      { forceRefresh: true }
    )
    if (!health) {
      return { success: false, error: 'No host answered at that address.' }
    }
    return { success: true, health }
  })

  // The host's state in words, for Settings and the voice evidence panel. Uses
  // the same short-lived health answer as the diarization path, so a status
  // line that polls does not add traffic or disagree with what a job would see.
  ipcMain.handle('model-host:status', async () => {
    const config = getConfig().transcription
    const address = config.modelHostUrl?.trim() || ''
    const configured = Boolean(address)
    const health = configured
      ? await checkModelHost({ url: address, token: config.modelHostToken || '' })
      : null
    const status: ModelHostStatus = {
      configured,
      paired: Boolean(config.modelHostToken),
      usedForSpeakers: configured && resolveSpeakerEngine(config) === 'model-host',
      address,
      health,
    }
    return { success: true, status }
  })

  ipcMain.handle('model-host:pair', async (_event, raw: unknown) => {
    const parsed = PairSchema.safeParse(raw)
    if (!parsed.success) {
      return { success: false, error: 'Enter the address and the code the host is showing.' }
    }
    try {
      const { token } = await pairWithModelHost(parsed.data.url, parsed.data.code)
      // Awaited: a pairing that says "done" while the token never reached disk
      // would work until the next restart and then quietly stop.
      await saveConfig({
        transcription: { modelHostUrl: parsed.data.url, modelHostToken: token },
      } as Parameters<typeof saveConfig>[0])
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('model-host:forget', async () => {
    resetModelHostHealthCache()
    try {
      // Empty, not undefined: saveConfig deep-merges and drops undefined, so
      // undefined would leave the old address in place and look like a no-op.
      await saveConfig({
        transcription: { modelHostUrl: '', modelHostToken: '' },
      } as Parameters<typeof saveConfig>[0])
      return { success: true }
    } catch (error) {
      // Saying "forgotten" while the token is still on disk is the one answer
      // this must never give.
      return { success: false, error: (error as Error).message }
    }
  })
}
