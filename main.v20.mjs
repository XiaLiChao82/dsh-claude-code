// llm-claude-code — Claude Code as a selectable DSH primary route.
//
// Claude Agent SDK owns the inner coding-agent/tool loop. DSH owns the outer
// session, model picker, cancellation, transcript, and effort selection. Native
// Claude tool calls are intentionally not re-emitted as DSH tool calls: doing so
// would execute them twice. DSH tool schemas arriving in `options.tools` are
// acknowledged with an explicit bridge note (see buildSystemAppend) instead of
// being silently dropped on the floor.
//
// v21 adds a display-only `tool-activity` content block:
//   - Same real-time ordering as v20 fold (emitted when each inner tool_result
//     arrives), but the block type is NOT `reasoning` and NOT `tool-call`.
//   - Agent loop persists the block and never sends it to executeToolCalls().
//   - Official Think / Markdown stay on their existing renderers; the client
//     only grows one extra AssistantMarkdown case for `tool-activity`.
//   - Default is `toolActivityDisplay: 'native'`. `fold` and `card` remain.
//
// v20 restores the correct THINK → TOOL → THINK → TOOL ordering:
//   - v16/v19 card mode was intentionally native-looking, but DSH's outer
//     agent loop appends `tool/call` and executes `executeToolCalls()` only
//     AFTER the entire LLM stream ends. Therefore inner Bash results emitted as
//     synthetic DSH tool-call blocks are inevitably batched after all of the
//     outer stream's reasoning blocks: Think1, Think2, Bash1, Bash2.
//   - fold mode projects each inner tool_result as a reasoning block.
//   - `toolActivityDisplay: 'card'` remains an explicit opt-in for native bash
//     tool cards, with the documented end-of-stream batching trade-off.
//
// v19 makes the AskUserQuestion bridge reliable under bypassPermissions:
//   - v18's canUseTool-only route was insufficient: bypass can shadow that
//     callback. v19 uses an SDK `hooks.PreToolUse` matcher, which reliably
//     catches AskUserQuestion before execution and maps it to DSH's native
//     user-question card. The canUseTool helper is retained only to expose the
//     built-in AskUserQuestion in headless mode.
//
// v17 makes the inner agent actually able to RUN commands (the rename
// matters: cordis-plugin-loader re-imports a module only when the row's
// `name` changes — see cordis.patch.yml notes):
//   - Symptom: inner Claude Code could not execute even `python3 -c "print(1)"`
//     — the command died in Claude Code's sandbox, and the unsandboxed retry
//     needs a permission prompt that a headless inner session can never show.
//     The inner CLI was running on the user settings'
//     `permissions.defaultMode: "auto"`, whose classifier either denies opaque
//     commands or cannot approve sandbox escalations — a dead end for
//     autonomous coding work. v18 now makes AskUserQuestion the one explicit
//     interaction exception.
//   - Fix: the adapter now passes an EXPLICIT permission mode, defaulting to
//     `permissionMode: 'bypassPermissions'` together with the required
//     `allowDangerouslySkipPermissions: true`. This deterministically skips
//     every permission prompt and sandbox escalation for the inner session —
//     the whole point of this route is Claude Code owning the tool loop
//     autonomously. The six SDK modes stay configurable via
//     llm-claude-code.permissionMode ('default' | 'acceptEdits' |
//     'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'); unknown values are
//     clamped back to the default. Note the inner loop never passes through
//     DSH's approval stack regardless of mode — the CLI owns its tools — so
//     the default matches what the route already implied.
//
// v16 hangs tool activity under NATIVE TOOL-CALL CARDS (now explicit opt-in;
// v20 defaults to ordered reasoning folds because DSH executes tool-call
// blocks only after the complete outer stream):
//   - Mode `toolActivityDisplay: 'card'` re-emits each completed inner
//     tool run as a REAL DSH tool-call chunk for a side-effect-free ECHO tool,
//     exactly v12's mechanism with its two flaws fixed. DSH executes the echo
//     after the LLM stream (protocol floor: tool/call events are appended in
//     executeToolCalls, never during the stream — cards CANNOT appear earlier),
//     the echo concludes the turn without a follow-up request, and the
//     transcript gains a native collapsible tool card with the exact output.
//   - Fix 1 (card title/variant): v12's single `claude_activity` card rendered
//     as a generic "Tool call" row. The client derives variant/title/summary
//     from the call NAME and args (TOOL_VARIANTS/SUMMARY_KEYS), so v16
//     registers echo tools under the variant-compatible lowercase names —
//     bash, read, edit, write, glob, grep, web_fetch, web_search — and emits
//     native-shaped args (command/file_path/pattern/query/url plus optional
//     description), so a Bash run gets a real bash-style card. Names are
//     collision-guarded with ctx.tools.get(): an echo is ONLY registered (and
//     its chunks ONLY emitted) when the name is free, so the real harness
//     Bash tool can never be shadowed into double execution. Unknown inner
//     tools fall back to a generic `claude_tool` echo.
//   - Fix 2 (replay integrity): the echoed arguments carry a `claudeActivity`
//     marker; planReplay and serializeConversation skip those call/result
//     pairs so synthetic display rows never force a full replay (v15's resume
//     watermark logic would otherwise treat the echo tool-result user message
//     as a real DSH execution boundary every single turn) and never replay
//     them into Claude's prompt.
//   - v15's reasoning-channel folds are now the default ordered projection:
//     `toolActivityDisplay: 'fold'` — the only REAL-TIME projection (cards
//     appear when the stream ends, folds the moment a tool_result arrives);
//     `showToolActivity: false` still disables activity entirely.
//
// v15 makes tool activity COLLAPSIBLE (this is now v20's ordered default):
//   - Each completed inner tool run is now projected as a DSH REASONING block,
//     which the transcript renders as the collapsed-by-default Think-style
//     disclosure row: collapsed it reads `▸ Bash ✓ · git status`, expanded it
//     shows the command plus the display-clamped output. v13/v14's plain
//     Markdown text cards cannot fold — assistant text has no collapse
//     affordance — and the only other collapsible block kind, tool-call, is an
//     execution request DSH dispatches after the whole LLM stream (v12's
//     claude_activity echo produced exactly that end-of-turn pop-in and was
//     removed in v13). A reasoning block is emitted the instant the
//     tool_result arrives, renders in real time, folds natively, and is never
//     executed. Set llm-claude-code.toolActivityDisplay='card' only when
//     end-of-stream native cards are preferred over event ordering.
//   - Replay clamping now also covers these `▸ `-prefixed reasoning blocks the
//     same way legacy `‹ ` text blocks are clamped (800 chars per block in
//     text-history replay), so display-side folds never bloat full replays.
//   - Removes the dead claude_activity echo-tool registration left over from
//     the v12→v13 port: it referenced unimported defineTool/ACTIVITY_TOOL and
//     threw into its own catch on every apply.
//
// v14 refines v13 activity presentation (historical; superseded by v20's
// ordered fold default; retained only for reference):
//   - An inner Claude Code tool run is now one completed Markdown code-card,
//     rather than separate `▸` call and `‹` result status blocks. The card holds
//     the native tool name, command/input, success/failure state, and output.
//     It is still ordinary assistant text: DSH's tool-call protocol is an
//     execution request which necessarily runs after the LLM stream, so using
//     it for an already-finished native call would again create a delayed card.
//     The trade-off is intentional: a card appears on native completion, not
//     while its command is still running.
//
// v11 adds over v10:
//   - Native session resume: instead of replaying the whole DSH history as
//     text every turn, the adapter tracks (per DSH session) the Claude Code
//     session id plus a watermark (the id of the last user message already
//     fed). When the next request's history still contains the watermark with
//     only our own assistant replies and trailing new user messages after it,
//     we resume that CC session (forkSession: true) and send ONLY the delta —
//     Claude then holds its own native tool results, thinking, and images, so
//     the replay-side truncation of ‹ blocks stops applying. Any divergence
//     (edited/deleted history, regenerated branch, a foreign-provider turn
//     after the watermark, missing watermark) falls back to full text replay
//     in a fresh session. persistSession is forced on while nativeResume is
//     enabled (resume needs the session file); a resume that fails because the
//     CC session vanished transparently retries once as full replay.
//
// v10 adds over v9 (the rename matters: cordis-plugin-loader re-imports a module
// only when the row's `name` changes — see cordis.patch.yml notes):
//   - Full-width tool activity display: the ▸ call line keeps up to 500 chars
//     (was 80); the ‹ result rendering preserves NEWLINES and shows up to
//     toolResultDisplayChars (default 3000, configurable) with a head+tail
//     ellipsis instead of a flat 240-char single-line cut. Replay-side, each
//     ‹ block is clamped to 800 chars in the next request's text history so
//     the display widening never bloats subsequent prompts.
//
// v9 adds over v8:
//   - Context windows realigned to the CLI 2.1.258 registry: fable/opus/sonnet
//     (current generation: fable-5, opus-5, sonnet-5) are NATIVE 1M
//     (window 1e6, native_1m) — the separate fable[1m] entry is gone since the
//     base alias already carries 1M. haiku stays 200k; a haiku[1m] suffix
//     variant is added (supports_1m_suffix in the registry).
//
// v8 adds over v7:
//   - Tool RESULT projection: native tool_result user messages now project as
//     "‹ Bash ✓ <output head>" status text beside the existing "▸ Bash · cmd"
//     call lines. Native cards remain impossible by design: DSH's tool-call
//     block is an EXECUTION request (dsh-agent-loop dispatches every one), so
//     replaying already-run inner tools as tool-call chunks would execute them
//     twice. The replayed result lines also hand Claude its own prior
//     inner-tool output (each turn is a fresh CLI session).
//
// v7 adds over v6:
//   - Model catalog: fable (Claude Fable 5 alias, subscription flagship with the
//     full effort ladder incl. xhigh/max) and fable[1m] (1M-context variant,
//     per-model contextWindow). Aliases verified against the 2.1.252 binary's
//     quick-switch list: haiku, fable, best, sonnet[1m], opus[1m], fable[1m],
//     opusplan. "fable" real-call verified on this subscription.
//
// v6 adds over v5:
//   - resolveWorkspace capture rewritten as a whitespace-free /-token: the v2
//     greedy capture backtracked to the LAST '.' of the line, so a system
//     prompt like "Working directory is /tmp. Answer in one sentence."
//     resolved the cwd to the WHOLE SENTENCE → execve ENOENT → every SDK
//     spawn failed inside dsh web with a misleading libc-mismatch message.
//   - spawnClaudeCodeProcess hook retained from the bisect: spawn via node
//     directly (detached) and surface the real code/syscall/errno on failure.
//
// v3/v4/v5 adds (consolidated):
//   - Image input: user-role image attachments are re-encoded through the
//     durable attachment service (readImageRequest, same pixel/byte policy
//     shape as dsh-llm-pi-ai) and delivered as base64 content blocks via the
//     SDK streaming-input channel (AsyncIterable<SDKUserMessage>). Every
//     user-role image is re-sent each turn — same replay semantics and the
//     same 20MiB aggregate guard as pi-ai — so follow-up questions about an
//     older screenshot keep working.
//   - Inner tool activity projection: complete SDK assistant messages expose
//     their tool_use blocks as compact status text blocks ("▸ Bash · git
//     status"), so long inner loops are no longer silent in the DSH transcript.
//     They are plain text, never tool-call-delta, so nothing executes twice.
//
// v2 fixes over main.mjs:
//   - resolveWorkspace no longer truncates paths containing '.' mid-path.
//   - settings integration: installSettingsSection hands setSource a FUNCTION;
//     the old `{...current}` spread of that function silently resolved to {} —
//     settings.yaml overrides never applied. config() now calls current().
//   - buildSystemAppend bridges the DSH tool catalog to native Claude tools.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { ToolCallId, LlmError, createUserMessage, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

const NS = 'llm-claude-code'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODELS = [
  // Context windows mirror the CLI 2.1.258 registry: the current generation
  // (fable-5, opus-5, sonnet-5, sonnet-4-6, opus-4-6+) is native 1M
  // (window 1e6, native_1m); only haiku-4-5 stays 200k with an optional
  // [1m] suffix variant (supports_1m_suffix).
  { id: 'fable', name: 'Claude Fable', description: 'Claude Code Fable 5 alias — subscription flagship; native 1M context, full effort ladder including xhigh/max.', context: 1000000 },
  { id: 'opus', name: 'Claude Opus', description: 'Claude Code Opus alias — strongest coding and reasoning; native 1M context.', context: 1000000 },
  { id: 'sonnet', name: 'Claude Sonnet', description: 'Claude Code Sonnet alias — balanced speed and capability; native 1M context.', context: 1000000 },
  { id: 'haiku', name: 'Claude Haiku', description: 'Claude Code Haiku alias — fastest and lightest; 200k context.', context: 200000 },
  { id: 'haiku[1m]', name: 'Claude Haiku · 1M', description: 'Haiku 4.5 with the 1M-context suffix variant.', context: 1000000 },
]
export const DEFAULTS = {
  providerName: 'Claude Code · 订阅',
  contextWindow: 200000,
  partialMessages: true,
  showThinking: true,
  persistSession: false,
  showToolActivity: true,
  toolActivityDisplay: 'native',
  permissionMode: 'bypassPermissions',
  imageMaxPixels: 2048 * 2048,
  imageMaxBytes: 1024 * 1024,
  toolResultDisplayChars: 3000,
  nativeResume: true,
  askUserQuestion: true,
  dshTools: true,
}

// Aggregate bound on base64 image payload per request, mirroring
// dsh-llm-pi-ai's DEFAULT_MAX_REQUEST_IMAGE_BYTES: every historical image is
// re-encoded into every request, so an unbounded history would eventually
// exceed the request-size cap and the session could never complete a turn.
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

