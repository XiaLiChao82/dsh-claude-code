// llm-claude-code — Claude Code as a selectable DSH primary route.
//
// Claude Agent SDK owns the inner coding-agent/tool loop. DSH owns the outer
// session, model picker, cancellation, transcript, and effort selection. Native
// Claude tool calls are intentionally not re-emitted as DSH tool calls: doing so
// would execute them twice. DSH tool schemas arriving in `options.tools` are
// acknowledged with an explicit bridge note (see buildSystemAppend) instead of
// being silently dropped on the floor.
//
// v43 deletes the `native` display mode and everything that existed only to
// serve it: the two DSH-source probes, degradeToolActivityDisplay, the
// tool-activity block builder/emitter, and the `<tool-activity>` replay branch.
// The mode shipped a `tool-activity` content kind DSH does not know, so it
// needed a patch inside the DSH install to render and a persistence allowlist
// entry to survive a reload — both of which an upgrade silently reverts. That
// patch no longer applies at all (its target function `toolActivitySummary` is
// gone from DSH 0.1.5-rc.1), so the double probe had been resolving `native`
// down to `fold` for some time: the mode was already dead, just not buried.
// v41's client plugin reaches the same goal through official extension points
// only — `session.append` for the card, a keyed `tool.call.toolview` to hide
// the driver — so nothing here touches DSH source any more. Verified before
// deleting: 232 session logs, zero containing a `tool-activity` block, i.e.
// the repair script had nothing left to repair. DEFAULTS now say `interleave`;
// anyone who never set the key was silently getting `fold`.
//
// v42 strips the ECHO_DRIVER block down to what a step cut actually needs.
// v41 split card-drawing from step-driving but only moved the DRAWING; the
// driver's payload stayed v16-shaped, so every hidden block still shipped a
// full copy of the native call — 1179 bytes average over one real session, 18
// of 34 carrying a verbatim shell command. Two costs, the second the reason it
// is worth a version: a reader of the log sees `ClaudeCodeActivity` holding a
// bash command and reasonably asks which of the two is real; and `output` plus
// the marker being schema-`required` made a fully-populated driver a block that
// WOULD pass a real tool's validation, i.e. exactly the shape that let v37's
// echoes run a second time. See buildDriverArguments for what stays and why.
//
// v41 gives `interleave` its rich cards back, which v40 had to spend to buy
// correctness. The two requirements look contradictory and are not:
//   - The visible card must carry a LOWERCASE name — that is the key DSH's
//     `tool.call.toolview` matches on to draw BashRow / FileMutationRow /
//     ReadFamilyRow. (Those rich rows are keyed toolviews, NOT TOOL_VARIANTS
//     entries; TOOL_VARIANTS only picks the look of GenericToolCard, the
//     fallback. Verified in the DOM: the rich row renders `data-sample="bash"`,
//     which only bash-sample.tsx writes.)
//   - The block that CUTS THE STEP must carry a name DSH does not own, or we
//     are back in the v37→v39 swamp.
// So they are split across two blocks. The card is appended by the live sink
// under the lowercase name (append never reaches the executor, so the name is
// free — this is the same reason `live` was always safe). The echo block keeps
// a name DSH cannot collide with and renders as nothing.
//
// That echo is now ONE dedicated name, ECHO_DRIVER, not nine per-tool ones.
// Nine capitalized keys would also have swallowed v40-era history, whose cards
// ARE those capitalized echoes: a keyed hit REPLACES the generic row and
// `ToolCallTree`'s fallback only fires when NO key matches, so registering
// `Bash` would blank every v40 `Bash` card ever recorded. One private name
// cannot alias anything that already exists.
//
// Hiding it needs a client shape (first one for this plugin — see ./client):
// a keyed toolview on ECHO_DRIVER returning a bare marker, plus one injected
// rule keyed off DSH's stable `data-chat-flow-kind` / marker attributes.
// `display:none` is required, not `:empty` — the seat still contains
// ToolCallTree's `.callRow` element, so DSH's own `.flowItem:empty` rule never
// matches. If that rule ever stops matching, the failure is a stray 16px gap,
// never a broken card.
//
// v40 renames the echoes out of DSH's namespace, which ends the whole family.
// v37→v39 were three fixes for three faces of ONE decision: echoing under the
// DSH tool name that draws the prettiest card. Each face got guarded, none got
// removed —
//   · v38 guards the agent plane (real tool shadows echo → ToolArgsError on
//     write/edit, silent double execution on bash/read/glob/grep);
//   · v39 guards the global plane (host-level tool-fs applies later → throws →
//     boot dies).
// Both guards work by DEGRADING, so on a preset deployment every card lost its
// identity to `claude_tool` anyway. Paying that price and still carrying two
// guards is the worst of both.
//
// The echo now takes the INNER tool's name instead: `Bash`, not `bash`. DSH's
// names are lowercase and register() enforces no charset (core/tools/src/index.ts
// reserves only RUN_CODE_NAME), so the capitalised set collides with nothing in
// any layer. No shadowing, so v38's guard stops firing and cards keep their
// names. No duplicate insert, so v39's crash cannot happen. `interleave` works
// as designed, with the card titled after the tool that actually ran.
//
// Cost, and it is real: the client keys a card's variant off the call name with
// an exact case-sensitive lookup (dsh-client-ui-tool tool-call-model.ts:41,87),
// so these land on the generic `others` row rather than the terminal/read/
// search rows. Not a regression — v38's degradation already put them on that
// same row under the name `claude_tool`. Rich rows are a client-side job (the
// keyed `tool.call.toolview` slot), deliberately not attempted from the host.
//
// v39 stops taking native tool names the configured mode will never use.
// Found while building an end-to-end rig on a profile whose host-level tool-fs
// is ENABLED (the stock `headless` one): DSH did not start at all.
//
//     Error: tool "read" is already registered
//       (for a per-agent variant, register through that agent's `agent.ctx`)
//         at applyReadTool (dsh-tool-fs/lib/index.js:331)
//
//   - The echo registration's `ctx.tools.get(name)` pre-check only sees plugins
//     that have ALREADY applied. cordis settles siblings with Promise.allSettled,
//     so a tool-fs that applies LATER finds our name sitting there and throws out
//     of its own apply. The try/catch around our register() cannot catch that —
//     the throw is on tool-fs's side — and the whole boot dies with it.
//   - The web profile hides this because @deepseek-ai/dsh-web-app disables the
//     host-level tool-fs/tool-bash/tool-fs-search rows (presets remount them on
//     the agent plane, which is the same fact v38 is about). Any composition
//     that keeps them enabled will not boot with this plugin mounted.
//   - v39 gated registration on the display mode, reasoning that only `card`
//     and `interleave` need to own a name. v40 DELETED that gate: it could not
//     read the mode at apply time (settings have not loaded; it saw DEFAULTS
//     'native', watched it degrade for want of the UI patch, and registered
//     nothing — leaving `interleave` with no echoes to emit), and the rename
//     made it pointless anyway. See the registration site.
//   - Verified end to end on 2026-09-15 (probes/e2e-scope.patch.yml then a real
//     run): agent scope shows the REAL write/edit/read, the inner session writes
//     and edits for real, and all four cards land as `cc-live-*` tool/call +
//     tool/result pairs — native names, full arguments, zero ToolArgsError, and
//     exactly one execution each.
//
// v38 CORRECTS v37's diagnosis and actually fixes it. v37 got the shape of the
// fix right (re-check ownership at emit time, degrade to claude_tool) and the
// LOOKUP wrong, so its guard could never fire even once:
//   - v37 blamed load order — "the echo registers `write` first, tool-fs
//     replaces it later". That cannot happen. NamedEntries.insert THROWS on a
//     duplicate within one table (core/scope/src/store.ts:43), and nothing
//     replaces anything. There are simply TWO tables.
//   - The real cause is SCOPE. This plugin mounts in the host composition, so
//     its echoes land in the GLOBAL layer. A preset-based deployment mounts
//     tool-fs / tool-bash on the AGENT plane (presets/*/agent.cordis.yml), so
//     the real read/write/edit/bash land in that agent's OWN layer. Both live
//     on happily; ToolRuntime.view() then writes the scope's own layer LAST
//     and it shadows the inherited global entry (core/tools/src/index.ts:1168).
//   - So `ctx.tools.get(name)` — no scope, i.e. the GLOBAL view (index.ts:1194)
//     — keeps answering "yes, still the echo" forever, while execution resolves
//     through `resolveExecution(name, exec.agent, …)` (index.ts:1536) and gets
//     the REAL tool. defineTool's wrapper then validates the card-only payload
//     against that tool's schema and throws ToolArgsError (schema.ts:585-588).
//   - The second half v37 missed: this is NOT only a write/edit problem.
//     parameterSchemaSpecToJsonSchema never sets additionalProperties:false
//     (schema.ts:449-457), so the extra marker keys are accepted and a payload
//     that happens to cover the required set EXECUTES FOR REAL. read/bash/glob/
//     grep were not "spared" — they silently ran a second time, per card. Only
//     write/edit were loud, and only because validation stopped them.
//   - Fix: judge ownership against THIS REQUEST's declared tools instead of the
//     global registry view. `options.tools` is projected for the calling scope
//     (systemPrompt.tools -> wireSchemas(context.scope), index.ts:825; carried
//     to the adapter by agent-loop/src/agent.ts:379,610-613), and wireSchemas
//     keeps the live `definition.parameters` reference, so the very same
//     echoOwnsToolName test now answers the question that actually matters:
//     "does the name this card is about to claim resolve to OUR echo for the
//     agent that will execute it?"
//   - Still explicitly NOT fixed by widening buildEchoArguments: that makes the
//     call PASS validation, which is how bash/read got their double execution.
//     probes/echo-ownership-check.mjs keeps that payload deliberately short.
//   - Structural note, deliberately left in the open: on a preset deployment
//     every native name is taken in the agent layer, so this guard degrades all
//     of them to claude_tool. `live` is the only display mode that is correct
//     by construction there — it appends tool/call + tool/result straight to
//     the session log and never enters the executor (see createLiveActivitySink).
//
// v36 adds `interleave` — real THINK → CARD → THINK → CARD, no DSH patch:
//   - CORRECTS v35's closing claim. v35 said one-step-per-run was "not fixable
//     from the plugin" because advancing the step mid-stream breaks the loop's
//     settle. The first half is right; the conclusion was not. The plugin must
//     never MOVE the step — but it can END THE STREAM, and the loop then opens
//     the next step by itself. Step boundaries stay entirely the loop's.
//   - Mechanism, all of it already present since v16: emit the echo tool-call,
//     then stop the stream while that echo is still UNEXECUTED. The loop runs
//     it (drawing a native card), and — because the echo no longer calls
//     concludeTurn — it still owes a follow-up request, so it opens a fresh
//     step and asks again. The adapter answers from the SUSPENDED generator,
//     so the follow-up costs no second Claude Code run.
//   - Why this fixes what v34 could not: each step settles its OWN assistant
//     message. v34 crammed several messages into ONE step and the client
//     replaced them all with the last. Here there is exactly one message per
//     step, so nothing overwrites anything and prose streams normally.
//   - Why v16/v20's "cards CANNOT appear earlier" was right AND escapable:
//     right about one stream (tool/call is appended in executeToolCalls, after
//     the stream ends), escapable by using MORE STREAMS. v20 measured the
//     batching and picked fold; it never tried cutting the stream short.
//   - Cost: one extra step per inner tool run, and a suspended run holds a
//     live Claude Code subprocess between steps. Four paths release it —
//     exhaustion, a non-continuation request, abort, and a 120s watchdog —
//     because the loop can stop asking without telling the adapter.
//   - Safe to hang the release on the abort listener: the loop reuses ONE
//     AbortController for every step of a turn (agent.ts replaces `phase.abort`
//     only after turn/end), so it fires on real cancellation, never between
//     two ordinary steps.
//   - `card` is unchanged: its echo still concludes the turn, so it keeps the
//     documented end-of-stream batching and never spends an extra request.
//   - Offline: probes/interleave-check.mjs (33 checks) pins the segment
//     boundary, that SEGMENT_BREAK never escapes into the DSH stream, exact
//     resumption, the ordering contract, fold-degradation NOT cutting a
//     segment, and continuation detection.
//
// v35 turns v34's prose withholding OFF — it silently ate reasoning and text:
//   - MEASURED, not reasoned: one turn of this session wrote 15 append-surface
//     `assistant/message` events, ALL of them turn=1/step=1, each carrying the
//     reasoning block that preceded a card. The transcript showed one.
//   - Cause is in the client, not here. ui-chat's assistantDefinition keys its
//     node by `${turn}:${step}` and its `update` does
//     `blocks = toAssistantBlocks(message.content)` — a REPLACE. Same-step
//     appends are read as "this one message was revised N times", so only the
//     last one renders, and the loop's own end-of-stream settle (which carries
//     just the tail) is what lands last. Everything before it disappears from
//     the view while staying in the log.
//   - Not fixable BY WITHHOLDING: the obvious fix is one step per run, but
//     core/session's invariant makes step/start fail unless `step === nextStep`
//     and the loop settles with the turn/step it captured BEFORE the stream
//     (agent.ts) — advancing the step mid-stream makes that settle fail
//     requireOpenStep and takes the whole turn down. Step boundaries are the
//     loop's to open, and step numbers cannot be handed back.
//     ⚠ v36 CORRECTS the conclusion drawn from this: the plugin cannot MOVE
//     the step, but ending the stream makes the loop open the next one on its
//     own. One step per run is reachable — see `interleave` above.
//   - So `live` returns to v33's shape: cards append in real time, prose stays
//     in the stream. Prose lands in the turn's single settled message, whose
//     seq is after every card — "all cards, then all words" is the honest
//     ordering the session model actually supports.
//
// v34 makes `live` interleave prose with its cards (SUPERSEDED by v35):
//   - v33 put the cards in the log but left the words in the stream, and the
//     loop settles a whole turn into ONE assistant message at stream end. The
//     client sorts conversation nodes by event seq, so every card landed on one
//     side of that single message: cards clumped, words clumped, never
//     "words, card, words, card".
//   - There is no fix from the stream side: StreamChunk has no message
//     boundary (block-start/deltas/block-end/usage/finish only), so an adapter
//     cannot make the loop settle mid-turn.
//   - So `live` now WITHHOLDS prose from the stream and appends each run as its
//     own `assistant/message` right before the card it introduced. DSH tolerates
//     several assistant messages inside one open step (the session invariant
//     only calls requireOpenStep).
//   - The tail — prose after the last tool run — still goes through the stream:
//     the loop settles it into the turn's assistant message, whose seq lands
//     after every card, which is exactly where it belongs.
//   - Accepted cost: withheld prose no longer streams token by token. It
//     appears one run at a time, when the run it precedes completes. Only
//     `live` with a usable sink withholds; every other mode is untouched.
//
// v33 adds `live` mode — native tool cards with NO DSH patch:
//   - The client picks a tool card off two session events alone (`tool/call`
//     and an append-surface `tool/result`); the assistant-side `tool-call`
//     block is explicitly excluded from rendering. So instead of projecting
//     activity into the STREAM (where `native` needs a UI patch, `fold`
//     degrades to reasoning rows, and `card` must wait for the loop to execute
//     an echo after the stream ends), `live` appends those two events straight
//     into the session — the same pair the agent loop itself writes.
//   - Result: real-time, correctly ordered, native-looking cards, on a stock
//     dsh install, with no custom content kind to brick persistence.
//   - The assistant `tool-call` half is NOT written: emitting one into the
//     stream would make the loop EXECUTE the call (agent.ts executeToolCalls).
//   - Constraint accepted: `tool/result` is a surface event, so DSH replays it
//     into the next request's messages. Those results carry a `cc-live-` call
//     id and are filtered out of everything fed back to Claude Code by
//     collectEchoCallIds — Claude ran these tools itself and must not be shown
//     orphan results for them.
//   - turn/step are read back off the log (findOpenStep): the session
//     invariant rejects events outside the open step, and GenerateOptions
//     carries only `sessionId`.
//
// v32 stops `native` mode from poisoning persisted sessions:
//   - dsh 0.1.5-rc.1 observes stored v0 artifacts through a strict v2→v3
//     content-kind allowlist (text/reasoning/image/file/tool-call/tool-result).
//     `tool-activity` is not on it, so EVERY session that ever rendered native
//     activity cards fails to load after the upgrade ("cannot safely transform
//     unclassified message content kind"). The append path never validated the
//     kind, so live turns looked fine while the log became unreadable.
//   - `native` now degrades to `fold` unless BOTH probes pass: the UI patch
//     (rendering) AND persistence admission (migration/persistence
//     CONTENT_KINDS accepting `tool-activity`). On a stock dsh ≥0.1.5 install
//     native therefore always degrades.
//   - `card` mode's own degrade was vestigial (it emits standard `tool-call`
//     echo blocks — persistence- and UI-safe) and is removed.
//   - Historical logs are repaired in place by dsh-patches/tool-activity/
//     repair-sessions.mjs (tool-activity blocks → fold-equivalent reasoning
//     blocks, original kept as *.tool-activity.bak).
//     [v43: that script is gone — a sweep of 232 local session logs found zero
//     tool-activity blocks, because the double probe had been degrading native
//     to fold all along. Recoverable from git history at 0.33.0 if some other
//     machine turns out to hold a contaminated log.]
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
import { ToolCallId, LlmError, createToolResultMessage, createUserMessage, requestImageHandleText } from '@deepseek-ai/dsh-llm'
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
  toolActivityDisplay: 'interleave',
  permissionMode: 'bypassPermissions',
  imageMaxPixels: 2048 * 2048,
  imageMaxBytes: 1024 * 1024,
  toolResultDisplayChars: 3000,
  nativeResume: true,
  askUserQuestion: true,
  dshTools: true,
  mirrorSubagents: true,
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
  // 'interleave' (a DSH step per card, rich cards, default), 'live' (rich
  // cards appended to the session log; all prose lands after them), 'fold'
  // (ordered Think rows), or 'card' (tool-call echo cards after the stream).
  // A plain string keeps the settings schema simple; config() clamps unknown
  // values to the default.
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
  // Mirror inner `Task` subagents into real DSH child sessions so they appear
  // in the session-header subagent catalog. Purely additive: the mirror writes
  // child sessions and never touches the parent transcript, so turning it off
  // only removes those rows. See createMirrorDriver for the failure policy.
  mirrorSubagents: z.boolean(),
})

