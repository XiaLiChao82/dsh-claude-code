// 验证 v23 的 /compact 分流：不需要真的起 dsh，用假 ctx 跑一遍 apply。
import { apply, planReplay, usageOf, resolveEffectivePermissionMode, stripAbsentToolGuidance, buildSystemAppend, jsonSchemaToZodShape, toMcpResult, buildDshToolBridge, buildNativeToolOverride, bridgeDisplayName, buildToolActivityBlock, describeToolActivityFolds, DEFAULTS } from './main.v20.mjs'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS ', name) }
  else { fail++; console.log('  FAIL ', name, extra) }
}

// ── 假 ctx ────────────────────────────────────────────────────────────
const registry = {}
const collect = (def) => { registry[def.name] = def; return () => {} }
let compactNowCalls = []
let compactionResult = { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4321, summarySeq: 9 }
let compactionThrows = null

const services = {
  compaction: {
    compactNow: (agent, signal, commandId) => {
      compactNowCalls.push({ provider: agent?.options?.provider, commandId })
      if (compactionThrows !== null) throw compactionThrows
      return compactionResult
    },
  },
}

const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  get: (key) => services[key],
  effect: (gen) => {
    if (typeof gen !== 'function') return () => {}
    const it = gen()
    if (it === null || typeof it !== 'object' || typeof it[Symbol.iterator] !== 'function') return () => {}
    for (const value of it) void value
    return () => {}
  },
  commands: { register: collect },
  llm: { registerConfigurableProviders() {}, registerAdapter() {} },
  subprocess: { resolveExecutable: async () => '/usr/bin/claude' },
  tools: { get: () => undefined, register: () => () => {} },
  // installSettingsSection 需要的表面
  settings: { register: () => () => {}, section: () => () => {} },
  on: () => () => {},
  // 不调用 fn：等价于 settings 服务尚未就绪，config() 保持传入的 rawConfig。
  inject: () => () => {},
}

let applyError = null
try { apply(ctx, {}) } catch (error) { applyError = error }

console.log('apply()')
check('apply 不抛异常', applyError === null, applyError?.message)
check('/compact 已注册', registry.compact?.name === 'compact', JSON.stringify(Object.keys(registry)))
check('描述与 DSH 原版一致', registry.compact?.description === 'Compact older conversation history')
check('handler 是函数', typeof registry.compact?.handler === 'function')

if (typeof registry.compact?.handler !== 'function') { console.log('\n无法继续'); process.exit(1) }
const handler = registry.compact.handler
let followups = []
const invocation = (provider, rawInput = '', sessionId = 'dsh-session-1', attachments = []) => ({
  commandId: 'cmd-1',
  rawInput,
  attachments,
  signal: new AbortController().signal,
  agent: {
    options: { provider },
    session: { id: sessionId },
    followup: (message) => { followups.push(message) },
  },
})

console.log('\n分流：其他 provider 必须原样走 DSH')
{
  compactNowCalls = []
  const r = await handler(invocation('deepseek'))
  check('deepseek 路由调用了 ctx.compaction', compactNowCalls.length === 1, JSON.stringify(compactNowCalls))
  check('文案与 DSH 原版逐字一致', r.text === 'Compacted 3 history items (~4321 tokens).', JSON.stringify(r))
  check('带上 sourceEventSeq', r.sourceEventSeq === 9, JSON.stringify(r))
}
{
  compactNowCalls = []
  compactionResult = null
  const r = await handler(invocation('some-other-provider'))
  check('无可压缩历史时文案一致', r.text === 'No compactable history yet.', JSON.stringify(r))
  compactionResult = { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4321, summarySeq: 9 }
}
{
  compactNowCalls = []
  const err = new Error('boom'); err.name = 'ManualCompactionError'; err.code = 'busy'
  compactionThrows = err
  const r = await handler(invocation('deepseek'))
  check('ManualCompactionError busy 文案一致', r.kind === 'error' && r.text.startsWith('Compaction is unavailable because'), JSON.stringify(r))
  compactionThrows = null
}
{
  compactNowCalls = []
  const err = new Error('nope'); err.name = 'TypeError'
  compactionThrows = err
  let threw = null
  try { await handler(invocation('deepseek')) } catch (e) { threw = e }
  check('非预期异常照旧抛出（不吞错）', threw === err)
  compactionThrows = null
}

console.log('\n分流：claude-code-main 不碰 DSH 压缩')
{
  compactNowCalls = []
  const r = await handler(invocation('claude-code-main'))
  check('完全没有调用 ctx.compaction', compactNowCalls.length === 0, JSON.stringify(compactNowCalls))
  check('无内层会话时给出明确提示', r.kind === 'success' && r.text.includes('No inner Claude Code session'), JSON.stringify(r))
}