// The Anthropic Messages API accepts exactly these media types; the attachment
// store admits the same set, so anything else is refused loudly instead of
// surfacing as an opaque upstream 400.
const ANTHROPIC_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const Config = z.object({
  providerName: z.string(),
  binary: z.string(),
  workspace: z.string(),
  contextWindow: z.number().step(1).min(1),
  partialMessages: z.boolean(),
  showThinking: z.boolean(),
  persistSession: z.boolean(),
  showToolActivity: z.boolean(),
  // 'native' (ordered display-only tool-activity cards, default), 'fold'
  // (ordered Think rows), or 'card' (tool-call echo cards after the stream).
  // A plain string keeps the settings schema simple; config() clamps unknown
  // values to 'native'.
  toolActivityDisplay: z.string(),
  // Inner-session permission mode passed to the Claude Agent SDK. Clamped to
  // PERMISSION_MODES; 'bypassPermissions' additionally sends
  // allowDangerouslySkipPermissions (the SDK requires both).
  permissionMode: z.string(),
  askUserQuestion: z.boolean(),
  imageMaxPixels: z.number().step(1).min(1),
  imageMaxBytes: z.number().step(1).min(1),
  toolResultDisplayChars: z.number().step(1).min(0),
  nativeResume: z.boolean(),
  // v29: the single switch for everything v26/v27/v28 added. Turning it off
  // reverts this plugin to its v25 behaviour EXACTLY — not approximately.
  //
  // That equivalence is not a coincidence to be maintained by hand: every
  // bridged-tool effect is derived from one `bridge` value, so a nullish bridge
  // makes all four call sites take their v25 branch on their own —
  //   · buildSystemAppend(.., [])      → v25's "every harness tool is absent"
  //   · buildNativeToolOverride([], ..) → native Bash/Read/Write/Edit stay on
  //   · no mcpServers / allowedTools    → the inner agent never sees mcp__dsh__*
  //   · bridgeDisplayName              → never fires, nothing to rename
  // Adding a fifth effect later must go through `bridge` too, or this switch
  // silently stops being a full rollback.
  //
  // Kept as a config flag rather than a plugin row because the row's v25-era
  // source no longer exists (this tree has no commits and no .bak), and because
  // the bridge is rebuilt per turn — a flip lands on the next turn with no
  // restart. The soft-fail path this shares with "zod is missing" is already
  // covered by tests.
  dshTools: z.boolean(),
})

const effortInfo = (id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })

// The SDK's PermissionMode union (sdk.d.ts). 'bypassPermissions' additionally
// requires allowDangerouslySkipPermissions: true — see buildPermissionOptions.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']

/** Clamp a configured permission mode to the SDK's union; unknown → default. */
export function resolvePermissionMode(value) {
  return PERMISSION_MODES.includes(value) ? value : DEFAULTS.permissionMode
}

export const TOOL_ACTIVITY_DISPLAYS = ['native', 'fold', 'card']

/**
 * Whether the tool-activity UI patch is present in the DSH install.
 *
 * `card` mode emits a custom content block that only a PATCHED DSH renders;
 * against an unpatched install the trajectory panel throws a TypeError. The
 * patch lives inside DSH's own bundle files, so a published package cannot
 * carry it and every DSH upgrade wipes it — see dsh-patches/tool-activity/.
 *
 * Three-valued on purpose. `'unknown'` (module not resolvable, exports map
 * hides package.json, file unreadable) must NOT degrade anything: a wrong
 * guess would silently take `card` away from a correctly patched install.
 * Only a confident `false` degrades.
 *
 * Cached: `config()` re-runs on every read, and this touches the filesystem.
 */
let toolActivityPatchState

export function toolActivityPatchPresent() {
  if (toolActivityPatchState !== undefined) return toolActivityPatchState
  try {
    const require = createRequire(import.meta.url)
    // The UI packages are INTERNAL to the DSH install: they sit in dsh's own
    // node_modules, not in the profile-level `@deepseek-ai` directory a plugin
    // resolves through, so requesting one by name always fails. Anchor on a
    // package this plugin already imports at the top of the file, then walk up
    // to the shared `@deepseek-ai` root (the same ROOT checkup.mjs scans).
    const anchor = require.resolve('@deepseek-ai/dsh-llm/package.json')
    const root = join(anchor, '..', '..')
    const source = readFileSync(join(root, 'dsh-client-ui-trajectory/lib/client.js'), 'utf8')
    toolActivityPatchState = source.includes('tool-activity')
  } catch {
    toolActivityPatchState = 'unknown'
  }
  return toolActivityPatchState
}

/** Reset the cached probe. Tests only. */
export function resetToolActivityPatchProbe() {
  toolActivityPatchState = undefined
}

/**
 * Fall back to `fold` when `card` was asked for but the UI patch is absent.
 *
 * `fold` is the closest survivor: it is the other real-time projection and
 * needs no patch. Warns once — this is a deployment fact, not a per-turn one,
 * and repeating it every turn would be noise.
 * @param display - already normalised display mode.
 * @param logger - optional ctx.logger.
 * @param present - probe result; injectable so the degrade branch is testable
 *   on a machine where the patch IS applied.
 * @returns the display mode to actually use.
 */
let toolActivityDegradeWarned = false

export function degradeToolActivityDisplay(display, logger, present = toolActivityPatchPresent()) {
  if (display !== 'card') return display
  if (present !== false) return display
  if (!toolActivityDegradeWarned) {
    toolActivityDegradeWarned = true
    logger?.warn?.(
      'toolActivityDisplay=card 需要 DSH 界面补丁，当前安装未打补丁（轨迹面板会抛 TypeError），'
      + '已自动回退到 fold。要启用卡片：node dsh-patches/tool-activity/apply.mjs，然后重启 dsh web。',
    )
  }
  return 'fold'
}

/** Clamp a configured activity display; unknown → native (ordered, not executed). */
export function resolveToolActivityDisplay(value) {
  return TOOL_ACTIVITY_DISPLAYS.includes(value) ? value : DEFAULTS.toolActivityDisplay
}

/** One display-only activity block. Never a DSH execution request. */
export function buildToolActivityBlock(use, output, isError) {
  return {
    type: 'tool-activity',
    // Bridged DSH tools show under the native name they replaced, so swapping
    // an implementation stays invisible in the transcript — see
    // bridgeDisplayName.
    name: bridgeDisplayName(use?.name) ?? 'tool',
    input: use?.input && typeof use.input === 'object' ? use.input : {},
    output: typeof output === 'string' && output.length > 0 ? output : '(no output)',
    isError: isError === true,
  }
}

// ─── Subagent mirroring: DSH session-event builders ─────────────────────
//
// WHY THESE EXIST AS BUILDERS rather than object literals at the call sites.
//
// Mirroring an inner Claude Code Task subagent into a DSH child session means
// hand-writing DSH session events. That storage format has at least THREE
// validators of increasing strictness, and the weak ones do not protect you:
//
//   persistence.inspect()                        reads a malformed log happily
//   sessions.prepare(seedSource:'persistence')   restore validation — also passes
//   projection fold                              the only one that rejects
//
// A shape mistake therefore survives `Session.append`, survives the durable
// write, survives a same-process read back, and finally surfaces as
// "会话记录损坏" on the user's screen with the real cause swallowed
// (`listChildren` only reports corrupt/unavailable/unsupported). Three shapes
// were measured wrong on the first attempt, each caught only at the fold:
//
//   1. `assistant/message` and `tool/result` need `data.message.id`; a
//      `user/message` needs `id` at the DATA top level instead
//      (core/session assertMessageEventShape).
//   2. A `tool-call` block is `{id, name, arguments}` — NOT
//      {toolCallId, toolName, input} — and `arguments` is a JSON STRING.
//      The `.length` read on the missing `arguments` is what threw.
//      A `tool-result` block, confusingly, does use `toolCallId`.
//   3. The three surface event types must carry a third append argument,
//      `{surfaceOp:'append'}`; it is a conditional type parameter, so nothing
//      at runtime reminds you.
//
// So these builders return a ready-to-apply `[type, data, opts]` TRIPLE and
// default a missing id to a fresh uuid: the aim is to make the invalid state
// unrepresentable at the call site, not merely detectable afterwards. Shapes
// below were transcribed from real session logs, not inferred from types.

/** `SUBAGENT_DESCRIPTOR_VERSION` in @deepseek-ai/dsh-subagent. */
export const MIRROR_DESCRIPTOR_VERSION = 3
/** The mandatory third `append` argument for every surface event type. */
const MIRROR_SURFACE = Object.freeze({ surfaceOp: 'append' })

/** Apply one built triple, so a call site cannot drop the surface argument. */
export function appendMirrorEvent(session, triple) {
  const [type, data, opts] = triple
  return opts === undefined ? session.append(type, data) : session.append(type, data, opts)
}

/**
 * Child-session `meta`, matching what `childSessionMeta()` produces for real
 * subagents. `origin` is what the sidebar filters on and what the header
 * catalog keys off; `parentSession` is what the lineage walk follows.
 */
export function buildMirrorChildMeta({ cwd, parentSession, delegationDepth = 1 }) {
  return { cwd, parentSession, origin: 'subagent', delegationDepth }
}

/**
 * The identity record without which a child is not a subagent at all: the
 * registered `subagent` projection is the SOLE mode/label classifier, so a
 * child carrying only `origin`/`parentSession` never reaches the catalog.
 */
export function buildMirrorDescriptor({ provider, label }) {
  return { version: MIRROR_DESCRIPTOR_VERSION, mode: 'one-shot', provider, label }
}

/** SDK `tool_use` → DSH `tool-call` block. Trap 2 lives entirely here. */
export function buildMirrorToolCallBlock(use) {
  const input = use?.input
  return {
    type: 'tool-call',
    id: String(use?.id ?? randomUUID()),
    name: String(use?.name ?? 'tool'),
    // Already-serialized input passes through; anything else is stringified,
    // because a non-string here is the exact `.length` crash.
    arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
  }
}

/** Tool output → DSH `tool-result` block. Note `toolCallId`, unlike tool-call. */
export function buildMirrorToolResultBlock({ callId, text, isError = false }) {
  return {
    type: 'tool-result',
    toolCallId: String(callId ?? ''),
    content: [{ type: 'text', text: typeof text === 'string' ? text : '' }],
    isError: isError === true,
  }
}

/** The Task prompt the parent handed down, as the child's opening user turn. */
export function buildMirrorUserEvent({ text, id, senderSessionId }) {
  return ['user/message', {
    content: [{ type: 'text', text: typeof text === 'string' ? text : '' }],
    // `agent-message`/`relay` is the registered source for one agent addressing
    // another; without a sender it degrades to a plain user prompt.
    source: senderSessionId === undefined
      ? { kind: 'user' }
      : { kind: 'agent-message', form: 'relay', senderSessionId },
    role: 'user',
    // Trap 1a: `user/message` carries its id at the DATA top level.
    id: id ?? randomUUID(),
  }, MIRROR_SURFACE]
}

/** One mirrored assistant message (reasoning / text / tool-call blocks). */
export function buildMirrorAssistantEvent({ turn = 1, step = 1, content, id, provider = 'claude-code', model }) {
  return ['assistant/message', {
    turn,
    step,
    message: {
      // Trap 1b: here the id belongs on `data.message`, not on `data`.
      id: id ?? randomUUID(),
      role: 'assistant',
      source: { kind: 'model', provider, ...model === undefined ? {} : { model } },
      content: Array.isArray(content) ? content : [],
    },
  }, MIRROR_SURFACE]
}

/** One mirrored tool result. `role` is `'user'` here, not `'tool'`. */
export function buildMirrorToolResultEvent({ turn = 1, step = 1, callId, text, isError = false, id }) {
  return ['tool/result', {
    turn,
    step,
    message: {
      id: id ?? randomUUID(),
      // Counter-intuitive but measured: a tool result rides as a USER-role
      // message whose source names the originating call.
      role: 'user',
      source: { kind: 'tool', callId: String(callId ?? '') },
      content: [buildMirrorToolResultBlock({ callId, text, isError })],
    },
  }, MIRROR_SURFACE]
}

/** The inner tool whose calls spawn a Claude Code subagent. */
const MIRROR_TASK_TOOL = 'Task'

/**
 * Clamp for one mirrored tool result. The child session is a transcript, not a
 * replay corpus, so this is generous compared with REPLAY_STATUS_MAX_CHARS —
 * but still bounded: a runaway build log would otherwise be persisted twice
 * (once in the parent's activity card, once here).
 */
const MIRROR_RESULT_MAX_CHARS = 8000

/** SDK content block → one DSH assistant content block, or undefined to drop. */
function mirrorContentBlock(block) {
  const type = block?.type
  if (type === 'text') return { type: 'text', text: String(block.text ?? '') }
  // The SDK names the field after the block: `thinking.thinking`. DSH calls the
  // same thing `reasoning.text`.
  if (type === 'thinking') return { type: 'reasoning', text: String(block.thinking ?? '') }
  if (type === 'redacted_thinking') return undefined
  if (type === 'tool_use') return buildMirrorToolCallBlock(block)
  return undefined
}

