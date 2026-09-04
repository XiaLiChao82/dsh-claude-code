// 验证 v23 的 /compact 分流：不需要真的起 dsh，用假 ctx 跑一遍 apply。
import { apply, planReplay, usageOf, resolveEffectivePermissionMode, stripAbsentToolGuidance, buildSystemAppend, jsonSchemaToZodShape, toMcpResult, buildDshToolBridge, buildNativeToolOverride, bridgeDisplayName, buildToolActivityBlock, describeToolActivityFolds, serializeConversation, appendMirrorEvent, buildMirrorChildMeta, buildMirrorDescriptor, buildMirrorToolCallBlock, buildMirrorToolResultBlock, buildMirrorUserEvent, buildMirrorAssistantEvent, buildMirrorToolResultEvent, createMirrorCollector, MIRROR_DESCRIPTOR_VERSION, DEFAULTS } from './main.v20.mjs'
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

// ── ⑥ replay 隔离标记（v31）────────────────────────────────────────────
// 全量 replay 把整段历史的活动块一次性灌进 prompt。这些块是纯文本，和模型
// 自己的正文之间没有边界，于是模型把这个形状当成可续写的输出格式，在正文
// 末尾伪造出下一次调用的卡片头（实测：resume 的 6 轮 0 处，重启后全量
// replay 那一轮 11 处）。标签把它们标成结构化记录而不是待模仿的样式。
{
  const activity = (name, summary, output = 'ok') => buildToolActivityBlock(
    { name, input: { description: summary } }, output, false,
  )
  const one = serializeConversation([{ role: 'assistant', content: [activity('Bash', 'git status')] }])
  check('⑥ 活动块 replay 带隔离标记',
    one.includes('<tool-activity>') && one.includes('</tool-activity>'), one.slice(0, 90))
  check('⑥ 标记内保留 ▸ sentinel（replayText 靠它识别活动块）',
    one.includes('<tool-activity>\n▸ Bash ✓ · git status\n$ git status'), one.slice(0, 140))

  // fold 模式的活动块走 reasoning 通道，文本自身以 ▸ 开头
  const fold = serializeConversation([
    { role: 'assistant', content: [{ type: 'reasoning', text: '▸ Bash ✓ · ls\n$ ls\n\nout' }] },
  ])
  check('⑥ fold 活动块同样被隔离', fold.includes('<tool-activity>'), fold)
  const legacy = serializeConversation([
    { role: 'assistant', content: [{ type: 'text', text: '‹ Bash ✓ out' }] },
  ])
  check('⑥ legacy ‹ 前缀同样被隔离', legacy.includes('<tool-activity>'), legacy)

  // 真实思考与正文绝不能被包裹 —— 那等于把这个形状教给它
  const prose = serializeConversation([
    { role: 'assistant', content: [
      { type: 'reasoning', text: '我在想这个问题' },
      { type: 'text', text: '结论是这样' },
    ] },
  ])
  check('⑥ 真实思考与正文不被包裹', !prose.includes('<tool-activity>'), prose)

  // 裁剪仍生效；标签是固定开销，不占内容预算
  const long = serializeConversation([
    { role: 'assistant', content: [activity('Bash', 'build', 'x'.repeat(3000))] },
  ])
  check('⑥ 超长活动块仍被裁剪', long.includes('… [replay truncated]'), long.slice(-60))
  const head = '<tool-activity>\n'
  const inner = long.slice(long.indexOf(head) + head.length, long.lastIndexOf('\n</tool-activity>'))
  check('⑥ 标签在裁剪预算之外', inner.length <= 800 + '\n… [replay truncated]'.length, `inner=${inner.length}`)
}

