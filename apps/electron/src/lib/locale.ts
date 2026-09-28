/**
 * The locale every date, time and number in the window is formatted with
 * (Settings > Display). "System" follows Windows. Before this, 18 places forced
 * en-US and the rest followed the system, so one screen could mix two styles
 * (settings inventory, 28-sep-2026).
 */
import { useConfigStore } from '@/store/domain/useConfigStore'

export const LOCALE_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'es-AR', label: 'Español (Argentina)' },
  { value: 'es-ES', label: 'Español (España)' },
  { value: 'es-MX', label: 'Español (México)' },
  { value: 'pt-BR', label: 'Português (Brasil)' }
]

/** The locale to pass to toLocale*String / Intl; undefined means the system's. */
export function appLocale(): string | undefined {
  try {
    const value = useConfigStore.getState().config?.ui?.locale
    return value && value !== 'system' && LOCALE_CHOICES.some((c) => c.value === value) ? value : undefined
  } catch {
    return undefined
  }
}