/**
 * Fold an SDK message stream into mirror ACTIONS for inner `Task` subagents.
 *
 * WHY A COLLECTOR AND NOT A ONE-SHOT CONVERTER: the live path has to write a
 * child session as its subagent runs, so the same logic must work
 * incrementally. Keeping it a pure closure — no ctx, no session, no I/O — is
 * what lets the whole risky half be tested against a fake ctx while the driver
 * that touches `~/.dsh` stays a three-line mapping.
 *
 * The stream carries parent and child interleaved, distinguished only by
 * `parent_tool_use_id`: `null` is the outer session, a string is the child of
 * that tool call. Today the plugin DISCARDS every non-null one (four filters in
 * translateSdkMessages) because sub-agent messages must not be sampled for
 * context occupancy — this collector is the consumer that discarding starved.
 *
 * Actions, in the order a driver must apply them:
 *   `open`   — a Task call appeared; create the child session, then append.
 *   `events` — child activity; append.
 *   `close`  — the Task's result arrived; append, then persist and forget.
 *
 * SIMPLIFICATION, deliberate: every child event is folded into turn 1 / step 1.
 * A faithful mirror would open a step per inner model call, but single-step is
 * the shape that was actually measured through a real projection fold; a
 * multi-step log is unverified, and this format punishes unverified guesses by
 * failing only at cold read. Revisit with a fold test, not by reasoning.
 */
export function createMirrorCollector({ provider = 'claude-code-task', model, senderSessionId } = {}) {
  /** taskId → the child's durable label, so `close` can title the session. */
  const open = new Map()

  const blocksOf = (message) => {
    const content = message?.message?.content
    return Array.isArray(content) ? content : []
  }

  return {
    /** Task ids still awaiting a result — a driver closes these on abort. */
    openTaskIds: () => [...open.keys()],

    /**
     * @param message - one raw SDK stream message.
     * @returns the actions this message produced, possibly empty.
     */
    observe(message) {
      const parentId = message?.parent_tool_use_id
      const actions = []

      // ── outer session ────────────────────────────────────────────────
      if (parentId === null || parentId === undefined) {
        if (message?.type === 'assistant') {
          for (const block of blocksOf(message)) {
            if (block?.type !== 'tool_use' || block?.name !== MIRROR_TASK_TOOL) continue
            if (typeof block.id !== 'string') continue
            const input = block.input ?? {}
            // `description` is the short human label Claude Code sends with
            // every Task; `subagent_type` names the persona it picked.
            const label = String(input.description ?? input.subagent_type ?? MIRROR_TASK_TOOL)
            open.set(block.id, label)
            actions.push({
              kind: 'open',
              taskId: block.id,
              label,
              subagentType: input.subagent_type === undefined ? undefined : String(input.subagent_type),
              events: [
                ['turn/start', { turn: 1 }, undefined],
                buildMirrorUserEvent({ text: String(input.prompt ?? ''), senderSessionId }),
                ['step/start', { turn: 1, step: 1 }, undefined],
              ],
            })
          }
          return actions
        }
        if (message?.type === 'user') {
          for (const block of blocksOf(message)) {
            if (block?.type !== 'tool_result') continue
            const taskId = block.tool_use_id
            const label = open.get(taskId)
            if (label === undefined) continue
            open.delete(taskId)
            actions.push({
              kind: 'close',
              taskId,
              isError: block.is_error === true,
              events: [
                ['step/end', { turn: 1, step: 1 }, undefined],
                ['turn/end', {
                  turn: 1,
                  reason: { kind: block.is_error === true ? 'error' : 'completed' },
                }, undefined],
                // Without a title the child shows as an unnamed row; the Task
                // description is the only label the stream offers.
                ['session/title', {
                  title: label,
                  messageSeqs: [],
                  source: { kind: 'fallback' },
                }, undefined],
              ],
            })
          }
        }
        return actions
      }

      // ── child of a known Task ────────────────────────────────────────
      if (!open.has(parentId)) return actions

      if (message?.type === 'assistant') {
        const content = blocksOf(message).map(mirrorContentBlock).filter(b => b !== undefined)
        // An empty (e.g. usage-only) message would add a contentless row.
        if (content.length === 0) return actions
        actions.push({
          kind: 'events',
          taskId: parentId,
          events: [buildMirrorAssistantEvent({ content, provider: 'claude-code', model })],
        })
        return actions
      }

      if (message?.type === 'user') {
        const events = []
        for (const block of blocksOf(message)) {
          if (block?.type !== 'tool_result') continue
          events.push(buildMirrorToolResultEvent({
            callId: block.tool_use_id,
            text: resultText(block.content, MIRROR_RESULT_MAX_CHARS),
            isError: block.is_error === true,
          }))
        }
        if (events.length > 0) actions.push({ kind: 'events', taskId: parentId, events })
      }
      return actions
    },
  }
}

/** SDK options for the configured mode; bypass carries its mandatory flag. */
export function buildPermissionOptions(mode = DEFAULTS.permissionMode) {
  const resolved = resolvePermissionMode(mode)
  return resolved === 'bypassPermissions'
    ? { permissionMode: resolved, allowDangerouslySkipPermissions: true }
    : { permissionMode: resolved }
}

/**
 * v24: DSH's plan mode and its read-only permission preset are DSH-side state
 * the inner agent never sees. DSH enforces both through its own tool catalog
 * and bash sandbox — neither applies to Claude Code's native tools. Without
 * this mapping the inner agent keeps editing files while the user believes the
 * session is read-only: the constraint silently degrades into a polite request
 * in the system prompt (see buildSystemAppend's tool-routing note).
 *
 * Claude Code has no read-only permission mode. 'plan' is its only mode that
 * actually refuses edits, so both DSH states map onto it.
 *
 * Deliberately ONE-DIRECTIONAL — this only ever tightens. Mapping the looser
 * presets (workspace-write → acceptEdits, danger-full-access →
 * bypassPermissions) would silently change behaviour for everyone who never
 * touches /permission, and a too-loose DSH preset is not the failure mode
 * worth guarding: a too-loose INNER agent is.
 *
 * @param configured - llm-claude-code.permissionMode after clamping.
 * @param restrictions - DSH state, or undefined when it cannot be read.
 * @returns the mode to hand the SDK for this request.
 */
export function resolveEffectivePermissionMode(configured, restrictions) {
  if (restrictions?.planMode === true) return 'plan'
  if (restrictions?.permissionPreset === 'read-only') return 'plan'
  return configured
}

// Optional, never required: only non-claude routes need DSH's own /goal
// handler, so a composition without dsh-command-goal (or a DSH release that
// renames it) must degrade to "unavailable on other routes" rather than
// failing to load this provider at all. Rejection is swallowed here so it can
// never surface as an unhandled rejection.
const dshGoalModule = import('@deepseek-ai/dsh-command-goal').catch(() => undefined)

// DSH's own hint, inlined: the command is registered synchronously at apply()
// time, before the optional module can resolve, and the UI needs the hint then.
const DSH_GOAL_INPUT = Object.freeze({ hint: '[<objective>|clear|edit <objective>|pause|resume]', images: true })

export const name = 'llm-claude-code'
export const inject = ['llm', 'subprocess', 'tools', 'commands']

export function modelInfo(provider, model, contextWindow = DEFAULTS.contextWindow) {
  const entry = MODELS.find((item) => item.id === model)
  return {
    provider,
    id: model,
    name: entry?.name ?? model,
    ...(entry?.description !== undefined ? { description: entry.description } : {}),
    inputModalities: ['text', 'image'],
    // Per-model context (e.g. the [1m] variants) overrides the configured default.
    context: { contextWindow: entry?.context ?? contextWindow },
    reasoning: { efforts: EFFORTS.map(effortInfo), defaultEffort: 'high' },
  }
}

/** Ordered deduped image refs from every user-role message, walking nested tool-result content. */
export function collectImageRefs(messages) {
  const refs = []
  const seen = new Set()
  const walk = (blocks) => {
    for (const block of blocks ?? []) {
      if (block?.type === 'image') {
        const id = block.attachment?.attachmentId
        if (id !== undefined && !seen.has(id)) {
          seen.add(id)
          refs.push(block.attachment)
        }
      } else if (block?.type === 'tool-result') {
        walk(block.content)
      }
    }
  }
  for (const message of messages ?? []) {
    if (message?.role === 'user') walk(message.content)
  }
  return refs
}