// ── ⑦ 子代理镜像的事件形状 ────────────────────────────────────────────
//
// 这组断言守的是 DSH 会话存储格式里【只在第三层校验器（projection fold）才
// 暴露】的三个陷阱。为什么必须在这里守：
//
//   · Session.append 会接受错误形状
//   · sessionPersistence.append 会把它落盘
//   · 同进程 persistence.inspect() 会原样读回来，一切看着正常
//   · 只有 projection fold 抛错，而 listChildren 把真错吞成
//     corrupt/unavailable/unsupported 三选一
//
// 结果就是：形状写错不会让任何测试变红，而是变成用户界面上的
// 「会话记录损坏」。三处形状实测都踩过，下面按「正向断言 + 反向断言」成对
// 写——只断言正确字段存在是不够的，必须同时断言错误字段【不存在】，否则
// 有人把 id 改回 toolCallId 时，正向断言依然全绿。
//
// 注意本文件跑的是假 ctx，装不下真 projection，所以这层只能查形状。
// 真 fold 的验证要用 .probe-subagent 的 --patch + headless 探针。
{
  const call = buildMirrorToolCallBlock({ id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } })
  check('⑦ tool-call 用 id/name（不是 toolCallId/toolName）',
    call.id === 'toolu_1' && call.name === 'Bash'
    && !('toolCallId' in call) && !('toolName' in call), JSON.stringify(call))
  check('⑦ tool-call 的 arguments 是 JSON 字符串（不是对象 input）',
    typeof call.arguments === 'string' && !('input' in call)
    && JSON.parse(call.arguments).command === 'echo hi', typeof call.arguments)
  check('⑦ 已序列化的 input 原样透传，不二次编码',
    buildMirrorToolCallBlock({ id: 'x', name: 'y', input: '{"a":1}' }).arguments === '{"a":1}')
  check('⑦ 缺 id 时自动补，不留空串',
    typeof buildMirrorToolCallBlock({ name: 'y' }).id === 'string'
    && buildMirrorToolCallBlock({ name: 'y' }).id.length > 0)

  const res = buildMirrorToolResultBlock({ callId: 'toolu_1', text: 'hi' })
  check('⑦ tool-result 反过来用 toolCallId（与 tool-call 命名不一致）',
    res.toolCallId === 'toolu_1' && !('id' in res), JSON.stringify(res))

  const [uType, uData, uOpts] = buildMirrorUserEvent({ text: '任务', senderSessionId: 'session-p' })
  check('⑦ user/message 的 id 在 data 顶层', uType === 'user/message'
    && typeof uData.id === 'string' && uData.id.length > 0)
  check('⑦ user/message 带 surfaceOp', uOpts?.surfaceOp === 'append')
  check('⑦ 有 sender 时用 agent-message/relay',
    uData.source.kind === 'agent-message' && uData.source.senderSessionId === 'session-p')
  check('⑦ 无 sender 时降级为普通 user 来源',
    buildMirrorUserEvent({ text: 'x' })[1].source.kind === 'user')

  const [aType, aData, aOpts] = buildMirrorAssistantEvent({ content: [{ type: 'text', text: 'hi' }], model: 'opus' })
  check('⑦ assistant/message 的 id 在 data.message（不在 data 顶层）',
    aType === 'assistant/message' && typeof aData.message.id === 'string'
    && aData.message.id.length > 0 && aData.id === undefined)
  check('⑦ assistant/message 带 surfaceOp', aOpts?.surfaceOp === 'append')

  const [tType, tData, tOpts] = buildMirrorToolResultEvent({ callId: 'toolu_1', text: 'hi' })
  check('⑦ tool/result 的 id 也在 data.message',
    tType === 'tool/result' && typeof tData.message.id === 'string' && tData.id === undefined)
  check('⑦ tool/result 的 role 是 user（不是 tool）', tData.message.role === 'user')
  check('⑦ tool/result 的 source 指回原调用', tData.message.source.kind === 'tool'
    && tData.message.source.callId === 'toolu_1')
  check('⑦ tool/result 带 surfaceOp', tOpts?.surfaceOp === 'append')

  check('⑦ descriptor 版本与 mode', (() => {
    const d = buildMirrorDescriptor({ provider: 'claude-code-task', label: 'L' })
    return d.version === MIRROR_DESCRIPTOR_VERSION && d.mode === 'one-shot' && d.label === 'L'
  })())
  check('⑦ 子会话 meta 带 origin:subagent', (() => {
    const m = buildMirrorChildMeta({ cwd: '/w', parentSession: 'session-p' })
    return m.origin === 'subagent' && m.parentSession === 'session-p' && m.delegationDepth === 1
  })())

  // appendMirrorEvent 是「surfaceOp 漏不掉」的最后一环：三元组里带 opts 就必须
  // 透传，不带就必须只传两个参数（非 surface 事件多传会被 append 拒绝）。
  const seen = []
  const fakeSession = { append: (...args) => { seen.push(args); return { seq: seen.length } } }
  appendMirrorEvent(fakeSession, buildMirrorUserEvent({ text: 'x' }))
  appendMirrorEvent(fakeSession, ['turn/start', { turn: 1 }, undefined])
  check('⑦ appendMirrorEvent 透传 surface 事件的第三参数',
    seen[0].length === 3 && seen[0][2].surfaceOp === 'append', JSON.stringify(seen[0]?.length))
  check('⑦ appendMirrorEvent 对非 surface 事件只传两个参数',
    seen[1].length === 2, JSON.stringify(seen[1]?.length))
}

