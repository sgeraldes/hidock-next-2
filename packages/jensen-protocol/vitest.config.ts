import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

/**
 * These tests replay real device captures and firmware images kept under
 * research/rea, which stays out of the public repository (16-oct-2026). They
 * run wherever that folder exists, and are left out where it does not (CI).
 */
const RESEARCH_FIXTURE_TESTS = [
  'tests/command-contracts630.test.ts',
  'tests/file-transfer-completion630.test.ts',
  'tests/firmware-boot-verification.test.ts',
  'tests/firmware-update.test.ts',
  'tests/native-recording.test.ts',
  'tests/owned-scratch-upload.test.ts',
  'tests/protocol-diagnostics.test.ts',
  'tests/recording-restore.test.ts',
  'tests/set-auto-record.test.ts',
  'tests/usb-read-geometry630.test.ts',
]

const hasResearchFixtures = existsSync(fileURLToPath(new URL('../../research/rea', import.meta.url)))

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...(hasResearchFixtures ? [] : RESEARCH_FIXTURE_TESTS)],
  },
})
