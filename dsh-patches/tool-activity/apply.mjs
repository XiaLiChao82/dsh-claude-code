#!/usr/bin/env node
// Apply the `tool-activity` client patches to an installed DSH tree.
//
// Why this exists: llm-claude-code v21 emits a display-only `tool-activity`
// content block. DSH's shipped client does not know that block type, so it
// classifies it as `kind: "other"` and the transcript renders the generic
// "unknown content block" JSON box. Three files must agree:
//
//   1. dsh-client-ui-chat/lib/client.js AND dsh-client-ui-trajectory/lib/client.js
//      `toAssistantBlock` / `emptyAssistantBlock` must classify the wire block
//      as `kind: "tool-activity"`. WITHOUT THIS the UI case below is dead code.
//      As of 0.1.2-rc.1 the dsh-client-runtime package is GONE (upstream
//      be531688f3) and each consumer bundle inlines its own copy of this
//      classifier — hence the same edit twice, once per bundle.
//   2. dsh-client-ui-chat/lib/client.js (was dsh-client-ui-conversation)
//      `AssistantMarkdown` grows one case rendering a native-looking
//      DisclosureRow card (same primitive as Think and the native tool rows).
//   3. dsh-llm/lib/index.js
//      `interruptedBlocks()` keeps completed `tool-activity` blocks so an
//      interrupted turn does not drop the activity already shown.
//
// Idempotent, and upgrade-aware: the first run stores a pristine `.bak` next to
// each target. Later runs rebuild from that `.bak`. If DSH was upgraded (the
// target no longer carries our marker), the `.bak` is refreshed from the new
// pristine file first, so the patch is re-derived against the new baseline.
//
// Bundles are served straight from node_modules as `/plugins/<id>/client.js`
// with a content-hash `rev` computed at plugin activation, and this deployment
// has cordis hmr disabled -> RESTART `dsh web` AND RELOAD THE PAGE after this.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MARKER = 'dsh-tool-activity-patch'
const BAK_SUFFIX = '.tool-activity.bak'

const DEFAULT_ROOT =
  '/home/sumer/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const T = '\t'
const tabs = (n) => T.repeat(n)

/** Join injected source lines at one indent depth. */
const block = (depth, lines) => lines.map((line) => tabs(depth) + line).join('\n')

// ---------------------------------------------------------------------------
// 1. dsh-client-runtime: classify the wire block so the UI case can match.
// ---------------------------------------------------------------------------

const RUNTIME_CLASSIFY_ANCHOR = block(4, [
  'default: return {',
  T + 'kind: "other",',
  T + 'block',
  '};',
])

const RUNTIME_CLASSIFY_PATCH =
  block(4, [
    `/* ${MARKER} */`,
    'case "tool-activity": return {',
    T + 'kind: "tool-activity",',
    T + 'name: typeof block.name === "string" && block.name !== "" ? block.name : "tool",',
    T + 'input: block.input !== null && typeof block.input === "object" ? block.input : {},',
    T + 'output: typeof block.output === "string" ? block.output : "",',
    T + 'isError: block.isError === true',
    '};',
  ]) +
  '\n' +
  RUNTIME_CLASSIFY_ANCHOR

const RUNTIME_EMPTY_ANCHOR = block(4, [
  'default: return {',
  T + 'kind: "other",',
  T + 'block: null',
  '};',
])

const RUNTIME_EMPTY_PATCH =
  block(4, [
    `/* ${MARKER} */`,
    'case "tool-activity": return {',
    T + 'kind: "tool-activity",',
    T + 'name: "",',
    T + 'input: {},',
    T + 'output: "",',
    T + 'isError: false',
    '};',
  ]) +
  '\n' +
  RUNTIME_EMPTY_ANCHOR

// ---------------------------------------------------------------------------
// 2. dsh-client-ui-conversation: the card itself.
// ---------------------------------------------------------------------------

