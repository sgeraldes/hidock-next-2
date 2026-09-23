// This package had no linter. It holds the engine that boots the app's schema,
// runs every migration and guards mass deletes, so it should meet the same bar
// as the app rather than be the one corner nothing checks.
//
// The rules are typescript-eslint's recommended set rather than the app's
// preset: the app's config is built around React and the Electron renderer, and
// none of that applies to a Node library.
//
// defineConfig comes from ESLint itself. typescript-eslint 8.70 deprecated its
// own `config()` helper in favour of it.
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.mjs', 'tsup.config.ts'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
  },
])
