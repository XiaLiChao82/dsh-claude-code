// Read-only probe: dump the event-type sequence around a real tool call, to
// learn exactly which session events the official agent-loop writes when a
// tool runs. Evidence for the "adapter appends its own tool events" design.
//
// Usage: node probes/dump-tool-events.mjs [sessionDir]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = join(homedir(), '.dsh', 'sessions')

// The log is a MULTI-FRAME zstd stream (header frame + body frames); node's
// zstdDecompressSync stops after the FIRST frame and returns a truncated log
// without erroring, which reads as "the session only has a few events". Shell
// out to `zstd -dc`, which concatenates every frame.
function readLog(file) {
  const r = spawnSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`zstd failed: ${r.stderr}`)
  return r.stdout.toString('utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
}

function* allLogs() {
  for (const project of readdirSync(ROOT)) {
    const projectDir = join(ROOT, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const session of readdirSync(projectDir)) {
      const file = join(projectDir, session, 'session.jsonl.zstd')
      try { statSync(file) } catch { continue }
      yield file
    }
  }
}

let found = 0
for (const file of allLogs()) {
  if (found >= 2) break
  let events
  try { events = readLog(file) } catch { continue }
  const at = events.findIndex((e) => e?.type === 'tool/call')
  if (at < 0) continue
  found += 1
  console.log('='.repeat(70))
  console.log('FILE:', file)
  console.log('total events:', events.length, ' first tool/call at index:', at)
  console.log('--- event types around the first tool call ---')
  for (const event of events.slice(Math.max(0, at - 6), at + 6)) {
    const data = event.data ?? {}
    const brief = {
      ...data.turn === undefined ? {} : { turn: data.turn },
      ...data.step === undefined ? {} : { step: data.step },
      ...data.name === undefined ? {} : { name: data.name },
      ...data.callId === undefined ? {} : { callId: String(data.callId).slice(0, 12) },
      ...data.message?.role === undefined ? {} : { role: data.message.role },
      ...data.message?.content === undefined
        ? {}
        : { blocks: data.message.content.map((b) => b?.type).join(',') },
      ...data.meta === undefined ? {} : { meta: Object.keys(data.meta).join(',') },
    }
    const surface = event.surfaceOp === undefined
      ? ''
      : `  surfaceOp=${event.surfaceOp} src=${JSON.stringify(event.sourceEventSeqs ?? [])}`
    console.log(String(event.seq).padStart(4), event.type.padEnd(22), JSON.stringify(brief) + surface)
  }
  const full = events[at]
  console.log('--- full tool/call payload ---')
  console.log(JSON.stringify(full, undefined, 2).slice(0, 900))
  const resultAt = events.findIndex((e, i) => i > at && e?.type === 'tool/result')
  if (resultAt > 0) {
    console.log('--- full tool/result payload (truncated) ---')
    console.log(JSON.stringify(events[resultAt], undefined, 2).slice(0, 1400))
  }
}
if (found === 0) console.log('no session log with a tool/call found')