// Body indent matches ReasoningRow's thinkBody (22px) so the card lines up
// under the row title. Every colour is a --dsw alias token, so light/dark and
// future theme changes are inherited rather than hard-coded.
const CARD_CSS = [
  '.dsh-ta{flex-direction:column;display:flex}',
  '.dsh-ta-row{position:relative;overflow:hidden}',
  '.dsh-ta-leading{flex-shrink:0}',
  '.dsh-ta[data-state=error] .dsh-ta-leading{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-ta-chevron{color:var(--dsw-alias-label-secondary)}',
  '.dsh-ta-title{font-weight:400}',
  '.dsh-ta-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}',
  '.dsh-ta-summary{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:14px;line-height:24px;overflow:hidden}',
  '.dsh-ta-summary[data-error]{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-ta-body{padding:4px 0 4px 22px}',
  // Same three CSS custom properties the native ToolRow feeds its TerminalBlock,
  // so the font, line height and 224px output cap match the native bash card.
  '.dsh-ta-terminal{--dsl-terminal-font:var(--dsw-font-markdown-code-block-small);--dsl-terminal-line-height:18px;--dsl-terminal-output-max-height:224px;border:1px solid var(--dsw-alias-border-l1)}',
].join('')

// Anchored on the ONE unsuffixed `const css = "` in the bundle rather than a
// hashed class name: the CSS-module hash (`.Sxvs8a_root`) is regenerated on
// every build, so the old anchor broke on each DSH upgrade for no reason.
const CARD_CSS_ANCHOR = 'const css = "'
const CARD_CSS_PATCH = 'const css = "' + CARD_CSS

const CARD_COMPONENT_ANCHOR =
  'const AssistantMarkdown = (0, react.memo)(function AssistantMarkdown({'

