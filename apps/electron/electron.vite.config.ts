import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// @hidock/database is bundled from its source, never loaded from its dist.
// In November 2026 packages/database/dist was older than its src, the app ran
// that old engine, and the v72 migration reached the owner's library without
// the pre-migration snapshot the source already required. The engine has no
// runtime dependencies besides Node built-ins, and better-sqlite3 is passed in
// by the app, so bundling it changes nothing but which code runs. The same
// alias is in vitest.config.ts and tsconfig.node.json, so tests and typecheck
// see the code the build ships. Other workspace packages still load from dist;
// scripts/dev/check-workspace-packages.mjs refuses to start or build when one
// of those dists is older than its source.
const databaseSource = resolve(__dirname, '../../packages/database/src/index.ts')
// @hidock/transcription is bundled from source too: the Gemini engine's
// cancellation (AbortSignal through uploads and requests) lives there.
const transcriptionSource = resolve(__dirname, '../../packages/transcription/src/index.ts')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@hidock/database', '@hidock/transcription'] })],
    resolve: {
      alias: {
        '@hidock/database': databaseSource,
        '@hidock/transcription': transcriptionSource
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/bootstrap.ts'),
          'local-embedder-worker': resolve(__dirname, 'electron/main/local-embedder-worker.ts'),
          'sqlite-backup-worker': resolve(__dirname, 'electron/main/sqlite-backup-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts'),
          splash: resolve(__dirname, 'electron/preload/splash.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html')
        },
        output: {
          // Manual chunks for better caching and bundle organization
          manualChunks: {
            // Core React runtime - rarely changes
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            // UI component library - changes occasionally
            'vendor-radix': [
              '@radix-ui/react-dialog',
              '@radix-ui/react-dropdown-menu',
              '@radix-ui/react-popover',
              '@radix-ui/react-select',
              '@radix-ui/react-tooltip',
              '@radix-ui/react-tabs',
              '@radix-ui/react-toast',
              '@radix-ui/react-scroll-area',
              '@radix-ui/react-slider'
            ],
            // State management
            'vendor-state': ['zustand']
          }
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@components': resolve(__dirname, 'src/components'),
        '@pages': resolve(__dirname, 'src/pages'),
        '@hooks': resolve(__dirname, 'src/hooks'),
        '@lib': resolve(__dirname, 'src/lib'),
        '@store': resolve(__dirname, 'src/store'),
        '@types': resolve(__dirname, 'src/types')
      }
    },
    plugins: [react()]
  }
})
