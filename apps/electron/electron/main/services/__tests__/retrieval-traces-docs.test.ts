// @vitest-environment node
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('query recording privacy notice', () => {
  it.each([
    ['README privacy section', () => readFileSync(resolve('../../README.md'), 'utf8').split('## Privacy and device safety')[1].split('\n## ')[0]],
    ['current release entry', () => readFileSync(resolve('CHANGELOG.md'), 'utf8').split('\n## ')[1]]
  ])('documents the default, controls, retention, and local storage in %s', (_name, read) => {
    const text = read().replace(/\s+/g, ' ')
    for (const phrase of ['chat', 'Explore', 'agents', 'on by default', '<data folder>\\traces\\retrieval-traces.db',
      'encrypted', '30 days', '90 days', '1 GiB', 'Settings > Assistant', 'Record queries', 'Keep the text of my queries', 'Nothing leaves the machine']) {
      expect(text).toContain(phrase)
    }
  })
})