// Written in the bundle's own compiled style: `react`, `react_jsx_runtime` and
// `_deepseek_ai_dsh_client_ui_primitives` are factory-scope bindings here.
const CARD_COMPONENT = block(2, [
  `//#region ${MARKER}`,
  '/** Tool name -> icon family. Unlisted tools fall back to the generic API glyph. */',
  'const TOOL_ACTIVITY_ICON_KINDS = {',
  T + 'read: "browse",',
  T + 'glob: "browse",',
  T + 'grep: "browse",',
  T + 'ls: "browse",',
  T + 'edit: "edit",',
  T + 'write: "edit",',
  T + 'multiedit: "edit",',
  T + 'notebookedit: "edit",',
  T + 'todowrite: "check",',
  T + 'task: "queue",',
  T + 'agent: "queue",',
  T + 'subagent: "queue"',
  '};',
  '/** Leading glyph: a failed run always shows the warning icon instead. */',
  'function toolActivityIcon(name, isError) {',
  T + 'const P = _deepseek_ai_dsh_client_ui_primitives;',
  T + 'if (isError) return (0, react_jsx_runtime.jsx)(P.IconWarningOutline16, { size: 14 });',
  T + 'switch (TOOL_ACTIVITY_ICON_KINDS[String(name).toLowerCase()]) {',
  T + T + 'case "browse": return (0, react_jsx_runtime.jsx)(P.IconBrowseOutline16, { size: 14 });',
  T + T + 'case "edit": return (0, react_jsx_runtime.jsx)(P.IconEditOutline16, { size: 14 });',
  T + T + 'case "check": return (0, react_jsx_runtime.jsx)(P.IconChecklistOutline14, { size: 14 });',
  T + T + 'case "queue": return (0, react_jsx_runtime.jsx)(P.IconQueueOutline14, { size: 14 });',
  T + T + 'default: return (0, react_jsx_runtime.jsx)(P.IconApiOutline14, { size: 14 });',
  T + '}',
  '}',
  '/**',
  '* Collapsed one-line summary: the most human-readable input field.',
  '*',
  '* `file_path` MUST outrank `command`. DSH\'s read/write/edit are',
  '* str-replace-editor-shaped: they carry a `command` DISCRIMINATOR whose value',
  '* is just the operation name ("read"/"write"/"edit"), so a command-first order',
  '* renders `Read read` / `Write write` / `Edit edit` and drops the path. Only',
  '* bash-shaped calls carry a command that is a real command, and those have no',
  '* `file_path` — so this order leaves them on `description`/`command` untouched.',
  '*',
  '* `pattern` MUST likewise outrank `path`. grep and glob send both: `pattern`',
  '* is WHAT is searched, `path` only WHERE, so a path-first order summarized a',
  '* search by its directory and hid the query. Tools that pass a bare `path`',
  '* (no pattern) still fall through to it unchanged.',
  '*/',
  'function toolActivitySummary(activity) {',
  T + 'const input = activity.input !== null && typeof activity.input === "object" ? activity.input : {};',
  T + 'const value = input.description ?? input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.query ?? input.url ?? "";',
  T + 'const first = String(value).split("\\n")[0] ?? "";',
  T + 'return first.length > 240 ? first.slice(0, 240) + "\\u2026" : first;',
  '}',
  '/** IN text: a shell command verbatim, anything else pretty-printed JSON. */',
  'function toolActivityInputText(activity) {',
  T + 'const input = activity.input !== null && typeof activity.input === "object" ? activity.input : {};',
  T + 'if (typeof input.command === "string" && input.command !== "") return input.command;',
  T + 'if (Object.keys(input).length === 0) return void 0;',
  T + 'let text;',
  T + 'try {',
  T + T + 'text = JSON.stringify(input, null, 2) ?? "";',
  T + '} catch {',
  T + T + 'text = String(input);',
  T + '}',
  T + 'if (text === "") return void 0;',
  T + 'return text.length > 2000 ? text.slice(0, 2000) + "\\n\\u2026" : text;',
  '}',
  '/**',
  '* Split the real exit code out of the output text.',
  '*',
  '* Claude Code prefixes a failed Bash result with a literal `Exit code <n>`',
  '* line and leaves a successful one untouched (verified against the Agent SDK:',
  '* failure -> "Exit code 3\\nhello" + is_error, success -> "hello"). That line is',
  '* the ONLY place a genuine exit code exists — the SDK tool_result carries just',
  '* `is_error` — so it is parsed off and reported instead of being invented.',
  '* `known` is false when a run failed without such a line (every non-Bash tool),',
  '* which the caller turns into a plain failure label rather than a fake number.',
  '*/',
  'function toolActivityExit(activity) {',
  T + 'const raw = typeof activity.output === "string" ? activity.output : "";',
  T + 'const isError = activity.isError === true;',
  T + 'const match = /^Exit code (\\d+)\\r?\\n?/.exec(raw);',
  T + 'if (match !== null) return {',
  T + T + 'exitCode: Number(match[1]),',
  T + T + 'output: raw.slice(match[0].length),',
  T + T + 'known: true',
  T + '};',
  T + 'return {',
  T + T + 'exitCode: isError ? 1 : 0,',
  T + T + 'output: raw,',
  T + T + 'known: !isError',
  T + '};',
  '}',
  // 0.1.2-rc.1 (upstream 3c10f5d2d3, "route UI copy through locale") made
  // `labels` REQUIRED on all three primitives and dropped their internal
  // DEFAULT_LABELS merge (`const copy = labels`). Passing undefined — or a
  // one-field Partial, which is what this patch used to do — now throws inside
  // the primitive the moment the card is expanded, taking the whole assistant
  // message tree down with it. So every label set below is COMPLETE, with the
  // copy lifted verbatim from the shipped zh dictionary.
  '/** Full zh label set for the native TerminalBlock (copy: locale zh). */',
  'const TOOL_ACTIVITY_TERMINAL_LABELS = {',
  T + 'signal: (signal) => `信号 ${signal}`,',
  T + 'exitCode: (code) => `退出码 ${code}`,',
  T + 'running: "运行中",',
  T + 'failed: "失败",',
  T + 'done: "已完成",',
  T + 'copy: "复制",',
  T + 'copied: "复制成功",',
  T + 'noOutput: "无输出",',
  T + 'collapseAria: "收起输出",',
  T + 'collapse: "收起",',
  T + 'expandAria: (n) => `展开其余 ${n} 行输出`,',
  T + 'expand: (n) => `… 其余 ${n} 行`',
  '};',
  '/** Failure with no parsable exit code: say so, do not claim a number. */',
  'const TOOL_ACTIVITY_UNKNOWN_EXIT_LABELS = {',
  T + '...TOOL_ACTIVITY_TERMINAL_LABELS,',
  T + 'exitCode: () => "执行失败"',
  '};',
  '/** Full zh label set for the native ReadBlock (copy: locale zh). */',
  'const TOOL_ACTIVITY_READ_LABELS = {',
  T + 'window: (shown, total) => `显示 ${shown} / ${total} 行`,',
  T + 'copy: "复制",',
  T + 'copied: "复制成功",',
  T + 'collapseAria: "收起内容",',
  T + 'expandAria: (n) => `展开其余 ${n} 行`,',
  T + 'collapse: "收起",',
  T + 'expand: (n) => `… 其余 ${n} 行`',
  '};',
  '/** Full zh label set for the native DiffBlock (copy: locale zh). */',
  'const TOOL_ACTIVITY_DIFF_LABELS = {',
  T + 'copy: "复制",',
  T + 'copied: "复制成功",',
  T + 'collapseAria: "收起差异",',
  T + 'expandAria: (n) => `展开其余 ${n} 行差异`,',
  T + 'collapse: "收起",',
  T + 'expand: (n) => `… 其余 ${n} 行`,',
  T + 'files: (count) => `${count} 个文件`',
  '};',
  '/** Tools whose result is a numbered file listing / a before-after pair. */',
  'const TOOL_ACTIVITY_READ_TOOLS = { read: true };',
  'const TOOL_ACTIVITY_DIFF_TOOLS = {',
  T + 'edit: true,',
  T + 'write: true,',
  T + 'multiedit: true,',
  T + 'notebookedit: true',
  '};',
  '/** The edited/read path off the tool input, or "" when there is none. */',
  'function toolActivityFilePath(activity) {',
  T + 'const input = activity.input !== null && typeof activity.input === "object" ? activity.input : {};',
  T + 'return typeof input.file_path === "string" ? input.file_path : "";',
  '}',
  '/**',
  '* Language key for the highlighter. Its alias map is keyed by extension',
  '* ("ts", "py", "rs", ...), so the raw extension is passed straight through and',
  '* an unknown one simply yields no highlighting.',
  '*/',
  'function toolActivityLang(path) {',
  T + 'const base = String(path).split(/[/\\\\]/).pop() ?? "";',
  T + 'const dot = base.lastIndexOf(".");',
  T + 'if (dot <= 0) return void 0;',
  T + 'const ext = base.slice(dot + 1).toLowerCase();',
  T + 'return ext === "" ? void 0 : ext;',
  '}',
  '/**',
  '* Parse a read result back into gutter rows. Two producers reach this card and',
  '* their shapes differ, so both are accepted:',
  '*',
  '*   Claude Code Read  `<number>\\t<text>` per line, no wrapper (verified',
  '*                     against the Agent SDK).',
  '*   DSH read          the same rows as `<number>: <text>`, wrapped in',
  '*                     `<path>/<type>/<content>` tags with a trailing footer',
  '*                     sentence (dsh-tool-fs formatReadOutput).',
  '*',
  '* The wrapper matters as much as the separator: the row loop stops at the first',
  '* non-matching line, so an unstripped `<path>` header alone would empty the',
  '* result and silently downgrade the card to the terminal view. Both producers',
  '* also emit a trailing numbered empty line for the text after the final',
  '* newline — that phantom row is dropped. Anything that is neither shape (an',
  '* error message, an image result) still yields undefined so the caller falls',
  '* back to the terminal view on purpose.',
  '*/',
  'function toolActivityReadLines(output) {',
  T + 'const text = String(output);',
  T + 'const wrapped = /<content>\\n([\\s\\S]*?)\\n<\\/content>/.exec(text);',
  T + 'const lines = [];',
  T + 'for (const raw of (wrapped === null ? text : wrapped[1]).split("\\n")) {',
  T + T + 'const match = /^\\s*(\\d+)(?:\\t|: )([\\s\\S]*)$/.exec(raw);',
  T + T + 'if (match === null) break;',
  T + T + 'lines.push({',
  T + T + T + 'number: Number(match[1]),',
  T + T + T + 'text: match[2]',
  T + T + '});',
  T + '}',
  T + 'const last = lines[lines.length - 1];',
  T + 'if (last !== void 0 && last.text === "") lines.pop();',
  T + 'return lines.length === 0 ? void 0 : lines;',
  '}',
  '/**',
  '* Diff hunks for Edit/Write. These come from the tool INPUT, not the result:',
  '* Claude Code answers an edit with only a confirmation sentence ("The file ...',
  '* has been updated successfully"), so the before/after pair exists nowhere else.',
  '*/',
  'function toolActivityDiffs(activity) {',
  T + 'const input = activity.input !== null && typeof activity.input === "object" ? activity.input : {};',
  T + 'const path = toolActivityFilePath(activity);',
  T + 'if (path === "") return void 0;',
  T + 'if (typeof input.old_string === "string" && typeof input.new_string === "string") return [{',
  T + T + 'path,',
  T + T + 'oldText: input.old_string,',
  T + T + 'newText: input.new_string',
  T + '}];',
  T + 'if (typeof input.content === "string") return [{',
  T + T + 'path,',
  T + T + 'oldText: null,',
  T + T + 'newText: input.content',
  T + '}];',
  T + 'if (Array.isArray(input.edits)) {',
  T + T + 'const out = [];',
  T + T + 'for (const edit of input.edits) {',
  T + T + T + 'if (edit === null || typeof edit !== "object") continue;',
  T + T + T + 'if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") continue;',
  T + T + T + 'out.push({',
  T + T + T + T + 'path,',
  T + T + T + T + 'oldText: edit.old_string,',
  T + T + T + T + 'newText: edit.new_string',
  T + T + T + '});',
  T + T + '}',
  T + T + 'return out.length === 0 ? void 0 : out;',
  T + '}',
  T + 'return void 0;',
  '}',
  '/**',
  '* One completed inner Claude Code tool run, as a collapsible read-only card.',
  '* Display only: DSH never executes a `tool-activity` block, so the row has no',
  '* running state and no approval affordance.',
  '*/',
  'function ToolActivityRow({ activity }) {',
  T + 'const [expanded, setExpanded] = (0, react.useState)(false);',
  T + 'const isError = activity.isError === true;',
  T + 'const summary = toolActivitySummary(activity);',
  T + 'const inputText = toolActivityInputText(activity);',
  T + 'const exit = toolActivityExit(activity);',
  // A failed run is never drawn as a diff or a file listing: the edit did not
  // happen, and the read result is an error message. Those fall to the terminal
  // view, which is the one that can show the failure.
  T + 'const nameKey = String(activity.name ?? "").toLowerCase();',
  T + 'const diffs = isError || TOOL_ACTIVITY_DIFF_TOOLS[nameKey] !== true ? void 0 : toolActivityDiffs(activity);',
  T + 'const readLines = isError || TOOL_ACTIVITY_READ_TOOLS[nameKey] !== true ? void 0 : toolActivityReadLines(exit.output);',
  T + 'return (0, react_jsx_runtime.jsx)("div", {',
  T + T + 'className: "dsh-ta",',
  T + T + '"data-state": isError ? "error" : "ok",',
  T + T + 'children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {',
  T + T + T + 'rowClassName: "dsh-ta-row",',
  T + T + T + 'leadingClassName: "dsh-ta-leading",',
  T + T + T + 'titleClassName: "dsh-ta-title",',
  T + T + T + 'chevronClassName: "dsh-ta-chevron",',
  T + T + T + 'icon: toolActivityIcon(activity.name, isError),',
  T + T + T + 'title: typeof activity.name === "string" && activity.name !== "" ? activity.name : "tool",',
  T + T + T + 'open: expanded,',
  T + T + T + 'expandable: true,',
  T + T + T + 'expandOnRowClick: true,',
  // Native tool rows keep their summary visible while open; only the Think row
  // drops it (there the expanded body IS the summary text, so repeating it
  // would be noise). A tool card's summary and its output are different things.
  T + T + T + 'keepContentWhenOpen: true,',
  T + T + T + 'onToggle: () => {',
  T + T + T + T + 'setExpanded((value) => !value);',
  T + T + T + '},',
  T + T + T + 'collapsedContent: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {',
  T + T + T + T + 'className: "dsh-ta-sep",',
  T + T + T + T + '"aria-hidden": true',
  T + T + T + '}), (0, react_jsx_runtime.jsx)("span", {',
  T + T + T + T + 'className: "dsh-ta-summary",',
  T + T + T + T + '"data-error": isError || void 0,',
  T + T + T + T + 'children: summary',
  T + T + T + '})] }),',
  T + T + T + 'children: (0, react_jsx_runtime.jsx)("div", {',
  T + T + T + T + 'className: "dsh-ta-body",',
  // One body per shape, mirroring which primitive the native tool row picks:
  // Edit/Write -> DiffBlock, Read -> ReadBlock, everything else -> TerminalBlock.
  // Each brings its own copy button and "... 其余 N 行" expander; maxLines 8 is
  // what the native chat row passes to the two file cards.
  T + T + T + T + 'children: diffs !== void 0 ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DiffBlock, {',
  T + T + T + T + T + 'diffs,',
  T + T + T + T + T + 'labels: TOOL_ACTIVITY_DIFF_LABELS,',
  T + T + T + T + T + 'maxLines: 8',
  T + T + T + T + '}) : readLines !== void 0 ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.ReadBlock, {',
  T + T + T + T + T + 'label: toolActivityFilePath(activity),',
  T + T + T + T + T + 'lines: readLines,',
  T + T + T + T + T + 'totalLines: readLines.length,',
  T + T + T + T + T + 'lang: toolActivityLang(toolActivityFilePath(activity)),',
  T + T + T + T + T + 'labels: TOOL_ACTIVITY_READ_LABELS,',
  T + T + T + T + T + 'maxLines: 8',
  // The native bash card IS this primitive: status dot, command lines, a hairline
  // divider, then the output — no IN/OUT labels. Its built-in labels are already
  // Chinese, so no label plumbing is needed on the common path.
  T + T + T + T + '}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TerminalBlock, {',
  T + T + T + T + T + 'command: inputText ?? (typeof activity.name === "string" ? activity.name : "tool"),',
  T + T + T + T + T + 'output: exit.output,',
  T + T + T + T + T + 'exitCode: exit.exitCode,',
  T + T + T + T + T + 'running: false,',
  T + T + T + T + T + 'maxLines: Infinity,',
  T + T + T + T + T + 'labels: exit.known ? TOOL_ACTIVITY_TERMINAL_LABELS : TOOL_ACTIVITY_UNKNOWN_EXIT_LABELS,',
  T + T + T + T + T + 'className: "dsh-ta-terminal"',
  T + T + T + T + '})',
  T + T + T + '})',
  T + T + '})',
  T + '});',
  '}',
  '//#endregion',
]) + '\n' + tabs(2)