console.log('\n参数与前置条件')
{
  const r = await handler(invocation('claude-code-main', '  50%  '))
  check('拒绝参数，文案与 DSH 一致', r.kind === 'error' && r.text === 'Usage: /compact (no arguments)', JSON.stringify(r))
}
{
  compactNowCalls = []
  const r2 = await handler(invocation('deepseek', 'x'))
  check('其他 provider 也拒绝参数', r2.kind === 'error' && compactNowCalls.length === 0)
}

console.log('\nnativeResume 关闭时必须拒绝（否则压完立刻被全量重放覆盖）')
{
  const reg2 = {}
  const ctx2 = { ...ctx, commands: { register: (def) => { reg2[def.name] = def; return () => {} } } }
  apply(ctx2, { nativeResume: false })
  const r = await reg2.compact.handler(invocation('claude-code-main'))
  check('明确拒绝并说明原因', r.kind === 'error' && r.text.includes('nativeResume'), JSON.stringify(r))
}

console.log('\ncompaction 服务缺失时不炸')
{
  const reg3 = {}
  const ctx3 = { ...ctx, get: (k) => (k === 'compaction' ? undefined : services[k]), commands: { register: (def) => { reg3[def.name] = def; return () => {} } } }
  apply(ctx3, {})
  const r = await reg3.compact.handler(invocation('deepseek'))
  check('给出可读错误而不是抛异常', r.kind === 'error' && r.text.includes('no compaction engine'), JSON.stringify(r))
}

console.log('\n压缩后必须还能接上（换了内层会话 id，水印不变）')
{
  const messages = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { id: 'a1', role: 'assistant', source: { provider: 'claude-code-main' }, content: [{ type: 'text', text: 'yo' }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'next' }] },
  ]
  // 压缩把 claudeSessionId 换成 fork 出来的新 id，lastFedMessageId 原样保留。
  const afterCompact = { claudeSessionId: 'compacted-fork', lastFedMessageId: 'u1', cwd: '/tmp' }
  const plan = planReplay(messages, afterCompact, 'claude-code-main')
  check('仍然走 resume（没退回全量重放）', plan.mode === 'resume', JSON.stringify(plan))
  check('指向压缩后的新会话', plan.resumeId === 'compacted-fork', JSON.stringify(plan))
  check('只送增量那一条', plan.delta?.length === 1 && plan.delta[0].id === 'u2', JSON.stringify(plan.delta?.map((m) => m.id)))
  check('水印推进到最新用户消息', plan.lastFedMessageId === 'u2', String(plan.lastFedMessageId))

  // 反面：水印在历史里找不到了（DSH 侧压缩过），必须退回全量重放。
  const stale = { claudeSessionId: 'compacted-fork', lastFedMessageId: 'gone', cwd: '/tmp' }
  check('水印失效时退回全量重放', planReplay(messages, stale, 'claude-code-main').mode === 'full')
}

console.log('\nv22 用量拆分回归（压力用最后一次，成本仍累加）')
{
  const cumulative = { input_tokens: 8, cache_read_input_tokens: 114921, cache_creation_input_tokens: 20216, output_tokens: 660 }
  const last = { input_tokens: 2, cache_read_input_tokens: 35865, cache_creation_input_tokens: 103, output_tokens: 1 }
  const u = usageOf(cumulative, last)
  const pressure = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  check('压力取最后一次调用', pressure === 35970, String(pressure))
  check('输出 token 仍累加', u.outputTokens === 660, String(u.outputTokens))
  check('没有最后一次时回退到累加', (() => {
    const f = usageOf(cumulative, undefined)
    return f.inputTokens + (f.cacheReadTokens ?? 0) + (f.cacheWriteTokens ?? 0) === 135145
  })())
}

console.log('\nv24: DSH 限制状态 → 内层权限模式（只收紧，不放松）')
{
  const cases = [
    // [配置值, DSH 状态, 期望, 说明]
    ['bypassPermissions', { planMode: true }, 'plan', '计划模式开 → 强制 plan'],
    ['bypassPermissions', { permissionPreset: 'read-only' }, 'plan', '只读预设 → 强制 plan'],
    ['acceptEdits', { planMode: true, permissionPreset: 'danger-full-access' }, 'plan', '计划模式压过宽松预设'],
    ['bypassPermissions', { permissionPreset: 'workspace-write' }, 'bypassPermissions', '可写预设不动配置'],
    ['bypassPermissions', { permissionPreset: 'danger-full-access' }, 'bypassPermissions', '全放开不动配置'],
    ['bypassPermissions', { permissionPreset: 'custom' }, 'bypassPermissions', 'custom 不动配置'],
    ['acceptEdits', { planMode: false }, 'acceptEdits', '计划模式关不动配置'],
    ['acceptEdits', undefined, 'acceptEdits', '读不到状态时不动配置'],
    ['default', {}, 'default', '空状态不动配置'],
  ]
  for (const [configured, state, want, label] of cases) {
    const got = resolveEffectivePermissionMode(configured, state)
    check(label, got === want, `got ${got}, want ${want}`)
  }
}

