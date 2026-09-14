// Offline check for `interleave` mode (v36): drive translateSdkMessages with a
// fake SDK stream and pump it segment by segment, asserting the shape DSH's
// agent loop needs in order to open a fresh STEP per inner tool run.
//
// The mode's whole claim is ordering: think, card, think, card, answer — with
// nothing overwritten. It gets there by ending each stream while still holding
// an unexecuted echo tool-call, which makes the loop execute it (drawing the
// card), then open another step and re-request. This probe proves the adapter
// side of that contract without a running dsh:
//
//   · a segment ends right after its echo, carrying that echo and a finish
//   · the SEGMENT_BREAK marker never escapes into the DSH stream
//   · the suspended generator resumes exactly where it stopped, losing nothing
//   · prose lands in the segment it belongs to (this is the v34 bug's grave)
//   · the final segment reports exhaustion so its resources can be released
//   · a fold fallback (echo name unavailable) does NOT cut a segment, which
//     would strand a step with no tool-call to execute
//   · segmented:false reproduces v16 `card` batching byte for byte
//
// Usage: node probes/interleave-check.mjs
import { translateSdkMessages, pumpSegment, isEchoContinuation, isEchoCallBlock, SEGMENT_BREAK } from '../main.v20.mjs'

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** One complete prose block, as the SDK streams it: start, delta(s), stop. */
function* proseBlocks(index, kind, text) {
  const nativeType = kind === 'text' ? 'text' : 'thinking'
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index, content_block: { type: nativeType } } }
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index, delta: kind === 'text' ? { text } : { thinking: text } } }
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index } }
}

const toolUse = (id, name, input) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'tool_use', id, name, input }] },
})

const toolResult = (id, text) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: false }] },
})

/** Think, speak, run a tool — twice — then answer. Two cards, three prose runs. */
async function* twoToolTurn() {
  yield* proseBlocks(0, 'reasoning', 'think one')
  yield* proseBlocks(1, 'text', 'reading the first file')
  yield toolUse('toolu_1', 'Read', { file_path: '/tmp/a.ts' })
  yield toolResult('toolu_1', 'contents of a')
  yield* proseBlocks(2, 'reasoning', 'think two')
  yield* proseBlocks(3, 'text', 'now listing the directory')
  yield toolUse('toolu_2', 'Bash', { command: 'ls' })
  yield toolResult('toolu_2', 'a.ts b.ts')
  yield* proseBlocks(4, 'text', 'both files exist')
  yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'cc-1', usage: {} }
}

/** Pump ONE segment; the generator's return value reports exhaustion. */
async function drainSegment(gen) {
  const it = pumpSegment(gen)
  const chunks = []
  for (;;) {
    const { value, done } = await it.next()
    if (done === true) return { chunks, exhausted: value }
    chunks.push(value)
  }
}

const textOf = (chunks) => chunks
  .filter((chunk) => chunk.type === 'block-end')
  .map((chunk) => chunk.block?.text ?? '')
  .join(' | ')

const echoCallsIn = (chunks) => chunks
  .filter((chunk) => chunk.type === 'block-end' && isEchoCallBlock(chunk.block))
  .map((chunk) => chunk.block)

const translate = (stream, segmented) => translateSdkMessages(stream, {
  toolActivityDisplay: 'interleave',
  segmented,
  // Mirrors the real adapter's fallback when no variant name is free.
  echoNameOf: (name) => (name === 'Read' ? 'read' : name === 'Bash' ? 'bash' : 'claude_tool'),
})

