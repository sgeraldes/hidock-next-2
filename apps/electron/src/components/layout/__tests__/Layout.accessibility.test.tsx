import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Layout } from '../Layout'
import { SettingsNav } from '@/features/settings/SettingsNav'

vi.mock('@/components/layout/TitleBar', () => ({ TitleBar: () => null }))
vi.mock('@/components/layout/PcRecording', () => ({ RecordingBar: () => null }))
vi.mock('@/components/OperationController', () => ({ OperationController: () => null }))
vi.mock('@/components/layout/OperationsPanel', () => ({ OperationsPanel: () => null }))
vi.mock('@/components/layout/Brand', () => ({ showBrandHorizontalDivider: () => true }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))
vi.mock('@/store/usePcRecorderStore', () => ({ installPcRecorderCloseGuard: vi.fn(() => vi.fn()) }))
vi.mock('@/store/ui/ui-config-sync', () => ({ startUiConfigSync: vi.fn(() => vi.fn()) }))

vi.mock('@/store/useAppStore', () => {
  const state = {
    loadMeetings: vi.fn(),
    syncCalendar: vi.fn(),
    meetings: [],
    unifiedRecordings: []
  }
  return {
    useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
    useLastCalendarSync: () => undefined,
    useDeviceState: () => ({ connected: false, model: null }),
    useConnectionStatus: () => ({ step: 'idle', message: null })
  }
})
vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: () => ({ config: null, loadConfig: vi.fn() })
}))
vi.mock('@/store/ui/useUIStore', () => {
  const state = { sidebarOpen: true, toggleSidebar: vi.fn() }
  return { useUIStore: (selector: (value: typeof state) => unknown) => selector(state) }
})
vi.mock('@/store', () => ({
  useActionablesPendingCount: () => 0,
  useActionablesStore: { getState: () => ({ loadActionables: vi.fn() }) }
}))
vi.mock('@/store/useFeatureStore', () => ({
  useFeatureStore: (selector: (value: { resolved: Record<string, never>; pendingRestart: string[] }) => unknown) =>
    selector({ resolved: {}, pendingRestart: [] }),
  describeDisableReason: () => '',
  featureForPath: () => undefined
}))

describe('Layout navigation landmarks', () => {
  it('names both the primary sidebar and the Settings sections landmark on Settings', () => {
    render(
      <MemoryRouter initialEntries={['/settings/overview']}>
        <Layout>
          <SettingsNav active="overview" onSelect={vi.fn()} />
        </Layout>
      </MemoryRouter>
    )

    expect(screen.getAllByRole('navigation')).toHaveLength(2)
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })
})
