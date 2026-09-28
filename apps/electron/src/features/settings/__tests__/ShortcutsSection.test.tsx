import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render, screen } from '@testing-library/react'
import { SHORTCUTS, ShortcutsSection } from '../ShortcutsSection'

describe('Settings > Shortcuts', () => {
  it('lists every shortcut', () => {
    render(<ShortcutsSection />)
    for (const s of SHORTCUTS) expect(screen.getByText(s.action)).toBeInTheDocument()
  })

  it('each one names a file that still handles it', () => {
    const src = join(__dirname, '..', '..', '..')
    for (const s of SHORTCUTS.filter((x) => x.source.endsWith('.tsx') || x.source.endsWith('.ts'))) {
      expect(() => readFileSync(join(src, s.source), 'utf8')).not.toThrow()
    }
  })
})
