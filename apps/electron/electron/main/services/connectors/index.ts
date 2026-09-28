/**
 * Connector host wiring for the Electron app.
 *
 * Builds the ConnectorHost with the Electron-backed store + ingestion sink,
 * registers the built-in connectors (M365 native; Slack from
 * @hidock/connectors-slack), and exposes accessors for the IPC layer.
 *
 * Registration of additional connectors happens HERE (the host registrar for
 * this wave). Slack is registered defensively so a problem loading its package
 * never blocks M365 or the rest of the app.
 */
import { ConnectorHost } from '@hidock/connectors'
import { getConnectorStore } from './connector-store'
import { createIngestionSink } from './ingestion'
import { m365Descriptor, createM365Connector } from './m365/m365-connector'
import { getConfig } from '../config'
import { isFeatureEnabledIn } from '../../../../src/shared/feature-registry'

let host: ConnectorHost | null = null

function buildHost(): ConnectorHost {
  const store = getConnectorStore()
  const sink = createIngestionSink()
  const h = new ConnectorHost({
    store,
    sink,
    log: (message, extra) => {
      // Low-volume: connector lifecycle + sync results only.
      if (extra !== undefined) console.log('[connectors]', message, extra)
      else console.log('[connectors]', message)
    },
  })

  // C3 — Microsoft 365 (native, device-code).
  h.register(m365Descriptor, (ctx) => createM365Connector(ctx))

  // C2 — Slack (from its own package). Defensive: never let a load error here
  // break the rest of the connector host.
  try {
    const slack = require('@hidock/connectors-slack') as {
      slackDescriptor?: Parameters<ConnectorHost['register']>[0]
      slackConnectorFactory?: Parameters<ConnectorHost['register']>[1]
    }
    if (slack.slackDescriptor && slack.slackConnectorFactory) {
      h.register(slack.slackDescriptor, slack.slackConnectorFactory)
    }
  } catch (err) {
    console.warn('[connectors] Slack connector unavailable:', err)
  }

  return h
}

export function getConnectorHost(): ConnectorHost {
  if (!host) host = buildHost()
  return host
}

/**
 * Initialize connectors on app start: build the host and eagerly attempt a
 * silent (re)connect for connectors that already have credentials, so cached
 * M365 tokens / Slack tokens light up without a manual click. Non-fatal.
 */
export async function initConnectors(): Promise<void> {
  const h = getConnectorHost()
  // Iterate INSTANCES (accounts), not types — a multi-instance connector like
  // M365 may have several accounts, each needing its own silent resume.
  for (const instanceId of h.listInstances()) {
    try {
      const status = h.getStatus(instanceId)
      // Only auto-connect ones that look configured (never interactive here, so
      // no browser popup / device-code prompt fires on startup).
      if (status.state === 'disconnected') {
        // A silent connect: M365 no-ops to auth-needed if no cached token;
        // Slack validates its token. Errors are swallowed (best-effort).
        await h.connect(instanceId).catch(() => {})
      }
    } catch {
      /* best-effort */
    }
  }
  startConnectorSchedule()
}

/** First scheduled sync after start: late enough to stay out of the boot work. */
const FIRST_SYNC_DELAY_MS = 2 * 60_000

let firstSyncTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let scheduledRunInFlight = false

/** Sync every connected connector once; a run never overlaps the previous one. */
export async function syncConnectedConnectors(): Promise<void> {
  if (scheduledRunInFlight) return
  const config = getConfig()
  if (!config.calendar.syncEnabled || !isFeatureEnabledIn(config.features, 'calendar')) return
  scheduledRunInFlight = true
  try {
    const h = getConnectorHost()
    for (const id of h.listInstances()) {
      if (h.getStatus(id).state !== 'connected') continue
      try {
        await h.syncNow(id)
      } catch (err) {
        console.warn(`[connectors] Scheduled sync of ${id} failed:`, err instanceof Error ? err.message : err)
      }
    }
  } finally {
    scheduledRunInFlight = false
  }
}

/**
 * Keep connected connectors in sync on the calendar's interval (Settings >
 * Calendar, "Every N minutes"; auto-sync off stops it). The host had a
 * scheduler that nothing called, so Microsoft 365 only synced on a click
 * (settings inventory, 28-sep-2026). Call again after the calendar settings
 * change.
 */
export function startConnectorSchedule(): void {
  stopConnectorSchedule()
  const config = getConfig()
  if (!config.calendar.syncEnabled) return
  const minutes = Math.max(5, Math.round(config.calendar.syncIntervalMinutes || 15))
  firstSyncTimer = setTimeout(() => void syncConnectedConnectors(), FIRST_SYNC_DELAY_MS)
  syncTimer = setInterval(() => void syncConnectedConnectors(), minutes * 60_000)
  firstSyncTimer.unref?.()
  syncTimer.unref?.()
}

export function stopConnectorSchedule(): void {
  if (firstSyncTimer) clearTimeout(firstSyncTimer)
  if (syncTimer) clearInterval(syncTimer)
  firstSyncTimer = null
  syncTimer = null
}
