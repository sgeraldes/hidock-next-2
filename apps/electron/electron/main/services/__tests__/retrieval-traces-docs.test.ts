// @vitest-environment node
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('query recording privacy notice', () => {
  it.each([
    ['README privacy section', () => readFileSync(resolve('../../README.md'), 'utf8').split('## Privacy and device safety')[1].split('\n## ')[0]],
    // The release entry that introduced query recording, wherever later entries put it.
    ['release entry that introduced query recording', () => {
      const entries = readFileSync(resolve('CHANGELOG.md'), 'utf8').split('\n## ').slice(1)
      const entry = entries.find((e) => e.includes('retrieval-traces.db'))
      expect(entry, 'no release entry mentions retrieval-traces.db').toBeDefined()
      return entry!
    }]
  ])('documents the default, controls, retention, and local storage in %s', (_name, read) => {
    const text = read().replace(/\s+/g, ' ')
    for (const phrase of ['chat', 'Explore', 'agents', 'on by default', '<data folder>\\traces\\retrieval-traces.db',
      'encrypted', '30 days', '90 days', '1 GiB', 'Settings > Assistant', 'Record queries', 'Keep the text of my queries', 'Nothing leaves the machine']) {
      expect(text).toContain(phrase)
    }
  })
})