const CARD_CASE_ANCHOR = tabs(5) + 'case "tool-call": break;\n'
const CARD_CASE_PATCH =
  CARD_CASE_ANCHOR +
  block(5, [
    `/* ${MARKER} */`,
    'case "tool-activity":',
    T + 'rendered.push((0, react_jsx_runtime.jsx)(ToolActivityRow, { activity: block }, i));',
    T + 'break;',
  ]) +
  '\n'

// ---------------------------------------------------------------------------
// 3. dsh-llm: keep completed activity blocks across an interruption.
// ---------------------------------------------------------------------------

const LLM_KEEP_ANCHOR =
  tabs(3) + 'if (type !== "text" && type !== "reasoning") return void 0;'
const LLM_KEEP_PATCH =
  tabs(3) +
  `/* ${MARKER} */ if (type === "tool-activity" && partial.block) return this.assemble(partial, index);\n` +
  LLM_KEEP_ANCHOR

const LLM_FILTER_ANCHOR =
  '}).filter((block) => (block?.type === "text" || block?.type === "reasoning") && block.text.trim() !== "");'
const LLM_FILTER_PATCH =
  '}).filter((block) => block?.type === "tool-activity" || ((block?.type === "text" || block?.type === "reasoning") && block.text.trim() !== ""));'

