/**
 * The gate that refuses to start or build the app on a workspace package whose
 * dist is older than its source (scripts/dev/check-workspace-packages.mjs).
 * Real files in a temp folder, real mtimes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { findStalePackages, SOURCE_BUNDLED_PACKAGES } from './check-workspace-packages.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let root

const T_OLD = new Date('2026-11-01T00:00:00Z')
const T_NEW = new Date('2026-11-20T00:00:00Z')

function write(path, text, time) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  utimesSync(path, time, time)
}

/** A package with src and dist, each file stamped with the given time. */
function makePackage(name, { srcTime, distTime, dist = true }) {
  const dir = join(root, 'packages', name)
  write(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@hidock/${name}`,
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' } },
    }),
    T_OLD
  )
  write(join(dir, 'src', 'index.ts'), 'export const a = 1\n', srcTime)
  write(join(dir, 'src', 'nested', 'deep.ts'), 'export const b = 2\n', srcTime)
  if (dist) {
    for (const f of ['index.js', 'index.cjs', 'index.d.ts']) write(join(dir, 'dist', f), '//\n', distTime)
  }
  return dir
}

function makeApp(deps) {
  const appDir = join(root, 'apps', 'electron')
  write(join(appDir, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps }), T_OLD)
  return appDir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hidock-wscheck-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('findStalePackages', () => {
  it('passes when every dist is newer than its source', () => {
    makePackage('alpha', { srcTime: T_OLD, distTime: T_NEW })
    const appDir = makeApp({ '@hidock/alpha': 'file:../../packages/alpha', react: '^19' })
    expect(findStalePackages({ appDir })).toEqual([])
  })

  it('reports a package whose source changed after its dist was built', () => {
    makePackage('alpha', { srcTime: T_OLD, distTime: T_NEW })
    const beta = makePackage('beta', { srcTime: T_NEW, distTime: T_OLD })
    const appDir = makeApp({ '@hidock/alpha': 'file:../../packages/alpha', '@hidock/beta': 'file:../../packages/beta' })
    const stale = findStalePackages({ appDir })
    expect(stale).toHaveLength(1)
    expect(stale[0]).toMatchObject({ name: '@hidock/beta', dir: beta, reason: 'older' })
    expect(stale[0].newestSource).toContain('index.ts')
  })

  it('sees a change in a nested source file', () => {
    const dir = makePackage('alpha', { srcTime: T_OLD, distTime: T_OLD })
    utimesSync(join(dir, 'src', 'nested', 'deep.ts'), T_NEW, T_NEW)
    const appDir = makeApp({ '@hidock/alpha': 'file:../../packages/alpha' })
    expect(findStalePackages({ appDir }).map((s) => s.newestSource)).toEqual([join(dir, 'src', 'nested', 'deep.ts')])
  })

  it('reports a package that has never been built', () => {
    makePackage('alpha', { srcTime: T_OLD, distTime: T_NEW, dist: false })
    const appDir = makeApp({ '@hidock/alpha': 'file:../../packages/alpha' })
    expect(findStalePackages({ appDir })).toMatchObject([{ name: '@hidock/alpha', reason: 'missing' }])
  })

  it('reports a dist missing one of its declared entry files', () => {
    const dir = makePackage('alpha', { srcTime: T_OLD, distTime: T_NEW })
    rmSync(join(dir, 'dist', 'index.cjs'))
    const appDir = makeApp({ '@hidock/alpha': 'file:../../packages/alpha' })
    expect(findStalePackages({ appDir })).toMatchObject([{ name: '@hidock/alpha', reason: 'missing' }])
  })

  it('skips packages the app bundles from source', () => {
    makePackage('database', { srcTime: T_NEW, distTime: T_OLD })
    const appDir = makeApp({ '@hidock/database': 'file:../../packages/database' })
    expect(findStalePackages({ appDir, skip: ['@hidock/database'] })).toEqual([])
  })

  it('checks the copy the app resolves through node_modules when there is one', () => {
    // A worktree's node_modules points at another checkout: that copy is the
    // code the app loads, so that is the one compared.
    makePackage('alpha', { srcTime: T_OLD, distTime: T_NEW })
    const elsewhere = join(root, 'other-checkout', 'alpha')
    write(join(elsewhere, 'package.json'), JSON.stringify({ name: '@hidock/alpha', main: './dist/index.js' }), T_OLD)
    write(join(elsewhere, 'src', 'index.ts'), 'x\n', T_NEW)
    write(join(elsewhere, 'dist', 'index.js'), 'x\n', T_OLD)
    const appDir = makeApp({ '@hidock/alpha': 'file:../../packages/alpha' })
    const resolved = { '@hidock/alpha': elsewhere }
    expect(findStalePackages({ appDir, resolve: (name) => resolved[name] ?? null })).toMatchObject([
      { name: '@hidock/alpha', dir: elsewhere, reason: 'older' },
    ])
  })
})

describe('the real repository wiring', () => {
  it('bundles from source exactly the packages the vite config excludes from externalizing', () => {
    const viteConfig = readFileSync(join(here, '..', '..', 'electron.vite.config.ts'), 'utf8')
    const vitestConfig = readFileSync(join(here, '..', '..', 'vitest.config.ts'), 'utf8')
    const tsconfig = readFileSync(join(here, '..', '..', 'tsconfig.node.json'), 'utf8')
    const excluded = [...(viteConfig.match(/exclude: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect([...excluded].sort()).toEqual([...SOURCE_BUNDLED_PACKAGES].sort())
    expect(SOURCE_BUNDLED_PACKAGES).toContain('@hidock/transcription')
    for (const name of SOURCE_BUNDLED_PACKAGES) {
      expect(viteConfig).toMatch(new RegExp(`'${name}': [a-z]+Source`))
      expect(vitestConfig).toContain(`'${name}':`)
      expect(tsconfig).toContain(`"${name}":`)
    }
  })

  it('runs before dev and before build', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'))
    expect(pkg.scripts.predev).toBe('node scripts/dev/check-workspace-packages.mjs')
    expect(pkg.scripts.prebuild).toBe('node scripts/dev/check-workspace-packages.mjs')
  })
})