console.log('--- interleave: one segment per inner tool run ---')
{
  const gen = translate(twoToolTurn(), true)

  const first = await drainSegment(gen)
  check('segment 1 suspends instead of ending the run', first.exhausted === false)
  check('segment 1 carries exactly one echo tool-call', echoCallsIn(first.chunks).length === 1,
    `got ${echoCallsIn(first.chunks).length}`)
  check('segment 1 echo is the FIRST tool (read)', echoCallsIn(first.chunks)[0]?.name === 'read',
    echoCallsIn(first.chunks)[0]?.name)
  check('segment 1 ends with a terminal finish', first.chunks.at(-1)?.type === 'finish'
    && first.chunks.at(-1)?.reason?.kind === 'stop', JSON.stringify(first.chunks.at(-1)))
  check('segment 1 finish is the ONLY finish', first.chunks.filter((c) => c.type === 'finish').length === 1)
  check('segment 1 carries its own lead prose', textOf(first.chunks).includes('think one')
    && textOf(first.chunks).includes('reading the first file'), textOf(first.chunks))
  check('segment 1 does NOT leak the next segment prose', !textOf(first.chunks).includes('think two'))
  check('SEGMENT_BREAK never reaches the DSH stream',
    first.chunks.every((chunk) => chunk.type !== SEGMENT_BREAK))
  check('segment 1 emits no usage (only the last segment may)',
    first.chunks.every((chunk) => chunk.type !== 'usage'))

  const second = await drainSegment(gen)
  check('segment 2 resumes the SUSPENDED generator', second.exhausted === false)
  check('segment 2 carries the second tool (bash)', echoCallsIn(second.chunks)[0]?.name === 'bash',
    echoCallsIn(second.chunks)[0]?.name)
  check('segment 2 carries the prose written between the two tools',
    textOf(second.chunks).includes('think two') && textOf(second.chunks).includes('now listing the directory'),
    textOf(second.chunks))
  check('segment 2 does not repeat segment 1 prose', !textOf(second.chunks).includes('think one'))
  check('segment 2 ends with a terminal finish', second.chunks.at(-1)?.type === 'finish')

  const third = await drainSegment(gen)
  check('segment 3 EXHAUSTS the run so its resources are released', third.exhausted === true)
  check('segment 3 carries the final answer', textOf(third.chunks).includes('both files exist'),
    textOf(third.chunks))
  check('segment 3 holds no echo — nothing left to execute, so the turn ends',
    echoCallsIn(third.chunks).length === 0)
  check('segment 3 reports usage exactly once', third.chunks.filter((c) => c.type === 'usage').length === 1)
  check('segment 3 ends with the real terminal finish', third.chunks.at(-1)?.type === 'finish')
}

console.log('--- ordering: what the transcript actually renders ---')
{
  const gen = translate(twoToolTurn(), true)
  const order = []
  for (;;) {
    const { chunks, exhausted } = await drainSegment(gen)
    for (const chunk of chunks) {
      if (chunk.type !== 'block-end') continue
      if (isEchoCallBlock(chunk.block)) order.push(`CARD(${chunk.block.name})`)
      else if (chunk.block?.type === 'reasoning') order.push('THINK')
      else if (chunk.block?.type === 'text') order.push('TEXT')
    }
    order.push('—step—')
    if (exhausted) break
  }
  const rendered = order.join(' ')
  const expected = 'THINK TEXT CARD(read) —step— THINK TEXT CARD(bash) —step— TEXT —step—'
  check('THINK → TOOL → THINK → TOOL ordering, one step each', rendered === expected, rendered)
}

console.log('--- fold fallback must NOT cut a segment ---')
{
  // echoNameOf returning null means the echo name was taken by a real tool, so
  // the run degrades to a fold. A fold is not executable, so cutting there
  // would hand DSH a step with nothing to run and silently end the turn early.
  const gen = translateSdkMessages(twoToolTurn(), {
    toolActivityDisplay: 'interleave',
    segmented: true,
    echoNameOf: () => null,
  })
  const only = await drainSegment(gen)
  check('a fully-degraded turn stays in ONE segment', only.exhausted === true)
  check('every run is still visible as a fold',
    only.chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'reasoning').length >= 2)
  check('no echo tool-call was emitted', echoCallsIn(only.chunks).length === 0)
}

console.log('--- segmented:false keeps v16 `card` batching ---')
{
  const gen = translate(twoToolTurn(), false)
  const only = await drainSegment(gen)
  check('the whole turn arrives in ONE segment', only.exhausted === true)
  check('both echoes ride that single stream', echoCallsIn(only.chunks).length === 2,
    `got ${echoCallsIn(only.chunks).length}`)
  check('no SEGMENT_BREAK is produced at all',
    only.chunks.every((chunk) => chunk.type !== SEGMENT_BREAK))
}

console.log('--- continuation detection ---')
{
  const echoCall = {
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: JSON.stringify({ claudeActivity: true, output: 'x' }) }],
  }
  const echoResult = { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [] }] }
  const realUser = { role: 'user', content: [{ type: 'text', text: 'and now do this' }] }

  check('an echo-result tail IS a continuation', isEchoContinuation([echoCall, echoResult]))
  check('a real user message is NOT a continuation', isEchoContinuation([echoCall, echoResult, realUser]) === false)
  check('an empty history is NOT a continuation', isEchoContinuation([]) === false)
  check('undefined is NOT a continuation', isEchoContinuation(undefined) === false)
  check('a non-echo tool-result is NOT a continuation', isEchoContinuation([
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_real', content: [] }] },
  ]) === false)
  check('a mixed tail (echo result + text) is NOT a continuation', isEchoContinuation([
    echoCall,
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [] }, { type: 'text', text: 'hi' }] },
  ]) === false)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
