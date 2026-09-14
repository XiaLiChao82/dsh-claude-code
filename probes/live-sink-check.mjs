// Offline check for `live` mode (v33 cards, v35 prose handling): drive
// translateSdkMessages with a fake SDK stream and a fake Session, then assert
// the appended events match what DSH's session invariant and the client's card
// matcher require.
//
// What it proves without a running dsh: event types, surface metadata, callId
// agreement across all three places, turn/step pinned to the open step, the
// wire tool name that selects the card, that NO stream chunk is emitted for a
// tool run, and — the v35 point — that ALL prose stays in the stream so the
// loop settles it into the turn's single assistant message.
//
// v34 asserted the opposite (prose appended as its own message before each
// card). That shape rendered as ONE message: the client keys its assistant node
// by turn:step and REPLACES the blocks on every same-step append, so each
// withheld run overwrote the last. The sink's `prose` entry point survives for
// the subagent mirror and is still shape-checked below, just no longer fed by
// the live path.
//
// Usage: node probes/live-sink-check.mjs
import { translateSdkMessages, createLiveActivitySink, findOpenStep, isLiveActivityCallId } from '../main.v20.mjs'

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** Minimal stand-in for a live DSH Session: records appends, hands out seqs. */
function fakeSession(logEvents) {
  const log = [...logEvents]
  return {
    appended: [],
    snapshotEvents: () => log,
    append(type, data, opts) {
      const event = { type, seq: log.length, data, ...opts === undefined ? {} : opts }
      log.push(event)
      this.appended.push(event)
      return event
    },
  }
}

/** One complete prose block, as the SDK streams it: start, delta(s), stop. */
function* proseBlocks(index, kind, text) {
  const nativeType = kind === 'text' ? 'text' : 'thinking'
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index, content_block: { type: nativeType } } }
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index, delta: kind === 'text' ? { text } : { thinking: text } } }
  yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index } }
}

/**
 * A turn shaped like a real one: think, speak, run a tool, then answer.
 * The lead prose must end up before the card; the answer after it.
 */
async function* fakeStream() {
  yield* proseBlocks(0, 'reasoning', 'the file probably holds it')
  yield* proseBlocks(1, 'text', 'let me read the file')
  yield {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      usage: { input_tokens: 10, output_tokens: 2 },
      content: [{ type: 'tool_use', id: 'toolu_inner_1', name: 'Read', input: { file_path: '/tmp/a.ts' } }],
    },
  }
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_inner_1', content: [{ type: 'text', text: 'line one\nline two' }], is_error: false }],
    },
  }
  yield* proseBlocks(2, 'text', 'it holds two lines')
  yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'cc-1', usage: {} }
}

const OPEN_LOG = [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'step/start', seq: 1, data: { turn: 1, step: 3 } },
  { type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 3 } },
]

console.log('--- findOpenStep ---')
check('open step is read off the log', JSON.stringify(findOpenStep(fakeSession(OPEN_LOG))) === '{"turn":1,"step":3}')
check('a closed step yields undefined', findOpenStep(fakeSession([...OPEN_LOG, { type: 'step/end', seq: 3, data: { turn: 1, step: 3 } }])) === undefined)

console.log('--- live mode: stream output ---')
const session = fakeSession(OPEN_LOG)
const sink = createLiveActivitySink({ session, logger: { warn: (m) => console.log('   (warn)', m) }, model: 'claude-opus-5' })
const chunks = []
for await (const chunk of translateSdkMessages(fakeStream(), { toolActivityDisplay: 'live', activitySink: sink })) {
  chunks.push(chunk)
}
const blockTypes = chunks.filter((c) => c.type === 'block-start').map((c) => c.blockType)
check('no tool-call / tool-activity block is streamed', !blockTypes.some((t) => t === 'tool-call' || t === 'tool-activity'), `got ${JSON.stringify(blockTypes)}`)
check('the turn still finishes', chunks.at(-1)?.type === 'finish')

const streamedText = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
check('the tail answer streams (loop settles it last)', streamedText.includes('it holds two lines'), `got ${JSON.stringify(streamedText)}`)
check('lead prose ALSO stays in the stream (v35)', streamedText.includes('let me read the file'), `got ${JSON.stringify(streamedText)}`)
const streamedReasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
check('reasoning stays in the stream (v35)', streamedReasoning.includes('the file probably holds it'), `got ${JSON.stringify(streamedReasoning)}`)
const streamIndices = chunks.filter((c) => c.type === 'block-start').map((c) => c.index)
check('stream block indices have no hole', streamIndices.every((value, at) => value === at), `got ${JSON.stringify(streamIndices)}`)

