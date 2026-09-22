/**
 * Refuse to package from a dependency tree electron-builder cannot walk.
 *
 * What happened on 2026-09-22: two installers were built from a git worktree
 * whose `apps/electron/node_modules` is a symlink to the main checkout's. Seen
 * through that link, npm reports `node-gyp-build` — a transitive production
 * dependency of `usb` — as `extraneous`, so electron-builder left it out of the
 * package. Both installers produced an app that shows its splash, fails to load
 * the USB bindings, and dies. Nothing in the build said a word: exit code 0, a
 * signed 255 MB installer, and an app that cannot start.
 *
 * The failure is silent at every stage, which is why it needs a gate rather
 * than a note in a document. Two checks, both cheap:
 *
 * 1. `node_modules` must be a real directory. A symlinked one means the build
 *    is running somewhere its dependencies were not installed.
 * 2. `npm ls --omit=dev` must report no missing or extraneous package.
 *    Extraneous is the one that bit: it is not an error npm exits non-zero for
 *    in every shape, and it is exactly what makes the builder drop a module.
 */

import { execSync } from 'child_process'
import { lstatSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const appDir = dirname(dirname(fileURLToPath(import.meta.url)))

/** Every problem found, so one run reports all of them. */
const problems = []

const modulesPath = join(appDir, 'node_modules')
try {
  if (lstatSync(modulesPath).isSymbolicLink()) {
    problems.push(
      `node_modules is a symlink (${modulesPath}).\n` +
        '  Packaging resolves dependencies through it and silently drops the ones npm\n' +
        '  then calls extraneous. Build from the checkout where the install actually\n' +
        '  happened, or run npm ci here first.'
    )
  }
} catch (error) {
  problems.push(`node_modules is missing at ${modulesPath}: ${error.message}`)
}

if (problems.length === 0) {
  let tree
  try {
    // One fixed string, no interpolation: npm is a shell script on Windows, and
    // execFileSync cannot spawn a .cmd without a shell. npm exits non-zero when
    // it finds problems and prints the JSON anyway, which is the point.
    tree = execSync('npm ls --omit=dev --json', {
      cwd: appDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (error) {
    tree = error.stdout || ''
  }

  let parsed
  try {
    parsed = JSON.parse(tree)
  } catch {
    problems.push('could not read the production dependency tree from `npm ls --omit=dev --json`')
  }

  if (parsed) {
    /** Walk the tree once, collecting anything the builder would not package. */
    const broken = []
    const seen = new Set()
    const visit = (node, name) => {
      if (!node || typeof node !== 'object') return
      if (name) {
        if (seen.has(name)) return
        seen.add(name)
        if (node.extraneous) broken.push(`${name} (extraneous)`)
        if (node.missing) broken.push(`${name} (missing)`)
      }
      for (const [child, value] of Object.entries(node.dependencies ?? {})) visit(value, child)
    }
    visit(parsed, '')

    if (broken.length > 0) {
      problems.push(
        `the production dependency tree is not intact: ${broken.join(', ')}.\n` +
          '  electron-builder walks this tree, so anything listed here is left out of\n' +
          '  app.asar and the packaged app fails to require it at startup.'
      )
    }
  }
}

if (problems.length > 0) {
  console.error('\n[preflight] refusing to package:\n')
  for (const problem of problems) console.error(`- ${problem}\n`)
  process.exit(1)
}

console.log('[preflight] dependency tree is intact; packaging')