console.log('\nv24: /goal 分流')
{
  let reg
  const ctx4 = { ...ctx, commands: { register: (def) => { if (def.name === 'goal') reg = def; return () => {} } } }
  apply(ctx4, {})
  check('/goal 已注册', reg?.name === 'goal')
  check('描述与 DSH 原版一致', reg?.description === 'set or view the goal for a long-running task', JSON.stringify(reg?.description))
  check('输入提示与 DSH 原版一致', reg?.input?.hint === '[<objective>|clear|edit <objective>|pause|resume]', JSON.stringify(reg?.input))
  check('声明接受图片（与 DSH 一致）', reg?.input?.images === true)

  const h = reg.handler

  followups = []
  const noSession = await h(invocation('claude-code-main', 'ship it'))
  check('无内层会话时拒绝', noSession.kind === 'error' && noSession.text.includes('No inner Claude Code session'), JSON.stringify(noSession))
  check('拒绝时没有注入任何消息', followups.length === 0)

  followups = []
  const withImages = await h(invocation('claude-code-main', 'ship it', 'dsh-session-1', [{ type: 'image', source: {} }]))
  check('带图片时明确拒绝', withImages.kind === 'error' && withImages.text.includes('image attachments'), JSON.stringify(withImages).slice(0, 120))
  check('带图片时不注入', followups.length === 0)

  let reg5
  const ctx5 = { ...ctx, commands: { register: (def) => { if (def.name === 'goal') reg5 = def; return () => {} } } }
  apply(ctx5, { nativeResume: false })
  const noResume = await reg5.handler(invocation('claude-code-main', 'ship it'))
  check('nativeResume 关闭时拒绝并说明', noResume.kind === 'error' && noResume.text.includes('nativeResume'), JSON.stringify(noResume).slice(0, 120))

  // 其他 provider：能加载到 DSH 原实现就用它，加载不到必须明确降级而不是崩。
  // 完整的假 goals 服务：DSH 原 handler 会 get 再 create，然后自己渲染结果。
  const madeGoal = {
    id: 'goal-1',
    revision: 1,
    phase: 'active',
    objective: 'ship it',
    roundsStarted: 0,
    maxGoalRounds: 25,
    activation: 'armed',
  }
  const goalsCalls = []
  const fakeGoals = {
    get: () => { goalsCalls.push('get'); return undefined },
    create: (_agent, input) => { goalsCalls.push('create'); return { ...madeGoal, objective: input.objective } },
    edit: () => { goalsCalls.push('edit'); return madeGoal },
    pause: () => { goalsCalls.push('pause'); return { ...madeGoal, phase: 'paused' } },
    resume: () => { goalsCalls.push('resume'); return madeGoal },
    clear: () => { goalsCalls.push('clear') },
  }
  const ctx6 = {
    ...ctx,
    get: (k) => (k === 'goals' ? fakeGoals : services[k]),
    commands: { register: (def) => { if (def.name === 'goal') reg = def; return () => {} } },
  }
  apply(ctx6, {})
  followups = []
  const other = await reg.handler(invocation('deepseek', 'ship it'))
  const reused = goalsCalls.includes('create')
  const degraded = other.kind === 'error' && other.text.includes('could not be loaded')
  check('其他 provider 走 DSH 原实现，或明确降级（二者之一）', reused || degraded,
    `goals=${JSON.stringify(goalsCalls)} 降级=${degraded} 结果=${JSON.stringify(other).slice(0, 140)}`)
  if (reused) {
    check('DSH 原实现的渲染结果原样返回', other.kind === 'success' && other.text.includes('Objective: ship it') && other.text.includes('Rounds: 0/25'), JSON.stringify(other).slice(0, 160))
    check('走 DSH 时不注入任何消息（不触发内层）', followups.length === 0)
    // 子命令同样交给 DSH，不被我们解析
    goalsCalls.length = 0
    await reg.handler(invocation('deepseek', 'pause'))
    check('pause 等子命令也由 DSH 处理', goalsCalls.includes('get'), JSON.stringify(goalsCalls))
  }
  console.log(`         （本次环境：${reused ? '成功复用 DSH 原实现' : 'dsh-command-goal 不可解析 → 走降级分支'}）`)
}

