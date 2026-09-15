/**
 * The driver block's wire names and the rule that hides its row.
 *
 * Split out of index.js ON PURPOSE: this file imports nothing, so probes can
 * load it under plain Node and check it against main.v20.mjs without pulling
 * React into the process. index.js is the only consumer at runtime.
 */

/**
 * The single wire name the host emits as an `interleave` driver block.
 *
 * MUST equal main.v20.mjs's ECHO_DRIVER. The two are deliberately NOT shared
 * through an import — main.v20.mjs is a self-contained Node module and this one
 * is browser-bundled — so probes/client-driver-check.mjs is the tripwire that
 * fails on drift.
 *
 * It must NEVER include ECHO_VARIANTS' per-tool names: this list decides what
 * the client BLANKS, and under v40 those names were the visible card. Keying
 * them would erase the tool cards of every session recorded then, because
 * ToolCallTree's `fallback` fires only when no keyed entry matches — a keyed
 * entry that renders nothing leaves an empty row instead of the generic card.
 */
export const DRIVER_KEYS = ['ClaudeCodeActivity']

/** Marker attribute the stylesheet keys on. */
export const MARKER = 'data-cc-echo-driver'

/**
 * One `:has()` rule collapsing any tool-call Seat that contains a driver block.
 *
 * Scoped to `data-chat-flow-kind="tool-call"` so it can never reach a Seat of
 * another kind, and matched on the marker rather than `:empty` so an element
 * that merely happens to be empty is never swallowed.
 *
 * Both hooks are data attributes DSH sets deliberately, not content-hashed
 * CSS-module class names. If a future DSH drops the attribute the rule stops
 * matching and driver rows reappear as blank gaps — a blemish, never a broken
 * card.
 */
export const STYLE = `[data-chat-flow-kind="tool-call"]:has([${MARKER}]) { display: none !important; }`