// ---------------------------------------------------------------------------
// 4. dsh-client-ui-trajectory: keep the Trajectory panel from crashing.
//
// Both of its `switch (block.kind)` arms are exhaustive over the kinds the
// shipped client can produce and have NO `default`, so an unhandled kind falls
// out as `undefined`. Before patch 1 these blocks arrived as `kind: "other"`
// and were handled; classifying them as `tool-activity` makes them unhandled,
// and TrajectoryTable then does `sourceBlocks.some(b => b.imageSrc !== ...)`
// over an array holding that `undefined` -> TypeError, panel down. This is not
// optional polish: patch 1 without patch 4 breaks a native surface.
// ---------------------------------------------------------------------------

const TRAJECTORY_SOURCE_ANCHOR = tabs(4) + 'case "other": return sourceBlock(block.block);'
const TRAJECTORY_SOURCE_PATCH =
  block(4, [
    `/* ${MARKER} */`,
    'case "tool-activity": return {',
    T + 'type: "tool-activity",',
    T + 'content: typeof block.output === "string" ? block.output : ""',
    '};',
  ]) +
  '\n' +
  TRAJECTORY_SOURCE_ANCHOR

const TRAJECTORY_TIMELINE_ANCHOR = block(4, [
  'case "other": return {',
  T + 'kind: "other",',
  T + 'block: null',
  '};',
])

