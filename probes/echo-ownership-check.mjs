// Offline check for the echo-name ownership guard (v38).
//
// The bug this locks down: echo tools are registered under the NATIVE tool
// names (write/edit/read/bash) so the transcript draws native cards. They land
// in the GLOBAL layer, because this plugin mounts in the host composition. A
// preset-based deployment mounts tool-fs / tool-bash on the AGENT plane, so the
// real read/write/edit/bash land in the calling agent's OWN layer, which
// shadows the inherited global entry at execution time. Cards then submitted a
// native name carrying card-only arguments, and DSH validated them against the
// REAL schema:
//
//   Error: invalid arguments: missing required property "content"
//   Error: invalid arguments: missing required property "old_string"; ...
//
// v37 tried to catch this by re-asking ctx.tools.get() at emit time. That call
// carries no scope, so it answers from the global view — where the echo is
// still ours and always will be — and the guard never fired once. THAT is what
// this probe now pins: the ownership question must be answered from the
// request's own declared tools.
//
// Three things are asserted, and the last two matter more than the first:
//
//   · echoOwnsToolName is an exact ownership test on either shape
//   · resolveEchoName degrades a SHADOWED name to claude_tool — the case a
//     global-view check structurally cannot see
//   · buildEchoArguments still does NOT carry the real tools' required fields
//
// The last is a tripwire, not a nicety. "Just add content/old_string so
// validation passes" is the obvious-looking fix and it is actively dangerous:
// the call would then pass validation and DSH would execute a SECOND, real
// write or edit. That is not hypothetical — it is exactly what bash/read/glob/
// grep cards were already doing, because their payload happens to cover the
// required set and DSH never closes additionalProperties. If this probe ever
// fails, read the v38 comment block before changing anything.
//
// Usage: node probes/echo-ownership-check.mjs
import {
  echoOwnsToolName, buildEchoArguments, buildDriverArguments, indexRequestTools, resolveEchoName,
  ECHO_VARIANTS, ECHO_FALLBACK, ECHO_DRIVER,
} from '../main.v20.mjs'

const MARKER = 'claudeActivity'

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// ── Shapes ───────────────────────────────────────────────────────────────────
// ctx.tools.get() returns a ToolDefinition whose `parameters` is already
// compiled to JSON Schema, so the marker sits under `properties`.

/** One of ours, as ctx.tools.get() hands it back after registration. */
const ourEcho = (name) => ({
  name,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      [MARKER]: { type: 'boolean' },
      ccTool: { type: 'string' },
      output: { type: 'string' },
      isError: { type: 'boolean' },
    },
    required: [MARKER, 'output'],
  },
})

/** The real fs write tool (packages/fs/tool-fs/src/write.ts). */
const realWrite = {
  name: 'write',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['file_path', 'content'],
  },
}

/** The real fs edit tool (packages/fs/tool-fs/src/edit.ts). */
const realEdit = {
  name: 'edit',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
}

console.log('\n── ownership test ──')

check('our echo tool is recognised', echoOwnsToolName(ourEcho('write')) === true)
check('the real write tool is NOT ours', echoOwnsToolName(realWrite) === false)
check('the real edit tool is NOT ours', echoOwnsToolName(realEdit) === false)

console.log('\n── ownership test survives junk ──')

// ctx.tools.get() returns undefined for an unregistered name; everything else
// here is defensive, because a wrong `true` re-opens the double-write path.
check('undefined (name never registered)', echoOwnsToolName(undefined) === false)
check('null', echoOwnsToolName(null) === false)
check('empty object', echoOwnsToolName({}) === false)
check('parameters present, properties absent', echoOwnsToolName({ parameters: {} }) === false)
check('properties present, marker absent', echoOwnsToolName({ parameters: { properties: {} } }) === false)
check('parameters is a string', echoOwnsToolName({ parameters: 'nope' }) === false)
check('marker at the wrong depth is rejected', echoOwnsToolName({ parameters: { [MARKER]: true } }) === false)

{
  // A tool that merely mentions the marker in a nested sub-schema must not
  // read as ours — ownership is about the top-level property map only.
  const decoy = { parameters: { properties: { payload: { properties: { [MARKER]: {} } } } } }
  check('marker nested inside another property is rejected', echoOwnsToolName(decoy) === false)
}

console.log('\n── the echo names must stay OUT of DSH\'s namespace (v40 tripwire) ──')

