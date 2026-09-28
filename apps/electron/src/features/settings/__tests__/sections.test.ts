import { describe, it, expect } from 'vitest'
import {
  SETTINGS_SECTIONS,
  isSettingsSectionId,
  searchSettingsSections,
  sectionFromLegacyHash
} from '../sections'

describe('settings sections', () => {
  it('has unique ids, and every section has a label and a description', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of SETTINGS_SECTIONS) {
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it('search finds a page by what it holds, not only by its name', () => {
    expect(searchSettingsSections('hugging face').map((s) => s.id)).toEqual(['speakers'])
    expect(searchSettingsSections('slack').map((s) => s.id)).toEqual(['connectors'])
    expect(searchSettingsSections('jev').map((s) => s.id)).toEqual(['decisions'])
    expect(searchSettingsSections('')).toHaveLength(SETTINGS_SECTIONS.length)
    expect(searchSettingsSections('nothing like this')).toEqual([])
  })

  it('maps the old single-page anchors to a section', () => {
    expect(sectionFromLegacyHash('#features')).toBe('features')
    expect(sectionFromLegacyHash('#nope')).toBeNull()
    expect(isSettingsSectionId('calendar')).toBe(true)
    expect(isSettingsSectionId(undefined)).toBe(false)
  })
})
