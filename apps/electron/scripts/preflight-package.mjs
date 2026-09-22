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
 * than a note in a document. Two checks:
 *
 * 1. `node_modules` must be a real directory. A symlinked one means the build
 *    is running somewhere its dependencies were not installed. Junctions count:
 *    `mklink /J`, `mklink /D` and the `'junction'` symlinks npm and pnpm create
 *    all report `isSymbolicLink()`.
 * 2. npm must report nothing `missing` or `extraneous` anywhere in the
 *    production tree.
 *
 * Two things about that second check are load-bearing, and the first version of
 * this file got both wrong:
 *
 * `--all` is not optional. Without it `npm ls` returns depth 1 only — 53 nodes
 * here against 3,142 with it — and a nested missing or extraneous package
 * produces no problem, no flag, and exit 0. The incident above was caught at
 * depth 1 purely because npm had hoisted `node-gyp-build` to the top; hoisting
 * is npm's choice, not a promise, and a version conflict nests the same package
 * out of sight. The eight `@hidock/*` links are the standing case: their own
 * production dependencies live two levels down and electron-builder packages
 * them.
 *
 * npm's `problems` array is the verdict, not a hand-rolled walk. The walk this
 * replaces deduped by bare package name, so a healthy `lodash` visited first
 * hid an extraneous `lodash` nested elsewhere — npm reported the problem and
 * the walk reported an intact tree.
 *
 * `invalid` is deliberately ignored. This repo has nine today, all dev-only
 * version mismatches inside the linked packages, and none of them changes what
 * gets packaged.
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
  let tree = ''
  let spawnFailure = null
  try {
    // One fixed string, no interpolation: npm is a shell script on Windows, and
    // execFileSync cannot spawn a .cmd without a shell. npm exits non-zero when
    // it finds problems and prints the JSON anyway, which is the point.
    tree = execSync('npm ls --omit=dev --all --json', {
      cwd: appDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    tree = error.stdout || ''
    // No JSON at all means npm never ran. Keep its own words: a missing binary
    // and a corrupt tree are different problems and used to read the same.
    if (!tree.trim()) spawnFailure = (error.stderr || error.message || '').trim()
  }

  if (spawnFailure) {
    problems.push(`could not run \`npm ls\`, so the dependency tree was never checked:\n  ${spawnFailure}`)
  } else {
    let parsed
    try {
      parsed = JSON.parse(tree)
    } catch {
      problems.push('`npm ls --omit=dev --all --json` returned something that is not JSON')
    }

    if (parsed) {
      const broken = (parsed.problems ?? []).filter((problem) => /^(missing|extraneous):/.test(problem))
      if (broken.length > 0) {
        problems.push(
          'the production dependency tree is not intact:\n' +
            broken.map((problem) => `    ${problem}`).join('\n') +
            '\n  electron-builder walks this tree, so anything listed here is left out of\n' +
            '  app.asar and the packaged app fails to require it at startup.'
        )
      }
    }
  }
}

if (problems.length > 0) {
  console.error('\n[preflight] refusing to package:\n')
  for (const problem of problems) console.error(`- ${problem}\n`)
  process.exit(1)
}

console.log('[preflight] dependency tree is intact; packaging')
