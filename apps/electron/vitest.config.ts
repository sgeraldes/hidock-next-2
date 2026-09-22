import { defineConfig, configDefaults } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html']
    },
    alias: {
      '@': resolve(__dirname, 'src'),
      '@components': resolve(__dirname, 'src/components'),
      '@pages': resolve(__dirname, 'src/pages'),
      '@hooks': resolve(__dirname, 'src/hooks'),
      '@lib': resolve(__dirname, 'src/lib'),
      '@store': resolve(__dirname, 'src/store'),
      '@types': resolve(__dirname, 'src/types')
    },
    // D3 follow-up (review): the better-sqlite3 dual-ABI shim is SCOPED, not
    // global. Only the `main-db` project (main-process, DB-backed tests) loads
    // src/test/setup-db.ts. Renderer tests never see the mock, and the
    // `native-binding` project runs UNMOCKED so it can detect a missing or
    // broken production binding (better-sqlite3-binding.smoke.test.ts).
    projects: [
      {
        extends: true,
        test: {
          name: 'renderer',
          include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
          setupFiles: ['./src/test/setup.ts'],
          // The heavier page suites render a full Library and drive it through
          // Testing Library's async queries. That is a few seconds alone and far
          // more when four workers share the machine: on 2026-09-22 a full-suite
          // run failed Library.trash.test.tsx with "Test timed out in 5000ms"
          // while the same file passed 27/27 on its own. The 5s default measures
          // how busy the runner is, not whether the UI works. A test that really
          // hangs still fails.
          testTimeout: 30000
        }
      },
      {
        extends: true,
        test: {
          name: 'main-db',
          include: ['electron/**/__tests__/**/*.test.ts', 'electron/**/__tests__/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, '**/*.smoke.test.ts'],
          setupFiles: ['./src/test/setup.ts', './src/test/setup-db.ts'],
          // Many main-db files run initializeDatabase() in beforeAll/beforeEach.
          // That's sub-second warm, but on cold or starved CI runners it blows
          // the default 10s hookTimeout (pixel-rag, timeline-analysis and
          // merge-journal have each red-lighted CI this way). A hung hook still
          // fails — it just gets a runner-realistic margin.
          hookTimeout: 60000,
          // The same argument, for the test bodies. These open real SQLite
          // databases and write to them, and the 5s default is not a
          // runner-realistic budget for that: on 2026-09-22 two green branches
          // failed CI on two unrelated files, recording-deletion.test.ts:467
          // and project-discovery-observations-heal-v43.test.ts:194, both with
          // "Test timed out in 5000ms" and both passing locally. A test that
          // genuinely hangs still fails; it just stops being a coin flip.
          testTimeout: 30000
        }
      },
      {
        extends: true,
        test: {
          name: 'native-binding',
          include: ['electron/**/__tests__/**/*.smoke.test.ts'],
          setupFiles: ['./src/test/setup.ts']
        }
      }
    ]
  }
})
