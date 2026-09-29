#!/usr/bin/env node
// Cut a release for @bestinslot/wallet-kit. `main` is protected (changes must
// go through a PR), so this is a two-step flow:
//
//   1. pnpm release <major|minor|patch|x.y.z>
//        Branches off origin/main, bumps package.json, and opens a
//        "chore(release): bump version to X.Y.Z" PR against main.
//
//   2. pnpm release:tag        (after that PR is merged)
//        Cuts the annotated vX.Y.Z tag on the merged main commit, pushes it,
//        and creates the GitHub release with generated notes. Tagging is
//        deferred to here because PRs squash-merge, so the tag must point at
//        the real merge commit — not the pre-merge bump commit. Re-running it
//        after a failed release step reuses the existing tag and creates only
//        the missing release.
//
// Then run `pnpm publish`.
//
// Flags:
//   --dry    print what would happen without changing anything

import { execFileSync } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const tagOnly = args.includes('--tag')
const bump = args.find(a => !a.startsWith('--'))

const ALLOWED = ['major', 'minor', 'patch']
// Fully-anchored semver (with optional prerelease) so only the documented
// `x.y.z` form is accepted, e.g. `1.2.3foo` is rejected.
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Z.-]+)?$/i

const die = msg => {
  console.error(msg)
  process.exit(1)
}

// Capture command output. On failure, exit cleanly with the command's own
// stderr instead of letting a raw Node stack trace surface.
const capture = (cmd, cmdArgs) => {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf8' }).trim()
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim()
    die(`Command failed: ${cmd} ${cmdArgs.join(' ')}\n${detail}`)
  }
}

// Run for effect; inherit stdio so the operator sees real command output when
// something fails, instead of a swallowed Node stack trace.
const run = (cmd, cmdArgs) => {
  if (dry) {
    console.log(`[dry] ${cmd} ${cmdArgs.join(' ')}`)
    return
  }
  execFileSync(cmd, cmdArgs, { stdio: 'inherit' })
}

// Read-only probe: true when the command exits zero.
const succeeds = (cmd, cmdArgs) => {
  try {
    execFileSync(cmd, cmdArgs, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// The version currently on origin/main is the authoritative base for both flows.
const baseVersionOnMain = () => {
  const pkg = JSON.parse(capture('git', ['show', 'origin/main:package.json']))
  return pkg.version
}

const nextVersion = (cur, kind) => {
  if (SEMVER.test(kind)) return kind
  // Extract just the numeric core so a prerelease base (e.g. 1.2.3-beta.1)
  // still yields a clean major/minor/patch bump.
  const m = cur.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) die(`Can't parse base version "${cur}".`)
  const [maj, min, pat] = m.slice(1, 4).map(Number)
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

// Validate the bump arg up front (before any git work) for the PR flow.
if (!tagOnly && (bump === undefined || (!ALLOWED.includes(bump) && !SEMVER.test(bump)))) {
  die(
    `Usage:\n` +
      `  pnpm release <major|minor|patch|x.y.z> [--dry]   open the bump PR\n` +
      `  pnpm release:tag [--dry]                          tag main after merge\n` +
      `Got: ${bump ?? '(nothing)'}`
  )
}

// Shared precondition: clean working tree.
const status = capture('git', ['status', '--porcelain'])
if (status) die(`Working tree is not clean. Commit or stash first:\n${status}`)

run('git', ['fetch', 'origin', 'main', '--tags'])

if (tagOnly) {
  // Step 2: tag the merged commit on origin/main and create its GitHub release.
  const version = baseVersionOnMain()
  const tag = `v${version}`
  const tagExists = Boolean(capture('git', ['tag', '--list', tag]))
  if (tagExists && succeeds('gh', ['release', 'view', tag])) {
    die(`Tag ${tag} and its GitHub release already exist. Nothing to do.`)
  }

  if (tagExists) {
    console.log(`Tag ${tag} already exists; creating its missing GitHub release.`)
  } else {
    run('git', ['tag', '-a', tag, 'origin/main', '-m', tag])
  }
  // Pushing an up-to-date tag is a no-op, so this also covers a retry after a failed push.
  run('git', ['push', 'origin', tag])
  run('gh', [
    'release',
    'create',
    tag,
    '--verify-tag',
    '--title',
    tag,
    '--generate-notes',
    ...(version.includes('-') ? ['--prerelease'] : []),
  ])
  console.log(
    dry
      ? `\n[dry] Would cut ${tag} on origin/main, push it, and create its GitHub release.`
      : `\nCut and pushed ${tag} (pointing at origin/main) and created its GitHub release. Now run \`pnpm publish\`.`
  )
  process.exit(0)
}

// Step 1: open the version-bump PR.
const base = baseVersionOnMain()
const version = nextVersion(base, bump)
const branch = `release/v${version}`
const message = `chore(release): bump version to ${version}`

console.log(`Base (origin/main): ${base} -> new: ${version} on ${branch}`)

run('git', ['switch', '-c', branch, 'origin/main'])
run('npm', ['version', '--no-git-tag-version', version])
run('git', ['commit', '-am', message])
run('git', ['push', '-u', 'origin', branch])

if (dry) {
  console.log(`\n[dry] Would open a PR: "${message}" (${branch} -> main).`)
  process.exit(0)
}

const url = capture('gh', [
  'pr',
  'create',
  '--base',
  'main',
  '--head',
  branch,
  '--title',
  message,
  '--body',
  `Automated release bump to \`${version}\`.\n\nAfter merge, run \`pnpm release:tag\` to cut \`v${version}\` on main, then \`pnpm publish\`.`,
])

console.log(
  `\nOpened release PR: ${url}\n` + `After it merges: \`pnpm release:tag\` then \`pnpm publish\`.`
)
