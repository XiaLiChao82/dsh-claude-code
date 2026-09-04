#!/usr/bin/env node
// Verify the tool-activity patch on a live DSH tree.
//
// The bundles are browser modules (window.__ModuleLoader__ + a bundler
// `require`), so they cannot simply be imported here. Instead this slices the
// three patched pure functions out of the bundle text and executes them, then
// asserts the two static wiring facts that no unit test can cover:
// the `tool-activity` case must exist AND must sit before the `default:` arm.

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_ROOT =
  '/home/sumer/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const rootArg = process.argv.slice(2).find((arg) => arg.startsWith('--root='))
const root = rootArg !== undefined ? rootArg.slice('--root='.length) : (process.env.DSH_ROOT ?? DEFAULT_ROOT)

let failures = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

/** Slice `function <name>(...) { ... }` by counting braces from its header. */
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`function ${name} not found`)
  let depth = 0
  let i = source.indexOf('{', start)
  const open = i
  for (; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const read = (relative) => {
  const path = resolve(root, relative)
  if (!existsSync(path)) throw new Error(`missing ${path}`)
  return readFileSync(path, 'utf8')
}

// 0.1.2-rc.1: dsh-client-runtime is gone and dsh-client-ui-conversation no
// longer carries the card — both live in dsh-client-ui-chat now, and the
// classifier is additionally inlined in dsh-client-ui-trajectory.
const runtime = read('dsh-client-ui-chat/lib/client.js')
const conversation = read('dsh-client-ui-chat/lib/client.js')
const llm = read('dsh-llm/lib/index.js')
const trajectory = read('dsh-client-ui-trajectory/lib/client.js')

console.log(`tool-activity verify\nroot: ${root}\n`)

// --- 1. the classifier: the single fix that made the UI case reachable ------
console.log('dsh-client-ui-chat (classifier)')
{
  const toAssistantBlock = new Function(
    `${sliceFunction(runtime, 'toAssistantBlock')}; return toAssistantBlock;`,
  )()
  const classified = toAssistantBlock({
    type: 'tool-activity',
    name: 'Bash',
    input: { command: 'npm test' },
    output: 'ok',
    isError: false,
  })
  check('tool-activity classifies as kind tool-activity', classified.kind === 'tool-activity', classified.kind)
  check('name/input/output survive classification', classified.name === 'Bash' && classified.input.command === 'npm test' && classified.output === 'ok')
  check('error flag survives', toAssistantBlock({ type: 'tool-activity', isError: true }).isError === true)
  check('missing name falls back', toAssistantBlock({ type: 'tool-activity' }).name === 'tool')
  check('non-object input coerced to {}', typeof toAssistantBlock({ type: 'tool-activity', input: 'x' }).input === 'object')
  check('unrelated types still fall through to other', toAssistantBlock({ type: 'mystery' }).kind === 'other')
  check('text/reasoning untouched', toAssistantBlock({ type: 'text', text: 'hi' }).kind === 'text')

  const emptyAssistantBlock = new Function(
    `${sliceFunction(runtime, 'emptyAssistantBlock')}; return emptyAssistantBlock;`,
  )()
  const empty = emptyAssistantBlock('tool-activity')
  check('block-start placeholder is tool-activity (no unknown-block flash)', empty.kind === 'tool-activity', empty.kind)
}

// --- 2. the card's pure helpers --------------------------------------------
console.log('\ndsh-client-ui-chat (card)')
{
  const summary = new Function(
    `${sliceFunction(conversation, 'toolActivitySummary')}; return toolActivitySummary;`,
  )()
  check('summary prefers description', summary({ input: { description: 'run tests', command: 'npm test' } }) === 'run tests')
  check('summary falls back to command', summary({ input: { command: 'npm test' } }) === 'npm test')
  check('summary uses first line only', summary({ input: { command: 'a\nb' } }) === 'a')
  check('summary reads file_path', summary({ input: { file_path: '/tmp/x' } }) === '/tmp/x')
  // Regression guard: DSH's read/write/edit are str-replace-editor-shaped and
  // send a `command` DISCRIMINATOR ("read"/"write"/"edit") next to the path. A
  // command-first order renders `Read read` / `Write write` / `Edit edit` and
  // drops the path entirely. No other check pairs the two keys, which is how
  // that regression slipped through.
  check(
    'summary prefers file_path over the command discriminator',
    summary({ input: { command: 'read', file_path: '/tmp/x' } }) === '/tmp/x',
    summary({ input: { command: 'read', file_path: '/tmp/x' } }),
  )
  // ...and that order must not steal bash's summary: a real command has no file_path.
  check('bash summary still uses its command', summary({ input: { command: 'ls -la' } }) === 'ls -la')
  // Same class of bug one key over: grep/glob send `pattern` (what) together
  // with `path` (where). Path-first summarized a search by its directory.
  check(
    'search summary prefers pattern over its search path',
    summary({ input: { pattern: 'TODO', path: '/src' } }) === 'TODO',
    summary({ input: { pattern: 'TODO', path: '/src' } }),
  )
  // A bare `path` (no pattern) must still reach the summary.
  check('a path-only tool still summarizes its path', summary({ input: { path: '/src/x.ts' } }) === '/src/x.ts')
  check('summary survives absent input', summary({}) === '')
  check('summary caps runaway length', summary({ input: { command: 'x'.repeat(9000) } }).length === 241)

  const inputText = new Function(
    `${sliceFunction(conversation, 'toolActivityInputText')}; return toolActivityInputText;`,
  )()
  check('shell command shown verbatim', inputText({ input: { command: 'npm test' } }) === 'npm test')
  check('non-shell input pretty-printed as json', (inputText({ input: { file_path: '/tmp/x' } }) ?? '').includes('"/tmp/x"'))
  check('empty input falls back to the tool name', inputText({ input: {} }) === undefined)
  check('huge input truncated', (inputText({ input: { blob: 'x'.repeat(9000) } })?.length ?? 0) <= 2002)

  const exitOf = new Function(
    `${sliceFunction(conversation, 'toolActivityExit')}; return toolActivityExit;`,
  )()
  // Claude Code's failed Bash result is literally "Exit code 3\nhello" + is_error.
  const failed = exitOf({ output: 'Exit code 3\nhello', isError: true })
  check('real exit code parsed off the output', failed.exitCode === 3 && failed.known === true, JSON.stringify(failed))
  check('the exit-code line is stripped from the shown output', failed.output === 'hello', JSON.stringify(failed.output))
  const ok = exitOf({ output: 'hello', isError: false })
  check('success reports exit code 0 and keeps its output', ok.exitCode === 0 && ok.output === 'hello' && ok.known === true)
  const opaque = exitOf({ output: 'file not found', isError: true })
  check('failure without an exit-code line is flagged unknown', opaque.exitCode === 1 && opaque.known === false)
  check('multi-digit exit codes parse', exitOf({ output: 'Exit code 127\nx', isError: true }).exitCode === 127)
  check('a mid-output mention is not mistaken for the code', exitOf({ output: 'see Exit code 3 below', isError: true }).known === false)

  // Read results are "<n>\t<text>" per line, with one trailing numbered blank
  // row for the text after the final newline (verified against the Agent SDK).
  const readLines = new Function(
    `${sliceFunction(conversation, 'toolActivityReadLines')}; return toolActivityReadLines;`,
  )()
  const parsed = readLines('1\talpha\n2\tbeta\n3\tgamma\n4\t')
  check('read output parses into gutter rows', parsed?.length === 3 && parsed[0].number === 1 && parsed[0].text === 'alpha', JSON.stringify(parsed))
  check('the phantom trailing row is dropped', parsed?.[2].text === 'gamma')
  check('an indented gutter still parses', readLines('   42\thello')?.[0].number === 42)
  check('tabs inside the line survive', readLines('1\ta\tb')?.[0].text === 'a\tb')
  check('a non-listing result is rejected', readLines('File does not exist.') === undefined)
  check('an empty result is rejected', readLines('') === undefined)

  // The other producer is DSH's own `read`, bridged in by llm-claude-code v28
  // once the native Read is switched off. dsh-tool-fs formatReadOutput wraps the
  // rows in <path>/<type>/<content> tags, separates the gutter with ": " instead
  // of a tab, and appends a footer sentence after a blank line. Every one of
  // those three differences is enough on its own to empty the parse and
  // downgrade the card to the terminal view, so all three are pinned here.
  const dshRead = [
    '<path>/tmp/demo.txt</path>',
    '<type>file</type>',
    '<content>',
    '1: alpha',
    '2: beta',
    '',
    '(End of file - total 2 lines)',
    '</content>',
  ].join('\n')
  const dshParsed = readLines(dshRead)
  check("DSH's wrapped colon format parses", dshParsed?.length === 2 && dshParsed[0].number === 1 && dshParsed[0].text === 'alpha', JSON.stringify(dshParsed))
  check('the <path> header does not empty the parse', dshParsed !== undefined)
  check('the footer sentence never becomes a row', dshParsed?.every((row) => !row.text.startsWith('(End of file')) === true)
  check('a colon inside the line survives', readLines('<content>\n1: a: b\n</content>')?.[0].text === 'a: b')
  check('a tab-format body inside the wrapper still parses', readLines('<content>\n1\talpha\n</content>')?.[0].text === 'alpha')
  check('a wrapper with no numbered rows is still rejected', readLines('<content>\nFile does not exist.\n</content>') === undefined)

  const diffsOf = new Function(
    `${sliceFunction(conversation, 'toolActivityFilePath')}
     ${sliceFunction(conversation, 'toolActivityDiffs')}; return toolActivityDiffs;`,
  )()
  const edit = diffsOf({ input: { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' } })
  check('Edit builds one hunk from its input', edit?.length === 1 && edit[0].oldText === 'a' && edit[0].newText === 'b')
  const write = diffsOf({ input: { file_path: '/tmp/x.ts', content: 'hello' } })
  check('Write is a null-oldText hunk (new file)', write?.length === 1 && write[0].oldText === null && write[0].newText === 'hello')
  const multi = diffsOf({ input: { file_path: '/tmp/x.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } })
  check('MultiEdit builds one hunk per edit', multi?.length === 2)
  check('a malformed edit entry is skipped', diffsOf({ input: { file_path: '/tmp/x.ts', edits: [null, { old_string: 'a' }] } }) === undefined)
  check('no file_path yields no diff', diffsOf({ input: { old_string: 'a', new_string: 'b' } }) === undefined)

  const langOf = new Function(
    `${sliceFunction(conversation, 'toolActivityLang')}; return toolActivityLang;`,
  )()
  check('lang is the raw extension (the alias map is keyed by it)', langOf('/a/b/c.TS') === 'ts')
  check('a dotfile is not treated as an extension', langOf('/a/.bashrc') === undefined)
  check('an extensionless path yields no lang', langOf('/a/Makefile') === undefined)
}

// --- 3. the native Trajectory panel must survive the new kind --------------
// Both of its kind switches are exhaustive with no `default`, so an unhandled
// kind returns undefined and TrajectoryTable dereferences it (`b.imageSrc`).
console.log('\ndsh-client-ui-trajectory')
{
  const assistantSourceBlock = new Function(
    `${sliceFunction(trajectory, 'assistantSourceBlock')}; return assistantSourceBlock;`,
  )()
  const projected = assistantSourceBlock({ kind: 'tool-activity', name: 'Bash', output: 'ok' })
  check('a tool-activity block never projects to undefined', projected !== undefined, String(projected))
  check('it projects to a dereferenceable {type, content}', projected?.type === 'tool-activity' && projected.content === 'ok')
  check('a non-string output degrades to ""', assistantSourceBlock({ kind: 'tool-activity' })?.content === '')
  check('native kinds are untouched', assistantSourceBlock({ kind: 'reasoning', text: 'x' })?.type === 'thinking')

  const timelineBlock = new Function(
    `${sliceFunction(trajectory, 'timelineBlock')}; return timelineBlock;`,
  )()
  check('timelineBlock handles the new kind', timelineBlock({ kind: 'tool-activity', name: 'Bash' }) !== undefined)
  check('timelineBlock still blanks text blocks', timelineBlock({ kind: 'text', text: 'x' })?.text === '')
}

// --- 4. static wiring the helpers cannot prove -----------------------------
console.log('\nwiring')
{
  const caseIndex = conversation.indexOf('case "tool-activity":')
  const defaultIndex = conversation.indexOf('default: rendered.push(')
  check('AssistantMarkdown has a tool-activity case', caseIndex !== -1)
  check('the case precedes the unknown-block default', caseIndex !== -1 && defaultIndex !== -1 && caseIndex < defaultIndex)
  check('the case renders ToolActivityRow', /case "tool-activity":\s*\n\s*rendered\.push\(\(0, react_jsx_runtime\.jsx\)\(ToolActivityRow/.test(conversation))
  check('card css is injected', conversation.includes('.dsh-ta-terminal{'))
  // The body must be the native bash primitive, not a hand-rolled frame: that is
  // what supplies the status dot, the divider and the exit-code suffix.
  check('body is the native TerminalBlock', /primitives\.TerminalBlock, \{\s*command:/.test(conversation))
  check('terminal is fed the parsed exit code', /TerminalBlock, \{[\s\S]{0,400}?exitCode: exit\.exitCode/.test(conversation))
  check('unknown exit codes fall back to a plain failure label', /labels: exit\.known \? TOOL_ACTIVITY_TERMINAL_LABELS : TOOL_ACTIVITY_UNKNOWN_EXIT_LABELS/.test(conversation))

  // Every primitive takes a REQUIRED, COMPLETE label set as of 0.1.2-rc.1
  // (upstream 3c10f5d2d3): they no longer merge a Partial over internal
  // defaults, they just read `labels.x`. A missing field is not a typing
  // nicety — it throws when the user expands the card and takes the whole
  // assistant message tree with it, which is exactly the bug this guards.
  // Field lists mirror packages/client/ui-primitives/src/<Block>.tsx.
  const labelObject = (name) => {
    const at = conversation.indexOf(`const ${name} = {`)
    if (at < 0) return undefined
    const from = conversation.indexOf('{', at)
    let depth = 0
    for (let i = from; i < conversation.length; i += 1) {
      if (conversation[i] === '{') depth += 1
      else if (conversation[i] === '}') {
        depth -= 1
        if (depth === 0) return conversation.slice(from, i + 1)
      }
    }
    return undefined
  }
  const REQUIRED_LABELS = {
    TOOL_ACTIVITY_TERMINAL_LABELS: ['signal', 'exitCode', 'running', 'failed', 'done', 'copy', 'copied', 'noOutput', 'collapseAria', 'collapse', 'expandAria', 'expand'],
    TOOL_ACTIVITY_READ_LABELS: ['window', 'copy', 'copied', 'collapseAria', 'expandAria', 'collapse', 'expand'],
    TOOL_ACTIVITY_DIFF_LABELS: ['copy', 'copied', 'collapseAria', 'expandAria', 'collapse', 'expand', 'files'],
  }
  for (const [name, fields] of Object.entries(REQUIRED_LABELS)) {
    const body = labelObject(name)
    const missing = body === undefined
      ? fields
      : fields.filter((field) => !new RegExp(`(^|[{,\\s])${field}\\s*:`).test(body))
    check(`${name} covers every field the primitive reads`, missing.length === 0,
      body === undefined ? 'label set not found' : `missing: ${missing.join(', ')}`)
  }
  const unknownExit = labelObject('TOOL_ACTIVITY_UNKNOWN_EXIT_LABELS')
  check('the unknown-exit set spreads the full terminal set',
    unknownExit !== undefined && unknownExit.includes('...TOOL_ACTIVITY_TERMINAL_LABELS') && /exitCode\s*:/.test(unknownExit))
  // Every render site must actually hand the set over; an omitted prop is the
  // same crash as an incomplete one.
  check('TerminalBlock is given labels', /primitives\.TerminalBlock, \{[\s\S]{0,600}?labels:/.test(conversation))
  check('ReadBlock is given labels', /primitives\.ReadBlock, \{[\s\S]{0,600}?labels: TOOL_ACTIVITY_READ_LABELS/.test(conversation))
  check('DiffBlock is given labels', /primitives\.DiffBlock, \{[\s\S]{0,600}?labels: TOOL_ACTIVITY_DIFF_LABELS/.test(conversation))
  check('terminal css vars match the native bash card', conversation.includes('--dsl-terminal-output-max-height:224px'))
  check('no leftover IN/OUT io-card markup', !conversation.includes('dsh-ta-io'))
  // Read and Edit must reach the same primitives the native tool row uses,
  // rather than being flattened into the terminal view.
  check('Read routes to the native ReadBlock', /primitives\.ReadBlock, \{\s*label:/.test(conversation))
  check('Edit routes to the native DiffBlock', /primitives\.DiffBlock, \{\s*diffs,/.test(conversation))
  check('failed runs bypass the diff/read cards', /const diffs = isError \|\|[\s\S]{0,200}?const readLines = isError \|\|/.test(conversation))
  check('file cards use the native chat-row line budget', (conversation.match(/maxLines: 8/g) ?? []).length === 2)
  check(
    'card uses the native DisclosureRow primitive',
    /_deepseek_ai_dsh_client_ui_primitives\.DisclosureRow, \{\s*rowClassName: "dsh-ta-row"/.test(conversation),
  )
  // DisclosureRow renders collapsedContent as `(keepContentWhenOpen || !open) && content`,
  // so without this the summary vanishes the moment the card is expanded.
  check(
    'summary stays visible while the card is open',
    /rowClassName: "dsh-ta-row"[\s\S]{0,600}?keepContentWhenOpen: true/.test(conversation),
  )
  check('interrupted streams keep completed activity', llm.includes('block?.type === "tool-activity" ||'))
  check('interrupted streams assemble the open activity block', llm.includes('if (type === "tool-activity" && partial.block) return this.assemble(partial, index);'))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
