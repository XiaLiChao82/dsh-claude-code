#!/usr/bin/env node
// One-time repair for sessions whose logs contain `tool-activity` content
// blocks (llm-claude-code's `native` display mode).
//
// WHY: dsh 0.1.5-rc.1 introduced a strict format-v2→v3 content-kind allowlist
// (text/reasoning/image/file/tool-call/tool-result) enforced when a stored v0
// artifact is observed. `tool-activity` is not on that list, so EVERY session
// that ever rendered native activity cards fails to load with
//   "cannot safely transform unclassified message content kind \"tool-activity\""
// The raw log is untouched by that failure ("source v0 artifact remains
// unchanged") — the data is intact, only unreadable.
//
// WHAT: rewrite each `tool-activity` block into a `reasoning` block whose text
// is the plugin's own fold rendering (`▸ name ✓ · summary\n$ summary\n\n…`).
// That is exactly what `fold` mode would have persisted, so replay (`▸ `
// sentinel detection in replayText) and transcript rendering keep working.
// Stream chunks are rewritten in place — `block-start` blockType swaps to
// `reasoning`, `block-end` block carries the converted block — no lines are
// inserted or removed, so seq numbering is preserved.
//
// Safety: the original log is kept next to the repaired one as
// `session.jsonl.zstd.tool-activity.bak`; re-running is a no-op once clean.
//
// Usage:
//   node repair-sessions.mjs [--dry-run] [--root <dir>] [session-dirs...]
//     --dry-run  report what would change, write nothing
//     --root     sessions tree to scan (default: ~/.dsh/sessions)
//   With explicit session-dirs, only those are processed.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, copyFileSync, chmodSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const BAK_SUFFIX = '.tool-activity.bak'

// ── fold text rendering (mirrors activityReplayLine in main.v20.mjs) ─────
// No <tool-activity> wrapper here: replayText wraps/clamps any reasoning text
// starting with `▸ ` when it feeds prompts; the transcript renders the full
// text. Keep the full stored output — this repair must not lose data.
function foldText(block) {
  const mark = block?.isError ? '✗' : '✓'
  const input = block?.input && typeof block.input === 'object' ? block.input : {}
  const summary = [input.description, input.command, input.file_path, input.path, input.pattern, input.query, input.url]
    .find((value) => typeof value === 'string' && value.length > 0) || ''
  const output = typeof block?.output === 'string' ? block.output : ''
  return `▸ ${block?.name ?? 'tool'} ${mark} · ${summary}\n$ ${summary}\n\n${output}`
}

// Deep-walk transform. Only two shapes are touched, never plain strings:
//   {type:'tool-activity', ...}          → {type:'reasoning', text: foldText(...)}
//   {type:'block-start', blockType:'tool-activity'} → blockType: 'reasoning'
function transform(value, stats) {
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const r = transform(item, stats)
      if (r !== item) changed = true
      return r
    })
    return changed ? out : value
  }
  if (value === null || typeof value !== 'object') return value
  if (value.type === 'tool-activity') {
    stats.blocks += 1
    return { type: 'reasoning', text: foldText(value) }
  }
  if (value.type === 'block-start' && value.blockType === 'tool-activity') {
    stats.starts += 1
    return { ...value, blockType: 'reasoning' }
  }
  let changed = false
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    const r = transform(v, stats)
    if (r !== v) changed = true
    out[k] = r
  }
  return changed ? out : value
}

function copyMode(from, to) {
  try { chmodSync(to, statSync(from).mode & 0o777) } catch { /* best effort */ }
}

