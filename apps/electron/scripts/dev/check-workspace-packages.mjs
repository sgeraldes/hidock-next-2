#!/usr/bin/env node
/**
 * Refuse to start or build the app on a workspace package whose dist is older
 * than its source.
 *
 * What happened in November 2026: packages/database/dist was older than
 * packages/database/src. The app loaded the dist, so it ran an engine from
 * before the pre-migration snapshot existed, and the v72 migration reached the
 * owner's library with no `<db>.bak-pre-v72-...` restore point. Nothing in the
 * dev launch or the build said a word.
 *
 * The app's `@hidock/*` dependencies are `file:` links to packages/*, each
 * built by tsup into its own dist. This gate runs before `npm run dev` and
 * `npm run build` (the predev and prebuild scripts) and fails when, for any of
 * them:
 *  - a dist entry file named by the package's main/exports is missing, or
 *  - a file under src/, or the package's package.json, tsconfig.json or
 *    tsup.config.ts, is newer than the oldest of those entry files.
 *
 * It compares the copy the app resolves through node_modules, because that is
 * the code that runs. In a worktree whose node_modules is a junction to the
 * main checkout, that is the main checkout's package, and its own src is the
 * reference.
 *
 * It fails rather than rebuilding: a rebuild from here would write into
 * whichever checkout the link points at, possibly under a running app, and
 * tsup's clean step deletes the dist first. The message names the command.
 *
 * Packages the app bundles from source (SOURCE_BUNDLED_PACKAGES, aliased in
 * electron.vite.config.ts and vitest.config.ts) never load their dist and are
 * skipped.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

/** Bundled from source by electron-vite; their dist is never loaded. */
export const SOURCE_BUNDLED_PACKAGES = ['@hidock/database']

const CONFIG_FILES = ['package.json', 'tsconfig.json', 'tsup.config.ts']

/** Newest file under `dir` (recursive), or null when there is none. */
function newestFile(dir) {
  let best = null
  if (!existsSync(dir)) return best
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = newestFile(full)
      if (inner && (!best || inner.mtimeMs > best.mtimeMs)) best = inner
    } else if (entry.isFile()) {
      const mtimeMs = statSync(full).mtimeMs
      if (!best || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs }
    }
  }
  return best
}

/** Every dist file the package's manifest promises (main, types, exports['.']). */
function entryFiles(pkgDir, manifest) {
  const named = new Set()
  for (const key of ['main', 'module', 'types']) if (typeof manifest[key] === 'string') named.add(manifest[key])
  const root = manifest.exports?.['.']
  if (typeof root === 'string') named.add(root)
  else if (root && typeof root === 'object') {
    for (const value of Object.values(root)) if (typeof value === 'string') named.add(value)
  }
  return [...named].map((p) => resolve(pkgDir, p))
}

/** The package directory node_modules resolves `name` to, or null. */
function resolveThroughNodeModules(appDir, name) {
  const link = join(appDir, 'node_modules', ...name.split('/'))
  if (!existsSync(link)) return null
  try {
    return realpathSync(link)
  } catch {
    return null
  }
}

/**
 * The workspace packages whose dist is older than their source or missing.
 * `resolve(name)` returns the directory the app loads the package from; the
 * default follows node_modules and falls back to the `file:` path.
 */
export function findStalePackages({ appDir, skip = SOURCE_BUNDLED_PACKAGES, resolve: resolvePackage } = {}) {
  const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
  const stale = []
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('file:') || skip.includes(name)) continue
    const declared = resolve(appDir, spec.slice('file:'.length))
    const dir = (resolvePackage ? resolvePackage(name) : resolveThroughNodeModules(appDir, name)) ?? declared
    const pkgManifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const entries = entryFiles(dir, pkgManifest)
    const missing = entries.filter((p) => !existsSync(p))
    if (entries.length === 0 || missing.length > 0) {
      stale.push({ name, dir, reason: 'missing', missing })
      continue
    }
    const oldestEntry = Math.min(...entries.map((p) => statSync(p).mtimeMs))
    let newest = newestFile(join(dir, 'src'))
    for (const file of CONFIG_FILES) {
      const p = join(dir, file)
      if (!existsSync(p)) continue
      const mtimeMs = statSync(p).mtimeMs
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path: p, mtimeMs }
    }
    if (newest && newest.mtimeMs > oldestEntry) {
      stale.push({ name, dir, reason: 'older', newestSource: newest.path, newestSourceMs: newest.mtimeMs, distMs: oldestEntry })
    }
  }
  return stale
}

function main() {
  const appDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const stale = findStalePackages({ appDir })
  if (stale.length === 0) {
    console.log('[workspace-packages] Every workspace package dist is current.')
    return
  }
  console.error('[workspace-packages] Refusing to continue: the app would load workspace code older than its source.')
  for (const s of stale) {
    if (s.reason === 'missing') {
      const what = s.missing.length ? s.missing.map((p) => relative(s.dir, p)).join(', ') : 'no entry files declared'
      console.error(`  ${s.name} (${s.dir}): dist missing (${what})`)
    } else {
      console.error(
        `  ${s.name} (${s.dir}): ${relative(s.dir, s.newestSource)} changed ${new Date(s.newestSourceMs).toISOString()}, ` +
          `dist built ${new Date(s.distMs).toISOString()}`
      )
    }
    console.error(`    rebuild: npm --prefix "${s.dir}" run build`)
  }
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