console.log('\nv25: 注入的 DSH 系统提示按段过滤（内层调不到的工具说明整段丢掉）')
{
  // 每段一行，真实注入文本的原句压缩版。
  const para = {
    identity: 'You are an AI agent powered by DeepSeek Harness.',
    gui: 'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:3080.',
    clickable: 'When you successfully create or modify files, mention the primary outputs in your final response.',
    read: 'Use the read tool — not shell commands like cat — to inspect text files.',
    memory: 'Use memory_search before investigating a new issue. Read only relevant matches with memory_read.',
    goal: 'Use goal tools for one objective. Call get_goal before update_goal and copy its exact goal_id.',
    ralph: 'Use the ralph tool ONLY when the direct human asks. Use plain subagents or workflows for fan-out.',
    job: 'Track every background job id. Collect results with job_output; job_kill jobs that stopped mattering.',
    websearch: 'Use the web_search tool to discover current information. The queries array accepts 1–4 queries.',
    workflow: 'Use the workflow tool ONLY when the user explicitly asks. For one or two delegations, prefer plain subagent calls.',
    unknown: 'Use the brand_new_dsh_tool to do something this file has never heard of.',
  }
  const kept = stripAbsentToolGuidance(Object.values(para).join('\n\n')).split('\n\n')
  const has = (key) => kept.includes(para[key])

  // 丢掉的：整段只讲内层没有的工具。
  for (const key of ['memory', 'goal', 'ralph', 'job', 'websearch']) {
    check(`丢掉 ${key} 段`, !has(key))
  }
  // 留下的：环境信息、渲染约定、有原生等价物的工具。
  for (const key of ['identity', 'gui', 'clickable', 'read', 'workflow']) {
    check(`保留 ${key} 段`, has(key))
  }
  // deny list 的保守性：没登记的工具一律保留，宁可多留也不误删真指令。
  check('未登记的新工具照旧保留', has('unknown'))
  // 边界：memory_read 里的 read 不算提及 read；散文里的大写 Read 也不算。
  check('下划线不让 memory_read 冒充 read', !has('memory'))
  check('段落数 11 → 6', kept.length === 6, String(kept.length))

  // 端到端：过滤之后，作废声明仍然要发出去 —— DSH 还会从用户消息侧
  // （system-reminder、AGENTS.md）提到这些工具，那些不经过本函数。
  const append = buildSystemAppend({ system: [para.identity, para.memory].join('\n\n') }, [{ name: 'memory_search' }, { name: 'read' }])
  check('过滤后仍附带工具路由声明', append.includes('Tool routing note'))
  check('路由声明列出 DSH 工具名', append.includes('memory_search, read'))
  check('过滤在前：memory 段不进最终提示', !append.includes('memory_read'))
  check('身份段仍在最终提示里', append.includes('DeepSeek Harness'))
}

