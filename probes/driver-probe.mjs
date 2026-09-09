/**
 * 接线后的真 projection fold 验证：让【生产驱动 createMirrorDriver】把一段
 * 合成 SDK 流写成真实子会话，再由全新进程冷读。
 *
 * 与 persist-probe 的区别、以及为什么不能只靠它：
 * persist-probe 手写了一套驱动逻辑（create / append / persist 三段），验证的是
 * 「那套手写逻辑产出的形状合法」。接线之后真正跑在生产路径上的是
 * main.v20.mjs 里的 createMirrorDriver，它多出三样 persist-probe 没有的东西：
 *   1. 串行队列（seq 水位由 entry.nextSeq 递推，而非每次重新 inspect）；
 *   2. settle() 给未闭合任务补的收尾事件；
 *   3. 失败与中断收尾的 `turn/end` reason —— persist-probe 只跑过
 *      `completed`。这个格式【只在冷读拒绝】，所以一个没验过的枚举值会以
 *      「会话记录损坏」出现在界面上，而不是在写入时报错。本探针就是这么抓到
 *      `{kind:'error'}` 不合法的：它通过写入、通过 projection fold，只在冷读
 *      被拒 `malformed pre-react-loop turn/end`（判据见 README「子代理镜像」）。
 *
 * 覆盖三条路径，一次跑完：
 *   task-ok      完整生命周期，close 成功  → reason.kind = 'completed'
 *   task-fail    close 时 is_error         → reason.kind = 'interrupted'
 *   task-open    永远不 close，交给 settle → reason.kind = 'interrupted' + 补标题
 *
 * 两阶段必须分进程：同进程 inspect 到的可能来自 live store，证明不了落盘。
 *
 * @module subagent-driver-probe
 */

import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMirrorDriver } from '../main.v20.mjs'

export const name = 'subagent-driver-probe'

/**
 * `sessionQuery` / `sessionProjections` 必须列进 inject：两者在 DSH 内部都是
 * 软查询 `ctx.get(...)`，不列的话 cordis 不会等它们就绪，探针抢跑会误报成
 * 「服务不存在」（persist-probe 实测踩过）。
 */
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'sessionProjections']

/**
 * 挂镜像子会话的父会话。**换机器必须改这一行**：它是本机一个真实存在的会话
 * id，决定这些探针产物出现在界面上哪一行底下。取本机任意一个：
 *   ls ~/.dsh/sessions/<工作区目录名>/
 * 指向不存在的父会话时，冷读验证本身仍然进行（本探针验的是子会话自己的事件
 * 形状），但产物在界面上无处归属，看不到。
 */
const PARENT = 'session-56e79102-2c62-41a9-a622-ea4be80f53a3'

/**
 * 其余路径都从本文件位置推出来，clone 到别处不用改。
 *
 * CWD 去掉尾斜杠：DSH 的会话 header 存的是不带尾斜杠的形式，父子不一致会让
 * 界面把子会话当成另一个工作区的。
 */
const CWD = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const IDS_FILE = fileURLToPath(new URL('./driver-probe-ids.json', import.meta.url))

/** 真实录制的一次派发（真名 Agent、真实字段），端到端的形状锚点。 */
const REAL_STREAM = fileURLToPath(new URL('../fixtures/subagent-stream.json', import.meta.url))

/**
 * 合成流的形状照 translateSdkMessages 实际消费的形状写。
 *
 * 工具名用 `Agent` —— 实测的真名。曾经这里写 `Task`，于是整条镜像静默失效
 * 而所有断言照样全绿。合成流只补真实录制覆盖不到的两条路径（失败收尾、
 * 未闭合收尾）。
 */
const taskUse = (id, description, prompt) => ({
  type: 'tool_use', id, name: 'Agent', input: { description, prompt, subagent_type: 'Explore' },
})
const assistant = (parentId, content) => ({ type: 'assistant', parent_tool_use_id: parentId, message: { content } })
const user = (parentId, content) => ({ type: 'user', parent_tool_use_id: parentId, message: { content } })

