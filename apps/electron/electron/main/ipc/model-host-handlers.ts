/**
 * IPC for the HiDock Model Host, the machine with the GPU.
 *
 * HiDock is in charge and the gamestation has no settings of its own (Sebastián,
 * 4-oct-2026). So pairing here also hands the host what it needs: this computer's
 * Hugging Face token (the host runs the voice model once with it) and when to step
 * aside. Check sends the token again to a host still waiting for it. Diarization
 * itself never comes through here; it is decided inside speaker-linking, where the
 * fall back to the local worker lives.
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  checkModelHost,
  pairWithModelHost,
  resetModelHostHealthCache,
  sendHfTokenToModelHost,
  setModelHostStepAside,
  getModelHostDiagnostics,
  repairModelHostRuntime,
  sendModelHostUpdate,
  type ModelHostSettings,
} from '../services/model-host-client'
import { getConfig, saveConfig } from '../services/config'
import { resolveSpeakerEngine } from '../services/speaker-engines'
import type {
  ModelHostHealthReport,
  ModelHostSetupReport,
  ModelHostStatus,
  ModelHostStepAside,
} from '../../../src/shared/model-host-status'

const AddressSchema = z.object({
  url: z.string().trim().min(1).max(2048),
})

const PairSchema = AddressSchema.extend({
  // Eight digits from the host's tray icon, or nothing while its automatic
  // pairing is open.
  code: z.string().trim().regex(/^(\d{4,12})?$/),
})

const StepAsideSchema = z.object({ value: z.enum(['any-use', 'games', 'never']) })

function stepAsideFromConfig(): ModelHostStepAside {
  return getConfig().transcription.modelHostStepAside ?? 'games'
}

/**
 * Give a freshly paired host what it needs. Pairing already succeeded, so a
 * failure here is a warning to show, not a reason to undo the pairing: Check
 * sends it again.
 */
async function provision(settings: ModelHostSettings): Promise<{ setup?: ModelHostSetupReport; warning?: string }> {
  const config = getConfig().transcription
  const warnings: string[] = []
  let setup: ModelHostSetupReport | undefined
  if (config.localAsrHfToken) {
    try {
      setup = await sendHfTokenToModelHost(settings, config.localAsrHfToken)
    } catch (error) {
      warnings.push(`The host did not take the Hugging Face token: ${(error as Error).message}`)
    }
  } else {
    warnings.push('This computer has no Hugging Face token to give the host. Add it in Settings > Secrets, then press Check.')
  }
  try {
    await setModelHostStepAside(settings, stepAsideFromConfig())
  } catch (error) {
    warnings.push(`The host did not take when to step aside: ${(error as Error).message}`)
  }
  return { ...(setup ? { setup } : {}), ...(warnings.length ? { warning: warnings.join(' ') } : {}) }
}

/** On Check: a paired host still waiting for the token gets it, and a stale step-aside is corrected. */
async function topUp(settings: ModelHostSettings, health: ModelHostHealthReport): Promise<boolean> {
  const config = getConfig().transcription
  let changed = false
  const waiting = health.setup?.status === 'needs-token' || health.setup?.status === 'failed'
  if (waiting && config.localAsrHfToken) {
    try {
      await sendHfTokenToModelHost(settings, config.localAsrHfToken)
      changed = true
    } catch {
      // The status line says what the host is waiting for.
    }
  }
  const wanted = stepAsideFromConfig()
  if (health.stepAside && health.stepAside !== wanted) {
    try {
      await setModelHostStepAside(settings, wanted)
      changed = true
    } catch {
      // Sent again on the next Check.
    }
  }
  return changed
}

export function registerModelHostHandlers(): void {
  ipcMain.handle('model-host:check', async (_event, raw: unknown) => {
    const parsed = AddressSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'Enter the host address.' }
    const config = getConfig().transcription
    const settings = { url: parsed.data.url, token: config.modelHostToken || '' }
    let health = await checkModelHost(settings, fetch, { forceRefresh: true })
    if (!health) {
      return { success: false, error: 'No host answered at that address.' }
    }
    if (settings.token && (await topUp(settings, health))) {
      health = (await checkModelHost(settings, fetch, { forceRefresh: true })) ?? health
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
      hasHfToken: Boolean(config.localAsrHfToken),
      address,
      health,
    }
    return { success: true, status }
  })

  ipcMain.handle('model-host:pair', async (_event, raw: unknown) => {
    const parsed = PairSchema.safeParse(raw)
    if (!parsed.success) {
      return { success: false, error: 'Enter the address, and the code from the host’s tray icon if it shows one.' }
    }
    try {
      const { token } = await pairWithModelHost(parsed.data.url, parsed.data.code)
      // Awaited: a pairing that says "done" while the token never reached disk
      // would work until the next restart and then quietly stop.
      await saveConfig({
        transcription: { modelHostUrl: parsed.data.url, modelHostToken: token },
      } as Parameters<typeof saveConfig>[0])
      const provisioned = await provision({ url: parsed.data.url, token })
      return { success: true, ...provisioned }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // The one setting for the gamestation. Saved here first; the host gets it now
  // if it answers, and on the next Check or pairing if it does not.
  ipcMain.handle('model-host:set-step-aside', async (_event, raw: unknown) => {
    const parsed = StepAsideSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'Choose any use, games or never.' }
    await saveConfig({
      transcription: { modelHostStepAside: parsed.data.value },
    } as Parameters<typeof saveConfig>[0])
    const config = getConfig().transcription
    if (!config.modelHostUrl || !config.modelHostToken) return { success: true, sent: false }
    try {
      await setModelHostStepAside({ url: config.modelHostUrl, token: config.modelHostToken }, parsed.data.value)
      return { success: true, sent: true }
    } catch {
      return { success: true, sent: false }
    }
  })

  // Looking after the host: HiDock is in charge, and nobody needs to sit at the
  // gamestation to read its logs, repair its runtime or update it.
  const pairedSettings = (): ModelHostSettings | null => {
    const config = getConfig().transcription
    return config.modelHostUrl && config.modelHostToken
      ? { url: config.modelHostUrl, token: config.modelHostToken }
      : null
  }
  const notPaired = { success: false, error: 'This computer is not paired with a model host.' }

  ipcMain.handle('model-host:diagnostics', async () => {
    const settings = pairedSettings()
    if (!settings) return notPaired
    try {
      return { success: true, diagnostics: await getModelHostDiagnostics(settings) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('model-host:repair', async () => {
    const settings = pairedSettings()
    if (!settings) return notPaired
    try {
      return { success: true, setup: await repairModelHostRuntime(settings) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('model-host:update', async (_event, raw: unknown) => {
    const parsed = z.object({ path: z.string().min(1).max(4096) }).safeParse(raw)
    if (!parsed.success) return { success: false, error: 'Choose the installer to send.' }
    const settings = pairedSettings()
    if (!settings) return notPaired
    try {
      await sendModelHostUpdate(settings, parsed.data.path)
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