// ── ⑧ 子代理镜像收集器 ─────────────────────────────────────────────────
//
// 收集器把 SDK 消息流折叠成 open/events/close 三种动作。它是纯闭包，所以这里
// 能完整测；写盘的驱动只是把三种动作映射成 sessions.create / appendMirrorEvent
// / sessionPersistence.append，风险都压在这一半。
//
// 重点覆盖边界：主流与子流靠 parent_tool_use_id 区分（null 是外层），
// 非 Task 工具不得触发，未知父 id 不得触发，关闭后不得再接受，并发任务不得混。
{
  const assistant = (parentId, content) => ({ type: 'assistant', parent_tool_use_id: parentId, message: { content } })
  const user = (parentId, content) => ({ type: 'user', parent_tool_use_id: parentId, message: { content } })
  const taskUse = (id, input) => ({ type: 'tool_use', id, name: 'Task', input })

  {
    const c = createMirrorCollector({ senderSessionId: 'session-parent', model: 'claude-opus-5' })
    const opened = c.observe(assistant(null, [taskUse('task-1', {
      description: '查依赖树', prompt: '请检查依赖', subagent_type: 'Explore',
    })]))
    check('⑧ Task 调用产出 open 动作', opened.length === 1 && opened[0].kind === 'open'
      && opened[0].taskId === 'task-1')
    check('⑧ label 取 description', opened[0].label === '查依赖树')
    check('⑧ subagent_type 被带出', opened[0].subagentType === 'Explore')
    check('⑧ open 的事件是 turn/start + user + step/start', (() => {
      const types = opened[0].events.map(e => e[0])
      return types.join(',') === 'turn/start,user/message,step/start'
    })(), JSON.stringify(opened[0].events.map(e => e[0])))
    check('⑧ 提示词进了 user/message', opened[0].events[1][1].content[0].text === '请检查依赖')
    check('⑧ openTaskIds 反映未闭合任务', c.openTaskIds().join() === 'task-1')

    // 子代理的思考 + 正文 + 工具调用
    const acts = c.observe(assistant('task-1', [
      { type: 'thinking', thinking: '先看 package.json' },
      { type: 'text', text: '开始检查' },
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
    ]))
    check('⑧ 子代理消息产出 events 动作', acts.length === 1 && acts[0].kind === 'events'
      && acts[0].taskId === 'task-1')
    const inner = acts[0].events[0][1].message.content
    check('⑧ thinking 映射成 reasoning', inner[0].type === 'reasoning' && inner[0].text === '先看 package.json')
    check('⑧ text 原样保留', inner[1].type === 'text' && inner[1].text === '开始检查')
    check('⑧ 子代理的 tool_use 转成合规 tool-call 块',
      inner[2].type === 'tool-call' && inner[2].id === 'call-1' && inner[2].name === 'Bash'
      && typeof inner[2].arguments === 'string' && !('input' in inner[2]))

    // 子代理的工具结果
    const resActs = c.observe(user('task-1', [
      { type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'a.js' }], is_error: false },
    ]))
    check('⑧ 子代理工具结果产出 tool/result',
      resActs[0].events[0][0] === 'tool/result'
      && resActs[0].events[0][1].message.source.callId === 'call-1')

    // 空消息（例如只带 usage）不该产出无内容的行
    check('⑧ 空内容的子代理消息不产出动作', c.observe(assistant('task-1', [])).length === 0)
    check('⑧ redacted_thinking 被丢弃而非变成空块',
      c.observe(assistant('task-1', [{ type: 'redacted_thinking', data: 'x' }])).length === 0)

    // Task 结果回到主流 → close
    const closed = c.observe(user(null, [
      { type: 'tool_result', tool_use_id: 'task-1', content: [{ type: 'text', text: '完成' }], is_error: false },
    ]))
    check('⑧ Task 结果产出 close 动作', closed.length === 1 && closed[0].kind === 'close'
      && closed[0].taskId === 'task-1')
    check('⑧ close 的事件是 step/end + turn/end + title', (() => {
      const types = closed[0].events.map(e => e[0])
      return types.join(',') === 'step/end,turn/end,session/title'
    })(), JSON.stringify(closed[0].events.map(e => e[0])))
    check('⑧ 标题用 Task 的 description',
      closed[0].events[2][1].title === '查依赖树')
    check('⑧ 成功的 turn/end 是 completed',
      closed[0].events[1][1].reason.kind === 'completed')
    check('⑧ close 后 openTaskIds 清空', c.openTaskIds().length === 0)
    check('⑧ close 后该 id 的子消息不再被接受',
      c.observe(assistant('task-1', [{ type: 'text', text: '迟到' }])).length === 0)
  }

  // 非 Task 工具不得触发镜像
  {
    const c = createMirrorCollector({})
    check('⑧ 非 Task 的 tool_use 不产出任何动作',
      c.observe(assistant(null, [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }])).length === 0
      && c.openTaskIds().length === 0)
  }

  // 未知父 id 的子消息不得触发（防止把别的东西当成子代理）
  {
    const c = createMirrorCollector({})
    check('⑧ 未知父 id 的消息被忽略',
      c.observe(assistant('never-opened', [{ type: 'text', text: 'x' }])).length === 0)
  }

  // 并发任务必须分组，不能混
  {
    const c = createMirrorCollector({})
    c.observe(assistant(null, [
      taskUse('t-a', { description: 'A', prompt: 'pa' }),
      taskUse('t-b', { description: 'B', prompt: 'pb' }),
    ]))
    check('⑧ 一条消息里的两个 Task 各自 open', c.openTaskIds().join() === 't-a,t-b')
    const a = c.observe(assistant('t-a', [{ type: 'text', text: 'from A' }]))
    const b = c.observe(assistant('t-b', [{ type: 'text', text: 'from B' }]))
    check('⑧ 并发子流按 taskId 分组', a[0].taskId === 't-a' && b[0].taskId === 't-b'
      && a[0].events[0][1].message.content[0].text === 'from A'
      && b[0].events[0][1].message.content[0].text === 'from B')
    const closedA = c.observe(user(null, [{ type: 'tool_result', tool_use_id: 't-a', content: [], is_error: true }]))
    check('⑧ 失败的 turn/end 是 error', closedA[0].events[1][1].reason.kind === 'error')
    check('⑧ 关掉一个不影响另一个', c.openTaskIds().join() === 't-b')
  }
}

console.log(`\n${fail === 0 ? 'all checks passed' : fail + ' FAILED'} (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
