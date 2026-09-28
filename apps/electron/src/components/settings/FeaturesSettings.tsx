/**
 * Features settings: the preset, then one switch per feature (owner,
 * 28-sep-2026: "main toggle should live here"). A switch writes a feature flag
 * through applyFeatureToggle, which names the preset again when the chosen set
 * is exactly one. A feature whose hard dependency is off shows why and cannot be
 * turned on until that one is. Jev's main switch is here too; its per-job
 * switches stay on the Decisions page. Connectors are turned on and off on the
 * Connectors page: the registry's connector entries gate nothing yet.
 */

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { usePendingRestart, useFeatureStore, describeDisableReason } from '@/store/useFeatureStore'
import {
  CORE_FEATURE_IDS,
  FEATURES,
  PRESET_INFO,
  applyFeatureToggle,
  type FeatureId,
  type PresetId,
} from '@/shared/feature-registry'
import { toast } from '@/components/ui/toaster'

const SELECTABLE_PRESETS: PresetId[] = ['library-only', 'library-transcription', 'full', 'custom']

const COST_WORD = { light: 'light', medium: 'medium', heavy: 'heavy' } as const

export function FeaturesSettings({
  onNavigate
}: {
  /** Open another Settings page (Connectors, Decisions). */
  onNavigate?: (section: 'connectors' | 'decisions') => void
} = {}): React.ReactElement {
  const { config, updateConfig } = useConfigStore()
  const resolved = useFeatureStore((s) => s.resolved)
  const pendingRestart = usePendingRestart()
  const [saving, setSaving] = useState(false)

  const preset: PresetId = config?.features?.preset ?? 'full'

  const applyPreset = async (next: PresetId) => {
    if (next === preset) return
    setSaving(true)
    try {
      // Switching to a NAMED preset clears the sparse flag overrides so the
      // preset's baseline is authoritative; `custom` keeps the current flags.
      const flags = next === 'custom' ? (config?.features?.flags ?? {}) : {}
      await updateConfig('features', { preset: next, flags })
      toast({
        title: 'Feature preset applied',
        description: PRESET_INFO[next].label,
        variant: 'success',
      })
    } catch (e) {
      toast.error('Failed to apply preset', e instanceof Error ? e.message : undefined)
    } finally {
      setSaving(false)
    }
  }

  const toggleFeature = async (id: FeatureId, on: boolean) => {
    setSaving(true)
    try {
      await updateConfig('features', applyFeatureToggle(config?.features, id, on))
    } catch (e) {
      toast.error(`Could not turn ${on ? 'on' : 'off'} ${FEATURES[id].label}`, e instanceof Error ? e.message : undefined)
    } finally {
      setSaving(false)
    }
  }

  const jevOn = config?.decisions?.jevEnabled !== false
  const setJev = async (on: boolean) => {
    try {
      await updateConfig('decisions', { ...(config?.decisions ?? { jevValue: true, jevMeetingMatch: true }), jevEnabled: on })
    } catch (e) {
      toast.error('Could not change Jev', e instanceof Error ? e.message : undefined)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Features</CardTitle>
        <CardDescription>
          Choose how much of the app runs. Smaller presets skip background work entirely.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="feature-preset" className="text-sm font-medium">
            Preset
          </label>
          <select
            id="feature-preset"
            aria-label="Feature preset"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={preset}
            disabled={saving}
            onChange={(e) => applyPreset(e.target.value as PresetId)}
          >
            {SELECTABLE_PRESETS.map((id) => (
              <option key={id} value={id}>
                {PRESET_INFO[id].label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{PRESET_INFO[preset].description}</p>
        </div>

        <ul className="divide-y divide-border rounded-md border border-border" aria-label="Features" data-testid="feature-switches">
          {CORE_FEATURE_IDS.map((id) => {
            const def = FEATURES[id]
            const state = resolved[id]
            const blockedBy = state?.reason?.startsWith('requires:') ? describeDisableReason(state.reason) : null
            return (
              <li key={id} className="flex items-start justify-between gap-4 px-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium">{def.label}</p>
                  <p className="text-xs text-muted-foreground">{def.description}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {blockedBy ? (
                      <span className="text-amber-700 dark:text-amber-400">{blockedBy}</span>
                    ) : (
                      <>
                        Uses CPU {COST_WORD[def.hardwareCost.cpu]}, memory {COST_WORD[def.hardwareCost.memory]}, network{' '}
                        {COST_WORD[def.hardwareCost.network]}
                        {!def.runtimeToggleable && ' · takes effect after a restart'}
                      </>
                    )}
                  </p>
                </div>
                <Switch
                  checked={!!state?.enabled}
                  disabled={saving || !!blockedBy}
                  onCheckedChange={(v) => void toggleFeature(id, v)}
                  aria-label={def.label}
                />
              </li>
            )
          })}
          <li className="flex items-start justify-between gap-4 px-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">Decisions (Jev)</p>
              <p className="text-xs text-muted-foreground">
                Rates recordings and links them to meetings with Jev. Each job has its own switch on the{' '}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onNavigate?.('decisions')}>
                  Decisions page
                </button>
                .
              </p>
            </div>
            <Switch checked={jevOn} onCheckedChange={(v) => void setJev(v)} aria-label="Decisions (Jev)" />
          </li>
          <li>
            <button
              type="button"
              onClick={() => onNavigate?.('connectors')}
              className="flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left hover:bg-accent/50"
            >
              <span className="min-w-0 space-y-0.5">
                <span className="block text-sm font-medium">Connectors</span>
                <span className="block text-xs text-muted-foreground">
                  Microsoft 365, Slack and the calendar feed are turned on and off on the Connectors page.
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        </ul>

        {pendingRestart.length > 0 && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
          >
            <div className="space-y-0.5 text-xs">
              {/* Round-3: distinguish the two pending directions honestly.
                  desired-ON + pending  ⇒ enable waits for restart to activate.
                  desired-OFF + pending ⇒ disabled for NEW work now; restart
                  fully unloads it (teardown/status stay available meanwhile). */}
              {pendingRestart.filter((id) => resolved[id]?.enabled).length > 0 && (
                <p>
                  Restart required to activate:{' '}
                  <span className="font-medium">
                    {pendingRestart
                      .filter((id) => resolved[id]?.enabled)
                      .map((id) => FEATURES[id].label)
                      .join(', ')}
                  </span>
                </p>
              )}
              {pendingRestart.filter((id) => !resolved[id]?.enabled).length > 0 && (
                <p>
                  Disabled for new work — restart to fully unload:{' '}
                  <span className="font-medium">
                    {pendingRestart
                      .filter((id) => !resolved[id]?.enabled)
                      .map((id) => FEATURES[id].label)
                      .join(', ')}
                  </span>
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => window.electronAPI?.app?.restart()}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Restart now
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