function syntheticStream() {
  return [
    // 三个 Task 一次派发（并发，和图里那两路一样）
    assistant(null, [
      taskUse('task-ok', '镜像验证·正常结束', '去查云端对接现状'),
      taskUse('task-fail', '镜像验证·失败结束', '去查设备侧缺口'),
      taskUse('task-open', '镜像验证·未闭合', '这个永远不返回'),
    ]),
    // 子流：思考 + 正文 + 工具调用 + 工具结果
    assistant('task-ok', [
      { type: 'thinking', thinking: '镜像进来的子代理思考文本' },
      { type: 'text', text: '镜像进来的子代理正文输出' },
      { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'echo hi' } },
    ]),
    user('task-ok', [
      { type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'hi' }], is_error: false },
    ]),
    assistant('task-fail', [{ type: 'text', text: '这一路会以错误收尾' }]),
    assistant('task-open', [{ type: 'text', text: '这一路不会等到结果' }]),
    // 主流：两个 Task 的结果回来（task-open 故意没有）
    user(null, [
      { type: 'tool_result', tool_use_id: 'task-ok', content: [{ type: 'text', text: '完成' }], is_error: false },
    ]),
    user(null, [
      { type: 'tool_result', tool_use_id: 'task-fail', content: [{ type: 'text', text: '失败' }], is_error: true },
    ]),
  ]
}

