import { defineConfig } from 'vitest/config'

// These tests open real SQLite databases on disk and write to them. That is
// fast on a warm machine and slow on a cold or starved CI runner: on
// 2026-09-22 this package's engine tests took 5.4 to 8.8 seconds each on the
// Windows runner ("initializes, creates tables, and persists to disk" alone
// took 5.7s) and failed the 5s default on two branches that did not touch
// them. apps/electron's vitest.config.ts made the same call for its main-db
// project for the same reason. A test that genuinely hangs still fails; it
// just stops being a coin flip.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000
  }
})
