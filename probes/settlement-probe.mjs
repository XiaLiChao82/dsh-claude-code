/**
 * `live` 模式写进【主会话】的那三种事件，过不过得了 projection fold。
 *
 * 为什么 driver-probe 替代不了它：driver-probe 验的是**子会话**（镜像出来的
 * 那个），而 `live` 模式（v33/v34）把 `assistant/message`、`tool/call`、
 * `tool/result` 直接 append 进**父会话**——一条此前没有任何探针覆盖的路径。
 *
 * 抓到过什么：`buildMirrorAssistantEvent` 缺 `stream` 字段（2026-09-14）。
 * 它通过 `session.append`（第一层完全不校验），然后
 *   - 会话还热着时，token-meter 的 `usageOf` → `lastAssistantStreamChunk` 里
 *     `stream.length - 1` 抛 TypeError，网关兜底成 `gateway/internal`，
 *     界面显示「历史加载失败：Cannot read properties of undefined
 *     (reading 'length')」；
 *   - 会话冷了之后，restore 的 `assertAssistantSettlementShape` 直接判整个
 *     日志损坏。
 * 同一个根因的冷热两副面孔，而离线断言一个也看不见。
 *
 * 本探针【调用生产构造器】，不手写事件 data：手写只能证明「代码与我的想象
 * 一致」，想象错了就一起错（`MIRROR_TASK_TOOL = 'Task'` 那次的教训）。
 *
 * CANARY 组存在的唯一理由是证明本探针没瞎：它故意把 `stream` 删掉，必须失败。
 * 两组都通过才算 SETTLEMENT_OK——GOOD 过而 CANARY 也过，说明这一层根本没在
 * 校验，探针本身已经失效。
 *
 * 同进程即可：这一层是 projection fold，不需要分进程冷读。
 *
 * @module live-settlement-probe
 */

import { randomUUID } from 'node:crypto'
import { buildMirrorAssistantEvent } from '../main.v20.mjs'

export const name = 'live-settlement-probe'

/**
 * 四个都要列。理由同 driver-probe：软查询服务不列进来，cordis 不会等它们就绪。
 * 而且【少列会让本探针变瞎】——只 inject `sessions` + `sessionProjections` 时
 * 注册的 projection 单元为空，`snapshot()` 什么都不折叠，于是连 CANARY 都能
 * 「通过」。空折叠必须当失败处理，见下面的 blind 自检。
 */
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'sessionProjections']

/** 去掉 `stream`，模拟修复前的形状。 */
function withoutStream(triple) {
  const [type, data, opts] = triple
  const { stream, ...rest } = data
  return [type, rest, opts]
}

/**
 * 按 `live` 模式的真实顺序写一轮：prose 消息 + 一张工具卡（两个事件）。
 * @param session - 新建的空会话。
 * @param mutate - 施加在 assistant/message 三元组上的变换。
 */
function writeLiveTurn(session, mutate) {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', {
    content: [{ type: 'text', text: 'settlement probe' }],
    source: { kind: 'user' },
    role: 'user',
    id: randomUUID(),
  }, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })

  // 生产构造器，原样调用。
  const [type, data, opts] = mutate(buildMirrorAssistantEvent({
    turn: 1,
    step: 1,
    content: [{ type: 'text', text: 'withheld prose, appended by live' }],
    model: 'claude-opus-5',
  }))
  session.append(type, data, opts)

  // createLiveActivitySink 的那两个事件，形状照抄。
  const callId = `cc-live-${randomUUID()}`
  const callSeq = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'Read',
    arguments: JSON.stringify({ file_path: '/x' }),
  }).seq
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: randomUUID(),
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })

  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

export function apply(ctx) {
  // 同步阶段取服务引用：异步边界之后 fiber 可能已 inactive。
  const sessions = ctx.sessions
  const projections = ctx.get('sessionProjections')

  // [标签, 变换, 期望 projection 通过]
  const groups = [
    ['GOOD   生产构造器原样', (t) => t, true],
    ['CANARY 故意删掉 stream', withoutStream, false],
  ]

  let ok = true
  let folded = 0
  for (const [label, mutate, expectPass] of groups) {
    const id = `session-${randomUUID()}`
    let failure
    try {
      const session = sessions.create(id, { meta: { cwd: process.cwd() } })
      writeLiveTurn(session, mutate)
      // 生产判「历史加载失败」走的就是这一层，append 全过也不代表它会过。
      const snap = projections.snapshot(session)
      folded = Math.max(folded, Object.keys(snap?.values ?? {}).length)
    } catch (error) {
      failure = error
    }
    const passed = failure === undefined
    const verdict = passed === expectPass ? '符合预期' : '不符合预期'
    if (passed !== expectPass) ok = false
    console.log(`[settlement] ${label}  projection=${passed ? 'ok' : '抛错'}  ${verdict}`)
    if (failure !== undefined) {
      console.log(`[settlement]     ${failure?.name}: ${String(failure?.message).split('\n')[0]}`)
    }
  }

  // 自检：一个单元都没折叠，说明上面两行「通过」什么也没证明。
  if (folded === 0) {
    ok = false
    console.log('[settlement] 自检失败：snapshot 折叠了 0 个单元，本探针是瞎的（检查 inject）')
  } else {
    console.log(`[settlement] 自检：snapshot 折叠了 ${folded} 个单元`)
  }

  console.log(`[settlement] RESULT=${ok ? 'SETTLEMENT_OK' : 'SETTLEMENT_PROBLEM'}`)
  process.exit(ok ? 0 : 1)
}
