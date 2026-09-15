/**
 * Offline checks for v41's host/client split.
 *
 * The split's whole premise is that two files agree about a name they cannot
 * share through an import: main.v20.mjs emits driver blocks under ECHO_DRIVER,
 * and src/client/driver-names.js hides exactly that. A silent drift would not
 * crash anything — it would just leave every driver row visible as a blank gap,
 * which is precisely the kind of defect nobody reports and nobody finds.
 *
 * The second invariant is sharper: the client must hide ONLY the driver name.
 * Keying a per-tool ECHO_VARIANTS name would blank the tool cards of every
 * session recorded under v40, where that name WAS the visible card.
 *
 * Run: node probes/client-driver-check.mjs
 */
import { ECHO_DRIVER, ECHO_FALLBACK, ECHO_VARIANTS, SINK_MODES, TOOL_ACTIVITY_DISPLAYS } from '../main.v20.mjs'
import { DRIVER_KEYS, MARKER, STYLE } from '../src/client/driver-names.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  PASS  ${label}`); return }
  failures += 1
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('v41 host/client parity')

const clientNames = [...new Set(DRIVER_KEYS)].sort()
check(
  'client hides exactly the host driver name',
  JSON.stringify(clientNames) === JSON.stringify([ECHO_DRIVER]),
  `host=${JSON.stringify([ECHO_DRIVER])} client=${JSON.stringify(clientNames)}`,
)
check('no duplicate driver keys', DRIVER_KEYS.length === clientNames.length)

// The v40-history guard. A keyed toolview REPLACES the generic row and
// ToolCallTree's `fallback` fires only when no entry matches, so keying a name
// that used to be the card blanks it retroactively.
const visibleEchoNames = new Set([...Object.values(ECHO_VARIANTS), ECHO_FALLBACK])
for (const name of DRIVER_KEYS) {
  check(`${name} was never a visible card name`, !visibleEchoNames.has(name))
}

console.log('v40 invariant still holds (names stay out of DSH\'s namespace)')
// DSH tool names are lowercase; a driver key that lowercases to itself would be
// back in the collision zone v40 escaped. claude_tool is the one legitimate
// exception — it is a tool this plugin registers itself, under its own name.
for (const name of DRIVER_KEYS) {
  if (name === ECHO_FALLBACK) continue
  check(`${name} is not a lowercase DSH-style name`, name !== name.toLowerCase())
}

console.log('hide rule')
check('rule interpolates the marker', STYLE.includes(`[${MARKER}]`))
check('rule leaves no unresolved placeholder', !STYLE.includes('${'))
check('rule is scoped to tool-call seats', STYLE.includes('[data-chat-flow-kind="tool-call"]'))
check('rule collapses the row', /display:\s*none/.test(STYLE))
// :empty would also swallow a legitimately empty card; the marker must be the
// only thing that triggers the collapse.
check('rule does not key on :empty', !STYLE.includes(':empty'))

console.log('sink modes')
check('live appends its card', SINK_MODES.has('live'))
check('interleave appends its card (v41)', SINK_MODES.has('interleave'))
check('card still batches at end of stream', !SINK_MODES.has('card'))
check('fold never touches the session', !SINK_MODES.has('fold'))
check('native never touches the session', !SINK_MODES.has('native'))
for (const mode of SINK_MODES) {
  check(`${mode} is a real display mode`, TOOL_ACTIVITY_DISPLAYS.includes(mode))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
