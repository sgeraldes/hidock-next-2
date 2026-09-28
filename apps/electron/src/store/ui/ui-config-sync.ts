/**
 * Chat placement, chat edge and clipboard auto-capture lived only in this
 * window's localStorage (settings map C-2, 28-sep-2026). config.json now keeps
 * them, like every other setting; the UI store still serves the components,
 * and this keeps the two in step.
 *
 * The keys have no default in config.json on purpose: a missing key means
 * "never saved there", so the first run copies the choice already made in
 * localStorage instead of resetting it.
 */
import { useConfigStore } from '@/store/domain/useConfigStore'
import { useUIStore } from './useUIStore'
import type { UIStore } from '@/types/stores'

interface SyncedPreference {
  section: 'ui' | 'capture'
  key: string
  read: (ui: UIStore) => unknown
  apply: (value: unknown) => void
}

const PREFERENCES: SyncedPreference[] = [
  {
    section: 'ui',
    key: 'chatPlacement',
    read: (ui) => ui.chatPlacement,
    apply: (v) => (v === 'floating' || v === 'embedded') && useUIStore.getState().setChatPlacement(v)
  },
  {
    section: 'ui',
    key: 'chatPosition',
    read: (ui) => ui.chatPosition,
    apply: (v) => (v === 'left' || v === 'right') && useUIStore.getState().setChatPosition(v)
  },
  {
    section: 'capture',
    key: 'autoClipboard',
    read: (ui) => ui.autoCaptureScreenshots,
    apply: (v) => typeof v === 'boolean' && useUIStore.getState().setAutoCaptureScreenshots(v)
  }
]

type Sections = Record<string, Record<string, unknown> | undefined>

function save(values: Record<'ui' | 'capture', Record<string, unknown>>): void {
  const updateConfig = useConfigStore.getState().updateConfig
  for (const section of ['ui', 'capture'] as const) {
    if (Object.keys(values[section]).length === 0) continue
    void updateConfig(section, values[section] as never).catch((err: unknown) =>
      console.error(`[ui-config-sync] Could not save ${Object.keys(values[section]).join(', ')}:`, err)
    )
  }
}

/** Start keeping the preferences in config.json. Returns the unsubscribe. */
export function startUiConfigSync(): () => void {
  let hydrated = false
  // What config.json holds or is about to hold: the store's config only
  // updates when a save returns, so A, B, A in quick succession must compare
  // with B, not with the A still in the store.
  const lastSent = new Map<string, unknown>()

  const hydrate = (config: Sections | null | undefined) => {
    if (!config || hydrated) return
    hydrated = true
    const ui = useUIStore.getState()
    const migrate: Record<'ui' | 'capture', Record<string, unknown>> = { ui: {}, capture: {} }
    for (const p of PREFERENCES) {
      const saved = config[p.section]?.[p.key]
      if (saved === undefined) {
        migrate[p.section][p.key] = p.read(ui)
        lastSent.set(`${p.section}.${p.key}`, p.read(ui))
      } else {
        lastSent.set(`${p.section}.${p.key}`, saved)
        if (saved !== p.read(ui)) p.apply(saved)
      }
    }
    save(migrate)
  }

  hydrate(useConfigStore.getState().config as unknown as Sections | null)
  const offConfig = useConfigStore.subscribe((state) => hydrate(state.config as unknown as Sections | null))
  const offUi = useUIStore.subscribe((state, previous) => {
    if (!hydrated) return
    const changes: Record<'ui' | 'capture', Record<string, unknown>> = { ui: {}, capture: {} }
    for (const p of PREFERENCES) {
      const next = p.read(state)
      const id = `${p.section}.${p.key}`
      if (next !== p.read(previous) && next !== lastSent.get(id)) {
        changes[p.section][p.key] = next
        lastSent.set(id, next)
      }
    }
    save(changes)
  })
  return () => {
    offConfig()
    offUi()
  }
}