const effortInfo = (id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })

// The SDK's PermissionMode union (sdk.d.ts). 'bypassPermissions' additionally
// requires allowDangerouslySkipPermissions: true — see buildPermissionOptions.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']

/** Clamp a configured permission mode to the SDK's union; unknown → default. */
export function resolvePermissionMode(value) {
  return PERMISSION_MODES.includes(value) ? value : DEFAULTS.permissionMode
}

export const TOOL_ACTIVITY_DISPLAYS = ['fold', 'card', 'live', 'interleave']

/**
 * Modes whose visible card is appended by the live sink rather than yielded
 * into the stream (v41).
 *
 * `live` has always been here. `interleave` joined because its echo block had
 * to give up the lowercase wire name to stop colliding with DSH's real tools
 * (v40), and the lowercase name is exactly what DSH's keyed `tool.call.toolview`
 * matches on to draw a rich row. Appending the card sidesteps the conflict:
 * the sink writes it under the lowercase name while the echo keeps the
 * capitalized one and renders as nothing.
 *
 * `card` stays out on purpose — it concludes the turn and keeps its documented
 * end-of-stream batching, so it has no step boundary to protect.
 */
export const SINK_MODES = new Set(['live', 'interleave'])

/**
 * Segment boundary marker (v36, `interleave` only).
 *
 * NEVER reaches DSH: `pumpSegment` in the adapter consumes it, converts it to
 * a terminal `finish`, and suspends the generator. Named with a `__` prefix so
 * a stray one would fail the LLM stream grammar loudly (invariant.ts rejects
 * unknown chunk types) instead of being silently dropped.
 */
