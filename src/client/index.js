/**
 * Browser half of dsh-llm-claude-code (v41).
 *
 * It owns exactly one job: make the `interleave` driver block invisible.
 *
 * Why a driver block exists at all
 * --------------------------------
 * `interleave` produces real THINK -> CARD -> THINK by ending the stream while
 * an echo tool-call is still UNEXECUTED; the loop runs it and — because that
 * echo does not conclude the turn — opens a FRESH step for the next prose.
 * Step boundaries belong to the loop (core/session refuses a step the adapter
 * advanced itself), so an unexecuted tool-call is the only lever a plugin has.
 * See main.v20.mjs's v35/v36 header notes.
 *
 * Since v40 those echoes carry the INNER tool's own name (`Bash`, `Write`, …)
 * so they cannot collide with DSH's lowercase tool names. The price was the
 * card: `tool.call.toolview` is keyed by wire name and DSH ships its rich rows
 * under the lowercase keys (`bash` -> BashRow, `write`/`edit` -> FileMutationRow,
 * `read` -> read-family), so a capitalized key misses and falls back to the
 * generic row.
 *
 * v41 splits the two jobs instead of asking one block to do both:
 *   - the VISIBLE card is appended by the live sink under the lowercase wire
 *     name, so it hits DSH's own rich toolview — no styling code here, and no
 *     second copy of ui-primitives or its CSS modules in this bundle;
 *   - the driver block takes ECHO_DRIVER, a name that has never been a card, and
 *     renders as nothing.
 *
 * That last detail is not cosmetic. Keying the per-tool names here would also
 * blank the cards of sessions recorded under v40, where those names WERE the
 * card: a keyed entry that renders nothing leaves an empty row, because
 * ToolCallTree's `fallback` fires only when NO entry matches.
 *
 * Why the CSS is needed on top of rendering null
 * ----------------------------------------------
 * ui-chat already anticipates a declining renderer — ChatView.module.css says
 * "A keyed renderer may intentionally decline its row after dispatch" and hides
 * `.flowItem:empty`. But `:empty` is strict: the Seat still contains ui-tool's
 * `.callRow` element, so the Seat is not empty and keeps its 16px column gap.
 * Hence the marker plus one `:has()` rule that collapses the whole Seat.
 *
 * The rule leans on two data attributes DSH sets deliberately as DOM hooks
 * (`data-chat-flow-kind` on the Seat, and our own marker), not on CSS-module
 * class names, which are content-hashed and would break on any rebuild. If a
 * future DSH drops the attribute the rule simply stops matching and the driver
 * rows come back as blank gaps — a visible blemish, never a broken card.
 */
import * as React from 'react'
import { DRIVER_KEYS, MARKER, STYLE } from './driver-names.js'

/** The slot service is a hard dependency: without it there is nothing to register. */
export const inject = ['slots']

/**
 * The driver block's view: present in the tree so the rule can find it,
 * invisible on its own so a browser without `:has()` still shows nothing.
 * @returns {React.ReactElement} the marker element.
 */
function EchoDriverRow() {
  return React.createElement('span', { [MARKER]: '', hidden: true })
}

/**
 * Register the hidden view for every driver name and install the collapse rule.
 * @param {object} ctx - the plugin's cordis context.
 * @returns {() => void} disposer removing the stylesheet.
 */
export function apply(ctx) {
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of DRIVER_KEYS) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key }, EchoDriverRow)
    }
  })

  const style = document.createElement('style')
  // Deliberately NOT the marker attribute: tagging the stylesheet with it would
  // make the sheet itself answer `[MARKER]` queries, which turns every "is a
  // driver row present?" check — ours and anyone debugging — into a false hit.
  style.dataset.ccEchoStyle = ''
  style.textContent = STYLE
  document.head.append(style)
  // cordis collects a returned function as this fiber's disposer, so a reload
  // or unmount takes the stylesheet with it instead of leaving a second copy.
  return () => { style.remove() }
}