function zstd(args, input) {
  const r = spawnSync('zstd', args, { input, maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`zstd ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

// ── physical frame layout ────────────────────────────────────────────────
// dsh stores a JSONL session log as INDEPENDENT Zstandard frames and asserts
// that the first frame decodes to exactly one line (the session header) —
// see assertZstdHeaderFrame / encodeMaterialization in
// @deepseek-ai/dsh-session-persistence-jsonl. Compressing the whole file as a
// single frame makes the boot-time workspace scan throw
//   "corrupt Zstandard session log: first frame is not exactly one header line"
// which takes down the entire plugin tree. Mirror dsh's own layout instead:
// header frame + body frame, both checksummed.
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function encodeFramedLog(outLines) {
  const lines = outLines.filter((l) => l.length > 0)
  if (lines.length === 0) throw new Error('refusing to write an empty session log')
  const headerFrame = zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8'), CHECKSUM_OPTIONS)
  // mirror assertZstdHeaderFrame before anything reaches disk
  const probe = zstdDecompressSync(headerFrame)
  if (probe.length === 0 || probe.indexOf(10) !== probe.length - 1) {
    throw new Error('header frame does not decode to exactly one line')
  }
  if (lines.length === 1) return headerFrame
  const body = lines.slice(1).join('\n') + '\n'
  return Buffer.concat([headerFrame, zstdCompressSync(Buffer.from(body, 'utf8'), CHECKSUM_OPTIONS)])
}

// ── optional semantic validation against the installed dsh validator ─────
// The failing migration validates events with the released payload-semantics
// checker; re-run it per repaired line so a shape mistake never reaches disk
// silently. Located by walking up from dsh's own internal @deepseek-ai root.
function findDshRoot() {
  const candidates = []
  if (process.env.DSH_ROOT) candidates.push(process.env.DSH_ROOT)
  try {
    const require = createRequire(import.meta.url)
    const anchor = require.resolve('@deepseek-ai/dsh-llm/package.json')
    candidates.push(join(anchor, '..', '..'))
  } catch { /* plugin dir may not resolve dsh internals */ }
  candidates.push(join(
    process.env.HOME ?? '', '.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh',
  ))
  for (const root of candidates) {
    if (existsSync(join(root, 'node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js'))) return root
  }
  return null
}

let assertSemantics
async function loadValidator() {
  const root = findDshRoot()
  if (!root) return null
  try {
    const mod = await import(join(root, 'node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js'))
    return mod.assertReleasedPayloadSemantics ?? null
  } catch {
    return null
  }
}

// ── session discovery ────────────────────────────────────────────────────
function* sessionLogs(root) {
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const log = join(root, dir.name, 'session.jsonl.zstd')
    if (existsSync(log)) yield log
    else yield* sessionLogs(join(root, dir.name))
  }
}

// ── main ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const rootIdx = argv.indexOf('--root')
const root = rootIdx !== -1 ? argv[rootIdx + 1] : join(process.env.HOME ?? '.', '.dsh/sessions')
const explicit = argv.filter((a, i) => a !== '--dry-run' && a !== '--root' && i !== rootIdx + 1)

const logs = explicit.length > 0
  ? explicit.map((d) => join(d, 'session.jsonl.zstd')).filter(existsSync)
  : [...sessionLogs(root)]

assertSemantics = await loadValidator()
const tmp = mkdtempSync(join(tmpdir(), 'ta-repair-'))
let repaired = 0
let clean = 0
let failed = 0

for (const log of logs) {
  const name = basename(basename(log, '.zstd'), '.jsonl')
  let raw
  try {
    raw = zstd(['-dc'], readFileSync(log))
  } catch (e) {
    console.error(`  SKIP  ${log}: cannot decompress (${e.message})`)
    failed += 1
    continue
  }
  const lines = raw.toString('utf8').split('\n')
  const stats = { blocks: 0, starts: 0 }
  const outLines = []
  const errors = []
  for (const line of lines) {
    if (line.length === 0) { outLines.push(line); continue }
    let event
    try { event = JSON.parse(line) } catch { outLines.push(line); continue }
    const fixed = transform(event, stats)
    if (fixed !== event && assertSemantics) {
      try { assertSemantics(fixed, 0) } catch (e) { errors.push(String(e)) }
    }
    outLines.push(JSON.stringify(fixed))
  }
  if (stats.blocks === 0 && stats.starts === 0) { clean += 1; continue }
  if (errors.length > 0) {
    console.error(`  FAIL  ${log}: ${stats.blocks} blocks, ${stats.starts} starts; semantic validation rejected ${errors.length} line(s)`)
    console.error(`        first: ${errors[0].slice(0, 300)}`)
    failed += 1
    continue
  }
  if (dryRun) {
    console.log(`  DRY   ${log}: ${stats.blocks} tool-activity blocks + ${stats.starts} stream starts → reasoning`)
    repaired += 1
    continue
  }
  const bak = log + BAK_SUFFIX
  if (!existsSync(bak)) copyFileSync(log, bak)
  const tmpOut = join(tmp, 'out.zst')
  try {
    writeFileSync(tmpOut, encodeFramedLog(outLines))
  } catch (e) {
    console.error(`  FAIL  ${log}: cannot encode framed log (${e.message})`)
    failed += 1
    continue
  }
  // sanity: the compressed round-trip contains no tool-activity marker
  if (zstd(['-dc'], readFileSync(tmpOut)).toString('utf8').includes('"tool-activity"')) {
    console.error(`  FAIL  ${log}: post-repair scan still finds tool-activity`)
    failed += 1
    continue
  }
  const st = statSync(tmpOut)
  if (st.size === 0) {
    console.error(`  FAIL  ${log}: compressed output empty`)
    failed += 1
    continue
  }
  renameSync(tmpOut, log)
  copyMode(bak, log)
  console.log(`  OK    ${log}: ${stats.blocks} blocks + ${stats.starts} starts rewritten (backup: ${basename(bak)})`)
  repaired += 1
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${repaired} repaired, ${clean} clean, ${failed} failed${dryRun ? ' (dry run — nothing written)' : ''}`)
process.exit(failed > 0 ? 1 : 0)
