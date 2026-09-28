import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RailTooltip } from '../Layout'

function renderItem(collapsed: boolean) {
  return render(
    <TooltipProvider delayDuration={0}>
      <RailTooltip collapsed={collapsed} label="Library">
        <a href="#/library" aria-label={collapsed ? 'Library' : undefined}>
          <span aria-hidden="true">icon</span>
          {!collapsed && <span>Library</span>}
        </a>
      </RailTooltip>
    </TooltipProvider>
  )
}

describe('RailTooltip (collapsed sidebar names)', () => {
  it('shows the name beside the icon on focus when the sidebar is collapsed', async () => {
    renderItem(true)
    const link = screen.getByRole('link', { name: 'Library' })
    fireEvent.focus(link)
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Library'))
  })

  it('adds no tooltip when the sidebar is expanded (the name is already there)', () => {
    renderItem(false)
    const link = screen.getByRole('link', { name: 'Library' })
    fireEvent.focus(link)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
