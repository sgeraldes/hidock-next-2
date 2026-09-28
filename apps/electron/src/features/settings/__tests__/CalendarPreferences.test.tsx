import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CalendarPreferences } from '../CalendarPreferences'
import { useConfigStore } from '@/store/domain/useConfigStore'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))
const updateConfig = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  updateConfig.mockClear()
  useConfigStore.setState({ config: { ui: { officeHoursStart: 9, officeHoursEnd: 18, workDays: [1, 2, 3, 4, 5] }, calendar: {} } as never, updateConfig })
})

describe('calendar preferences', () => {
  it('saves office hours, and moves the end when the start passes it', () => {
    render(<CalendarPreferences />)
    fireEvent.change(screen.getByLabelText('Office hours start'), { target: { value: '8' } })
    expect(updateConfig).toHaveBeenCalledWith('ui', { officeHoursStart: 8 })
    fireEvent.change(screen.getByLabelText('Office hours start'), { target: { value: '20' } })
    expect(updateConfig).toHaveBeenCalledWith('ui', { officeHoursStart: 20, officeHoursEnd: 21 })
  })

  it('adds a work day', () => {
    render(<CalendarPreferences />)
    fireEvent.click(screen.getByRole('button', { name: 'Sat' }))
    expect(updateConfig).toHaveBeenCalledWith('ui', { workDays: [1, 2, 3, 4, 5, 6] })
  })

  it('does not save an empty set of work days', () => {
    useConfigStore.setState({ config: { ui: { workDays: [3] }, calendar: {} } as never })
    render(<CalendarPreferences />)
    fireEvent.click(screen.getByRole('button', { name: 'Wed' }))
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('saves the calendar window', () => {
    render(<CalendarPreferences />)
    const back = screen.getByLabelText(/Back/)
    fireEvent.change(back, { target: { value: '90' } })
    fireEvent.blur(back)
    expect(updateConfig).toHaveBeenCalledWith('calendar', { windowPastDays: 90 })
  })
})
