import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DisplaySection } from '../DisplaySection'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { appLocale } from '@/lib/locale'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))

const updateConfig = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  updateConfig.mockClear()
  useConfigStore.setState({ config: { ui: { theme: 'system' } } as never, updateConfig })
})

describe('appLocale', () => {
  it('is undefined (the system) by default and for unknown values', () => {
    expect(appLocale()).toBeUndefined()
    useConfigStore.setState({ config: { ui: { locale: 'xx-YY' } } as never })
    expect(appLocale()).toBeUndefined()
  })

  it('returns a chosen locale, and formatting follows it', () => {
    useConfigStore.setState({ config: { ui: { locale: 'es-AR' } } as never })
    expect(appLocale()).toBe('es-AR')
    expect((2137).toLocaleString(appLocale())).toBe('2.137')
  })
})

describe('DisplaySection', () => {
  it('saves the chosen format', () => {
    render(<DisplaySection />)
    fireEvent.change(screen.getByLabelText('Dates, times and numbers'), { target: { value: 'es-AR' } })
    expect(updateConfig).toHaveBeenCalledWith('ui', { locale: 'es-AR' })
  })
})
