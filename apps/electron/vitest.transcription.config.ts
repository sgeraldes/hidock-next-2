import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
const base = fileURLToPath(new URL('.', import.meta.url))

// Run package source tests with the app's installed tools, without touching shared junctions.
export default defineConfig({
  cacheDir: resolve(base, 'out/vitest-transcription-cache'),
  resolve: { alias: {
    '@google/genai': resolve(base, 'node_modules/@google/genai/dist/node/index.mjs'),
    vitest: resolve(base, 'node_modules/vitest/dist/index.js')
  } },
  test: { environment: 'node', include: ['../../packages/transcription/tests/**/*.test.ts'] }
})