console.log('\nv26: DSH 工具桥（内层真的能调到 DSH 的工具）')
{
  const zod = await import('zod').then((m) => m.z ?? m.default?.z ?? m.default).catch(() => undefined)
  if (zod === undefined) {
    check('zod 可用（桥接前提）', false, '工作区解析不到 zod，跳过桥接测试')
  } else {
    // --- schema 翻译：DSH 的 JSON Schema → SDK 要的 zod shape
    const parsed = zod.object(jsonSchemaToZodShape(zod, {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'id' },
        revision: { type: 'number' },
        action: { type: 'string', enum: ['edit', 'complete'] },
        objective: { type: 'string' },
      },
      required: ['goal_id', 'revision', 'action'],
    }))
    check('必填齐了就通过', parsed.safeParse({ goal_id: 'g1', revision: 2, action: 'complete' }).success)
    check('缺必填被拒', !parsed.safeParse({ goal_id: 'g1', revision: 2 }).success)
    check('可选参数缺了也通过', parsed.safeParse({ goal_id: 'g1', revision: 2, action: 'edit' }).success)
    check('enum 之外的值被拒', !parsed.safeParse({ goal_id: 'g1', revision: 2, action: 'nope' }).success)
    check('类型错了被拒', !parsed.safeParse({ goal_id: 'g1', revision: 'two', action: 'edit' }).success)
    check('空参数表转成空 shape', Object.keys(jsonSchemaToZodShape(zod, { type: 'object', properties: {} })).length === 0)
    const nested = zod.object(jsonSchemaToZodShape(zod, {
      type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'],
    }))
    check('数组嵌套能翻译', nested.safeParse({ tags: ['a', 'b'] }).success && !nested.safeParse({ tags: [1] }).success)
    const unknown = zod.object(jsonSchemaToZodShape(zod, {
      type: 'object', properties: { blob: { type: 'weird-future-type' } }, required: ['blob'],
    }))
    check('认不出的类型降级放行（不硬崩）', unknown.safeParse({ blob: { any: 'thing' } }).success)

    // --- 结果换壳
    check('结果原样换壳', toMcpResult({ content: [{ type: 'text', text: 'x' }] }).content[0].text === 'x')
    check('报错标记保留', toMcpResult({ content: [{ type: 'text', text: 'e' }], isError: true }).isError === true)
    check('空结果补占位（MCP 不收空 content）', toMcpResult({ content: [] }).content.length === 1)

    // --- 桥接本体
    const fakeTool = (name, description, schema, handler) => ({ name, description, schema, handler })
    const fakeServer = (opts) => ({ __server: true, tools: opts.tools })
    const goalDef = {
      description: 'Update the goal.',
      parameters: { type: 'object', properties: { goal_id: { type: 'string' } }, required: ['goal_id'] },
    }
    let executed
    const tools = {
      get: (name) => (name === 'update_goal' || name === 'get_goal' ? { ...goalDef, name } : undefined),
      execute: async (input) => { executed = input; return { content: [{ type: 'text', text: 'done' }] } },
    }
    const liveAgent = { id: 'a1', status: 'running' }
    const deps = {
      createSdkMcpServer: fakeServer, tool: fakeTool, z: zod, tools,
      agents: { currentInitiator: () => liveAgent },
      callId: () => 'call-1', names: ['get_goal', 'create_goal', 'update_goal'],
    }
    const bridge = buildDshToolBridge(deps)
    check('只桥接注册过的工具', bridge !== undefined && bridge.names.join(',') === 'get_goal,update_goal', String(bridge?.names))
    check('免审批名单带 mcp 前缀', bridge.allowed.join(',') === 'mcp__dsh__get_goal,mcp__dsh__update_goal', String(bridge.allowed))
    check('跳过的工具不让名字错位', bridge.allowed.every((n, i) => n === `mcp__dsh__${bridge.names[i]}`))

    const out = await bridge.server.tools.find((t) => t.name === 'update_goal').handler({ goal_id: 'g9' })
    check('handler 真的调到 DSH 的执行入口', executed?.name === 'update_goal' && executed?.arguments?.goal_id === 'g9')
    check('把当前活着的 agent 传给 DSH', executed?.agent === liveAgent)
    check('DSH 的返回原样回到内层', out.content[0].text === 'done')

    check('没有 zod 就不桥接（软降级）', buildDshToolBridge({ ...deps, z: undefined }) === undefined)
    check('没有 tools 服务就不桥接', buildDshToolBridge({ ...deps, tools: undefined }) === undefined)
    check('一个都没注册就不桥接', buildDshToolBridge({ ...deps, names: ['nope'] }) === undefined)

    // --- 与 v25 过滤的联动
    const opts = { system: [
      'You are an AI agent powered by DeepSeek Harness.',
      'Use goal tools for one long-running completion objective. create_goal may infer goal intent. Call get_goal before update_goal.',
      'Use memory_search before investigating a new issue.',
    ].join('\n\n') }
    const catalog = [{ name: 'update_goal' }, { name: 'memory_search' }, { name: 'bash' }]
    const withBridge = buildSystemAppend(opts, catalog, ['get_goal', 'update_goal', 'create_goal'])
    const without = buildSystemAppend(opts, catalog, [])
    check('桥接后 goal 段留下来（说明现在有用了）', withBridge.includes('create_goal may infer'))
    check('没桥接时 goal 段照旧删掉', !without.includes('create_goal may infer'))
    check('memory 段两种情况都删', !withBridge.includes('memory_search before') && !without.includes('memory_search before'))
    check('告诉内层桥接工具的真名', withBridge.includes('update_goal (call it as mcp__dsh__update_goal)'))
    check('作废声明不再点名桥接过的工具', !/NOT callable from here[^\n]*update_goal/.test(withBridge))
    check('作废声明仍点名没桥接的工具', /NOT callable from here/.test(withBridge) && withBridge.includes('memory_search'))
  }
}

