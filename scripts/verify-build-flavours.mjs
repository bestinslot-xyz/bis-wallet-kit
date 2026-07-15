// Guardrail for the browser/server build split (#8): asserts the node build's
// module graph is free of Vue and the modal, and that the browser build is also
// Vue-free (modal is now framework-free). Run after `pnpm build`.
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

for (const f of ['node.js', 'browser.js', 'core.js', 'react.js', 'vue.js']) {
  if (!existsSync(`${DIST}/${f}`)) {
    console.error(`Missing ${DIST}/${f} — run \`pnpm build\` first.`)
    process.exit(1)
  }
}

// Match every form that references the external `vue` specifier: static
// `from "vue"` / side-effect `import "vue"`, dynamic `import("vue")`, and
// `require("vue")`.
const VUE = /(?:from|import|require)[\s(]*["']vue["']/
// Follow both static and dynamic relative imports so dynamically code-split
// chunks are included in the graph walk.
const RELATIVE_IMPORT = /(?:from|import)[\s(]*["'](\.\/[^"']+\.js)["']/g

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

// The browser, core, and react builds must ALSO be Vue-free.
for (const entry of ['browser.js', 'core.js', 'react.js']) {
  const graph = reachable(entry)
  const label = entry.replace('.js', '')
  let entryFailed = false
  for (const file of graph) {
    if (VUE.test(readFileSync(`${DIST}/${file}`, 'utf8'))) {
      fail(`${label} build imports Vue via dist/${file} (should be Vue-free)`)
      entryFailed = true
    }
  }
  if (!entryFailed) {
    ok(`${label} build is Vue-free (${graph.size} chunk(s) checked)`)
  }
}

// Sanity: the dedicated Vue adapter entry DOES reference Vue, so the Vue-free
// checks above are meaningful (i.e. the detector can find Vue when present).
// `vue.js` is required up front (see the existence check above), so this can
// never be silently skipped.
const vueAdapterUsesVue = [...reachable('vue.js')].some(file =>
  VUE.test(readFileSync(`${DIST}/${file}`, 'utf8')),
)
if (vueAdapterUsesVue) {
  ok('vue adapter build references Vue (as expected)')
}
else {
  fail('vue adapter build does not reference Vue — the Vue-free checks would be vacuous')
}

process.exit(failed ? 1 : 0)
