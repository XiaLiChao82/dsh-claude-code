/**
 * 挂载探针：在一个隔离 profile 的真实 DSH 进程里回答一个问题——
 * 「llm-claude-code 的 apply() 是否跑到了最后一行」。
 *
 * 为什么不能靠看日志：插件末尾那句 `logger.info('provider "claude-code-main"
 * registered …')` 在 web 形态下被日志级别过滤掉了，启动输出里什么都不会出现。
 * 「没有报错」和「挂上了」是两回事——cordis 把每个 fiber 的异常收在自己那层，
 * apply() 半途抛错的表现同样是「安静地什么都没有」。
 *
 * 所以改问运行时要证据，取两个**在 apply() 末尾才发生**的副作用：
 *   1. ctx.llm 的 provider 目录里有没有 claude-code-main
 *      （registerConfigurableProviders / registerAdapter 在 main.v20.mjs 倒数第二、
 *       第三行，它们在 = apply 走完了）；
 *   2. 全局工具视图里我们注册的回显工具在不在、带不带 ECHO_MARKER。
 *
 * 第 2 条顺带把 v38 的前提当场证一遍：全局视图里 write/edit 看起来「是我们的」，
 * 而真正执行时走的是 agent 层——这正是 v37 守卫失效的原因。探针只读，不注册任何
 * 工具、不改任何文件，跑完即随 fiber 卸载。
 */

const ECHO_MARKER = 'claudeActivity'
const ECHO_NAMES = ['claude_tool', 'write', 'edit', 'read', 'bash', 'glob', 'grep', 'todo_write']

export const name = 'cc-mount-probe'
export const inject = ['llm', 'tools', 'agents']

/**
 * `exitOnAgent: true` 把探针变成「agent 作用域取样器」：在 `agent/created` 上
 * 打印那个 agent 真正看见的工具视图，然后**立刻 process.exit(0)**，请求根本发不
 * 出去 —— 零 token 成本地回答「preset 到底有没有把 tool-fs 挂到 agent 平面」。
 *
 * 这正是全局视图回答不了的那半个问题：`ctx.tools.schemas()` 不带 scope 只看全局层，
 * 而 agent 层的注册会 shadow 它（core/tools/src/index.ts:1156-1173）。agent 自己
 * 就是 ScopeKey —— 事件以 `scopeTarget(agent, agent)` 派发（core/agent/src/index.ts:545）。
 */
export const Config = undefined

export function apply(ctx, config = {}) {
  const lines = []
  const fail = (what, error) => lines.push(`${what}: FAILED — ${error?.message ?? error}`)

  const run = () => {
    try {
      const routed = ctx.llm.listProviders().map((p) => p?.id).filter((id) => typeof id === 'string')
      const configurable = ctx.llm.listConfigurableProviders().map((p) => p?.provider).filter((p) => typeof p === 'string')
      lines.push(`llm routes (${routed.length}): ${routed.join(', ')}`)
      lines.push(`llm configurable (${configurable.length}): ${configurable.join(', ')}`)
      lines.push(`claude-code-main routed:      ${routed.includes('claude-code-main')}`)
      lines.push(`claude-code-main configurable: ${configurable.includes('claude-code-main')}`)
    } catch (error) {
      fail('llm probe', error)
    }

    try {
      const schemas = ctx.tools.schemas()
      const present = new Set(schemas.map((s) => s?.name))
      const ours = new Set(
        schemas.filter((s) => s?.parameters?.properties?.[ECHO_MARKER] !== undefined).map((s) => s.name),
      )
      lines.push(`global tool view: ${schemas.length} tools, ${ours.size} carry ${ECHO_MARKER}`)
      for (const n of ECHO_NAMES) {
        lines.push(`  ${n.padEnd(12)} present=${present.has(n)}  echo-owned(global)=${ours.has(n)}`)
      }
    } catch (error) {
      fail('tools probe', error)
    }

    console.log(`\n=== CC-MOUNT-PROBE ===\n${lines.join('\n')}\n=== CC-MOUNT-PROBE END ===\n`)
  }

  if (config.exitOnAgent === true) {
    ctx.on('agent/created', ({ agent }) => {
      const out = []
      try {
        const schemas = ctx.tools.schemas(agent)
        const byName = new Map(schemas.map((s) => [s?.name, s]))
        const ours = (n) => byName.get(n)?.parameters?.properties?.[ECHO_MARKER] !== undefined
        out.push(`agent scope: ${schemas.length} tools visible to agent ${agent?.id}`)
        for (const n of ECHO_NAMES) {
          const present = byName.has(n)
          out.push(`  ${n.padEnd(12)} present=${present}  echo-owned(agent)=${present && ours(n)}`)
        }
        const realFs = ['write', 'edit', 'read'].filter((n) => byName.has(n) && !ours(n))
        out.push(`REAL fs tools at agent scope: ${realFs.length > 0 ? realFs.join(', ') : '(none — preset did NOT mount tool-fs)'}`)
        // v40: the echoes are named after the INNER tools, so a fixed lowercase
        // list cannot see them. Print whatever actually carries the marker.
        const echoes = schemas.filter((s) => s?.parameters?.properties?.[ECHO_MARKER] !== undefined).map((s) => s.name)
        out.push(`echo tools registered: ${echoes.length > 0 ? echoes.join(', ') : '(none)'}`)
        out.push(`all names: ${schemas.map((s) => s?.name).join(', ')}`)
      } catch (error) {
        out.push(`agent-scope probe FAILED — ${error?.message ?? error}`)
      }
      console.log(`\n=== CC-AGENT-SCOPE ===\n${out.join('\n')}\n=== CC-AGENT-SCOPE END ===\n`)
      // 打印完就走：再往下就是真实的 LLM 请求，那是要花钱的。
      process.exit(0)
    })
    return
  }

  // 延后到整棵树挂完再问：inject 只保证 llm/tools 就绪，不保证
  // llm-claude-code 这一行已经 apply 过。
  const timer = setTimeout(run, 5000)
  ctx.effect(() => () => clearTimeout(timer))
}
