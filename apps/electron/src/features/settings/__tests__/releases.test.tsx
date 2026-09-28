import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { parseReleases, RELEASES } from '../releases'
import { ReleasesSection } from '../ReleasesSection'

const SAMPLE = `# Notes

Intro text that is not a release.

## 2026-09-28 | Settings with a menu

Summary line.

### Fixes

- **One.** First fix.

## 2026-09-27 | Jev rates recordings

### New

- Jev.
`

describe('release notes', () => {
  it('reads one release per "## date | title" heading, newest first as written', () => {
    const releases = parseReleases(SAMPLE)
    expect(releases.map((r) => r.date)).toEqual(['2026-09-28', '2026-09-27'])
    expect(releases[0].title).toBe('Settings with a menu')
    expect(releases[0].body).toContain('### Fixes')
    expect(releases[0].body).not.toContain('Intro text')
  })

  it('ships notes in the app, dated and titled', () => {
    expect(RELEASES.length).toBeGreaterThan(0)
    for (const r of RELEASES) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(r.title.length).toBeGreaterThan(0)
    }
  })

  it('shows the newest release as installed and opens another from the list', () => {
    render(<ReleasesSection releases={parseReleases(SAMPLE)} />)
    const list = screen.getByRole('listbox', { name: 'Releases' })
    const options = within(list).getAllByRole('option')
    expect(options[0]).toHaveTextContent('Installed')
    expect(screen.getByRole('heading', { level: 3, name: 'Settings with a menu' })).toBeInTheDocument()
    expect(screen.getByText('First fix.')).toBeInTheDocument()

    fireEvent.click(options[1])
    expect(screen.getByRole('heading', { level: 3, name: 'Jev rates recordings' })).toBeInTheDocument()
  })
})