{
  // v40's whole claim is that an echo can never collide, because DSH's tool
  // names are lowercase and ours are not. That claim is one `toLowerCase()`
  // away from being silently untrue, so it gets pinned here rather than in a
  // comment: rename `Bash` back to `bash` for a prettier client row and this
  // check fails before the harness does.
  //
  // `claude_tool` is the deliberate exception — it is lowercase but names
  // nothing DSH ships, and it predates the rename as the generic fallback.
  const names = [...new Set([...Object.values(ECHO_VARIANTS), ECHO_FALLBACK])]
  const lower = names.filter((n) => n !== ECHO_FALLBACK && n === n.toLowerCase())
  check('every variant echo is capitalised, i.e. outside DSH\'s lowercase namespace',
    lower.length === 0, lower.join(','))
  check('each inner tool maps to an echo named after itself',
    Object.entries(ECHO_VARIANTS).every(([cc, echo]) => cc === echo),
    Object.entries(ECHO_VARIANTS).filter(([cc, e]) => cc !== e).map(([cc, e]) => `${cc}->${e}`).join(','))

  // The realistic preset deployment, which is what v37/v38 were about: the
  // agent declares DSH's REAL lowercase fs/bash tools. None of them can shadow
  // an echo any more, so nothing degrades and every card keeps its own name.
  const owned = new Set(names)
  const presetScope = indexRequestTools([
    realWrite,
    realEdit,
    { name: 'read', parameters: { type: 'object', properties: { file_path: {} }, required: ['file_path'] } },
    { name: 'bash', parameters: { type: 'object', properties: { command: {}, description: {} }, required: ['command', 'description'] } },
    ...names.map((n) => ourEcho(n)),
  ])
  const degraded = []
  for (const cc of ['Write', 'Edit', 'Read', 'Bash', 'Glob', 'Grep']) {
    check(`${cc} keeps its own card name next to DSH's real tools`,
      resolveEchoName(cc, presetScope, owned, (n) => degraded.push(n)) === cc)
  }
  check('nothing degraded at all', degraded.length === 0, degraded.join(','))
}

console.log('\n── scope-accurate resolution (v38, the half v37 lacked) ──')
// Still exercised as a MECHANISM: v40 removed the collision, it did not remove
// the guard. Nothing in the harness shadows `Write`/`Bash` today, so the
// shadow has to be CONSTRUCTED here — that is the point. The guard must keep
// working for whatever takes one of these names next (another plugin, a future
// preset, a DSH release that adds capitalised tools), not only for the
// lowercase tool-fs collision that happened to reveal it.

{
  // Everything we registered at startup: the full v40 set.
  const owned = new Set([...Object.values(ECHO_VARIANTS), ECHO_FALLBACK])

  // A constructed hostile scope: something else declares `Write`/`Edit`/`Read`/
  // `Bash` with real schemas. `claude_tool` stays ours, so it remains the
  // fallback every degraded card lands on.
  const shadowed = indexRequestTools([
    { ...realWrite, name: 'Write' },
    { ...realEdit, name: 'Edit' },
    { name: 'Read', parameters: { type: 'object', properties: { file_path: {} }, required: ['file_path'] } },
    { name: 'Bash', parameters: { type: 'object', properties: { command: {}, description: {} }, required: ['command', 'description'] } },
    ourEcho(ECHO_FALLBACK),
  ])

  const degraded = []
  const resolve = (ccName) => resolveEchoName(ccName, shadowed, owned, (name) => degraded.push(name))

  check('Write degrades when the agent scope resolves it to a real tool', resolve('Write') === ECHO_FALLBACK)
  check('Edit degrades the same way', resolve('Edit') === ECHO_FALLBACK)
  // These two are the silent half: they never failed validation, they RAN.
  check('Bash degrades even though its payload would have passed validation', resolve('Bash') === ECHO_FALLBACK,
    'a passing payload means DSH executes the real command a second time')
  check('Read degrades for the same reason', resolve('Read') === ECHO_FALLBACK)
  check('each shadowed name is reported exactly once', degraded.join(',') === 'Write,Edit,Bash,Read', degraded.join(','))
}

{
  // The other direction: nothing is shadowed, so the echo names stay claimable.
  const owned = new Set(['Bash', 'Write', ECHO_FALLBACK])
  const free = indexRequestTools([ourEcho('Write'), ourEcho('Bash'), ourEcho(ECHO_FALLBACK)])
  check('an unshadowed name is still used', resolveEchoName('Write', free, owned) === 'Write')
  check('an unshadowed bash is still used', resolveEchoName('Bash', free, owned) === 'Bash')
}

{
  // A name we never registered cannot be claimed no matter what the request
  // declares — `owned` and `declared` are AND-ed, not OR-ed.
  const declared = indexRequestTools([ourEcho('Write'), ourEcho(ECHO_FALLBACK)])
  check('an unregistered name falls through to the fallback',
    resolveEchoName('Write', declared, new Set([ECHO_FALLBACK])) === ECHO_FALLBACK)
  check('with no fallback registered either, the run gets no card',
    resolveEchoName('Write', declared, new Set()) === null)
}

{
  // `options.tools` is OMITTED when the calling scope declares no tools
  // (agent-loop/src/agent.ts:565). An absent index must read as "nothing is
  // ours", never as "everything is".
  const owned = new Set(['Write', ECHO_FALLBACK])
  for (const [label, input] of [['undefined', undefined], ['null', null], ['empty array', []], ['a string', 'nope']]) {
    check(`request tools = ${label} claims nothing`, resolveEchoName('Write', indexRequestTools(input), owned) === null)
  }
  check('junk entries are skipped rather than throwing',
    resolveEchoName('Write', indexRequestTools([null, 42, {}, { name: '' }, ourEcho(ECHO_FALLBACK)]), owned) === ECHO_FALLBACK)
}

