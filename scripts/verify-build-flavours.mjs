// Guardrail for the browser/server build split (#8): asserts the node build's
// module graph is free of Vue and the modal, and that the browser build does use
// Vue (so the node check isn't vacuous). Run after `pnpm build`.
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

const DIST = 'dist'
let failed = false
function fail(msg) {
  failed = true
  console.error(`✗ ${msg}`)
}
function ok(msg) {
  console.log(`✓ ${msg}`)
}

for (const f of ['node.js', 'browser.js']) {
  if (!existsSync(`${DIST}/${f}`)) {
    console.error(`Missing ${DIST}/${f} — run \`pnpm build\` first.`)
    process.exit(1)
  }
}

const VUE = /(?:from|import)\s*["']vue["']|require\(\s*["']vue["']\s*\)/
const RELATIVE_IMPORT = /(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g

// Collect every dist chunk reachable from an entry (following relative imports).
function reachable(entry) {
  const seen = new Set()
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file) || !existsSync(`${DIST}/${file}`)) {
      continue
    }
    seen.add(file)
    const src = readFileSync(`${DIST}/${file}`, 'utf8')
    for (const match of src.matchAll(RELATIVE_IMPORT)) {
      stack.push(match[1].replace(/^\.\//, ''))
    }
  }
  return seen
}

// The node graph must contain no Vue import and no modal/Vue-app markers.
const nodeGraph = reachable('node.js')
for (const file of nodeGraph) {
  const src = readFileSync(`${DIST}/${file}`, 'utf8')
  if (VUE.test(src)) {
    fail(`node build imports Vue via dist/${file}`)
  }
  for (const marker of ['createApp', 'showConnect']) {
    if (src.includes(marker)) {
      fail(`node build contains "${marker}" (modal/Vue leak) via dist/${file}`)
    }
  }
}
if (!failed) {
  ok(`node build is Vue/modal-free (${nodeGraph.size} chunk(s) checked)`)
}

// Sanity: the browser build *does* reference Vue, so the check above is meaningful.
const browserUsesVue = [...reachable('browser.js')].some(file =>
  VUE.test(readFileSync(`${DIST}/${file}`, 'utf8')),
)
if (browserUsesVue) {
  ok('browser build references Vue (as expected)')
}
else {
  fail('browser build does not reference Vue — the node Vue-free check would be vacuous')
}

process.exit(failed ? 1 : 0)