console.log('--- live mode: appended events ---')
const [call, result] = session.appended
check('two events appended: call, result', session.appended.length === 2, `got ${session.appended.map((e) => e.type).join(', ')}`)
check('the live path appends NO assistant/message', !session.appended.some((e) => e.type === 'assistant/message'))

check('first is tool/call', call?.type === 'tool/call')
check('tool/call carries NO surfaceOp', call?.surfaceOp === undefined && call?.sourceEventSeqs === undefined)
check('tool/call turn/step matches the open step', call?.data?.turn === 1 && call?.data?.step === 3)
check('wire name selects the read card', call?.data?.name === 'read', `got ${call?.data?.name}`)
check('arguments keep the real input', call?.data?.arguments === JSON.stringify({ file_path: '/tmp/a.ts' }))
check('callId is marked as display-only', isLiveActivityCallId(call?.data?.callId))

check('second is tool/result', result?.type === 'tool/result')
check('tool/result declares surfaceOp append', result?.surfaceOp === 'append')
check('tool/result cites the call seq', JSON.stringify(result?.sourceEventSeqs) === JSON.stringify([call?.seq]))
check('tool/result turn/step matches', result?.data?.turn === 1 && result?.data?.step === 3)

const message = result?.data?.message
check('result message has a non-empty id', typeof message?.id === 'string' && message.id.length > 0)
check('result message is user-role', message?.role === 'user')
check('result source names the call', message?.source?.kind === 'tool' && message?.source?.callId === call?.data?.callId)
check('result has exactly one tool-result block', Array.isArray(message?.content) && message.content.length === 1 && message.content[0]?.type === 'tool-result')
check('block toolCallId agrees with source', message?.content?.[0]?.toolCallId === call?.data?.callId)
check('output text survives', message?.content?.[0]?.content?.[0]?.text === 'line one\nline two')

// The live path no longer calls this, but the entry point stays on the sink and
// the same builder backs the subagent mirror — so its shape is still asserted.
// Anything that revives interleaving has to satisfy these again.
console.log('--- sink.prose shape (no longer driven by live) ---')
const proseSession = fakeSession(OPEN_LOG)
const proseSink = createLiveActivitySink({ session: proseSession, model: 'claude-opus-5' })
proseSink.prose([{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'said' }])
const prose = proseSession.appended[0]
check('prose appends exactly one event', proseSession.appended.length === 1, `got ${proseSession.appended.length}`)
check('prose is an assistant/message', prose?.type === 'assistant/message')
check('prose declares surfaceOp append', prose?.surfaceOp === 'append')
check('prose turn/step matches the open step', prose?.data?.turn === 1 && prose?.data?.step === 3)
check('prose message has a non-empty id', typeof prose?.data?.message?.id === 'string' && prose.data.message.id.length > 0)
check('prose message is assistant-role', prose?.data?.message?.role === 'assistant')
check('prose source names the model', prose?.data?.message?.source?.kind === 'model' && prose?.data?.message?.source?.model === 'claude-opus-5')
const proseKinds = (prose?.data?.message?.content ?? []).map((b) => b.type)
check('prose keeps both blocks in order', JSON.stringify(proseKinds) === JSON.stringify(['reasoning', 'text']), `got ${JSON.stringify(proseKinds)}`)
check('prose text survives', prose?.data?.message?.content?.[1]?.text === 'said')
check('prose ignores an empty block list', (() => {
  const before = proseSession.appended.length
  proseSink.prose([])
  return proseSession.appended.length === before
})())

console.log('--- degradation: live without a session ---')
const noSink = []
for await (const chunk of translateSdkMessages(fakeStream(), { toolActivityDisplay: 'live', activitySink: undefined })) {
  noSink.push(chunk)
}
check('falls back to a reasoning fold', noSink.some((c) => c.type === 'block-start' && c.blockType === 'reasoning'))
const degradedText = noSink.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
check('prose keeps streaming when nothing is withheld', degradedText.includes('let me read the file') && degradedText.includes('it holds two lines'), `got ${JSON.stringify(degradedText)}`)

check('createLiveActivitySink rejects a dead session', createLiveActivitySink({ session: undefined }) === undefined)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