// `timelineBlock` blanks the streaming payload of each block. A tool-activity
// block never streams deltas, so it is returned as-is — exactly how the
// neighbouring `case "image"` treats the other non-delta kind.
const TRAJECTORY_TIMELINE_PATCH =
  block(4, [`/* ${MARKER} */`, 'case "tool-activity": return block;']) +
  '\n' +
  TRAJECTORY_TIMELINE_ANCHOR

// ---------------------------------------------------------------------------

const TARGETS = [
  {
    // 0.1.2-rc.1 deleted dsh-client-runtime (upstream be531688f3, "remove
    // Runtime") and inlined its block classifier into EACH consumer bundle.
    // Chat carries one copy and Trajectory carries another, so the classify
    // edits below are applied to BOTH — patching only one leaves that surface
    // rendering the generic "unknown content block" box.
    file: 'dsh-client-ui-chat/lib/client.js',
    why: 'classify the tool-activity wire block + render the activity card',
    edits: [
      ['toAssistantBlock', RUNTIME_CLASSIFY_ANCHOR, RUNTIME_CLASSIFY_PATCH],
      ['emptyAssistantBlock', RUNTIME_EMPTY_ANCHOR, RUNTIME_EMPTY_PATCH],
      ['card css', CARD_CSS_ANCHOR, CARD_CSS_PATCH],
      ['card component', CARD_COMPONENT_ANCHOR, CARD_COMPONENT + CARD_COMPONENT_ANCHOR],
      ['AssistantMarkdown case', CARD_CASE_ANCHOR, CARD_CASE_PATCH],
    ],
  },
  {
    file: 'dsh-llm/lib/index.js',
    why: 'keep activity blocks on interruption',
    edits: [
      ['interruptedBlocks keep', LLM_KEEP_ANCHOR, LLM_KEEP_PATCH],
      ['interruptedBlocks filter', LLM_FILTER_ANCHOR, LLM_FILTER_PATCH],
    ],
  },
  {
    file: 'dsh-client-ui-trajectory/lib/client.js',
    why: 'classify in this bundle\'s own copy, and stop the panel crashing on the new kind',
    edits: [
      ['toAssistantBlock', RUNTIME_CLASSIFY_ANCHOR, RUNTIME_CLASSIFY_PATCH],
      ['emptyAssistantBlock', RUNTIME_EMPTY_ANCHOR, RUNTIME_EMPTY_PATCH],
      ['assistantSourceBlock', TRAJECTORY_SOURCE_ANCHOR, TRAJECTORY_SOURCE_PATCH],
      ['timelineBlock', TRAJECTORY_TIMELINE_ANCHOR, TRAJECTORY_TIMELINE_PATCH],
    ],
  },
]

