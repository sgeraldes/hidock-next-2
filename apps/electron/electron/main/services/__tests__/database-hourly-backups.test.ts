// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ db: '' }))
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db }))
import { listHourlyBackups } from '../database'

describe('hourly migration backup discovery', () => {
  let root = ''
  afterEach(() => {
    if (!root) return
    const backups = join(root, 'backups')
    for (const name of readdirSync(backups)) rmSync(join(backups, name))
    rmdirSync(backups)
    rmdirSync(root)
    root = ''
  })

  it('offers newest exact backups first and rejects nonempty WAL or invalid proof', () => {
    root = mkdtempSync(join(tmpdir(), 'hidock-hourly-proof-'))
    paths.db = join(root, 'data', 'hidock.db')
    const dir = join(root, 'backups')
    mkdirSync(dir)
    const record = { exact: true, db_mtime_ns: '123456789', db_size: 4096, wal_size: 0 }
    for (const [stamp, proof] of [
      ['20261004-010000', record],
      ['20261004-020000', record],
      ['20261004-030000', { ...record, wal_size: 32 }],
      ['20261004-040000', { ...record, exact: false }],
      ['20261004-050000', { ...record, db_size: -1 }],
      ['20261004-060000', { ...record, db_size: 1.5 }],
      ['20261004-070000', { ...record, db_mtime_ns: 'invalid' }],
      ['20261004-080000', { ...record, wal_size: undefined }],
      ['20261004-090000', { ...record, db_size: undefined }],
    ] as const) {
      const name = `hidock-${stamp}.db`
      writeFileSync(join(dir, name), 'placeholder')
      writeFileSync(join(dir, `${name}.source.json`), JSON.stringify(proof))
    }
    expect(listHourlyBackups()).toEqual([
      { path: join(dir, 'hidock-20261004-020000.db'), sourceMtimeNs: 123456789n, sourceSize: 4096 },
      { path: join(dir, 'hidock-20261004-010000.db'), sourceMtimeNs: 123456789n, sourceSize: 4096 },
    ])
  })
})