/** Base64 length of raw bytes, padding included. */
function base64Length(bytes) {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Resolve request-image versions through the durable attachment service and
 * map them to Anthropic base64 image content blocks.
 * @returns Map<attachmentId, { block, handle }>
 */
export async function prepareImageBlocks(refs, attachments, policy, signal) {
  const prepared = new Map()
  let total = 0
  for (const ref of refs) {
    const version = await attachments.readImageRequest(ref, policy, signal)
    if (!ANTHROPIC_MEDIA_TYPES.has(version.mediaType)) {
      throw new LlmError(`llm-claude-code: image type ${version.mediaType} is not accepted by the Anthropic API`, 'UNSUPPORTED_CONTENT')
    }
    const data = Buffer.from(version.data).toString('base64')
    total += data.length
    if (total > MAX_REQUEST_IMAGE_BYTES) {
      throw new LlmError(`llm-claude-code: conversation images exceed the ${(MAX_REQUEST_IMAGE_BYTES / 1024 / 1024) | 0}MiB per-request image budget`, 'INVALID_REQUEST')
    }
    prepared.set(ref.attachmentId, {
      block: { type: 'image', source: { type: 'base64', media_type: version.mediaType, data } },
      // (ref, version) — NOT (version). Identity comes from the occurrence's own
      // DURABLE ref while the dimensions come from the prepared request version:
      // one version is shared by every occurrence of the same attachment id, so
      // the two arguments are genuinely different objects and cannot be folded.
      // Passing only the version made `ref` the version and `version` undefined,
      // and the helper's first statement reads `version.width` -> TypeError
      // "Cannot read properties of undefined (reading 'width')" on every send
      // that carried an image. `access` stays omitted: without it the helper
      // emits the plain "may be resized or re-encoded" wording, which is what
      // this route wants — it has no tool-execution world to resolve a path in.
      handle: requestImageHandleText(ref, version),
    })
  }
  return prepared
}

// Replay budget for one projected tool-activity block. The transcript shows
// the full rendering (toolResultDisplayChars); the next request's text
// replay clamps each `▸`/`‹` block to this many chars so long build logs don't
// bloat every subsequent prompt — Claude keeps the head, which is what it
// needs to recall its own prior inner-tool output.
const REPLAY_STATUS_MAX_CHARS = 800

// v31 wraps every replayed activity block in `<tool-activity>` tags.
//
// WHY: these blocks are plain text — `▸ Bash ✓ · desc\n$ desc\n\n<output>` —
// with no boundary between them and the model's own prose. A FULL replay
// (planReplay's 'full' mode: guaranteed after a host restart, since
// resumeState is in-memory, and also on edits, deletions, regeneration
// branches, retries and forks) dumps the entire history's worth of these
// blocks into one prompt. Claude then reads the shape as an output format it
// may continue, and starts DRAWING the next tool's card at the end of its
// prose — inventing a `▸ Bash · desc\n$ desc` header for a call it has not
// made yet. Measured on this session: 0 occurrences across six resumed
// turns, then 11 in the single full-replay turn right after a restart.
// The tag makes each block a structural record instead of a style to mimic.
//
// The `▸ ` sentinel stays INSIDE the tag: replayText below identifies
// activity blocks by that prefix, and the tag already supplies the isolation.
//
// Scope: prompt text only. The DSH transcript renders from
// buildToolActivityBlock's structured data, so display is untouched.
const ACTIVITY_REPLAY_OPEN = '<tool-activity>'
const ACTIVITY_REPLAY_CLOSE = '</tool-activity>'

/** Clamp to the replay budget, then isolate. Tags are outside the budget. */
function wrapActivityReplay(text) {
  const clamped = text.length > REPLAY_STATUS_MAX_CHARS
    ? `${text.slice(0, REPLAY_STATUS_MAX_CHARS).trimEnd()}\n… [replay truncated]`
    : text
  return `${ACTIVITY_REPLAY_OPEN}\n${clamped}\n${ACTIVITY_REPLAY_CLOSE}`
}

function replayText(block) {
  const text = block?.text ?? ''
  const kind = block?.type
  // `‹ ` marks the legacy v8–v13 text status blocks; `▸ ` marks the v15 fold
  // blocks carried on the reasoning channel. Genuine Claude thinking never
  // starts with either sentinel, so it keeps replaying unclamped AND unwrapped
  // — wrapping real prose would teach the very shape this guards against.
  if ((kind === 'text' || kind === 'reasoning') && (text.startsWith('‹ ') || text.startsWith('▸ '))) {
    return wrapActivityReplay(text)
  }
  return text
}

function activityReplayLine(block) {
  const mark = block?.isError ? '✗' : '✓'
  const input = block?.input && typeof block.input === 'object' ? block.input : {}
  const summary = [input.description, input.command, input.file_path, input.path, input.pattern, input.query, input.url]
    .find((value) => typeof value === 'string' && value.length > 0) || ''
  const output = typeof block?.output === 'string' ? block.output : ''
  return wrapActivityReplay(`▸ ${block?.name ?? 'tool'} ${mark} · ${summary}\n$ ${summary}\n\n${output}`)
}

function blockText(block, images) {
  if (block?.type === 'text') return replayText(block)
  if (block?.type === 'reasoning') return replayText(block)
  if (block?.type === 'tool-activity') return activityReplayLine(block)
  if (block?.type === 'tool-call') return `[DSH tool request ${block.name}: ${block.arguments ?? ''}]`
  if (block?.type === 'tool-result') {
    const text = (block.content ?? []).filter((item) => item?.type === 'text').map((item) => item.text).join('')
    return `TOOL RESULT ${block.toolCallId}:\n${text || '(no output)'}`
  }
  if (block?.type === 'image') {
    const id = block.attachment?.attachmentId
    // Attached images carry the deterministic handle text so the model can tie
    // each in-position marker to the trailing image blocks; anything not in the
    // request (non-user roles are never collected) stays an explicit omission.
    if (id !== undefined && images.has(id)) return `[${images.get(id).handle}]`
    return '[image omitted: this route re-sends only user-role image attachments]'
  }
  return ''
}

export function serializeConversation(messages, images = new Map()) {
  // Echoed display pairs are pure presentation: skip the synthetic tool-call
  // blocks and their synthetic results entirely so a full replay never feeds
  // them back to Claude (the resume path keeps the activity natively anyway).
  const echoIds = collectEchoCallIds(messages)
  const isEchoResult = (block) => block?.type === 'tool-result' && echoIds.has(block.toolCallId)
  const sections = []
  for (const message of messages ?? []) {
    const parts = (message.content ?? [])
      .filter((block) => block?.type !== 'tool-call' || !isEchoCallBlock(block))
      .filter((block) => !isEchoResult(block))
      .map((block) => blockText(block, images))
      .filter((text) => text.length > 0)
    if (parts.length === 0) continue
    const role = message.role === 'assistant' ? 'ASSISTANT' : message.role === 'system' ? 'SYSTEM' : 'USER'
    sections.push(`${role}:\n${parts.join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * Wrap the serialized transcript (plus trailing image blocks) as an SDK prompt.
 * With images the prompt becomes a one-message AsyncIterable<SDKUserMessage>;
 * without images it stays a plain string so behavior is byte-identical to v2.
 */
export function buildSdkPrompt(promptText, imageBlocks) {
  if (imageBlocks.length === 0) return promptText
  const content = [{ type: 'text', text: promptText }, ...imageBlocks]
  async function* input() {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
  }
  return input()
}

/**
 * Split the two things DSH reads out of one usage chunk.
 *
 * `result.usage` is the SUM over every inner API call of the turn, but DSH's
 * token meter treats the prompt-side fields as ONE request's context occupancy:
 * `pressureFrom = inputTokens + cacheReadTokens + cacheWriteTokens` drives both
 * the context bar and the auto-compaction threshold. Feeding it the sum
 * over-reports badly and grows with the inner tool-call count — measured on a
 * 5-call turn: 135k reported against a real ~36k context, 68% of a 200k window
 * after a single turn, so auto-compaction fires almost immediately.
 *
 * `last` is the final main-session assistant message's own usage, which is
 * exactly the end-of-turn context occupancy. Output stays cumulative: it is a
 * cost figure, excluded from pressure, and every inner call's output was really
 * produced. Cached/uncached INPUT totals therefore under-report the turn's true
 * cost — the accepted trade for a context bar and a compaction trigger that
 * mean what they say.
 *
 * @param usage - `result.usage`, cumulative over the turn.
 * @param last - usage of the last `parent_tool_use_id === null` assistant
 *   message, or undefined when none carried usage (then the cumulative
 *   prompt-side numbers are kept rather than reporting nothing).
 */
export function usageOf(usage, last) {
  const prompt = last ?? usage
  return {
    inputTokens: prompt?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(typeof prompt?.cache_read_input_tokens === 'number' ? { cacheReadTokens: prompt.cache_read_input_tokens } : {}),
    ...(typeof prompt?.cache_creation_input_tokens === 'number' ? { cacheWriteTokens: prompt.cache_creation_input_tokens } : {}),
  }
}

/**
 * Decide how this request reaches Claude Code.
 *
 * `stored` is the per-DSH-session tracking entry
 * `{ claudeSessionId, lastFedMessageId }` from the last fully successful
 * turn. Resume is only safe when the history is still a pure extension of
 * what that CC session already contains: the watermark message must still be
 * present, everything between it and the trailing user messages must be OUR
 * assistant replies (a foreign-provider turn after the watermark means the CC
 * session missed an exchange), and the new material must be exactly one
 * trailing run of user messages. Anything else — edits, deletions,
 * regeneration branches, retries, parallel forks — falls back to full text
 * replay in a fresh session.
 *
 * @returns { mode: 'full' } or
 *          { mode: 'resume', resumeId, delta, lastFedMessageId }
 */
export function planReplay(messages, stored, provider) {
  if (stored === undefined) return { mode: 'full' }
  const echoIds = collectEchoCallIds(messages)
  const real = (message) => !isEchoOnlyUserMessage(message, echoIds)
  const watermark = (messages ?? []).findIndex((message) => message?.id === stored.lastFedMessageId)
  if (watermark < 0) return { mode: 'full' }
  const after = messages.slice(watermark + 1).filter(real)
  if (after.length === 0) return { mode: 'full' }
  // Only our assistant replies may appear before the new user input. A real
  // user-role tool result would mean DSH executed a tool that Claude Code's
  // native session never saw, so it is not a plain continuation. Echoed
  // display pairs (claudeActivity) are filtered out above — they are pure
  // presentation and must not force a full replay.
  const firstUser = after.findIndex((message) => message?.role === 'user')
  if (firstUser < 0) return { mode: 'full' }
  for (let i = 0; i < firstUser; i++) {
    const message = after[i]
    if (message?.role !== 'assistant' || message?.source?.provider !== provider) return { mode: 'full' }
  }
  const delta = after.slice(firstUser)
  if (delta.length === 0) return { mode: 'full' }
  for (const message of delta) {
    if (message?.role !== 'user') return { mode: 'full' }
    if ((message.content ?? []).some((block) => block?.type === 'tool-result' && !echoIds.has(block.toolCallId))) return { mode: 'full' }
  }
  return {
    mode: 'resume',
    resumeId: stored.claudeSessionId,
    delta,
    lastFedMessageId: after[after.length - 1].id,
  }
}

function sdkFailure(message) {
  const detail = Array.isArray(message?.errors) && message.errors.length > 0
    ? message.errors.join('; ')
    : message?.subtype ?? 'unknown Claude Code failure'
  const code = message?.subtype === 'error_max_turns' ? 'MAX_TOKENS' : 'PROVIDER_ERROR'
  return new LlmError(`llm-claude-code: ${detail}`, code)
}

const TOOL_INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']
const TOOL_INPUT_MAX_CHARS = 500

/** The compact one-line description of one native tool_use's input. */
export function toolUseInputLine(use) {
  const input = use?.input ?? {}
  let detail = ''
  for (const key of TOOL_INPUT_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) {
      detail = value
      break
    }
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      detail = value.join(' ')
      break
    }
  }
  if (detail === '') detail = JSON.stringify(input)
  return detail.replace(/\s+/g, ' ').trim().slice(0, TOOL_INPUT_MAX_CHARS)
}

/** One compact human-readable line per native tool_use block. */
export function describeToolUses(uses) {
  return uses.map((use) => `▸ ${use?.name ?? 'tool'} · ${toolUseInputLine(use)}`).join('\n')
}

/**
 * Render one native tool_result content (string or block array) for DISPLAY:
 * newlines are preserved and long output keeps both ends — the head carries
 * what was asked for, the tail carries the exit status / final lines.
 * @param maxChars total display budget (configurable toolResultDisplayChars)
 */
export function resultText(content, maxChars = DEFAULTS.toolResultDisplayChars) {
  const parts = typeof content === 'string'
    ? [content]
    : (content ?? []).filter((block) => block?.type === 'text').map((block) => block.text)
  const text = parts.join('\n').trim()
  if (maxChars <= 0 || text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.floor(maxChars * 0.3)
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n… [${omitted} chars omitted] …\n${text.slice(-tail)}`
}

/** One Markdown code card per completed inner native tool run (v14 style). */
export function describeToolActivityCards(results, useOf, maxChars = DEFAULTS.toolResultDisplayChars) {
  const entries = []
  for (const block of results) {
    const use = useOf(block?.tool_use_id) ?? { name: 'tool', inputLine: '' }
    const mark = block?.is_error ? 'failed' : 'completed'
    const output = resultText(block?.content, maxChars) || '(no output)'
    // A dynamic-length fence preserves any backticks from a command or its
    // output without accidentally terminating the Markdown card early.
    const body = `$ ${use.inputLine || '(no input)'}\n\n${output}`
    const runs = body.match(/`+/g) ?? []
    const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
    entries.push(`**${use.name}** · ${mark}\n\n${fence}sh\n${body}\n${fence}`)
  }
  return entries.join('\n\n')
}

/**
 * One collapsible fold per completed inner native tool run, carried on the
 * reasoning channel. The FIRST LINE is the summary the collapsed Think-style
 * row shows; the remainder is the expanded body — plain pre-wrap text, NOT
 * Markdown, so no fences or bold here. The leading `▸ ` doubles as the
 * replay-clamp sentinel shared with the legacy `‹ ` blocks.
 * @returns an array of fold texts, one per tool_result block
 */
export function describeToolActivityFolds(results, useOf, maxChars = DEFAULTS.toolResultDisplayChars) {
  return results.map((block) => {
    const use = useOf(block?.tool_use_id) ?? { name: 'tool', inputLine: '' }
    const mark = block?.is_error ? '✗' : '✓'
    const output = resultText(block?.content, maxChars) || '(no output)'
    const input = use.inputLine || '(no input)'
    return `▸ ${bridgeDisplayName(use.name)} ${mark} · ${input}\n$ ${input}\n\n${output}`
  })
}

// Echo-card machinery. The client derives a tool card's variant/title/summary
// from the call NAME and its arguments (TOOL_VARIANTS/SUMMARY_KEYS in
// dsh-client-ui-tool), so echoing under the variant-compatible lowercase name
// with native-shaped args yields a real bash/read/search-style card. The
// `claudeActivity` marker inside the arguments is the durable side-channel
// that marks a call/result pair as display-only (planReplay and
// serializeConversation skip it; the payload rides in the persisted arguments
// so the card's render survives process restarts, like v12).
const ECHO_MARKER = 'claudeActivity'
const ECHO_VARIANTS = {
  Bash: 'bash',
  Read: 'read',
  Edit: 'edit',
  Write: 'write',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
}
const ECHO_FALLBACK = 'claude_tool'
const ECHO_OUTPUT_MAX_CHARS = 20000

/**
 * Native-shaped arguments for one echoed run: the client's summary keys first
 * (description wins over command on the bash variant, like real bash cards),
 * then the marker + output payload. `output` is display-clamped by the caller.
 */
export function buildEchoArguments(ccName, input, output, isError) {
  const source = input ?? {}
  const line = typeof output === 'string' ? output.slice(0, ECHO_OUTPUT_MAX_CHARS) : ''
  const args = {}
  if (ccName === 'Bash') {
    if (typeof source.description === 'string' && source.description.length > 0) args.description = source.description
    args.command = typeof source.command === 'string' && source.command.length > 0 ? source.command : (source._inputLine ?? '')
  } else if (ccName === 'Read' || ccName === 'Edit' || ccName === 'Write') {
    args.file_path = typeof source.file_path === 'string' ? source.file_path : (source._inputLine ?? '')
  } else if (ccName === 'Glob' || ccName === 'Grep') {
    args.pattern = typeof source.pattern === 'string' && source.pattern.length > 0 ? source.pattern : (source._inputLine ?? '')
  } else if (ccName === 'WebSearch') {
    args.query = typeof source.query === 'string' && source.query.length > 0 ? source.query : (source._inputLine ?? '')
  } else if (ccName === 'WebFetch') {
    args.url = typeof source.url === 'string' && source.url.length > 0 ? source.url : (source._inputLine ?? '')
  } else {
    args.description = source._inputLine ?? ''
  }
  args[ECHO_MARKER] = true
  args.ccTool = ccName
  args.output = line === '' ? '(no output)' : line
  args.isError = isError === true
  return args
}

/** True when a tool-call block is one of our display-only echoes. */
export function isEchoCallBlock(block) {
  if (block?.type !== 'tool-call') return false
  try {
    return JSON.parse(block.arguments ?? '{}')?.[ECHO_MARKER] === true
  } catch {
    return false
  }
}

/** Every echoed call id in a message list (result blocks reference these). */
export function collectEchoCallIds(messages) {
  const ids = new Set()
  for (const message of messages ?? []) {
    if (message?.role !== 'assistant') continue
    for (const block of message.content ?? []) {
      if (isEchoCallBlock(block) && typeof block?.id === 'string') ids.add(block.id)
    }
  }
  return ids
}

/** A user message that carries ONLY echoed results (no real DSH execution). */
export function isEchoOnlyUserMessage(message, echoIds) {
  if (message?.role !== 'user') return false
  const content = message.content ?? []
  return content.length > 0 && content.every((block) => block?.type === 'tool-result' && echoIds.has(block.toolCallId))
}

export async function* translateSdkMessages(messages, { showToolActivity = true, toolActivityDisplay = DEFAULTS.toolActivityDisplay, toolResultDisplayChars = DEFAULTS.toolResultDisplayChars, echoNameOf = () => ECHO_FALLBACK, onResult } = {}) {
  // native/fold are order-preserving. card still batches after the outer stream.
  // Unknown values clamp to native so a typo cannot silently restore batched cards.
  const activityDisplay = resolveToolActivityDisplay(toolActivityDisplay)
  const blocks = new Map()
  const toolUses = new Map()
  const useOf = (id) => toolUses.get(id)
  let nextIndex = 0
  let emittedText = false
  let result
  let lastPromptUsage

  const emitTextBlock = (text) => {
    const index = nextIndex++
    // Status text must not set emittedText: the result.result fallback below
    // exists precisely for turns whose real text never streamed, and a
    // tool-only prefix must not suppress the final answer.
    return [
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    ]
  }

  const emitFoldBlock = (text) => {
    const index = nextIndex++
    // The reasoning channel renders as the transcript's collapsed-by-default
    // disclosure row (real-time, never executed). Like emitTextBlock it must
    // not set emittedText, or a tool-only turn would lose its final answer.
    return [
      { type: 'block-start', index, blockType: 'reasoning' },
      { type: 'reasoning-delta', index, text },
      { type: 'block-end', index, block: { type: 'reasoning', text } },
    ]
  }

  // Display-only activity: same start/end chunk pair as other blocks so the
  // stream invariant stays happy, but the type is never tool-call.
  const emitNativeActivityBlock = (use, output, isError) => {
    const index = nextIndex++
    const block = buildToolActivityBlock(use, output, isError)
    return [
      { type: 'block-start', index, blockType: 'tool-activity' },
      { type: 'block-end', index, block },
    ]
  }

  // One complete tool-call block for an ECHO tool: the agent loop dispatches
  // it after the stream settles, the echo concludes the turn with no follow-up
  // request, and the transcript gains a native collapsible tool card with the
  // exact output. Never a real execution request (see the v16 header notes).
  const emitActivityCardChunk = (use, echoName, output, isError) => {
    const index = nextIndex++
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: use.id,
          name: echoName,
          arguments: JSON.stringify(buildEchoArguments(bridgeDisplayName(use.name), use.input, output, isError)),
        },
      },
    ]
  }

  for await (const message of messages) {
    if (message?.type === 'stream_event' && message.parent_tool_use_id === null) {
      const event = message.event
      if (event?.type === 'content_block_start') {
        const native = event.content_block
        const kind = native?.type === 'text' ? 'text' : native?.type === 'thinking' || native?.type === 'redacted_thinking' ? 'reasoning' : undefined
        if (kind !== undefined) {
          const state = { index: nextIndex++, kind, text: '' }
          blocks.set(event.index, state)
          yield { type: 'block-start', index: state.index, blockType: kind }
        }
      } else if (event?.type === 'content_block_delta') {
        const state = blocks.get(event.index)
        if (state !== undefined) {
          const delta = event.delta
          const text = state.kind === 'text' ? delta?.text : delta?.thinking
          if (typeof text === 'string' && text.length > 0) {
            state.text += text
            if (state.kind === 'text') {
              emittedText = true
              yield { type: 'text-delta', index: state.index, text }
            } else {
              yield { type: 'reasoning-delta', index: state.index, text }
            }
          }
        }
      } else if (event?.type === 'content_block_stop') {
        const state = blocks.get(event.index)
        if (state !== undefined) {
          blocks.delete(event.index)
          yield {
            type: 'block-end',
            index: state.index,
            block: state.kind === 'text' ? { type: 'text', text: state.text } : { type: 'reasoning', text: state.text },
          }
        }
      }
      continue
    }
    // Context occupancy, tracked independently of the activity-display mode:
    // the LAST main-session assistant message carries the turn's real end state.
    // Sub-agent messages (parent_tool_use_id set) run their own context and must
    // not be sampled here.
    if (message?.type === 'assistant' && message.parent_tool_use_id === null && message.message?.usage !== undefined) {
      lastPromptUsage = message.message.usage
    }
    if (message?.type === 'assistant' && message.parent_tool_use_id === null && showToolActivity) {
      // Retain native calls (full input, for native-shaped echo args) until
      // their results arrive. Cards/folds are emitted at completion.
      const uses = (message.message?.content ?? []).filter((block) => block?.type === 'tool_use')
      for (const use of uses) {
        if (typeof use?.id === 'string') {
          toolUses.set(use.id, { id: use.id, name: use.name ?? 'tool', inputLine: toolUseInputLine(use), input: use.input })
        }
      }
      continue
    }
    if (message?.type === 'user' && message.parent_tool_use_id === null && showToolActivity) {
      const results = Array.isArray(message.message?.content)
        ? message.message.content.filter((block) => block?.type === 'tool_result')
        : []
      if (results.length > 0) {
        if (activityDisplay === 'fold') {
          for (const fold of describeToolActivityFolds(results, useOf, toolResultDisplayChars)) {
            yield* emitFoldBlock(fold)
          }
        } else if (activityDisplay === 'native') {
          for (const block of results) {
            const use = useOf(block?.tool_use_id)
            if (use === undefined) continue
            yield* emitNativeActivityBlock(use, resultText(block?.content, toolResultDisplayChars) || '(no output)', block?.is_error === true)
          }
        } else {
          for (const block of results) {
            const use = useOf(block?.tool_use_id)
            if (use === undefined) continue
            // Map before choosing the variant: a bridged `mcp__dsh__bash` has
            // to land on ECHO_VARIANTS' `Bash` entry, not the generic
            // fallback, or the swap would be visible as a plainer card.
            const echoName = echoNameOf(bridgeDisplayName(use.name))
            if (echoName === null) {
              // Name collision or registration failure: this run still gets a
              // real-time fold instead of a card it could not safely claim.
              yield* emitFoldBlock(describeToolActivityFolds([block], useOf, toolResultDisplayChars)[0])
            } else {
              yield* emitActivityCardChunk(use, echoName, resultText(block?.content, toolResultDisplayChars) || '(no output)', block?.is_error === true)
            }
          }
        }
        for (const block of results) toolUses.delete(block?.tool_use_id)
      }
      continue
    }
    if (message?.type === 'result') result = message
  }

  if (result === undefined) throw new LlmError('llm-claude-code: SDK ended without a result', 'EMPTY_RESPONSE')
  if (result.subtype !== 'success' || result.is_error) throw sdkFailure(result)
  if (!emittedText && typeof result.result === 'string' && result.result.length > 0) {
    const index = nextIndex++
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text: result.result }
    yield { type: 'block-end', index, block: { type: 'text', text: result.result } }
  }
  if (typeof onResult === 'function') {
    try { onResult(result) } catch { /* tracking must never break the stream */ }
  }
  yield { type: 'usage', usage: usageOf(result.usage, lastPromptUsage) }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

// The workspace path is a single non-whitespace token starting with '/'; the
// sentence around it (trailing period, further sentences) must never leak into
// the captured path. A greedy capture backtracks to the LAST '.' of the line
// (v2–v5 bug: "Working directory is /tmp. Answer in one sentence." resolved to
// the whole sentence → nonexistent cwd → child_process spawn ENOENT); a lazy
// one truncates at the FIRST dot, breaking dotted paths. Capturing a
// whitespace-free token and trimming trailing sentence punctuation handles
// both. Paths containing spaces are unsupported (and never occur in DSH
// system prompts).
const WORKSPACE_PATTERNS = [
  /[Ww]orking directory is (?:currently )?`?(\/[^\s`]+)`?(?=[.\n]|$)/,
  /(?:工作目录|当前目录)(?:是|为)\s*`?(\/[^\s`]+)`?(?=[。.\n]|$)/,
]

export function resolveWorkspace(options, configured) {
  if (typeof configured === 'string' && configured.length > 0) return configured
  const system = typeof options?.system === 'string' ? options.system : ''
  for (const pattern of WORKSPACE_PATTERNS) {
    const match = pattern.exec(system)
    if (match !== null) {
      const path = match[1].trim().replace(/[.。,，;；:：!！?？)）"'']+$/, '')
      if (path.startsWith('/')) return path
    }
  }
  return process.cwd()
}

/**
 * Convert Claude's AskUserQuestion input to DSH's userQuestions request.
 * Claude calls the field `multiSelect`; DSH uses the same camel-case field.
 * Preserve stable ids, labels, descriptions, headers, and optional detail.
 */
export function normalizeAskUserQuestions(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : []
  return questions
    .filter((question) => typeof question?.question === 'string' && question.question.length > 0)
    .map((question, index) => ({
      id: typeof question.id === 'string' && question.id.length > 0 ? question.id : `claude-question-${index + 1}`,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
      ...(Array.isArray(question.options) ? {
        options: question.options
          .filter((option) => typeof option?.label === 'string' && option.label.length > 0)
          .map((option) => ({
            label: option.label,
            ...(typeof option.description === 'string' ? { description: option.description } : {}),
          })),
      } : {}),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    }))
}

/**
 * Convert DSH's stable-id answer list back to Claude's required question-text
 * keyed map. Custom free-text answers take precedence over selected labels;
 * multi-select labels are joined exactly as Claude's own UI expects.
 */
export function buildAskUserQuestionInput(input, answer) {
  const questions = normalizeAskUserQuestions(input)
  const byId = new Map((answer?.answers ?? []).map((item) => [item?.id, item]))
  const answers = {}
  for (const question of questions) {
    const item = byId.get(question.id)
    if (item === undefined) continue
    const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
    const selected = Array.isArray(item.selected) ? item.selected.filter((value) => typeof value === 'string') : []
    if (custom.length > 0) answers[question.question] = custom
    else if (selected.length > 0) answers[question.question] = selected.join(', ')
    else answers[question.question] = ''
  }
  return {
    questions: Array.isArray(input?.questions) ? input.questions : [],
    answers,
  }
}

/**
 * Handle one AskUserQuestion invocation through the native DSH question card.
 * A missing service/provider is fail-closed and returns a tool-visible denial;
 * it must never leave the SDK parked indefinitely in a headless session.
 */
export async function askUserQuestionThroughDsh(input, { userQuestions, agent, signal } = {}) {
  if (userQuestions === undefined || typeof userQuestions.ask !== 'function') {
    return {
      behavior: 'deny',
      message: 'DSH user-question UI is unavailable; continue without asking the user.',
    }
  }
  const questions = normalizeAskUserQuestions(input)
  if (questions.length === 0) {
    return {
      behavior: 'deny',
      message: 'AskUserQuestion carried no valid questions; continue without asking the user.',
    }
  }
  try {
    const answer = await userQuestions.ask({
      questions,
      ...(agent !== undefined ? { agent } : {}),
      signal,
    })
    return {
      behavior: 'allow',
      updatedInput: buildAskUserQuestionInput(input, answer),
    }
  } catch (error) {
    return {
      behavior: 'deny',
      message: `The DSH user-question UI could not collect an answer: ${error?.message ?? error}`,
    }
  }
}

/** SDK option switch: expose AskUserQuestion to the bridge, or fail closed. */
/**
 * Adapt the DSH-facing permission result to the Agent SDK PreToolUse hook
 * envelope. Keeping this pure lets the bridge be tested without spawning CLI.
 */
export function createAskUserQuestionHook(permissionHandler) {
  return async (hookInput, _toolUseId, sdkOptions) => {
    if (hookInput?.hook_event_name !== 'PreToolUse' || hookInput.tool_name !== 'AskUserQuestion') {
      return { continue: true }
    }
    const permission = await permissionHandler(hookInput.tool_input, sdkOptions)
    if (permission.behavior === 'allow') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: permission.updatedInput,
        },
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: permission.message,
      },
    }
  }
}

export function buildUserInteractionOptions(enabled, hook) {
  return enabled && typeof hook === 'function'
    ? {
        hooks: {
          PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [hook] }],
        },
      }
    : { disallowedTools: ['AskUserQuestion'] }
}

/**
 * DSH tool names the inner agent cannot usefully act on.
 *
 * This provider never registers DSH's catalog with the SDK — `options.tools`
 * is read for NAMES only (see buildSystemAppend's routing note) — yet 72% of
 * the injected system prompt teaches that catalog. Names listed here are
 * either absent from Claude Code entirely (memory_*, the goal trio, ralph,
 * visualize, generate_image, claude_tool, todo_write) or wear a same-ish name
 * over a different call contract: DSH's `web_search` takes a queries ARRAY
 * where Claude Code's WebSearch takes one string, and job_output/job_kill
 * address a job id Claude Code has no concept of. Both kinds actively
 * misdirect, which is worse than merely occupying prompt space.
 *
 * Deliberately a DENY list, never an allow list: an unrecognised DSH tool
 * keeps its guidance. Wrongly guessing "no equivalent" would silently drop
 * real instruction, and DSH grows tools faster than this file is revised.
 */
const INNER_ABSENT_TOOLS = [
  'memory_search', 'memory_read',
  'create_goal', 'get_goal', 'update_goal',
  'ralph', 'visualize', 'generate_image', 'claude_tool', 'todo_write',
  'job_list', 'job_output', 'job_kill',
  'web_search',
]

/** DSH tools whose guidance still lands, because Claude Code has a close
 *  native counterpart under a recognisable name. */
const INNER_PRESENT_TOOLS = [
  'read', 'write', 'edit', 'glob', 'grep', 'bash',
  'skill', 'subagent', 'subagent_fork', 'workflow', 'web_fetch',
  'ask_user_question', 'exit_plan_mode',
  'send_message', 'list_agents', 'interrupt_agent',
  'mcp_tools_search', 'mcp_tools_call',
]

/**
 * Drop the paragraphs of DSH's system prompt that only teach absent tools.
 *
 * A paragraph goes only when every DSH tool name it mentions is absent
 * inside. One that mixes an absent tool with a present one still carries
 * usable instruction and stays — DSH's ralph note also mentions subagents,
 * its workflow note mentions `subagent`. Paragraphs naming no tool at all
 * ALWAYS stay: the harness identity, the Web GUI contract and the
 * clickable-path convention are things Claude Code cannot know on its own,
 * and they are the reason this is a filter rather than a wholesale drop.
 *
 * Matching is case-sensitive with word boundaries, so prose capitals ("Read
 * only relevant matches") never count as a tool mention and an underscore
 * keeps `memory_read` from registering as `read`.
 */
export function stripAbsentToolGuidance(system, bridged = []) {
  const mentions = (text, name) => new RegExp(`\\b${name}\\b`).test(text)
  // A bridged tool is present again, so its paragraph carries live
  // instruction: v26 must not delete the very guidance that now applies.
  const absent = INNER_ABSENT_TOOLS.filter((name) => !bridged.includes(name))
  const present = [...INNER_PRESENT_TOOLS, ...bridged]
  return system
    .split(/\n{2,}/)
    .filter((paragraph) => {
      if (!absent.some((name) => mentions(paragraph, name))) return true
      return present.some((name) => mentions(paragraph, name))
    })
    .join('\n\n')
}

/**
 * v26: bridge a few DSH tools into the inner agent for real, instead of only
 * naming them in prose.
 *
 * v25 deleted the paragraphs that taught tools the inner agent cannot call —
 * that conceded they do not exist. This is the other half: make the one whose
 * absence actually breaks a DSH feature exist.
 *
 * Why goal first. DSH's goal machinery ends a goal through `update_goal`. The
 * inner agent could never call it, so a goal attached to a Claude Code session
 * can never be marked complete: DSH keeps auto-continuing until it burns
 * maxGoalRounds. No amount of system-prompt wording closes that — the tool has
 * to be callable.
 *
 * The route, all in one process:
 *
 *   inner agent calls mcp__dsh__update_goal
 *      -> the SDK's in-process MCP server (no subprocess, no socket)
 *      -> ctx.tools.execute(), DSH's own execution entry
 *      -> DSH's permission gate, approval, tool body, tools/result event
 *      -> the result is re-shaped into MCP's reply and handed back
 *
 * v27 adds `bash` and its two job companions for a different reason than the
 * goal tools. The inner agent HAS a native Bash — that is the problem. Native
 * Bash runs outside DSH entirely, so DSH's file sandbox and its approval
 * prompts never see a single command the inner agent runs, and the workspace
 * policy the user selected silently applies to nothing. Bridging bash and then
 * disabling the native one (see REPLACED_NATIVE_TOOLS) is what actually puts
 * command execution under the session's stated policy.
 *
 * `job_output` / `job_kill` ride along because DSH's own bash description
 * tells the caller to collect background output with them. Bridging bash
 * alone would leave `run_in_background: true` as a trap: the job starts, the
 * id comes back, and nothing can ever read it.
 *
 * v28 adds write/edit to close the file-write gap v27 left open. Their DSH
 * parameters are identical to the native ones (file_path/content and
 * file_path/old_string/new_string/replace_all), so the swap itself costs
 * nothing.
 *
 * `read` and `read_image` are NOT here for containment — a read tool cannot
 * escape a write policy. They are here because DSH's edit hard-depends on
 * them. dsh-fs-observation-policy's editIntent throws FS_NOT_OBSERVED unless
 * the same agent session has already read that exact path THROUGH A DSH TOOL;
 * the observation is recorded from DSH's own `fs/observed` event, which the
 * native Read never emits. Bridging edit without read would therefore fail
 * 100% of the time, and bridging write without read degrades it to
 * create-only: writeIntent falls back to `createIfAbsent` for an unobserved
 * path, so overwriting an existing file cannot succeed either. read_image
 * rides along so the PNG/JPEG/WebP/GIF half of the native Read survives.
 *
 * v30 adds `todo_write`, and its reason is visibility rather than containment.
 * The inner agent HAS a native TodoWrite — that is the problem. Its list never
 * leaves the SDK, so DSH records no `todo/write` event, the session's `todos`
 * projection stays null, and the plan panel the user reads for every other
 * agent stays empty for the whole run. Bridging todo_write and disabling the
 * native one (see REPLACED_NATIVE_TOOLS) is what puts the inner agent's plan
 * where the user already looks for it.
 *
 * Two shape differences ride along, both absorbed rather than translated. The
 * native item carries an `activeForm` alongside content/status where DSH's
 * carries neither; no stripping code is needed, because the bridge builds its
 * argument object with `z.object()`, which drops unknown keys before DSH's
 * `additionalProperties: false` could reject them. And DSH clears the list at
 * `turn/start` where the native one persists across turns — the projection's
 * documented lifetime, not a defect to compensate for.
 *
 * Still NOT bridged: glob/grep. Both are read-only, so neither buys
 * containment, and grep would be a plain downgrade — DSH's takes
 * pattern/path/include where the native Grep takes a dozen parameters
 * (output_mode, -A/-B/-C, -i, multiline, head_limit, offset).
 */
const BRIDGED_TOOL_NAMES = [
  'get_goal', 'create_goal', 'update_goal',
  'bash', 'job_output', 'job_kill',
  'read', 'read_image', 'write', 'edit',
  'todo_write',
]

/**
 * Native Claude Code tools to switch off once their DSH counterpart bridges,
 * mapped to the DSH tool that replaces each one.
 *
 * Two SDK options do the work together, and both are needed:
 *   - `disallowedTools` removes the native tool from the model's context, so
 *     it stops being an option at all.
 *   - `toolAliases` catches the case where the model emits the native name
 *     anyway — a skill document saying "run the tests with Bash" is enough —
 *     and resolves it to the bridged tool instead of failing as unknown.
 *
 * Only applied for tools that actually bridged. A failed bridge must leave the
 * native tool alone: taking Bash away without providing a replacement would
 * strand the inner agent with no way to run anything.
 *
 * v28 closes v27's KNOWN GAP: with Write and Edit swapped too, every path that
 * mutates a file now runs through DSH's sandbox.
 *
 * Read is swapped as well, and the reason is mechanical rather than about
 * containment: DSH's edit only accepts a path this agent session already read
 * through a DSH tool (see BRIDGED_TOOL_NAMES). Leaving the native Read in
 * place would put a second reader next to it that satisfies nothing, so every
 * edit would need a redundant re-read first — a toll on the single most
 * frequent operation there is. One reader keeps that path clean.
 *
 * The cost, accepted deliberately: the native Read also handles PDF pages and
 * Jupyter notebooks, which DSH's read (UTF-8 text) and read_image
 * (PNG/JPEG/WebP/GIF) do not cover. Those fall back to a third-party MCP
 * reader or a bash converter.
 *
 * Remaining asymmetry, by design and worth stating: reads are not confined.
 * Native Glob/Grep and third-party MCP servers can still reach any path this
 * OS user can. Only writes are governed.
 *
 * v30's TodoWrite is the one entry here that governs nothing. Leaving it in
 * place would not be unsafe, it would be pointless: this model reaches for its
 * own TodoWrite by reflex, so an unswapped bridge would sit unused and the
 * plan panel would stay as empty as before. Switching the native one off is
 * the only way the bridged tool actually gets called. `toolAliases` then earns
 * its keep more than usual — the reflex is strong enough that the native name
 * will still be emitted, and it resolves to the bridge instead of failing.
 */
const REPLACED_NATIVE_TOOLS = { Bash: 'bash', Read: 'read', Write: 'write', Edit: 'edit', TodoWrite: 'todo_write' }

/**
 * DSH tool name → the name its calls appear under in the transcript.
 *
 * Derived from REPLACED_NATIVE_TOOLS so the two can never drift: a bridged
 * call that stands in for a native tool shows the native name the user already
 * knows (`Bash`, not `mcp__dsh__bash`). The `mcp__server__tool` shape is
 * reserved for genuine third-party MCP servers, where it carries real
 * information about where the tool came from.
 */
const BRIDGE_DISPLAY_NAMES = Object.fromEntries(
  Object.entries(REPLACED_NATIVE_TOOLS).map(([nativeName, dshName]) => [dshName, nativeName]),
)

/**
 * Display name for one inner tool call.
 *
 * Three cases, in order:
 *   - a bridged tool standing in for a native one → the native name (`Bash`)
 *   - any other bridged DSH tool → its bare DSH name (`get_goal`), because the
 *     `mcp__dsh__` prefix is an artifact of how the bridge is mounted, not
 *     something the user needs to see
 *   - anything else, third-party MCP servers included → untouched
 */
export function bridgeDisplayName(name) {
  if (typeof name !== 'string' || !name.startsWith(BRIDGE_PREFIX)) return name
  const bare = name.slice(BRIDGE_PREFIX.length)
  return BRIDGE_DISPLAY_NAMES[bare] ?? bare
}

/** Prefix the SDK gives tools served by an in-process MCP server named `dsh`. */
const BRIDGE_PREFIX = 'mcp__dsh__'

/**
 * Convert DSH's enforced JSON Schema subset into a Zod raw shape, the only
 * parameter form the SDK's `tool()` accepts.
 *
 * `z` is injected rather than imported at module top level: zod resolves in
 * the profile but not in this repo's checkout, and a hard top-level import
 * would stop the offline self-check from loading this module at all. Injection
 * also lets the self-check exercise the walk with a recording stub.
 *
 * Anything outside the subset degrades to `z.unknown()` rather than throwing:
 * a schema this function cannot express is still better bridged loosely than
 * not bridged at all, since DSH validates the arguments again on its side.
 */
export function jsonSchemaToZodShape(z, schema) {
  const node = (spec) => {
    if (spec === null || typeof spec !== 'object') return z.unknown()
    let base
    if (Array.isArray(spec.enum) && spec.enum.length > 0) {
      base = spec.enum.every((value) => typeof value === 'string')
        ? z.enum(spec.enum)
        : z.union(spec.enum.map((value) => z.literal(value)))
    } else if ('const' in spec) {
      base = z.literal(spec.const)
    } else {
      switch (spec.type) {
        case 'string': base = z.string(); break
        case 'number': base = z.number(); break
        case 'integer': base = z.number().int(); break
        case 'boolean': base = z.boolean(); break
        case 'null': base = z.null(); break
        case 'array': base = z.array(node(spec.items)); break
        case 'object': base = z.object(shapeOf(spec)); break
        default: base = z.unknown()
      }
    }
    return typeof spec.description === 'string' && spec.description.length > 0
      ? base.describe(spec.description)
      : base
  }
  const shapeOf = (spec) => {
    const properties = spec?.properties
    if (properties === null || typeof properties !== 'object') return {}
    const required = new Set(Array.isArray(spec.required) ? spec.required : [])
    const shape = {}
    for (const [key, value] of Object.entries(properties)) {
      const built = node(value)
      shape[key] = required.has(key) ? built : built.optional()
    }
    return shape
  }
  return shapeOf(schema)
}

/**
 * Re-shape a DSH tool result into MCP's reply.
 *
 * The two formats already agree on `content` and `isError`, so this stays a
 * shallow copy rather than a translation. A result with no content still has
 * to carry something: MCP treats an empty content array as a protocol error,
 * and an inner agent that receives one reports the tool as broken instead of
 * seeing what DSH actually said.
 */
export function toMcpResult(result) {
  const content = Array.isArray(result?.content) && result.content.length > 0
    ? result.content
    : [{ type: 'text', text: result?.isError === true ? 'Error: tool failed with no output' : '(no output)' }]
  return result?.isError === true ? { content, isError: true } : { content }
}

/**
 * Build the in-process MCP server that serves DSH tools to the inner agent.
 *
 * Returns `undefined` when the bridge cannot stand up — zod missing, the tools
 * service absent, or none of the wanted tools registered. A missing bridge is
 * a soft degradation: the inner agent simply keeps working without those
 * tools, exactly as it did before v26.
 *
 * The agent is resolved per call, not captured once. DSH's goal tools reject
 * any execution whose agent is not the live initiator of the current turn, so
 * a stale capture would fail every call after the first turn.
 */
export function buildDshToolBridge(deps) {
  const { createSdkMcpServer, tool, z, tools, agents, callId, logger, names = BRIDGED_TOOL_NAMES } = deps
  if (createSdkMcpServer === undefined || tool === undefined || z === undefined || tools === undefined) return undefined

  const definitions = []
  const bridged = []
  for (const name of names) {
    let definition
    try {
      definition = tools.get?.(name, agents?.currentInitiator?.())
    } catch (error) {
      logger?.warn?.('llm-claude-code: could not read DSH tool %s: %o', name, error)
    }
    if (definition === undefined) continue
    let shape
    try {
      shape = jsonSchemaToZodShape(z, definition.parameters)
    } catch (error) {
      logger?.warn?.('llm-claude-code: could not convert schema for %s: %o', name, error)
      continue
    }
    definitions.push(tool(
      name,
      definition.description ?? name,
      shape,
      async (args) => {
        const agent = agents?.currentInitiator?.()
        const result = await tools.execute({
          callId: callId(),
          name,
          arguments: args ?? {},
          ...(agent === undefined ? {} : { agent }),
          signal: new AbortController().signal,
        })
        return toMcpResult(result)
      },
    ))
    bridged.push(name)
  }
  if (definitions.length === 0) return undefined
  return {
    server: createSdkMcpServer({ name: 'dsh', version: '1.0.0', tools: definitions }),
    allowed: bridged.map((name) => `${BRIDGE_PREFIX}${name}`),
    names: bridged,
  }
}

/**
 * Decide which native tools to switch off, and where their names should route.
 *
 * `existingDisallowed` is threaded through rather than assumed empty:
 * `buildUserInteractionOptions` already returns a `disallowedTools` array when
 * AskUserQuestion is off, and object spread would silently drop it if this
 * function returned a fresh array of its own. Merging here keeps both.
 *
 * Returns `{}` — not a half-applied override — when nothing bridged, so a
 * failed bridge leaves the SDK options exactly as they were before v27.
 */
/**
 * The native tools the routing note may still point at.
 *
 * A tool this build switched off must drop out of that list: telling the inner
 * agent to "use your native Bash" right after removing Bash sends it after a
 * tool that is no longer in its context.
 */
function nativeEquivalents(bridgedNames = []) {
  const gone = new Set(
    Object.entries(REPLACED_NATIVE_TOOLS)
      .filter(([, dshName]) => bridgedNames.includes(dshName))
      .map(([nativeName]) => nativeName),
  )
  const remaining = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch']
    .filter((name) => !gone.has(name))
  return `${remaining.join(', ')}, …`
}

export function buildNativeToolOverride(bridgedNames = [], existingDisallowed = []) {
  const replaced = Object.entries(REPLACED_NATIVE_TOOLS)
    .filter(([, dshName]) => bridgedNames.includes(dshName))
  if (replaced.length === 0) {
    return existingDisallowed.length > 0 ? { disallowedTools: [...existingDisallowed] } : {}
  }
  const disallowedTools = [...existingDisallowed]
  const toolAliases = {}
  for (const [nativeName, dshName] of replaced) {
    if (!disallowedTools.includes(nativeName)) disallowedTools.push(nativeName)
    toolAliases[nativeName] = `${BRIDGE_PREFIX}${dshName}`
  }
  return { disallowedTools, toolAliases }
}

export function buildSystemAppend(options, tools, bridged = []) {
  const sections = []
  const system = typeof options?.system === 'string' ? stripAbsentToolGuidance(options.system.trim(), bridged) : ''
  if (system.length > 0) sections.push(system)
  const names = (tools ?? [])
    .map((tool) => tool?.name)
    .filter((name) => typeof name === 'string' && name.length > 0 && !bridged.includes(name))
  if (names.length > 0) {
    sections.push(
      'Tool routing note: this conversation runs through the Claude Agent SDK, which owns the tool loop with your native Claude Code tools. '
        + `The harness tool catalog (${names.join(', ')}) is NOT callable from here — any instruction above or below telling you to call those tools `
        + `applies instead to your native Claude Code equivalents (${nativeEquivalents(bridged)}) under their own names. `
        + 'Do not emit harness-style tool-call blocks; use native tools directly.',
    )
  }
  // The bridged tools ARE callable, but the SDK serves them under an
  // MCP-qualified name. Surrounding prose (DSH's own system text, AGENTS.md,
  // the user's messages) calls them by their bare DSH names, so the mapping
  // has to be stated or the inner agent looks for a tool that is right there
  // under a different label.
  if (bridged.length > 0) {
    sections.push(
      `Harness tools available here: ${bridged.map((name) => `${name} (call it as ${BRIDGE_PREFIX}${name})`).join(', ')}. `
        + 'These reach the real DSH implementation, including its permission and approval checks. '
        + 'Any instruction that names them by their bare name refers to these.',
    )
  }
  return sections.join('\n\n')
}

export function apply(ctx, rawConfig = {}) {
  let current = () => rawConfig
  const config = () => {
    const merged = { ...DEFAULTS, ...current() }
    return {
      ...merged,
      permissionMode: resolvePermissionMode(merged.permissionMode),
      // Degrade AFTER normalising: `card` is an explicit opt-in, and an
      // unpatched DSH would crash its trajectory panel on the custom block.
      toolActivityDisplay: degradeToolActivityDisplay(
        resolveToolActivityDisplay(merged.toolActivityDisplay),
        ctx.logger,
      ),
    }
  }
  const logger = ctx.logger
  // Per-DSH-session native-resume tracking: dsh session key →
  // { claudeSessionId, lastFedMessageId }. In-memory only — a host restart
  // simply falls back to one full-replay turn and re-seeds the entry.
  const resumeState = new Map()
  const userQuestions = ctx.get('userQuestions')
  const agents = ctx.get('agents')
  const askUserQuestion = (input, sdkOptions) => askUserQuestionThroughDsh(input, {
    userQuestions,
    agent: agents?.currentInitiator?.(),
    signal: sdkOptions?.signal,
  })
  const askUserQuestionHook = createAskUserQuestionHook(askUserQuestion)
  // zod resolves in the profile's dependency tree but not in this repo's
  // checkout, and the SDK's tool() accepts no other parameter form. Loading it
  // lazily keeps the offline self-check able to import this module: a missing
  // zod disables the DSH tool bridge and changes nothing else.
  let zodPromise
  const loadZod = () => {
    if (zodPromise === undefined) {
      zodPromise = import('zod')
        .then((module) => module.z ?? module.default?.z ?? module.default)
        .catch((error) => {
          logger?.warn?.('llm-claude-code: zod unavailable, DSH tool bridge disabled: %o', error)
          return undefined
        })
    }
    return zodPromise
  }
  const planModeService = ctx.get('planMode')
  const permissionPresets = ctx.get('permissionPresets')
  // Read the two DSH-side restrictions for the agent driving this request.
  // Both services are optional (a composition may omit either), and both reads
  // are contained: a throwing projection must not fail the whole request, it
  // just means no tightening for this turn.
  const readDshRestrictions = () => {
    const agent = agents?.currentInitiator?.()
    if (agent === undefined) return undefined
    let planMode
    try {
      const state = planModeService?.get(agent)
      // A pending selection counts as active: it is the user's latest intent
      // and treating it as on is the tightening direction.
      planMode = state?.active === true || state?.pending === true
    } catch (error) {
      logger?.warn?.('llm-claude-code: could not read plan mode: %o', error)
    }
    let permissionPreset
    try {
      permissionPreset = permissionPresets?.current?.(agent.session)
    } catch (error) {
      logger?.warn?.('llm-claude-code: could not read permission preset: %o', error)
    }
    return { planMode, permissionPreset }
  }

  const canUseTool = (toolName, input, sdkOptions) => (
    toolName === 'AskUserQuestion'
      ? askUserQuestion(input, sdkOptions)
      : { behavior: 'allow' }
  )

  // Echo tools (v16): side-effect-free cards for completed inner tool runs.
  // Executing one just concludes the turn (no follow-up LLM request) and the
  // declared render replays the embedded output into the card's Output
  // section. Registration is collision-guarded with ctx.tools.get(): a name
  // that is already taken is NEVER registered — and its chunks are never
  // emitted (echoNameOf returns null) — so a real harness tool can never be
  // shadowed into executing a command twice. Only the exact names below are
  // ever emitted; unknown inner tools map to the generic claude_tool echo.
  const echoDescriptionOf = (name) => (
    `Internal display-only echo of one Claude Code inner tool run on the claude-code-main route. `
      + `Registered under "${name}" only so the transcript can draw a native collapsible card. `
      + `Calling it has NO effect — never call this tool.`
  )
  const ECHO_PARAMETER_DESCRIPTIONS = {
    description: 'Short human summary of the run, when the native call carried one.',
    command: 'The native command (bash variant summary).',
    file_path: 'The native file path (read/edit/write variants).',
    pattern: 'The native search pattern (glob/grep variants).',
    query: 'The native search query (web_search variant).',
    url: 'The native URL (web_fetch variant).',
    ccTool: 'Real Claude Code tool name, e.g. Bash.',
    output: 'The native tool output (display-clamped).',
    isError: 'Whether the native run failed.',
  }
  const defineEchoTool = (name) => defineTool({
    name,
    description: echoDescriptionOf(name),
    parameters: {
      description: { type: 'string', description: ECHO_PARAMETER_DESCRIPTIONS.description },
      command: { type: 'string', description: ECHO_PARAMETER_DESCRIPTIONS.command },
      file_path: { type: 'string', description: ECHO_PARAMETER_DESCRIPTIONS.file_path },
      pattern: { type: 'string', description: ECHO_PARAMETER_DESCRIPTIONS.pattern },
      query: { type: 'string', description: ECHO_PARAMETER_DESCRIPTIONS.query },
      url: { type: 'string', description: ECHO_PARAMETER_DESCRIPTIONS.url },
      [ECHO_MARKER]: { type: 'boolean', required: true, description: 'Internal display-echo marker.' },
      ccTool: { type: 'string', description: ECHO_PARAMETER_DESCRIPTIONS.ccTool },
      output: { type: 'string', required: true, description: ECHO_PARAMETER_DESCRIPTIONS.output },
      isError: { type: 'boolean', description: ECHO_PARAMETER_DESCRIPTIONS.isError },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } },
      render: (args) => [{ type: 'text', text: typeof args?.output === 'string' ? args.output : '' }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 5000,
    async execute(args, exec) {
      exec.concludeTurn()
      return { recorded: true }
    },
  })
  const ownedEchoNames = new Set()
  for (const name of new Set([...Object.values(ECHO_VARIANTS), ECHO_FALLBACK])) {
    if (ctx.tools.get(name) !== undefined) continue
    try {
      ctx.tools.register(defineEchoTool(name))
      ownedEchoNames.add(name)
    } catch (error) {
      logger.warn(`llm-claude-code: echo tool "${name}" unavailable (${error?.message ?? error})`)
    }
  }
  // Null means "no echo card for this run" — translateSdkMessages falls back
  // to a reasoning fold for that run, so the run is still visible.
  const echoNameOf = (ccName) => {
    const preferred = ECHO_VARIANTS[ccName]
    if (typeof preferred === 'string' && ownedEchoNames.has(preferred)) return preferred
    return ownedEchoNames.has(ECHO_FALLBACK) ? ECHO_FALLBACK : null
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: config().providerName }
    },
    providerRetryPolicy() {
      return undefined
    },
    async listModels(provider) {
      return MODELS.map((item) => ({
        provider,
        id: item.id,
        name: item.name,
        description: item.description,
        inputModalities: ['text', 'image'],
      }))
    },
    async resolveModel(provider, model) {
      return modelInfo(provider, model, config().contextWindow)
    },
    async prepareCall(provider, model, signal) {
      return {
        model: await this.resolveModel(provider, model, signal),
        stream: (options) => this.stream(options),
      }
    },
    async *stream(options) {
      if (options.signal?.aborted) throw new LlmError('llm-claude-code: request aborted', 'ABORTED')

      const resolved = config()
      const sessionKey = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : 'default'
      const plan = resolved.nativeResume
        ? planReplay(options.messages, resumeState.get(sessionKey), 'claude-code-main')
        : { mode: 'full' }
      let forceFull = plan.mode !== 'resume'
      // Resume resolves the CC session file under the project slug derived from
      // cwd, so a later /compact must reuse the SAME cwd or the session is
      // unfindable. Captured here and stored alongside the session id.
      const workspace = resolveWorkspace(options, resolved.workspace)

      const executable = typeof resolved.binary === 'string' && resolved.binary.length > 0
        ? resolved.binary
        : await ctx.subprocess.resolveExecutable('claude', {}, options.signal)
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const effort = options.reasoningEffort === undefined ? 'high' : String(options.reasoningEffort)
      // DSH plan mode / read-only preset must reach the SDK as a real
      // permission mode, not just as prose in the system prompt.
      const effectivePermissionMode = resolveEffectivePermissionMode(resolved.permissionMode, readDshRestrictions())
      // v26: hand the inner agent the DSH tools it has no counterpart for.
      // Rebuilt per turn because the goal tools reject any execution whose
      // agent is not the live initiator of the current turn. Built BEFORE the
      // system append so the prompt can describe what actually got bridged.
      //
      // v29: llm-claude-code.dshTools gates the whole thing. Left nullish, the
      // four downstream call sites each fall back to their v25 branch, so this
      // one line is the entire rollback. The ternary also skips loadZod(), so a
      // deliberately disabled bridge neither imports zod nor logs the
      // "zod unavailable" warning that a genuine failure should still produce.
      const bridge = resolved.dshTools
        ? buildDshToolBridge({
            createSdkMcpServer,
            tool,
            z: await loadZod(),
            tools: ctx.tools,
            agents,
            callId: () => ToolCallId(`claude-code-bridge-${randomUUID()}`),
            logger,
          })
        : undefined
      const append = buildSystemAppend(options, options.tools, bridge?.names ?? [])
      const interaction = buildUserInteractionOptions(resolved.askUserQuestion, askUserQuestionHook)
      const nativeOverride = buildNativeToolOverride(bridge?.names ?? [], interaction.disallowedTools ?? [])
      // Spawn the CLI through node directly (detached, like the dsh subprocess
      // service) and record the true spawn error: the SDK's default path wraps
      // any failure in a generic libc-mismatch message that hides the real
      // errno (here: ENOENT from a nonexistent cwd — see resolveWorkspace).
      const runQuery = (sdkPrompt, resumeOptions) => {
        let spawnFailure = null
        const spawnClaude = (spec) => {
          const child = spawn(spec.command, spec.args, {
            cwd: spec.cwd,
            env: spec.env,
            signal: spec.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
          })
          child.on('error', (error) => {
            spawnFailure = `${error?.code ?? 'ERR'} ${error?.syscall ?? ''} ${error?.message ?? ''}`
          })
          return child
        }
        const sdkQuery = query({
          prompt: sdkPrompt,
          options: {
            spawnClaudeCodeProcess: spawnClaude,
            abortController: controller,
            cwd: workspace,
            pathToClaudeCodeExecutable: executable,
            model: options.model,
            effort,
            // v17: run the inner agent without permission prompts or sandbox
            // escalations it could never see headless (default
            // bypassPermissions; configurable via llm-claude-code.permissionMode).
            ...buildPermissionOptions(effectivePermissionMode),
            // canUseTool is retained alongside the hook because the SDK uses
            // its presence to expose AskUserQuestion in headless mode. Under
            // bypass it may be shadowed for ordinary tools (expected warning),
            // but PreToolUse remains the authoritative gate for this one
            // interaction tool. The hook routes it to the native DSH card.
            ...(resolved.askUserQuestion ? { canUseTool } : {}),
            // Resume needs the session file on disk; force persistence while
            // nativeResume is enabled regardless of the legacy default.
            persistSession: resolved.nativeResume || resolved.persistSession,
            ...interaction,
            // v27: once DSH's bash is bridged, switch off the native one and
            // route its name to the bridge. Merges the disallowedTools that
            // `interaction` may already carry — see buildNativeToolOverride.
            ...nativeOverride,
            includePartialMessages: resolved.partialMessages,
            ...(resolved.showThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
            ...(append.length > 0 ? {
              systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append,
              },
            } : {}),
            ...(bridge === undefined ? {} : {
              mcpServers: { dsh: bridge.server },
              // allowedTools is the auto-approve list, not a whitelist: naming
              // the bridged tools here keeps them from prompting under a
              // permission mode that would otherwise ask, and leaves every
              // native tool exactly as available as before.
              allowedTools: bridge.allowed,
            }),
            ...resumeOptions,
          },
        })
        return { sdkQuery, spawnFailureOf: () => spawnFailure }
      }

      // One attempt = build the prompt for the current mode (delta-only when
      // resuming, full history otherwise) and stream it. A vanished CC session
      // flips to full replay and retries once.
      let resuming = !forceFull
      while (true) {
        const replayMessages = resuming ? plan.delta : options.messages
        const imageRefs = collectImageRefs(replayMessages)
        const attachments = imageRefs.length > 0 ? ctx.get('attachments') : undefined
        if (imageRefs.length > 0 && attachments === undefined) {
          throw new LlmError('llm-claude-code: image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
        }
        const images = imageRefs.length > 0
          ? await prepareImageBlocks(imageRefs, attachments, { maxPixels: resolved.imageMaxPixels, maxBytes: resolved.imageMaxBytes }, options.signal)
          : new Map()
        let prompt
        if (resuming) {
          prompt = plan.delta
            .map((message) => (message.content ?? []).map((block) => blockText(block, images)).filter((text) => text.length > 0).join('\n'))
            .filter((text) => text.length > 0)
            .join('\n\n')
        } else {
          prompt = serializeConversation(options.messages, images)
        }
        if (prompt.trim().length === 0 && images.size === 0) throw new LlmError('llm-claude-code: request carried no usable text', 'INVALID_REQUEST')
        const sdkPrompt = buildSdkPrompt(prompt, [...images.values()].map((item) => item.block))
        const { sdkQuery, spawnFailureOf } = runQuery(sdkPrompt, resuming ? { resume: plan.resumeId, forkSession: true } : {})
        try {
          yield* translateSdkMessages(sdkQuery, {
            showToolActivity: resolved.showToolActivity,
            toolActivityDisplay: resolveToolActivityDisplay(resolved.toolActivityDisplay),
            toolResultDisplayChars: resolved.toolResultDisplayChars,
            echoNameOf,
            onResult: (result) => {
              if (typeof result?.session_id !== 'string' || result.session_id.length === 0) return
              if (resuming) {
                // forkSession writes each resumed turn to a NEW session id.
                resumeState.set(sessionKey, { claudeSessionId: result.session_id, lastFedMessageId: plan.lastFedMessageId, cwd: workspace })
              } else {
                // The watermark must be the last REAL user message: an
                // echo-result user message was never fed to Claude Code.
                const echoIds = collectEchoCallIds(options.messages)
                const lastUser = [...(options.messages ?? [])].reverse()
                  .find((message) => message?.role === 'user' && !isEchoOnlyUserMessage(message, echoIds))
                if (lastUser?.id !== undefined) resumeState.set(sessionKey, { claudeSessionId: result.session_id, lastFedMessageId: lastUser.id, cwd: workspace })
              }
            },
          })
          return
        } catch (error) {
          const message = error instanceof LlmError ? error.message : String(error?.message ?? error)
          // A resumed session may have been garbage-collected by Claude Code
          // itself; retry once as a full replay before surfacing the failure.
          if (resuming && /session|resume|conversation/i.test(message)) {
            sdkQuery.close()
            resumeState.delete(sessionKey)
            resuming = false
            continue
          }
          if (error instanceof LlmError) throw error
          const detail = spawnFailureOf() !== null ? ` [claude spawn: ${spawnFailureOf()}]` : ''
          throw new LlmError(`llm-claude-code: ${error?.message ?? error}${detail}`, error?.code === 'MAX_TOKENS' ? 'MAX_TOKENS' : 'PROVIDER_ERROR')
        } finally {
          options.signal?.removeEventListener('abort', onAbort)
          sdkQuery.close()
        }
      }
    },
  }

  // ── v23: /compact targets the INNER Claude Code session ────────────────
  //
  // DSH's own compaction rewrites DSH history: it shadows a span of surface
  // messages and inserts one summary checkpoint. Under nativeResume that is
  // the wrong lever — the live context lives in the inner Claude Code session,
  // which DSH never sees. Compacting THERE is what actually frees tokens, and
  // it leaves DSH history untouched (the transcript you scroll stays whole).
  //
  // Every resumed turn forks to a new inner session id, so the compacted fork
  // id is written back while lastFedMessageId is preserved verbatim: DSH
  // history did not change, so the watermark still matches and the next
  // planReplay() keeps resuming instead of replaying everything (which would
  // undo the compaction).
  //
  // Command output is appended as command/run + command/done EVENTS, and only
  // user/message + assistant/message project into the surface, so running this
  // cannot itself break the resume chain.
  const compactInnerSession = async (sessionKey, signal) => {
    const stored = resumeState.get(sessionKey)
    if (stored === undefined || typeof stored.claudeSessionId !== 'string' || stored.claudeSessionId.length === 0) {
      return { kind: 'absent' }
    }
    const resolved = config()
    const executable = typeof resolved.binary === 'string' && resolved.binary.length > 0
      ? resolved.binary
      : await ctx.subprocess.resolveExecutable('claude', {}, signal)
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const sdkQuery = query({
      prompt: '/compact',
      options: {
        spawnClaudeCodeProcess: (spec) => spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          signal: spec.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        }),
        abortController: controller,
        cwd: typeof stored.cwd === 'string' && stored.cwd.length > 0 ? stored.cwd : resolveWorkspace({}, resolved.workspace),
        pathToClaudeCodeExecutable: executable,
        ...buildPermissionOptions(resolved.permissionMode),
        // resume needs the session file on disk regardless of the config default.
        persistSession: true,
        resume: stored.claudeSessionId,
        forkSession: true,
      },
    })
    try {
      let boundary
      let forked
      let text = ''
      for await (const message of sdkQuery) {
        if (message?.type === 'system' && message.subtype === 'compact_boundary') {
          boundary = message.compact_metadata
        } else if (message?.type === 'result') {
          if (typeof message.session_id === 'string' && message.session_id.length > 0) forked = message.session_id
          if (typeof message.result === 'string') text = message.result
        }
      }
      // Repoint even when nothing was compacted: the fork carries the same
      // conversation, and the watermark is unchanged either way.
      if (forked !== undefined) resumeState.set(sessionKey, { ...stored, claudeSessionId: forked })
      if (boundary === undefined) return { kind: 'skipped', text: text.trim() }
      return { kind: 'done', before: boundary.pre_tokens, after: boundary.post_tokens }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      sdkQuery.close()
    }
  }

  // Verbatim copies of dsh-command-compact's outcome copy, so every non
  // claude-code route keeps the exact wording it had before this replaced it.
  const DSH_COMPACT_ERRORS = {
    busy: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
    cancelled: 'Compaction cancelled.',
    changed: 'The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.',
    summary: 'Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.',
    commit: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
    persistence: 'Compaction finished, but the session could not be saved.',
  }

  /** Forward one /compact to DSH's own engine, preserving its result copy. */
  const compactThroughDsh = async (invocation) => {
    const engine = ctx.get('compaction')
    if (engine === undefined) {
      return { kind: 'error', text: 'Compaction is unavailable: no compaction engine is loaded.' }
    }
    try {
      const result = await engine.compactNow(invocation.agent, invocation.signal, invocation.commandId)
      if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
      return {
        kind: 'success',
        text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
        ...(result.summarySeq === undefined ? {} : { sourceEventSeq: result.summarySeq }),
      }
    } catch (error) {
      if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
      // Matched by name instead of instanceof: importing dsh-compaction just
      // for the error class would add a dependency this plugin does not need.
      if (error?.name === 'ManualCompactionError') {
        return { kind: 'error', text: DSH_COMPACT_ERRORS[error.code] ?? `Compaction failed: ${error.message}` }
      }
      throw error
    }
  }

  /**
   * `/compact`, routed by provider. This registration REPLACES
   * dsh-command-compact — registering the same name twice throws, so that
   * plugin must be removed from the composition (see INSTALL.md).
   */
  const compactHandler = async (invocation) => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: 'Usage: /compact (no arguments)' }
    if (invocation.agent?.options?.provider !== 'claude-code-main') return compactThroughDsh(invocation)
    if (!config().nativeResume) {
      return {
        kind: 'error',
        text: 'Inner compaction needs llm-claude-code.nativeResume enabled: without it every turn replays DSH history into a fresh Claude Code session, so a compacted inner context would be discarded immediately.',
      }
    }
    const id = invocation.agent?.session?.id
    const sessionKey = typeof id === 'string' && id.length > 0 ? id : 'default'
    const outcome = await compactInnerSession(sessionKey, invocation.signal)
    if (outcome.kind === 'absent') {
      return { kind: 'success', text: 'No inner Claude Code session to compact yet — send one message on this route first.' }
    }
    if (outcome.kind === 'skipped') {
      return { kind: 'success', text: outcome.text.length > 0 ? `Claude Code did not compact: ${outcome.text}` : 'Claude Code reported nothing to compact.' }
    }
    const after = typeof outcome.after === 'number' ? outcome.after : undefined
    const saved = after === undefined ? undefined : outcome.before - after
    const detail = after === undefined
      ? `${outcome.before.toLocaleString('en-US')} tokens summarized`
      : `${outcome.before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} tokens (freed ~${saved.toLocaleString('en-US')})`
    return { kind: 'success', text: `Compacted the Claude Code context: ${detail}. DSH history is unchanged.` }
  }

  // ── v24: /goal routes to the INNER Claude Code session ─────────────────
  //
  // DSH's goal domain drives rounds from the OUTSIDE: after each turn the
  // round driver sends a "keep going" followup until the model calls
  // `update_goal` to report completion. But `update_goal` is a DSH tool, and
  // buildSystemAppend explicitly tells the inner agent that harness tools are
  // not callable — so the inner agent can finish the work and still have no
  // way to say so. The goal then burns every round up to maxGoalRounds.
  //
  // Claude Code has its own /goal (verified present in supportedCommands and
  // working headless). Forwarding to it is the same move v23 made for
  // /compact.
  //
  // It is forwarded as an ordinary INJECTED USER MESSAGE, not executed inside
  // the command handler, because the inner /goal really works: it loops and
  // calls tools for as long as the objective needs. Running that inside a
  // command would freeze the UI and then dump one summary line — every tool
  // card, thought and partial reply would be invisible. `agent.followup()`
  // wakes a normal turn instead, so the whole run streams natively.
  //
  // This relies on nativeResume: in resume mode the delta is passed to the SDK
  // as VERBATIM text, so a leading slash command is recognized. A full replay
  // goes through serializeConversation, which wraps history in role markers —
  // the slash command would land mid-transcript and read as prose.
  //
  // Non claude-code routes reuse DSH's OWN handler, captured below, so their
  // behaviour, copy and input hint stay byte-identical instead of reimplemented.
  // Capture DSH's real /goal definition by running its apply() against a shim
  // whose `goals` proxies to the live service. Reusing the original handler
  // keeps every non-claude route byte-identical instead of reimplemented here.
  let dshGoalDefinition
  let dshGoalCaptureAttempted = false
  const captureDshGoal = async () => {
    if (dshGoalDefinition !== undefined || dshGoalCaptureAttempted) return dshGoalDefinition
    dshGoalCaptureAttempted = true
    const module = await dshGoalModule
    if (module?.apply === undefined) {
      logger.warn('llm-claude-code: dsh-command-goal unavailable; /goal on non-claude routes will report it unavailable')
      return undefined
    }
    try {
      module.apply({
        get goals() {
          return ctx.get('goals')
        },
        commands: {
          register: (definition) => {
            dshGoalDefinition = definition
            return () => {}
          },
        },
      })
    } catch (error) {
      logger.warn('llm-claude-code: could not capture DSH /goal handler: %o', error)
    }
    return dshGoalDefinition
  }

  const goalHandler = async (invocation) => {
    if (invocation.agent?.options?.provider !== 'claude-code-main') {
      const definition = await captureDshGoal()
      if (definition === undefined) {
        return { kind: 'error', text: 'The goal command is unavailable: DSH\'s own goal handler could not be loaded.' }
      }
      return definition.handler(invocation)
    }
    if (!config().nativeResume) {
      return {
        kind: 'error',
        text: 'Forwarding /goal needs llm-claude-code.nativeResume enabled: only a resumed turn passes your text to Claude Code verbatim, which is what makes a slash command register.',
      }
    }
    if (invocation.attachments.length > 0) {
      return {
        kind: 'error',
        text: 'On the Claude Code route /goal cannot carry image attachments yet — the slash command has to be the first thing in the forwarded message. Send the images as a normal message first, then set the goal.',
      }
    }
    const id = invocation.agent?.session?.id
    const sessionKey = typeof id === 'string' && id.length > 0 ? id : 'default'
    if (resumeState.get(sessionKey) === undefined) {
      return {
        kind: 'error',
        text: 'No inner Claude Code session yet, so /goal would be replayed as plain text instead of running. Send one ordinary message on this route first.',
      }
    }
    const raw = invocation.rawInput.trim()
    invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text: raw.length === 0 ? '/goal' : `/goal ${raw}` }],
      source: { kind: 'user' },
    }))
    return {
      kind: 'success',
      text: raw.length === 0
        ? 'Asked Claude Code to show its own goal state; the reply streams as a normal turn.'
        : 'Handed the objective to Claude Code\'s own goal mechanism. It runs as a normal turn, so its tool calls and replies stream as usual. DSH\'s goal panel stays empty by design — the goal lives inside Claude Code.',
    }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'compact',
      description: 'Compact older conversation history',
      handler: compactHandler,
    })
    yield ctx.commands.register({
      name: 'goal',
      description: 'set or view the goal for a long-running task',
      input: DSH_GOAL_INPUT,
      handler: goalHandler,
    })
  }, 'llm-claude-code /compact + /goal lifecycle')

  ctx.llm.registerConfigurableProviders([
    { provider: 'claude-code-main', displayName: config().providerName, settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter(['claude-code-main'], adapter)
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, rawConfig, {
      setSource: (source) => { current = source },
      onChange: () => {},
    })
  })
  logger.info('provider "claude-code-main" registered — Claude Agent SDK owns the native coding-agent loop')
}