export function apply(ctx, config = {}) {
  const mode = config.mode ?? 'append'

  // 同步阶段取服务引用：异步边界之后 fiber 可能 inactive，getter 会抛，
  // 而 DSH 内部的软 ctx.get 会开始返回 undefined 并伪造出误导错误。
  const sessions = ctx.sessions
  const persistence = ctx.sessionPersistence
  const sessionQuery = ctx.get('sessionQuery')
  const projections = ctx.get('sessionProjections')

  if (mode === 'append') {
    // 驱动现在是【全同步】的（落盘交给 dsh-session-persistence 的订阅），
    // 所以整轮镜像 + projection 快照都能在 apply 的同步阶段跑完，
    // 完全绕开「异步工作活得比 cordis fiber 长」那一整类假故障。
    //
    // 代理 sessions 只为记下 create 返回的 live session 对象：
    // 不能用 sessions.get(id)，fiber 一卸载 store 里就查不到了（实测踩过）。
    const live = []
    const proxied = {
      create(id, options) {
        const session = sessions.create(id, options)
        live.push({ id, session })
        return session
      },
    }

    const driver = createMirrorDriver({
      sessions: proxied,
      logger: {
        info: (...a) => console.log('[driver:info]', ...a),
        warn: (...a) => console.log('[driver:WARN]', ...a),
      },
      cwd: CWD,
      parentSessionId: PARENT,
      model: 'claude-opus-5',
    })

    // 先喂真实录制流（真实形状），再喂合成流（补失败与未闭合两条路径）。
    const real = JSON.parse(readFileSync(REAL_STREAM, 'utf8'))
    for (const message of real) driver.observe(message)
    for (const message of syntheticStream()) driver.observe(message)
    const opened = driver.settle()
    const ids = driver.childIds()
    console.log(`[driver] settle 报告建了 ${opened} 个子会话`)
    console.log(`[driver] childIds = ${ids.join(' ')}`)

    // 生产判「会话记录损坏」走的就是 projection fold。省略 keys 即折叠
    // 全部已注册单元 —— 这是写入和 inspect 都发现不了的那一层。
    // 4 个 = 真实录制的 1 个 + 合成流的 3 个（正常/失败/未闭合）
    let allOk = ids.length === 4 && live.length === 4
    for (const { id, session } of live) {
      try {
        projections.snapshot(session)
        // Session 的事件访问器名字未经确认，所以只当附加信息读，读不到就打
        // (n/a)，不让它影响本探针真正要验的那一件事。
        let detail = '(n/a)'
        try {
          const events = [...(session.events ?? session.log ?? [])]
          const end = events.find((e) => e.type === 'turn/end')
          detail = `事件数=${events.length} turn/end.reason=${end?.data?.reason?.kind ?? '(无)'}`
        } catch { /* 附加信息而已 */ }
        console.log(`[driver]   ${id}  projection=ok  ${detail}`)
      } catch (error) {
        allOk = false
        console.log(`[driver]   ${id}  projection=抛错 :: ${String(error?.message ?? error).split('\n')[0]}`)
      }
    }

    writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2))
    console.log(`[driver] 同步阶段 RESULT=${allOk ? 'APPENDED_OK' : 'APPEND_PROBLEM'}`)

    // 落盘是定时批量的，直接 exit 会把还在队列里的事件丢掉，
    // 所以显式 flush 一次再退。生产里不需要这一步（进程长驻，会话 dispose
    // 时协调器会做最终 drain）——这是探针为了立刻冷读才做的。
    // 协调器的 flush 不是公开方法（服务外壳只暴露 create/append/inspect/...），
    // 它挂在 `session/flush` 事件上，所以走事件；cordis 的 parallel 会等所有
    // handler 的 promise。再兜一个短等待，覆盖批量定时器那条路径。
    void (async () => {
      try {
        for (const { session } of live) await ctx.parallel('session/flush', session)
        console.log('[driver] flush 事件已广播')
      } catch (error) {
        console.log(`[driver] flush 事件失败（回退到等定时器）:: ${String(error?.message ?? error).split('\n')[0]}`)
      }
      await new Promise((resolve) => { setTimeout(resolve, 3000) })
      const counts = []
      for (const { id } of live) {
        try {
          const got = await persistence.inspect(id)
          counts.push(`${id.slice(8, 16)}=${got?.events?.length ?? '?'}`)
        } catch (error) {
          counts.push(`${id.slice(8, 16)}=读不到`)
        }
      }
      console.log(`[driver] 退出前同进程 inspect: ${counts.join('  ')}`)
      process.exit(0)
    })()
    return
  }

  // 阶段二：冷路径。observeSession 必须是【第一个 await】（见 persist-probe）。
  const storedIds = JSON.parse(readFileSync(IDS_FILE, 'utf8'))
  void (async () => {
    try {
      let bad = 0
      for (const id of storedIds) {
        try {
          await sessionQuery.observeSession(id, {})
          console.log(`[driver]   ${id}  冷读=ok`)
        } catch (error) {
          bad += 1
          const parts = []
          let cur = error?.cause
          for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth += 1) {
            parts.push(`${cur?.name ?? 'Error'}: ${String(cur?.message ?? cur).split('\n')[0]}`)
            cur = cur?.cause
          }
          console.log(`[driver]   ${id}  冷读=拒绝 code=${error?.code ?? '(无)'} :: ${String(error?.message ?? error).split('\n')[0]}`)
          console.log(`[driver]     cause 链 = ${parts.length === 0 ? '(无)' : parts.join('  <=  ')}`)
        }
      }
      // 对照：确认收尾事件真在盘上，而不只是过了冷读。
      for (const id of storedIds) {
        const got = await persistence.inspect(id)
        const events = got?.events ?? []
        const tail = events.slice(-3).map((e) => e.type).join(' → ')
        const end = events.find((e) => e.type === 'turn/end')
        console.log(`[driver]   ${id}  事件数=${events.length} 尾部=${tail} turn/end.reason=${end?.data?.reason?.kind ?? '(无)'}`)
      }
      console.log(`[driver] RESULT=${bad === 0 ? 'COLD_OK' : 'COLD_REJECTED'}`)
    } catch (error) {
      console.log(`[driver] RESULT=FAIL ${error?.stack ?? error}`)
    } finally {
      process.exit(0)
    }
  })()
}
