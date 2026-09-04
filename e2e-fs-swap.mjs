// 端到端验证 v28：内层 Claude Code 的 Read/Write/Edit 换成 DSH 的之后，
// 「读完再改」这条链还能不能走通。
//
// 这是部署前的必过关：DSH 的 edit 只接受「本 agent 会话已通过 DSH 工具读过」
// 的路径（dsh-fs-observation-policy 的 editIntent）。如果观察记录对不上，
// 内层会彻底失去改文件的能力。
//
// 跑法：node e2e-fs-swap.mjs

import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import * as zmod from 'zod'
import { buildDshToolBridge, buildNativeToolOverride, bridgeDisplayName } from './main.v20.mjs'

const z = zmod.z ?? zmod.default?.z ?? zmod.default
const TARGET = new URL('./e2e-fs-target.txt', import.meta.url).pathname

// —— 假的 DSH 侧：只做两件事，记录观察、按观察放行 ——
// 复刻 dsh-fs-observation-policy 的判定，不是真的 DSH，但策略逻辑一致。
const observed = new Map()
const calls = []

const FAKE_TOOLS = {
  read: {
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
      required: ['file_path'],
    },
  },
  write: {
    name: 'write',
    description: 'Create a file or completely replace its contents.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
  edit: {
    name: 'edit',
    description: 'Replace literal old_string with new_string in an existing file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
}

// 桥的 handler 走 ctx.tools.execute()，所以假 ctx 必须同时提供 get 和 execute。
const fakeCtxTools = {
  get: (name) => FAKE_TOOLS[name],
  execute: (input) => fakeExecute(input),
}

const AGENT = { id: 'agent-1', status: 'running', session: { id: 'sess-1' } }
const fakeAgents = { currentInitiator: () => AGENT }

// 复刻 DSH 的执行入口 + 观察策略
const fakeExecute = async ({ name, arguments: args }) => {
  calls.push({ name, args })
  const owner = AGENT.session
  const key = args.file_path

  if (name === 'read') {
    const text = readFileSync(key, 'utf8')
    observed.set(`${owner.id}:${key}`, { kind: 'present', version: 1 })
    return { content: [{ type: 'text', text }] }
  }
  if (name === 'write') {
    const prior = observed.get(`${owner.id}:${key}`)
    // writeIntent：没观察过 → createIfAbsent，已存在则失败
    if (prior === undefined) {
      return { content: [{ type: 'text', text: 'Error: file exists and was not observed (createIfAbsent)' }], isError: true }
    }
    writeFileSync(key, args.content)
    observed.set(`${owner.id}:${key}`, { kind: 'present', version: 2 })
    return { content: [{ type: 'text', text: 'written' }] }
  }
  if (name === 'edit') {
    const prior = observed.get(`${owner.id}:${key}`)
    // editIntent：没观察过 → FS_NOT_OBSERVED
    if (prior === undefined) {
      return { content: [{ type: 'text', text: `Error: edit requires reading "${key}" first` }], isError: true }
    }
    const before = readFileSync(key, 'utf8')
    if (!before.includes(args.old_string)) {
      return { content: [{ type: 'text', text: 'Error: old_string not found' }], isError: true }
    }
    writeFileSync(key, before.replace(args.old_string, args.new_string))
    return { content: [{ type: 'text', text: 'edited' }] }
  }
  return { content: [{ type: 'text', text: 'unknown tool' }], isError: true }
}

// —— 建桥 ——
const bridge = buildDshToolBridge({
  createSdkMcpServer,
  tool,
  z,
  tools: fakeCtxTools,
  agents: fakeAgents,
  names: ['read', 'write', 'edit'],
  execute: fakeExecute,
  callId: () => `probe-${Math.random().toString(36).slice(2)}`,
  logger: console,
})

if (bridge === undefined) {
  console.error('桥没建起来，后面免谈')
  process.exit(1)
}

// Bash 也一起关掉，否则内层会绕过桥接的文件工具直接跑 shell 改文件 —— 那就
// 测不到观察策略这条链了。Agent/Task 同理：子代理会带回一整套原生工具。
const override = buildNativeToolOverride(bridge.names, ['Bash', 'Agent', 'Task', 'NotebookEdit'])

console.log('桥接到的工具:', bridge.names)
console.log('关掉的原生工具:', override.disallowedTools)
console.log('重定向:', override.toolAliases)
console.log('显示名:', bridge.names.map((n) => `${n} → ${bridgeDisplayName(n)}`).join(', '))
console.log()

writeFileSync(TARGET, '原始第一行\n原始第二行\n')

const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
  return ok ? 0 : 1
}
let fail = 0

console.log('让内层改一个文件（它只有 DSH 的工具可用）')
for await (const message of query({
  prompt: `把 ${TARGET} 里的「原始第二行」改成「已经改过了」。改完复述一句结果。`,
  options: {
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    // 和实际部署对齐：插件会在系统提示里点名桥接工具的真名（buildSystemAppend
    // 的 bridged 说明）。不点名内层就只能靠 ToolSearch 猜关键词，实测猜不中。
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `Bridged DSH tools are callable here under these exact names: ${bridge.names.join(', ')}. `
        + 'Read a file with mcp__dsh__read, change it with mcp__dsh__edit.',
    },
    mcpServers: { dsh: bridge.server },
    allowedTools: bridge.allowed,
    ...override,
  },
})) {
  if (message?.type === 'assistant') {
    for (const block of message.message?.content ?? []) {
      if (block?.type === 'tool_use') console.log(`  ▶ 内层调用: ${bridgeDisplayName(block.name)}`)
      if (block?.type === 'text' && block.text.trim()) console.log(`  ▶ 内层说: ${block.text.trim().slice(0, 120)}`)
    }
  }
}

console.log()
console.log('验证')
const final = readFileSync(TARGET, 'utf8')
const order = calls.map((c) => c.name)

fail += check('文件真的被改了', final.includes('已经改过了'), JSON.stringify(final))
fail += check('原始第一行没被破坏', final.includes('原始第一行'))
fail += check('DSH 侧收到了调用', calls.length > 0, order.join(' → '))
fail += check('先读后改（观察策略要求的顺序）', order.indexOf('read') !== -1 && order.indexOf('read') < order.lastIndexOf('edit'), order.join(' → '))
fail += check('没有出现 FS_NOT_OBSERVED 死循环', calls.filter((c) => c.name === 'edit').length <= 3, `edit 调了 ${calls.filter((c) => c.name === 'edit').length} 次`)
fail += check('原生 Read/Write/Edit 都被关掉', ['Read', 'Write', 'Edit'].every((n) => override.disallowedTools.includes(n)), override.disallowedTools.join(','))
fail += check('显示名映射成原生名', bridgeDisplayName('mcp__dsh__edit') === 'Edit' && bridgeDisplayName('mcp__dsh__read') === 'Read')

rmSync(TARGET, { force: true })

console.log(`\n${fail === 0 ? 'all checks passed' : `${fail} FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