{
  // An unknown inner tool has no ECHO_VARIANTS entry, so it must land on the
  // fallback — and the fallback is subject to the SAME test.
  const owned = new Set(['claude_tool'])
  check('unknown inner tool uses the fallback when the fallback is ours',
    resolveEchoName('Skill', indexRequestTools([ourEcho('claude_tool')]), owned) === 'claude_tool')
  check('unknown inner tool gets no card when even the fallback is shadowed',
    resolveEchoName('Skill', indexRequestTools([{ name: 'claude_tool', parameters: { type: 'object', properties: {} } }]), owned) === null)
}

console.log('\n── the payload must stay incomplete (tripwire) ──')

{
  const args = buildEchoArguments('Write', { file_path: '/tmp/a.txt', content: 'hello' }, 'Created file', false)
  check('Write echo carries file_path', args.file_path === '/tmp/a.txt')
  check('Write echo does NOT carry content', !('content' in args),
    'adding it would let DSH perform a second, real write')
  check('Write echo carries the marker', args[MARKER] === true)
  check('Write echo carries output', typeof args.output === 'string' && args.output.length > 0)
}

{
  const input = { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' }
  const args = buildEchoArguments('Edit', input, 'Edited file', false)
  check('Edit echo carries file_path', args.file_path === '/tmp/a.txt')
  check('Edit echo does NOT carry old_string', !('old_string' in args),
    'adding it would let DSH perform a second, real edit')
  check('Edit echo does NOT carry new_string', !('new_string' in args))
}

// NOT a "they were fine" control group — the opposite. These payloads cover
// the real tools' entire required set, so a shadowed read/bash card PASSED
// validation and DSH executed the real tool a second time. What is pinned here
// is that the payloads stay this shape, so the scope guard above is the only
// thing standing between a card and a duplicate execution.
console.log('\n── why read/bash failed SILENTLY instead of loudly ──')

{
  const args = buildEchoArguments('Read', { file_path: '/tmp/a.txt' }, 'file body', false)
  check('Read echo covers the real read\'s entire required set', args.file_path === '/tmp/a.txt')
}

{
  const input = { command: 'ls -la', description: 'List files' }
  const args = buildEchoArguments('Bash', input, 'a\nb', false)
  check('Bash echo covers command', args.command === 'ls -la')
  check('Bash echo covers description', args.description === 'List files')
}

{
  // Unknown inner tools land on the generic claude_tool echo, whose only
  // required fields are the marker and output — so this path cannot fail
  // validation no matter which tool showed up.
  const args = buildEchoArguments('Skill', { _inputLine: 'apifox-cli' }, 'skill body', false)
  check('unknown tool still produces marker + output', args[MARKER] === true && typeof args.output === 'string')
  check('unknown tool records its real name', args.ccTool === 'Skill')
}

console.log('\n── the driver block must carry NO native payload (v42 tripwire) ──')
{
  // Regression guard with teeth. The driver exists to hold the step open; the
  // live sink draws the card from the real arguments. Any native field creeping
  // back here is both log bloat and a block that could satisfy a real tool's
  // schema if ECHO_DRIVER ever collided — the shape that made v37's echoes run
  // twice. Compare against a fully-populated echo of the SAME run.
  const input = { command: 'rm -rf /tmp/x', description: 'Remove scratch dir' }
  const driver = buildDriverArguments('Bash')
  const card = buildEchoArguments('Bash', input, 'some output', false)

  const NATIVE_FIELDS = ['command', 'description', 'file_path', 'pattern', 'query', 'url']
  const leaked = NATIVE_FIELDS.filter((f) => driver[f] !== undefined)
  check(`driver leaks no native field (found: ${leaked.join(',') || 'none'})`, leaked.length === 0)
  check('the same run DOES populate the card form', card.command === 'rm -rf /tmp/x')

  // What must survive: isEchoCallBlock filters replayed blocks on the marker,
  // and defineEchoTool's schema makes marker + output required.
  check('driver keeps the marker (isEchoCallBlock depends on it)', driver[MARKER] === true)
  check('driver keeps an output key (schema required)', typeof driver.output === 'string')
  check('driver output body is empty', driver.output === '')
  check('driver stays legible in a raw log', driver.ccTool === 'Bash')

  const driverBytes = JSON.stringify(driver).length
  const cardBytes = JSON.stringify(card).length
  check(`driver is smaller than the card form (${driverBytes} < ${cardBytes})`, driverBytes < cardBytes)
  // ECHO_DRIVER is the only name that routes here; every other echo IS a card.
  check('ECHO_DRIVER is not one of the per-tool variants', !Object.values(ECHO_VARIANTS).includes(ECHO_DRIVER))
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
