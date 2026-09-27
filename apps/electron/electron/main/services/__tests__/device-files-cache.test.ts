// @vitest-environment node

/**
 * saveDeviceFilesCache against a real SQLite database: the clear + reinsert
 * now runs inside one transaction (it rewrites the whole device list, 2,000+
 * rows on a loaded device, and per-statement auto-commit made that thousands
 * of individual WAL commits). These tests pin the observable behaviour: a
 * save replaces the cache wholesale, and the rows read back exactly.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-devcache-${process.pid}-${Date.now()}.db`)

vi.mock('../file-storage', () => ({
  getDatabasePath: () => paths.db,
}))

import {
  initializeDatabase,
  closeDatabase,
  saveDeviceFilesCache,
  getDeviceFilesCache,
} from '../database'

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
}

describe('saveDeviceFilesCache', () => {
  beforeAll(async () => {
    cleanup()
    await initializeDatabase()
  })

  afterAll(() => {
    try {
      closeDatabase()
    } catch {
      /* already closed */
    }
    cleanup()
  })

  it('replaces the cache wholesale and reads the rows back', () => {
    const files = Array.from({ length: 500 }, (_, i) => ({
      filename: `rec_${String(i).padStart(4, '0')}.hda`,
      size: 2048,
      duration_seconds: 30,
      date_recorded: `2026-09-${String((i % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
    }))

    saveDeviceFilesCache(files)

    const cached = getDeviceFilesCache()
    expect(cached).toHaveLength(500)
    const first = cached.find((row) => row.filename === 'rec_0000.hda')
    expect(first).toMatchObject({ file_size: 2048, duration_seconds: 30 })

    // A second save replaces, never appends.
    saveDeviceFilesCache([
      { filename: 'rec_9999.hda', size: 4096, duration_seconds: 60, date_recorded: '2026-09-27T12:00:00.000Z' },
    ])
    const replaced = getDeviceFilesCache()
    expect(replaced).toHaveLength(1)
    expect(replaced[0].filename).toBe('rec_9999.hda')
  })

  it('accepts the file_size alias for size', () => {
    saveDeviceFilesCache([
      { filename: 'alias.hda', file_size: 8192, date_recorded: '2026-09-27T13:00:00.000Z' },
    ])
    const cached = getDeviceFilesCache()
    expect(cached).toHaveLength(1)
    expect(cached[0].file_size).toBe(8192)
  })
})