console.log('\nv27: 把内层的 Bash 换成 DSH 的（命令执行受 DSH 沙箱管）')
{
  const on = buildNativeToolOverride(['bash', 'get_goal'], [])
  check('bash 桥接后关掉内置 Bash', (on.disallowedTools ?? []).includes('Bash'))
  check('内置 Bash 的名字被指向 DSH 的', on.toolAliases?.Bash === 'mcp__dsh__bash')

  const off = buildNativeToolOverride(['get_goal'], [])
  check('bash 没桥接就不动内置 Bash', off.disallowedTools === undefined && off.toolAliases === undefined)
  check('什么都没有时返回空对象', Object.keys(buildNativeToolOverride([], [])).length === 0)

  const merged = buildNativeToolOverride(['bash'], ['AskUserQuestion'])
  check('已有的 AskUserQuestion 禁用不丢', (merged.disallowedTools ?? []).includes('AskUserQuestion'))
  check('两条并存', (merged.disallowedTools ?? []).length === 2)

  const kept = buildNativeToolOverride([], ['AskUserQuestion'])
  check('没桥接时也不吞掉已有的那条', JSON.stringify(kept.disallowedTools) === '["AskUserQuestion"]')

  const dedup = buildNativeToolOverride(['bash'], ['Bash'])
  check('重复不叠加', (dedup.disallowedTools ?? []).filter((n) => n === 'Bash').length === 1)

  const sys = { system: 'Use the bash tool to run commands.\n\nUnrelated paragraph.' }
  const withBash = buildSystemAppend(sys, [{ name: 'bash' }, { name: 'ralph' }], ['bash'])
  check('桥接后不再说"用你自己的 Bash"', !/equivalents \(Bash,/.test(withBash))
  check('其他原生工具照旧推荐', withBash.includes('Read, Edit, Write'))
  check('作废声明不再点名 bash', !/catalog \([^)]*\bbash\b/.test(withBash))
  check('告诉内层 bash 的真名', withBash.includes('bash (call it as mcp__dsh__bash)'))

  const noBridge = buildSystemAppend(sys, [{ name: 'bash' }, { name: 'ralph' }], [])
  check('没桥接时仍推荐原生 Bash', /equivalents \(Bash,/.test(noBridge))

  const jobText = 'Track every background job id you start. Collect with job_output, and job_kill jobs that stopped mattering.'
  check('job 段桥接后保留', stripAbsentToolGuidance(jobText, ['job_output', 'job_kill']) === jobText)
  check('job 段没桥接时删掉', stripAbsentToolGuidance(jobText, []) === '')

  const seen = []
  const fakeZ = { unknown: () => ({ optional: () => ({}) }), string: () => ({ optional: () => ({}) }) }
  const mkTools = (have) => ({
    get: (name) => (have.includes(name)
      ? { name, description: name, parameters: { type: 'object', properties: {} } }
      : undefined),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  })
  const bridge = buildDshToolBridge({
    createSdkMcpServer: (cfg) => cfg,
    tool: (name) => { seen.push(name); return name },
    z: fakeZ,
    tools: mkTools(['bash', 'job_output', 'job_kill', 'get_goal']),
    agents: { currentInitiator: () => ({ id: 'a1' }) },
    callId: () => 'c1',
  })
  check('bash 在桥接名单里', seen.includes('bash'))
  check('job_output 一起桥接', seen.includes('job_output'))
  check('job_kill 一起桥接', seen.includes('job_kill'))
  check('免审批名单带上 bash', (bridge?.allowed ?? []).includes('mcp__dsh__bash'))

  const partial = buildDshToolBridge({
    createSdkMcpServer: (cfg) => cfg,
    tool: (name) => name,
    z: fakeZ,
    tools: mkTools(['get_goal']),
    agents: { currentInitiator: () => ({ id: 'a1' }) },
    callId: () => 'c1',
  })
  const safe = buildNativeToolOverride(partial?.names ?? [], [])
  check('DSH 没有 bash 时内层保住原生 Bash', !(safe.disallowedTools ?? []).includes('Bash'))
}

console.log('\nv28: 文件工具换成 DSH 的（写入进沙箱），显示名保持原生')
{
  // —— 桥接名单 ——
  const bridgedFor = (registered) => {
    const fake = { get: (n) => (registered.includes(n) ? { name: n, description: n, parameters: { type: 'object', properties: {} } } : undefined) }
    const b = buildDshToolBridge({
      createSdkMcpServer: (o) => o, tool: (n, d, s, h) => ({ n, d, s, h }),
      z: { object: () => ({}) }, tools: fake, agents: { currentInitiator: () => ({ id: 'a' }) },
      callId: () => 'c', logger: null,
    })
    return b?.names ?? []
  }
  const all = bridgedFor(['get_goal', 'create_goal', 'update_goal', 'bash', 'job_output', 'job_kill', 'read', 'read_image', 'write', 'edit'])
  check('write 在桥接名单里', all.includes('write'))
  check('edit 在桥接名单里', all.includes('edit'))
  check('read 一起桥接（DSH 的 edit 硬依赖它）', all.includes('read'))
  check('read_image 一起桥接（补回看图能力）', all.includes('read_image'))
  check('glob 不桥接（只读，且无收益）', !all.includes('glob'))
  check('grep 不桥接（参数会从十几个砍到 3 个）', !all.includes('grep'))

  // —— 关掉哪些原生工具 ——
  const full = buildNativeToolOverride(['bash', 'read', 'write', 'edit'], [])
  check('关掉原生 Read', full.disallowedTools.includes('Read'))
  check('关掉原生 Write', full.disallowedTools.includes('Write'))
  check('关掉原生 Edit', full.disallowedTools.includes('Edit'))
  check('关掉原生 Bash', full.disallowedTools.includes('Bash'))
  check('Read 重定向到 DSH 的 read', full.toolAliases?.Read === 'mcp__dsh__read')
  check('Write 重定向到 DSH 的 write', full.toolAliases?.Write === 'mcp__dsh__write')
  check('Edit 重定向到 DSH 的 edit', full.toolAliases?.Edit === 'mcp__dsh__edit')

  // 只桥接了一部分时，没桥接的原生工具必须留着
  const onlyBash = buildNativeToolOverride(['bash'], [])
  check('只桥接 bash 时不动原生 Read', !onlyBash.disallowedTools.includes('Read'))
  check('只桥接 bash 时不动原生 Write', !onlyBash.disallowedTools.includes('Write'))
  const onlyWrite = buildNativeToolOverride(['write'], [])
  check('只桥接 write 时不动原生 Read', !onlyWrite.disallowedTools.includes('Read'))
  check('只桥接 write 时仍关掉 Write', onlyWrite.disallowedTools.includes('Write'))

  // —— 显示名 ——
  check('mcp__dsh__bash 显示成 Bash', bridgeDisplayName('mcp__dsh__bash') === 'Bash')
  check('mcp__dsh__read 显示成 Read', bridgeDisplayName('mcp__dsh__read') === 'Read')
  check('mcp__dsh__write 显示成 Write', bridgeDisplayName('mcp__dsh__write') === 'Write')
  check('mcp__dsh__edit 显示成 Edit', bridgeDisplayName('mcp__dsh__edit') === 'Edit')
  check('没有原生对应的桥接工具去掉前缀', bridgeDisplayName('mcp__dsh__get_goal') === 'get_goal')
  check('read_image 去掉前缀（原生没有同名工具）', bridgeDisplayName('mcp__dsh__read_image') === 'read_image')
  check('真外挂 MCP 的名字原样保留', bridgeDisplayName('mcp__filesystem__write_file') === 'mcp__filesystem__write_file')
  check('github MCP 的名字原样保留', bridgeDisplayName('mcp__github__create_branch') === 'mcp__github__create_branch')
  check('原生名字原样保留', bridgeDisplayName('Grep') === 'Grep')
  check('非字符串不炸', bridgeDisplayName(undefined) === undefined)
  check('前缀相似但不相等的名字不动', bridgeDisplayName('mcp__dshx__bash') === 'mcp__dshx__bash')

  // —— 三条显示路径都用映射名 ——
  const block = buildToolActivityBlock({ name: 'mcp__dsh__edit', input: { file_path: '/a' } }, 'ok', false)
  check('活动块用映射后的名字', block.name === 'Edit', String(block.name))
  const blockMcp = buildToolActivityBlock({ name: 'mcp__filesystem__read_file', input: {} }, 'ok', false)
  check('活动块不动真外挂 MCP 的名字', blockMcp.name === 'mcp__filesystem__read_file')
  const blockNone = buildToolActivityBlock(undefined, '', false)
  check('活动块缺 use 时兜底', blockNone.name === 'tool')

  const folds = describeToolActivityFolds(
    [{ tool_use_id: 't1', content: [{ type: 'text', text: 'out' }] }],
    () => ({ name: 'mcp__dsh__bash', inputLine: 'ls' }),
  )
  check('折叠行也用映射后的名字', folds[0].includes('▸ Bash'), folds[0].split('\n')[0])
  check('折叠行不再露出 mcp__dsh__ 前缀', !folds[0].includes('mcp__dsh__'))
}

console.log('\nv29: dshTools 开关（关掉即逐字回到 v25）')
{
  // ---- 开关本身
  check('默认打开', DEFAULTS.dshTools === true, String(DEFAULTS.dshTools))

  const src = readFileSync(new URL('./main.v20.mjs', import.meta.url), 'utf8')
  check('配置里登记了 dshTools', /dshTools:\s*z\.boolean\(\)/.test(src))
  check('闸门读的是 resolved.dshTools', /resolved\.dshTools\s*\?\s*buildDshToolBridge\(/.test(src))

  // 关掉时既不该白白 import zod，也不该打出"zod 不可用"的假警报——
  // 那条警告要留给真正的加载失败。
  const gateStart = src.indexOf('resolved.dshTools')
  const gateEnd = src.indexOf('const append = buildSystemAppend')
  const gate = src.slice(gateStart, gateEnd)
  check('闸门位于 buildSystemAppend 之前', gateStart > 0 && gateEnd > gateStart)
  check('loadZod 只在打开的分支里', gate.indexOf('loadZod()') < gate.indexOf(': undefined'))
  check('关掉时 bridge 取 undefined', gate.includes(': undefined'))

  // ---- 等价性：同一份输入，关掉 == v25，打开 == v28
  const sys = [
    'You are an AI agent powered by DeepSeek Harness.',
    'Use goal tools for one long-running completion objective. create_goal may infer goal intent; call get_goal before update_goal.',
    'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  ].join('\n\n')
  const opts = { system: sys }
  // 目录里故意留一个永不桥接的工具（ralph），这样两种情况下路由声明都还在，
  // 差别只体现在"点了谁的名"上，断言才有区分度。
  const cat = ['bash', 'read', 'write', 'edit', 'get_goal', 'create_goal', 'update_goal', 'ralph']
    .map((name) => ({ name }))
  const BRIDGED = ['bash', 'job_output', 'job_kill', 'get_goal', 'create_goal', 'update_goal', 'read', 'read_image', 'write', 'edit']

  const off = buildSystemAppend(opts, cat, [])
  const on = buildSystemAppend(opts, cat, BRIDGED)

  // 调用点①：系统提示按段过滤
  check('① 关掉后 goal 段被删掉（v25 行为）', !off.includes('create_goal may infer'))
  check('①对照 打开时 goal 段保留', on.includes('create_goal may infer'))
  check('① 两种情况下 bash 段都保留', off.includes('[exit code: N]') && on.includes('[exit code: N]'))
  check('① 两种情况下环境段都保留', off.includes('DeepSeek Harness') && on.includes('DeepSeek Harness'))

  // 调用点②：作废声明
  check('② 关掉后声明点名 goal', /NOT callable/.test(off) && off.includes('create_goal'))
  check('②对照 打开后声明不点名 goal', !on.slice(on.indexOf('NOT callable')).split('applies instead')[0].includes('create_goal'))
  check('② 两种情况下都点名 ralph（永不桥接）', off.includes('ralph') && on.includes('ralph'))
  check('② 关掉后仍推荐原生 Bash', /equivalents \([^)]*Bash/.test(off))
  check('②对照 打开后不再推荐原生 Bash', !/equivalents \([^)]*Bash/.test(on))

  // 调用点③：真名说明段
  check('③ 关掉后没有"真名"说明段（v25 行为）', !off.includes('Harness tools available here'))
  check('③对照 打开后有真名说明段', on.includes('Harness tools available here'))
  check('③ 关掉后整段提示里不出现 mcp__dsh__', !off.includes('mcp__dsh__'))

  // 调用点④：原生工具开关
  const offOverride = buildNativeToolOverride([], ['AskUserQuestion'])
  const onOverride = buildNativeToolOverride(BRIDGED, ['AskUserQuestion'])
  check('④ 关掉后一个原生工具都不关', (offOverride.disallowedTools ?? []).join(',') === 'AskUserQuestion')
  check('④ 关掉后没有重定向', offOverride.toolAliases === undefined)
  check('④ 关掉后 AskUserQuestion 那条不丢', (offOverride.disallowedTools ?? []).includes('AskUserQuestion'))
  check('④对照 打开后关掉 Bash/Read/Write/Edit',
    ['Bash', 'Read', 'Write', 'Edit'].every((n) => (onOverride.disallowedTools ?? []).includes(n)))
  check('④对照 打开后有重定向', onOverride.toolAliases?.Bash === 'mcp__dsh__bash')

  // 调用点⑤（显示名）：关掉后没有 mcp__dsh__ 名字流进来，映射自然是空转
  check('⑤ 关掉后原生名字原样通过', bridgeDisplayName('Read') === 'Read' && bridgeDisplayName('Bash') === 'Bash')
  check('⑤ 真外挂 MCP 名字始终不动', bridgeDisplayName('mcp__filesystem__write_file') === 'mcp__filesystem__write_file')
}

console.log(`\n${fail === 0 ? 'all checks passed' : fail + ' FAILED'} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