export const SEGMENT_BREAK = '__cc-segment-break'

/**
 * Modes this plugin used to accept, mapped to nothing — kept ONLY so an
 * upgrader who still has the old value in settings.yaml gets told once why
 * their configured mode is not the one running. Silent clamping is fine for a
 * typo; it is not fine for a value that was this plugin's own default for
 * twenty versions.
 */
const RETIRED_TOOL_ACTIVITY_DISPLAYS = new Set(['native'])
const warnedRetiredDisplays = new Set()

/** Clamp a configured activity display; unknown → the default (`interleave`). */
export function resolveToolActivityDisplay(value, logger) {
  if (TOOL_ACTIVITY_DISPLAYS.includes(value)) return value
  if (RETIRED_TOOL_ACTIVITY_DISPLAYS.has(value) && !warnedRetiredDisplays.has(value)) {
    warnedRetiredDisplays.add(value)
    logger?.warn?.(
      `toolActivityDisplay "${value}" was removed in v43 (it required a patch inside the DSH ` +
      `install that no longer applies); falling back to "${DEFAULTS.toolActivityDisplay}". ` +
      `Update settings.yaml to silence this.`,
    )
  }
  return DEFAULTS.toolActivityDisplay
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

/**
 * One mirrored assistant message (reasoning / text / tool-call blocks).
 *
 * Trap 4: `stream` is MANDATORY and neither layer that writes tells you so.
 * dsh's own loop settles every `assistant/message` with `stream: live.stream`
 * (four call sites in dsh-agent-loop, no exception), and two consumers assume
 * it is always an array:
 *   - restore validation (`assertAssistantSettlementShape` in dsh-session)
 *     rejects the whole log with "invalid settlement fields" — the session
 *     reads as CORRUPT once it goes cold;
 *   - the token meter's `usageOf` calls `lastAssistantStreamChunk(stream, …)`,
 *     which does `stream.length - 1` — so while the session is still HOT the
 *     projection fold throws a bare TypeError ("Cannot read properties of
 *     undefined (reading 'length')") that the gateway reports as
 *     `gateway/internal` and the UI shows as "历史加载失败".
 * `session.append` validates none of this, so a missing `stream` looks fine
 * for an entire turn and only surfaces when someone loads the history.
 *
 * `[]` is the correct value here, not a placeholder: a mirrored message is not
 * an LLM settlement, so it carries no stream records and must contribute no
 * usage. The blocks live in `message.content`, which is what renders.
 */
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
    stream: [],
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

/**
 * The inner tool names whose calls spawn a Claude Code subagent.
 *
 * MEASURED, NOT ASSUMED. claude 2.1.263 dispatches subagents through a tool
 * named `Agent` — NOT `Task`, which is what this file assumed from de537d8
 * until a live SDK probe showed otherwise. That single wrong string silently
 * disabled the whole mirror: no name match, no `open` action, no child
 * session, and no error anywhere to notice. The offline self-check could not
 * catch it either, because its fixtures were built from the same wrong
 * assumption — a closed loop that proves only that the code agrees with
 * itself.
 *
 * Both names are accepted because the CLI binary still carries both strings,
 * so the older one may resurface in another version; accepting a name that
 * never arrives costs nothing, missing the live one costs everything.
 *
 * checkup.mjs --live re-measures this against the real CLI.
 */
export const MIRROR_TASK_TOOLS = Object.freeze(['Agent', 'Task'])

/**
 * True when one tool-call block is a subagent dispatch.
 *
 * The name alone is not the test: `Agent` is a bare, unprefixed name, and a
 * third-party MCP server is free to register one too (its calls would arrive
 * as `mcp__<server>__Agent`, but a future bridge shape is not guaranteed).
 * A real dispatch always carries the prompt handed down to the child, so
 * requiring it keeps an unrelated tool from opening an empty child session.
 */
export function isMirrorTaskCall(block) {
  if (block?.type !== 'tool_use' || !MIRROR_TASK_TOOLS.includes(block?.name)) return false
  return typeof block.input?.prompt === 'string'
}

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
            if (!isMirrorTaskCall(block)) continue
            if (typeof block.id !== 'string') continue
            const input = block.input ?? {}
            // `description` is the short human label Claude Code sends with
            // every dispatch; `subagent_type` names the persona it picked.
            const label = String(input.description ?? input.subagent_type ?? block.name)
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
                // `interrupted`, NOT `error`, for a failed Task. Measured, not
                // reasoned: restore validation accepts `completed` / `blocked`
                // / `max-tokens` / `interrupted` as SINGLE-KEY reasons, while
                // `error` additionally demands either an `error` field or a
                // `step` + `failure{message,code}` pair. A bare
                // `{kind:'error'}` passes append AND passes the projection
                // fold, then fails the cold read with "malformed
                // pre-react-loop turn/end" — i.e. the child reads as corrupt
                // in the UI, on a code path only a FAILING subagent takes.
                ['turn/end', {
                  turn: 1,
                  reason: { kind: block.is_error === true ? 'interrupted' : 'completed' },
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

/**
 * Drive one SDK stream's mirror actions into real DSH child sessions.
 *
 * WHY A SEPARATE LAYER: createMirrorCollector is a pure fold — no ctx, no
 * session, no I/O — so the whole risky half can be tested against a fake ctx.
 * This is the thin mapping that actually creates sessions, and it is kept
 * deliberately dumb: create, append, forget.
 *
 * FULLY SYNCHRONOUS, AND THAT IS THE WHOLE POINT. Durability is not this
 * layer's job: dsh-session-persistence subscribes to `session/event` and
 * batches every append to disk on its own timer, exactly as it does for the
 * parent session. An earlier version of this driver also called
 * `sessionPersistence.append()` by hand and tracked a seq watermark — that was
 * a SECOND writer for the same log, and the real DSH rejected it on the second
 * batch ("append seq mismatch: expected 9, got 7") because the coordinator had
 * already persisted seqs 7 and 8. Do not reintroduce manual persistence: the
 * events published here are enough, and a hand-rolled watermark can only ever
 * drift from the coordinator's.
 *
 * EVERY FAILURE IS SWALLOWED AND LOGGED. A broken mirror must not break the
 * turn it is mirroring — the mirror is an extra view of work that already ran.
 *
 * @param sessions - the `sessions` service, read synchronously in apply().
 * @param cwd - the parent's workspace; child headers key storage off it.
 * @param parentSessionId - the DSH session the Task was dispatched from.
 */
export function createMirrorDriver({ sessions, logger, cwd, parentSessionId, model, provider = 'claude-code-task' }) {
  const collector = createMirrorCollector({ senderSessionId: parentSessionId, model, provider })
  /** taskId → the child being written, for Tasks that have not returned yet. */
  const children = new Map()
  /** Every child id this stream created, in order, for logs and cold-read checks. */
  const openedIds = []

  const warn = (what, error) => logger?.warn?.(`llm-claude-code: subagent mirror (${what}) failed: %o`, error)

  /** Append triples one at a time: a rejected event must not cost the batch. */
  const appendAll = (entry, triples) => {
    for (const triple of triples) {
      try {
        appendMirrorEvent(entry.session, triple)
      } catch (error) {
        // A gap is better than a truncated child session.
        warn(`append ${triple[0]}`, error)
      }
    }
  }

  const openChild = (action) => {
    const id = `session-${randomUUID()}`
    const session = sessions.create(id, {
      meta: buildMirrorChildMeta({ cwd, parentSession: parentSessionId }),
    })
    // Without the descriptor this is merely a session: the registered
    // `subagent` projection is the SOLE mode/label classifier, so a child
    // carrying only origin/parentSession never reaches the catalog.
    session.append('subagent/descriptor', buildMirrorDescriptor({ provider, label: action.label }))
    const entry = { session, label: action.label }
    children.set(action.taskId, entry)
    openedIds.push(id)
    appendAll(entry, action.events)
  }

  const applyAction = (action) => {
    if (action.kind === 'open') return openChild(action)
    const entry = children.get(action.taskId)
    // A child whose creation failed still receives events and closes; dropping
    // them here is what keeps one bad open from cascading.
    if (entry === undefined) return
    appendAll(entry, action.events)
    if (action.kind === 'close') children.delete(action.taskId)
  }

  return {
    /** Child session ids created so far, in dispatch order. */
    childIds: () => [...openedIds],

    /** Feed one raw SDK message. */
    observe(message) {
      let actions
      try {
        actions = collector.observe(message)
      } catch (error) {
        warn('fold', error)
        return
      }
      for (const action of actions) {
        try {
          applyAction(action)
        } catch (error) {
          warn(action.kind, error)
        }
      }
    },

    /**
     * Close whatever the stream never returned a result for — abort, inner
     * error, or a killed process all leave a child sitting mid-turn, which
     * reads as "still running" in a session that has no live Agent and can
     * therefore never progress.
     *
     * `reason.kind: 'interrupted'` — same measured constraint as the close
     * path: it is one of the four single-key reasons restore validation
     * accepts, whereas `error` needs a `step` + `failure` envelope and
     * `aborted` needs a nested `reason`. Both of those pass append and pass
     * the projection fold, and only fail at COLD READ as "session log
     * corrupt", long after the turn they belong to. Verify with
     * `probes/driver-probe.mjs` before changing this value.
     *
     * @returns how many child sessions this stream opened.
     */
    settle() {
      for (const taskId of collector.openTaskIds()) {
        const entry = children.get(taskId)
        if (entry === undefined) continue
        try {
          appendAll(entry, [
            ['step/end', { turn: 1, step: 1 }, undefined],
            ['turn/end', { turn: 1, reason: { kind: 'interrupted' } }, undefined],
            ['session/title', { title: entry.label, messageSeqs: [], source: { kind: 'fallback' } }, undefined],
          ])
        } catch (error) {
          warn('unclosed task', error)
        }
      }
      children.clear()
      return openedIds.length
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
// `sessions` is what the subagent mirror creates child sessions through. It is
// a HARD requirement rather than a soft `ctx.get` read because a soft read
// cordis was never told to wait for can return undefined while the service is
// merely not ready yet — which would disable mirroring permanently on a startup
// race instead of visibly. It ships with dsh-base and underpins every DSH
// session, so a composition that runs an LLM turn at all has it.
//
// `sessionPersistence` is deliberately NOT injected: the mirror never calls it.
// It subscribes to `session/event` and persists on its own, so a composition
// without it degrades to memory-only child sessions (visible this run, gone
// after a restart) rather than refusing to load this provider at all.
export const inject = ['llm', 'subprocess', 'tools', 'commands', 'sessions']

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
// Scope: prompt text only. The DSH transcript renders from its own blocks and
// session events, so display is untouched.
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

function blockText(block, images) {
  if (block?.type === 'text') return replayText(block)
  if (block?.type === 'reasoning') return replayText(block)
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

// Echo-card machinery. The `claudeActivity` marker inside the arguments is the
// durable side-channel that marks a call/result pair as display-only (planReplay
// and serializeConversation skip it; the payload rides in the persisted
// arguments so the card's render survives process restarts, like v12).
//
// v40 renames every echo to the INNER tool's own name — `Bash`, not `bash`.
// Until v39 these were the DSH lowercase names, chosen because the client keys
// a card's variant off the call name (TOOL_VARIANTS in dsh-client-ui-tool's
// tool-call-model.ts:41), so `bash` bought a real terminal-style row. That
// bargain is what the v37/v38/v39 bugs were all made of: taking a name DSH
// itself owns means colliding with the tool that owns it, and the collision
// lands differently at every layer —
//   · agent plane (preset deployments): the real tool shadows the echo, DSH
//     validates our card payload against ITS schema → ToolArgsError on
//     write/edit, silent second execution on bash/read/glob/grep (v38);
//   · global plane (host-level tool-fs): whoever applies second throws, and
//     boot dies with it (v39).
// The capitalised names collide with nothing: DSH tool names are lowercase, and
// register() enforces no charset at all (core/tools/src/index.ts, only
// RUN_CODE_NAME is reserved), so `Bash`/`Write`/`Edit` are free in every layer.
//
// The price, paid deliberately: TOOL_VARIANTS is an exact case-sensitive lookup
// (tool-call-model.ts:87), so these fall to the generic `others` row instead of
// the terminal/read/search rows. That is NOT a regression — v38 already had to
// degrade every one of them to `claude_tool`, which is the same `others` row
// with a worse title. This trades a title of "claude_tool" for "Bash" and gets
// the collision class deleted rather than guarded. Restoring the rich rows is a
// client-side job (the keyed `tool.call.toolview` slot), not a naming trick.
const ECHO_MARKER = 'claudeActivity'
export const ECHO_VARIANTS = {
  Bash: 'Bash',
  Read: 'Read',
  Edit: 'Edit',
  Write: 'Write',
  Glob: 'Glob',
  Grep: 'Grep',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
}
export const ECHO_FALLBACK = 'claude_tool'

/**
 * v41 `interleave` driver name — the echo block that exists ONLY to hold the
 * step open while the live sink draws the visible card.
 *
 * It is deliberately NOT one of ECHO_VARIANTS. The client plugin hides every
 * row it keys, and keying the per-tool names would also blank the cards of
 * sessions recorded under v40, where the capitalized echo WAS the card
 * (`ToolCallTree`'s `fallback` only applies when NO keyed entry matches, so a
 * keyed entry that renders nothing leaves an empty row, not the generic card).
 * One dedicated name that never appeared before keeps history intact and drops
 * the client to a single key. Since the row is hidden, its name is invisible.
 */
export const ECHO_DRIVER = 'ClaudeCodeActivity'
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

/**
 * v42: the minimal payload for an ECHO_DRIVER block — everything the step cut
 * needs and nothing else.
 *
 * buildEchoArguments above is v16-shaped: back then the echo block WAS the
 * card, so it had to carry `command` / `file_path` / `output` for the client to
 * have anything to draw. v41 moved drawing to the live sink (which appends the
 * real, unclamped arguments under the lowercase wire name) and left the driver
 * with one job: hold the step open. Its payload was never revisited, so every
 * driver kept shipping a full copy of the native call — measured at 1179 bytes
 * average over one real session, 18 of 34 carrying a verbatim shell command.
 *
 * That is not merely wasteful. `output` and the marker are `required` in
 * defineEchoTool's schema, so a fully-populated driver is a block that WOULD
 * satisfy a real tool's validation if ECHO_DRIVER ever collided with one — the
 * exact shape that made v37's echoes execute a second time. Shipping only what
 * the driver needs keeps that door shut by construction.
 *
 * Kept: the marker, because isEchoCallBlock filters replayed blocks on it, and
 * `ccTool`, because it is the one field that makes a hidden row legible when
 * reading a session log by hand. Dropped: every native payload field, and
 * `output`'s body — the key stays (schema `required`) with an empty string,
 * which the echo tool's `render` turns into an empty result nobody reads: the
 * row is hidden client-side and collectEchoCallIds strips it before replay.
 */
export function buildDriverArguments(ccName) {
  return { [ECHO_MARKER]: true, ccTool: ccName, output: '' }
}

/**
 * True when a tool definition or declared schema is one of OUR echo tools.
 *
 * Both shapes carry the same field: a ToolDefinition's `parameters` is already
 * compiled to JSON Schema (core/tools/src/schema.ts:566,572), and the schemas
 * DSH hands the adapter in `options.tools` reuse that very reference —
 * wireSchemas projects with `schemaOf(definition, false)`, which does NOT
 * detach (core/tools/src/index.ts:1246-1256). So the marker lives under
 * `properties` in either case, and no real harness tool declares it, which
 * makes its presence an exact ownership test.
 */
export function echoOwnsToolName(tool) {
  return tool?.parameters?.properties?.[ECHO_MARKER] !== undefined
}

/**
 * Index one request's declared tool schemas by name (v38).
 *
 * Tolerates every degenerate shape on purpose: `options.tools` is OMITTED
 * entirely when the calling scope declares no tools (agent-loop/src/agent.ts:565
 * only spreads it while `tools.length > 0`), and a missing index must read as
 * "nothing is ours" rather than throw inside a display path.
 */
export function indexRequestTools(requestTools) {
  const declared = new Map()
  if (!Array.isArray(requestTools)) return declared
  for (const schema of requestTools) {
    if (typeof schema?.name === 'string' && schema.name.length > 0) declared.set(schema.name, schema)
  }
  return declared
}

/**
 * Pick the echo tool name this card may safely claim, for ONE request (v38).
 *
 * Two conditions, and both are load-bearing:
 *   · `owned` — we successfully registered that name at startup.
 *   · `declared` — and the agent about to execute this call still resolves that
 *     name to OUR echo. This is the half v37 lacked: registration happens in
 *     the global layer, execution resolves through the agent's layer, and a
 *     preset that mounts tool-fs on the agent plane shadows the name without
 *     ever touching our registration.
 *
 * Null means "no echo card for this run" — the caller falls back to a reasoning
 * fold, so the run stays visible instead of failing a real tool's validation.
 * @param onDegrade - notified once per name that was ours to register but is not ours to call.
 * @param preferDriver - v41: a live sink is drawing the card, so this block is
 *   only a step driver and should claim ECHO_DRIVER, whose row the client hides.
 */
export function resolveEchoName(ccName, declared, owned, onDegrade, preferDriver = false) {
  const usable = (name) => {
    if (typeof name !== 'string' || !owned.has(name)) return false
    if (echoOwnsToolName(declared.get(name))) return true
    onDegrade?.(name)
    return false
  }
  // Falling through to a per-tool variant is intentional: if the driver name is
  // somehow unusable the run still gets a v40-shaped visible card rather than
  // losing the step cut and the card together.
  if (preferDriver && usable(ECHO_DRIVER)) return ECHO_DRIVER
  const preferred = ECHO_VARIANTS[ccName]
  if (usable(preferred)) return preferred
  return usable(ECHO_FALLBACK) ? ECHO_FALLBACK : null
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

/**
 * Call-id prefix for `live` mode's display-only tool events (v33).
 *
 * `live` writes its `tool/call` straight to the session log, so — unlike an
 * echo — there is NO assistant tool-call block carrying {@link ECHO_MARKER} to
 * recognise the pair by. The id itself is the marker, and it has to be one:
 * `tool/result` is a surface event (`SURFACE_EVENT_TYPES` in DSH's
 * session/surface.ts), so DSH replays these results into the next request's
 * messages whether we want them or not. Every consumer that must not feed them
 * back to Claude recognises them through {@link collectEchoCallIds}.
 */
const LIVE_CALL_PREFIX = 'cc-live-'

/** Whether a call id belongs to a `live`-mode display-only tool event. */
export function isLiveActivityCallId(id) {
  return typeof id === 'string' && id.startsWith(LIVE_CALL_PREFIX)
}

/** A fresh display-only call id for one `live` tool run. */
export function newLiveActivityCallId() {
  return `${LIVE_CALL_PREFIX}${randomUUID()}`
}

/**
 * Every display-only call id in a message list (result blocks reference these).
 *
 * Two shapes land here, and both must be filtered out of anything replayed to
 * Claude Code — it ran these tools itself, so feeding its own results back is
 * at best duplication and at worst an orphan tool result the route rejects:
 *   - `card` echoes: an assistant tool-call block marked with ECHO_MARKER.
 *   - `live` events: a user-role tool-result whose callId carries
 *     {@link LIVE_CALL_PREFIX}. There is no assistant block to inspect, by
 *     design (emitting one would make the agent loop EXECUTE the call).
 * Returning both through one set keeps every existing call site — replay
 * planning, transcript serialisation, the resume watermark — unchanged.
 */
export function collectEchoCallIds(messages) {
  const ids = new Set()
  for (const message of messages ?? []) {
    if (message?.role === 'assistant') {
      for (const block of message.content ?? []) {
        if (isEchoCallBlock(block) && typeof block?.id === 'string') ids.add(block.id)
      }
      continue
    }
    if (message?.role !== 'user') continue
    for (const block of message.content ?? []) {
      if (block?.type === 'tool-result' && isLiveActivityCallId(block.toolCallId)) ids.add(block.toolCallId)
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

/**
 * Whether this request is DSH coming back for the NEXT interleave segment
 * (v36), rather than a genuinely new turn.
 *
 * The signal is the last message: after the loop executes a segment's echo it
 * re-requests with that echo's tool-result appended, and an echo result is the
 * ONLY thing in that message. A real user message, steering, or a normal tool
 * result all fail this test — so a stale suspended generator can never hijack
 * fresh input.
 */
export function isEchoContinuation(messages) {
  const list = messages ?? []
  const last = list[list.length - 1]
  if (last === undefined) return false
  return isEchoOnlyUserMessage(last, collectEchoCallIds(list))
}

/**
 * Drain ONE interleave segment from a (possibly suspended) translateSdkMessages.
 *
 * Returns `true` when the generator ran out — this was the turn's last segment
 * and its resources must be released. Returns `false` when it stopped at a
 * {@link SEGMENT_BREAK}: the generator is SUSPENDED mid-stream, still holding
 * the live Claude Code query, and must be kept alive for the next DSH step.
 *
 * The break is converted to a terminal `finish` rather than forwarded: DSH's
 * stream grammar knows nothing about segments, and the assistant message this
 * finish settles still carries the unexecuted echo tool-call, which is what
 * makes the loop run it and open the next step.
 */
export async function* pumpSegment(gen) {
  for (;;) {
    const next = await gen.next()
    if (next.done === true) return true
    const chunk = next.value
    if (chunk?.type === SEGMENT_BREAK) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return false
    }
    yield chunk
  }
}

/**
 * The turn/step the outer loop currently has OPEN, or undefined when none is.
 *
 * `live` mode appends into a session another plugin is driving, and DSH's
 * session invariant (core/session/src/invariant.ts, `requireOpenStep`) rejects
 * a `tool/call` or `tool/result` whose turn/step is not the open one. The loop
 * does not hand the adapter its step — `GenerateOptions` carries only
 * `sessionId` — so it has to be read back off the log.
 *
 * Scans BACKWARDS and stops at the first step boundary: whichever of
 * `step/start` / `step/end` comes last decides, and it is always near the tail,
 * so this never walks the whole log.
 * @param session - the live DSH session.
 * @returns `{ turn, step }` of the open step, or undefined.
 */
export function findOpenStep(session) {
  const events = session?.snapshotEvents?.() ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'step/end') return undefined
    if (event?.type === 'step/start') {
      const { turn, step } = event.data ?? {}
      return typeof turn === 'number' && typeof step === 'number' ? { turn, step } : undefined
    }
  }
  return undefined
}

/**
 * Claude Code tool name → the DSH wire name that picks the card (v33).
 *
 * The client keys its rich tool views off the wire name alone
 * (`tool.call.toolview` slot key, and `TOOL_VARIANTS` for the generic row), so
 * this map is what turns a run into a read row, a bash row or a diff row
 * instead of the unclassified `others` row.
 *
 * v40 SPLIT this from ECHO_VARIANTS, which it used to share. The two tables
 * answer different questions and only looked alike:
 *   · here the name is written straight into the session log and read by the
 *     client. Nothing registers it, nothing executes it, so naming it `read`
 *     costs nothing and buys the rich row.
 *   · ECHO_VARIANTS names a tool that DSH will REGISTER and EXECUTE, where
 *     `read` means colliding with tool-fs — the v37→v39 bug family.
 * Sharing one table meant `live` was paying for `card`'s constraint, or (after
 * the v40 rename) would silently have lost its rich rows. Keep them apart.
 *
 * An unmapped name is passed through UNCHANGED rather than forced onto a
 * fallback: an honest tool name on a generic row beats a wrong card.
 */
const LIVE_WIRE_NAMES = {
  Bash: 'bash',
  Read: 'read',
  Edit: 'edit',
  Write: 'write',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
}

export function liveWireToolName(ccName) {
  return LIVE_WIRE_NAMES[ccName] ?? ccName
}

/**
 * Write one completed inner tool run into the session as a native tool card.
 *
 * This is `live` mode's whole mechanism, and it is deliberately NOT a stream
 * projection: it appends the same two events the official agent loop writes
 * when it runs a tool, so the transcript and the Trajectory panel render their
 * ordinary cards, in real time, with no DSH patch and no custom content kind.
 *
 *   tool/call    no SurfaceIntent — not a surface event, never reaches the model
 *   tool/result  surfaceOp 'append', citing the call's seq (DSH requires both)
 *
 * The assistant-side `tool-call` block the loop normally writes is omitted ON
 * PURPOSE: the client excludes it from rendering anyway, and emitting one into
 * the stream would make the loop EXECUTE the call.
 *
 * Never throws: display is a side view, and a failed card must not take the
 * turn down with it.
 * @param session - the live session to append into.
 * @param logger - optional ctx.logger for the one-time failure notice.
 * @param model - optional model name recorded on appended prose messages.
 * @returns a sink `{ prose, tool }`, or undefined when the session is unusable.
 */
export function createLiveActivitySink({ session, logger, model }) {
  if (session === undefined || typeof session.append !== 'function') return undefined
  // Resolved once, not per call: the adapter's whole stream runs inside ONE
  // loop step, so the open turn/step cannot change underneath it.
  let location
  let resolved = false
  let warned = false
  const warn = (what, error) => {
    if (warned) return
    warned = true
    logger?.warn?.(`llm-claude-code: live tool card ${what} failed (${error?.message ?? error}); activity is hidden for this turn`)
  }
  const place = () => {
    if (!resolved) {
      resolved = true
      location = findOpenStep(session)
    }
    return location
  }
  /**
   * One withheld prose run, appended as its own assistant message (v34).
   *
   * The client sorts conversation nodes by event seq, and the loop settles the
   * whole turn into ONE assistant message at stream end — so prose left in the
   * stream can never sit between two cards. Writing each run here is what makes
   * the transcript read "words, card, words, card" instead of "all cards, then
   * all words". DSH tolerates several assistant messages inside one open step
   * (core/session invariant only calls requireOpenStep).
   */
  const prose = (blocks) => {
    if (!Array.isArray(blocks) || blocks.length === 0) return
    try {
      const at = place()
      if (at === undefined) return warn('placement', new Error('no open step in the session log'))
      appendMirrorEvent(session, buildMirrorAssistantEvent({ turn: at.turn, step: at.step, content: blocks, model }))
    } catch (error) {
      warn('prose append', error)
    }
  }
  const tool = (use, output, isError) => {
    try {
      const location = place()
      if (location === undefined) return warn('placement', new Error('no open step in the session log'))
      const callId = newLiveActivityCallId()
      const input = use?.input ?? {}
      const callSeq = session.append('tool/call', {
        turn: location.turn,
        step: location.step,
        callId,
        name: liveWireToolName(bridgeDisplayName(use?.name ?? 'tool')),
        arguments: typeof input === 'string' ? input : JSON.stringify(input),
      }).seq
      session.append('tool/result', {
        turn: location.turn,
        step: location.step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: typeof output === 'string' && output.length > 0 ? output : '(no output)' }],
          isError: isError === true,
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    } catch (error) {
      warn('append', error)
    }
  }
  return { prose, tool }
}

export async function* translateSdkMessages(messages, { showToolActivity = true, toolActivityDisplay = DEFAULTS.toolActivityDisplay, toolResultDisplayChars = DEFAULTS.toolResultDisplayChars, echoNameOf = () => ECHO_FALLBACK, onResult, mirror, activitySink, segmented = false } = {}) {
  // native/fold are order-preserving. card still batches after the outer stream.
  // Unknown values clamp to native so a typo cannot silently restore batched cards.
  const activityDisplay = resolveToolActivityDisplay(toolActivityDisplay)
  const blocks = new Map()
  const toolUses = new Map()
  const useOf = (id) => toolUses.get(id)
  let nextIndex = 0
  let emittedText = false
  // v35 forces this OFF — see the file header. v34 set it for `live` to
  // interleave prose with cards; the client collapses every same-step
  // assistant/message into ONE node (blocks are REPLACED, not appended), so
  // each withheld run overwrote the previous one and only the final settle
  // survived. Withholding is kept as a switch rather than deleted because the
  // machinery below is what a future interleave attempt would reuse, but
  // nothing may turn it back on without a client that appends.
  const withholdProse = false
  const pendingProse = []
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
          // v42: ECHO_DRIVER means a live sink already drew the card with the
          // real arguments, so this block is a step cut and nothing more. Every
          // other echo name IS the card (`card` mode, or a sink-less fallback),
          // and still needs the native-shaped payload to render.
          arguments: JSON.stringify(
            echoName === ECHO_DRIVER
              ? buildDriverArguments(bridgeDisplayName(use.name))
              : buildEchoArguments(bridgeDisplayName(use.name), use.input, output, isError),
          ),
        },
      },
    ]
  }

  for await (const message of messages) {
    // Mirror FIRST and unconditionally: the four `parent_tool_use_id === null`
    // filters below discard every sub-agent message (their context must not be
    // sampled for occupancy, and their tools must not be re-displayed in the
    // parent), and the mirror is the consumer that discarding starved. It needs
    // the main-session messages too — a Task's tool_use opens a child and its
    // tool_result closes one — so this cannot move inside a branch.
    //
    // Synchronous by contract (writes are queued in the driver) and never
    // allowed to throw: mirroring is a side view, not part of the turn.
    if (mirror !== undefined) {
      try {
        mirror(message)
      } catch { /* the driver logs its own failures */ }
    }
    if (message?.type === 'stream_event' && message.parent_tool_use_id === null) {
      const event = message.event
      if (event?.type === 'content_block_start') {
        const native = event.content_block
        const kind = native?.type === 'text' ? 'text' : native?.type === 'thinking' || native?.type === 'redacted_thinking' ? 'reasoning' : undefined
        if (kind !== undefined) {
          // A withheld block must NOT consume a stream index: the assembler
          // keys blocks by index, and skipping one would leave a hole.
          const state = { index: withholdProse ? -1 : nextIndex++, kind, text: '' }
          blocks.set(event.index, state)
          if (!withholdProse) yield { type: 'block-start', index: state.index, blockType: kind }
        }
      } else if (event?.type === 'content_block_delta') {
        const state = blocks.get(event.index)
        if (state !== undefined) {
          const delta = event.delta
          const text = state.kind === 'text' ? delta?.text : delta?.thinking
          if (typeof text === 'string' && text.length > 0) {
            state.text += text
            // Tracked even when withheld: the result.result fallback must not
            // re-emit an answer this turn already produced.
            if (state.kind === 'text') emittedText = true
            if (!withholdProse) {
              yield state.kind === 'text'
                ? { type: 'text-delta', index: state.index, text }
                : { type: 'reasoning-delta', index: state.index, text }
            }
          }
        }
      } else if (event?.type === 'content_block_stop') {
        const state = blocks.get(event.index)
        if (state !== undefined) {
          blocks.delete(event.index)
          const block = state.kind === 'text' ? { type: 'text', text: state.text } : { type: 'reasoning', text: state.text }
          if (withholdProse) pendingProse.push(block)
          else yield { type: 'block-end', index: state.index, block }
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
        if (activityDisplay === 'live') {
          // Nothing is yielded: the card is written straight into the session
          // log by the sink. A missing sink (no live session) degrades to a
          // fold so the run is still visible rather than silently lost.
          for (const block of results) {
            const use = useOf(block?.tool_use_id)
            if (use === undefined) continue
            const text = resultText(block?.content, toolResultDisplayChars)
            if (activitySink === undefined) {
              yield* emitFoldBlock(describeToolActivityFolds([block], useOf, toolResultDisplayChars)[0])
            } else {
              // Words first, then the card they introduced: the client sorts by
              // event seq, so flushing here is what produces the interleaving.
              if (pendingProse.length > 0) activitySink.prose(pendingProse.splice(0))
              activitySink.tool(use, text, block?.is_error === true)
            }
          }
        } else if (activityDisplay === 'fold') {
          for (const fold of describeToolActivityFolds(results, useOf, toolResultDisplayChars)) {
            yield* emitFoldBlock(fold)
          }
        } else {
          for (const block of results) {
            const use = useOf(block?.tool_use_id)
            if (use === undefined) continue
            // Map before choosing the variant: a bridged `mcp__dsh__bash` has
            // to land on ECHO_VARIANTS' `Bash` entry, not the generic
            // fallback, or the swap would be visible as a plainer card.
            const echoName = echoNameOf(bridgeDisplayName(use.name), activitySink !== undefined)
            if (echoName === null) {
              // Name collision or registration failure: this run still gets a
              // real-time fold instead of a card it could not safely claim.
              yield* emitFoldBlock(describeToolActivityFolds([block], useOf, toolResultDisplayChars)[0])
            } else {
              // v41: when a sink is available (interleave with a live session),
              // IT draws the visible card — under the lowercase wire name, so
              // DSH's own keyed toolview gives it the rich row the capitalized
              // echo name cannot match. The echo block below then exists only
              // to hold the step open, and the client plugin renders it as
              // nothing. Without a sink this is skipped and the echo block is
              // the card, exactly as in v40.
              if (activitySink !== undefined) {
                activitySink.tool(use, resultText(block?.content, toolResultDisplayChars), block?.is_error === true)
              }
              yield* emitActivityCardChunk(use, echoName, resultText(block?.content, toolResultDisplayChars) || '(no output)', block?.is_error === true)
              // v36 `interleave`: cut the stream HERE. DSH appends tool/call
              // only in executeToolCalls, i.e. after a stream ends — so one
              // stream can never show a card before its own later prose. The
              // way out is more STEPS, not an earlier card: end this stream
              // holding an unexecuted echo, and the loop runs it, draws the
              // card, and opens a fresh step whose assistant message carries
              // the next prose. Each step owns its own message, so nothing
              // overwrites anything (contrast v34, which faked several
              // messages inside ONE step and lost all but the last).
              //
              // Only legal while the echo does NOT concludeTurn — see
              // defineEchoTool. A `card`-mode echo still concludes, so `card`
              // keeps its documented end-of-stream batching.
              if (segmented) yield { type: SEGMENT_BREAK }
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
  // The tail — prose after the LAST tool run — goes through the stream on
  // purpose: the loop settles it into this turn's assistant message, whose seq
  // lands after every card, which is exactly where it belongs. Emitted whole
  // because it was withheld rather than streamed. Flushed after the failure
  // checks so a broken turn does not leave half an answer behind.
  for (const block of pendingProse.splice(0)) {
    yield* block.type === 'text' ? emitTextBlock(block.text) : emitFoldBlock(block.text)
  }
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
      // v43: no mode needs a patched install any more, so there is nothing to
      // degrade. Every surviving mode emits only standard content blocks or
      // standard session events.
      toolActivityDisplay: resolveToolActivityDisplay(merged.toolActivityDisplay),
    }
  }
  const logger = ctx.logger
  // Taken SYNCHRONOUSLY, and never re-read per turn. Past the first await the
  // cordis fiber may already be inactive, and then this getter throws while
  // DSH's own soft `ctx.get(...)` reads start returning undefined — which
  // fabricates misleading downstream errors instead of failing here.
  const sessions = ctx.sessions
  // Per-DSH-session native-resume tracking: dsh session key →
  // { claudeSessionId, lastFedMessageId }. In-memory only — a host restart
  // simply falls back to one full-replay turn and re-seeds the entry.
  const resumeState = new Map()
  // v36 `interleave`: dsh session key → the SUSPENDED run that owes more
  // segments. Holds the half-consumed translateSdkMessages generator, the live
  // Claude Code query behind it, and that attempt's mirror driver.
  //
  // Every entry is a live subprocess, so nothing may leak one: `settle()` is
  // idempotent and runs on exhaustion, on a non-continuation request, on
  // abort, and on a watchdog timeout (the loop can stop asking for segments
  // without telling the adapter — an error between steps, or a user interrupt).
  const interleaveState = new Map()
  const SEGMENT_WATCHDOG_MS = 120000
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
      // v36: `interleave` depends on the loop opening ANOTHER step after this
      // card, and NOT concluding is precisely what owes it that follow-up
      // request (DSH loop.spec.ts: "a tool can conclude the turn despite owing
      // a follow-up request"). The adapter answers that request from the
      // SUSPENDED generator, so the follow-up costs no extra Claude Code run.
      //
      // Every other mode keeps v16's conclude: there the echo is the last
      // thing in the turn and a follow-up would be a wasted model call.
      if (resolveToolActivityDisplay(config().toolActivityDisplay) !== 'interleave') exec.concludeTurn()
      return { recorded: true }
    },
  })
  // Registered unconditionally, and v39's attempt to gate this on the display
  // mode is DELETED rather than repaired. Two reasons, in order of weight:
  //
  //   1. It cannot read the mode here. `config()` is `{...DEFAULTS, ...current()}`
  //      and the settings document has not loaded at apply time, so the gate saw
  //      DEFAULTS.toolActivityDisplay — then 'native' — watched the (now
  //      deleted, v43) degrade helper knock it down to a fold for want of the
  //      UI patch, and skipped
  //      registration — leaving `interleave` with no echoes to emit. Observed
  //      2026-09-15 via probes/e2e-scope.patch.yml: settings said `interleave`,
  //      the agent scope showed `echo tools registered: (none)`.
  //   2. Its whole purpose is gone. v39 gated registration to avoid the
  //      duplicate-insert crash; v40's rename put these names outside DSH's
  //      namespace, so there is nothing left to crash into.
  //
  // Registering eight display tools that a fold-only deployment never emits is
  // mild catalog noise, and it is the behaviour v16–v38 shipped. Trading a
  // correctness bug for that noise was the wrong trade.
  //
  // The `ctx.tools.get()` pre-check stays. It is one lookup per name, and it is
  // the only thing standing between a future rename back into DSH's namespace
  // and a silent repeat of v37 → v39.
  const ownedEchoNames = new Set()
  for (const name of new Set([...Object.values(ECHO_VARIANTS), ECHO_FALLBACK, ECHO_DRIVER])) {
    if (ctx.tools.get(name) !== undefined) continue
    try {
      ctx.tools.register(defineEchoTool(name))
      ownedEchoNames.add(name)
    } catch (error) {
      logger.warn(`llm-claude-code: echo tool "${name}" unavailable (${error?.message ?? error})`)
    }
  }
  // v38: the registration-time guard above is necessary but NOT sufficient,
  // and — unlike what v37 assumed — re-asking ctx.tools.get() does not help.
  //
  // That call carries no scope, so it answers from the GLOBAL view
  // (core/tools/src/index.ts:1194), which is exactly where our echoes live and
  // where they stay ours forever. Execution resolves through the AGENT's view
  // instead (index.ts:1536), and a preset mounting tool-fs on the agent plane
  // shadows `write`/`edit`/`read`/`bash` there without disturbing our global
  // registration at all — two separate tables, no duplicate, no replacement
  // (core/scope/src/store.ts:43). The global check therefore returns true on
  // every single call and degrades nothing.
  //
  // What the card must ask is a per-request question, so it is answered from
  // per-request data: `options.tools` is projected for the calling scope and is
  // the same view that will execute the call. See resolveEchoName.
  //
  // Widening buildEchoArguments to satisfy the real schemas remains the WRONG
  // fix, and v38 is the proof: the payload for bash/read/glob/grep ALREADY
  // covers their required set, additionalProperties is never closed
  // (core/tools/src/schema.ts:449-457), and those cards were silently running
  // the real tool a second time. Failing validation is what kept write/edit
  // from doing the same.
  const lostEchoNames = new Set()
  const noteEchoLost = (name) => {
    if (lostEchoNames.has(name)) return
    lostEchoNames.add(name)
    logger.warn(
      `llm-claude-code: echo name "${name}" resolves to another tool in the calling agent's scope `
        + `(a preset likely mounts it on the agent plane) — cards for it degrade to "${ECHO_FALLBACK}"`,
    )
  }
  // Built once per request: the scope, and therefore the answer, belongs to
  // that request. Null means "no echo card for this run" — translateSdkMessages
  // falls back to a reasoning fold, so the run is still visible.
  const buildEchoNameOf = (requestTools) => {
    const declared = indexRequestTools(requestTools)
    return (ccName, preferDriver) => resolveEchoName(ccName, declared, ownedEchoNames, noteEchoLost, preferDriver)
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: config().providerName }
    },
    providerRetryPolicy() {
      return undefined
    },
    // Declares no route-owned image pricing, exactly like the LlmAdapter base
    // class does by default — DSH then falls back to its own neutral estimate.
    //
    // It has to be spelled out even though the default is "return undefined":
    // this adapter is a plain object, so it inherits nothing from the abstract
    // class, and LlmService.imageRequestPricing() calls the method WITHOUT an
    // optional call (`adapters.get(p)?.adapter.imageRequestPricing(...)` guards
    // only the lookup). Omitting it made every token measurement that priced
    // history on this route throw `imageRequestPricing is not a function` —
    // which is what surfaced as a raw TypeError out of /compact, since
    // compactNow's failure is not a ManualCompactionError and gets rethrown.
    imageRequestPricing() {
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
      const resolved = config()
      const sessionKey = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : 'default'
      const interleaving = resolveToolActivityDisplay(resolved.toolActivityDisplay) === 'interleave'

      // ── v36 `interleave`: serve the NEXT segment of a suspended run ───────
      //
      // The loop just executed the previous segment's echo, drew its card, and
      // opened a fresh step. Answering it from the suspended generator is what
      // makes the next prose land in a NEW assistant message — interleaved and
      // whole — instead of overwriting the previous one.
      //
      // Ordered before the abort check on purpose: a suspended run owns a live
      // Claude Code subprocess, and returning early without settling it would
      // leak that process for the watchdog to reap minutes later.
      const carried = interleaveState.get(sessionKey)
      if (carried !== undefined) {
        interleaveState.delete(sessionKey)
        carried.disarm()
        // Resumable only for the exact request it was suspended for. A new
        // user message, a mode switched away from interleave, or an abort all
        // mean its remaining segments would answer a question nobody asked.
        if (interleaving && options.signal?.aborted !== true && isEchoContinuation(options.messages)) {
          let exhausted = true
          try {
            exhausted = yield* pumpSegment(carried.gen)
          } catch (error) {
            carried.settle()
            throw error instanceof LlmError
              ? error
              : new LlmError(`llm-claude-code: ${error?.message ?? error}`, 'PROVIDER_ERROR')
          }
          if (exhausted) carried.settle()
          else carried.arm()
          return
        }
        carried.settle()
      }

      if (options.signal?.aborted) throw new LlmError('llm-claude-code: request aborted', 'ABORTED')

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
      const onAbort = () => {
        controller.abort(options.signal?.reason)
        // v36: a suspended interleave run outlives the stream() call that
        // created it, so this listener is the last reference able to release
        // it. Safe to hang the release here because the loop reuses ONE
        // AbortController for every step of a turn (agent.ts: `phase.abort` is
        // replaced only after turn/end), so this fires on a real cancellation
        // — never between two ordinary steps of the same turn.
        const suspendedRun = interleaveState.get(sessionKey)
        if (suspendedRun !== undefined) {
          interleaveState.delete(sessionKey)
          suspendedRun.disarm()
          suspendedRun.settle()
        }
      }
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
            // canUseTool is retained alongside the hook, and NOT as a gate.
            //
            // Passing it makes the SDK push `--permission-prompt-tool stdio`,
            // and that flag is what lets a headless inner CLI expose the
            // built-in AskUserQuestion at all. The callback itself allows
            // everything except AskUserQuestion; PreToolUse is the
            // authoritative gate for that one tool and routes it to DSH's
            // native question card.
            //
            // EXPECTED, DO NOT "FIX": every query() prints
            //   (node) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool
            //   will not be invoked: permissionMode 'bypassPermissions' ...
            // The SDK emits it whenever canUseTool is present AND the mode is
            // bypassPermissions — both deliberate here. It is one
            // process.emitWarning and changes no behaviour. What bypass
            // shadows is the ordinary-tool arm, which returns
            // {behavior:'allow'} anyway, so nothing is lost. emitWarning does
            // not dedupe, hence once per turn.
            //
            // Both apparent fixes are worse:
            //   · dropping canUseTool also drops the flag -> the inner session
            //     can no longer ask anything (trades a real feature for a log).
            //   · passing permissionPromptToolName:'stdio' with no callback
            //     does silence it (the check reads !!canUseTool), but the SDK
            //     throws "canUseTool callback is not provided." if a
            //     can_use_tool request ever arrives — betting on undocumented
            //     CLI behaviour, i.e. a crash instead of a warning.
            // Leaving bypassPermissions is not on the table either: v17 chose
            // it because a headless inner session can never answer a prompt.
            //
            // checkup.mjs pins the flag mechanism, so if the SDK ever grows a
            // standalone switch for exposing AskUserQuestion, this whole
            // argument expires loudly instead of silently.
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
        // One driver per ATTEMPT, not per turn: a resume retry re-runs the
        // whole inner turn, so its Tasks are dispatched again and would
        // otherwise mirror twice into the same children. The failed attempt's
        // children are closed by settle() in the finally below.
        const mirror = resolved.mirrorSubagents
          ? createMirrorDriver({
            sessions,
            logger,
            cwd: workspace,
            parentSessionId: options.sessionId,
            model: options.model,
          })
          : undefined
        // `live` writes its cards into THIS session's log, so it needs the live
        // Session object. Resolved per attempt (a resume retry re-enters here)
        // and left undefined for every other mode, which touches no session.
        //
        // v41 adds `interleave` to that set. This does NOT make interleave a
        // second live mode: it still cuts the stream on an unexecuted echo to
        // win its step boundary. The sink only takes over the VISIBLE card,
        // under the lowercase wire name, so DSH's own keyed toolview draws the
        // rich row — the echo block keeps the capitalized name that makes it
        // collision-free and renders as nothing (src/client/index.js).
        // No sink (no live session) degrades interleave to its v40 shape:
        // the echo block is the card again, generic row and all.
        // `logger` here is also what surfaces the one-shot retired-mode warning
        // (v43): this runs per request, i.e. after settings have loaded, unlike
        // apply() — see the v39 note about reading live config too early.
        const activitySink = SINK_MODES.has(resolveToolActivityDisplay(resolved.toolActivityDisplay, logger))
          && typeof options.sessionId === 'string' && options.sessionId.length > 0
          ? createLiveActivitySink({ session: sessions.get(options.sessionId), logger, model: options.model })
          : undefined
        // One idempotent release for this attempt. `finally` runs it on every
        // ordinary exit; an interleave SUSPENSION hands it to the carrier
        // instead, which runs it once the last segment drains — or when the
        // watchdog or an abort gives up on the run.
        let released = false
        const releaseAttempt = () => {
          if (released) return
          released = true
          options.signal?.removeEventListener('abort', onAbort)
          sdkQuery.close()
          // Synchronous, and contains every failure itself: an abort still
          // closes the children's open turns, and throwing here would replace
          // the turn's real error with a mirroring one. Durability is the
          // persistence coordinator's job, so there is nothing to await.
          if (mirror !== undefined) {
            const opened = mirror.settle()
            if (opened > 0) logger.info('llm-claude-code: mirrored %d Task subagent(s): %s', opened, mirror.childIds().join(' '))
          }
        }
        let suspended = false
        try {
          const segments = translateSdkMessages(sdkQuery, {
            mirror: mirror?.observe,
            activitySink,
            showToolActivity: resolved.showToolActivity,
            toolActivityDisplay: resolveToolActivityDisplay(resolved.toolActivityDisplay),
            toolResultDisplayChars: resolved.toolResultDisplayChars,
            // v38: scoped to THIS request's declared tools, not the global
            // registry view — see buildEchoNameOf.
            echoNameOf: buildEchoNameOf(options.tools),
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
            segmented: interleaving,
          })
          if (!interleaving) {
            yield* segments
            return
          }
          // Exhausted on the first pass = the inner run made no tool calls at
          // all, so there was never anything to interleave.
          if (yield* pumpSegment(segments)) return
          // Suspended mid-stream. Hold the half-consumed generator — and the
          // live Claude Code query behind it — for the next step's request.
          // The watchdog is the only guard against a step that never comes:
          // the loop can stop asking without telling the adapter.
          suspended = true
          let timer = null
          const entry = {
            gen: segments,
            settle: releaseAttempt,
            disarm() {
              if (timer === null) return
              clearTimeout(timer)
              timer = null
            },
            arm() {
              entry.disarm()
              timer = setTimeout(() => {
                if (interleaveState.get(sessionKey) === entry) interleaveState.delete(sessionKey)
                logger.warn('llm-claude-code: interleave run was never resumed; releasing its Claude Code process')
                releaseAttempt()
              }, SEGMENT_WATCHDOG_MS)
              timer.unref?.()
              interleaveState.set(sessionKey, entry)
            },
          }
          entry.arm()
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
          // A suspended interleave run owns its own release (entry.settle), so
          // closing here would kill the query the next segment still needs.
          if (!suspended) releaseAttempt()
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