/** Replace `anchor` exactly once, or throw with the count that was found. */
function replaceOnce(source, label, anchor, patch) {
  const count = source.split(anchor).length - 1
  if (count !== 1) {
    throw new Error(
      `anchor "${label}" matched ${count} times (expected 1) — DSH internals changed, re-derive this patch`,
    )
  }
  return source.replace(anchor, patch)
}

function applyTarget(root, target) {
  const path = resolve(root, target.file)
  if (!existsSync(path)) throw new Error(`missing target: ${path}`)
  const bak = path + BAK_SUFFIX

  const current = readFileSync(path, 'utf8')
  const patchedAlready = current.includes(MARKER)

  if (!existsSync(bak)) {
    if (patchedAlready) {
      throw new Error(
        `${target.file} is already patched but has no ${BAK_SUFFIX} — reinstall DSH or restore it manually`,
      )
    }
    copyFileSync(path, bak)
  } else if (!patchedAlready) {
    // The target is pristine while a stale .bak exists: DSH was upgraded and
    // overwrote our edit. Re-baseline so the patch applies to the new file.
    copyFileSync(path, bak)
  }

  let next = readFileSync(bak, 'utf8')
  if (next.includes(MARKER)) throw new Error(`${bak} is not pristine (it carries the marker)`)
  for (const [label, anchor, patch] of target.edits) {
    next = replaceOnce(next, `${target.file} :: ${label}`, anchor, patch)
  }

  if (next === current) return { path, changed: false }
  writeFileSync(path, next)
  return { path, changed: true }
}

const rootArg = process.argv.slice(2).find((arg) => arg.startsWith('--root='))
const root = rootArg !== undefined ? rootArg.slice('--root='.length) : (process.env.DSH_ROOT ?? DEFAULT_ROOT)

console.log(`tool-activity patch\nroot: ${root}\n`)
let changedAny = false
for (const target of TARGETS) {
  const result = applyTarget(root, target)
  changedAny = changedAny || result.changed
  console.log(`  ${result.changed ? 'patched ' : 'current '} ${target.file}  (${target.why})`)
}
console.log(
  changedAny
    ? '\ndone — restart `dsh web`, then reload http://127.0.0.1:3080 (bundle rev is hashed at activation; hmr is disabled here)'
    : '\ndone — every target already carried this exact patch',
)
