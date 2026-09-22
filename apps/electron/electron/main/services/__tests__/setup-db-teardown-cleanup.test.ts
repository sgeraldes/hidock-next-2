import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

const fixturePath = join(__dirname, 'setup-db-teardown-cleanup.fixture.test.ts')
const vitestPath = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')

function databasePath(): string {
  return join(tmpdir(), `hidock-setup-db-teardown-${process.pid}-${Date.now()}.sqlite`)
}

describe('setup-db teardown cleanup', () => {
  it('removes an open database and its WAL siblings after the setup hook runs', () => {
    const database = databasePath()

    execFileSync(process.execPath, [vitestPath, 'run', '--root', process.cwd(), fixturePath, '--project', 'main-db'], {
      env: { ...process.env, HIDOCK_SETUP_DB_TEARDOWN_DATABASE: database },
      encoding: 'utf8',
      stdio: 'pipe',
    })

    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      expect(existsSync(`${database}${suffix}`), `${database}${suffix}`).toBe(false)
    }
  })
})
