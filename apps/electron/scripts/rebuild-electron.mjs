#!/usr/bin/env node
/**
 * Rebuild better-sqlite3 for the Electron ABI, forced.
 *
 * Uses the @electron/rebuild that electron-builder already ships (resolved through
 * app-builder-lib, so it does not depend on npm hoisting it to the top level).
 * `electron-builder install-app-deps` is not enough here: it calls @electron/rebuild
 * without `force`, which skips a module whose build marker says "already built for
 * Electron" even when `npm rebuild` has since replaced the binary with a Node build
 * (25-sep: a Node-ABI binary shipped in the installer that way).
 *
 * Usage: node scripts/rebuild-electron.mjs  (npm run rebuild:electron)
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const appRequire = createRequire(join(appDir, 'package.json'))
const builderRequire = createRequire(appRequire.resolve('app-builder-lib/package.json'))

const electronVersion = appRequire('electron/package.json').version
const { rebuild } = await import(pathToFileURL(builderRequire.resolve('@electron/rebuild')).href)

console.log(`[rebuild-electron] better-sqlite3 for Electron ${electronVersion} (${process.arch}), forced`)
await rebuild({
  buildPath: appDir,
  electronVersion,
  arch: process.arch,
  onlyModules: ['better-sqlite3'],
  force: true
})
console.log('[rebuild-electron] done')
