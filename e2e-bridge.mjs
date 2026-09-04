// 端到端：真 SDK + 真 createSdkMcpServer + 插件写的桥 + 假的 DSH tools 服务。
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { buildDshToolBridge, buildSystemAppend } from './main.v20.mjs'

const zod = await import('zod').then((m) => m.z ?? m.default?.z ?? m.default)

const GOAL = {
  get_goal: { description: 'Return the current goal, its exact id and revision.', parameters: { type: 'object', properties: {} } },
  update_goal: {
    description: 'Update the exact current goal revision. Use action complete when the objective is achieved.',
    parameters: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'Exact id returned by get_goal.' },
        revision: { type: 'number', description: 'Exact revision returned by get_goal.' },
        action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'], description: 'what to do' },
      },
      required: ['goal_id', 'revision', 'action'],
    },
  },
}

const calls = []
const agent = { id: 'agent-1', status: 'running' }
const bridge = buildDshToolBridge({
  createSdkMcpServer, tool, z: zod,
  tools: {
    get: (name) => (GOAL[name] ? { name, ...GOAL[name] } : undefined),
    execute: async (input) => {
      calls.push(input)
      if (input.name === 'get_goal') {
        return { content: [{ type: 'text', text: JSON.stringify({ goal_id: 'goal-77', revision: 3, objective: '把上下文百分比修对' }) }] }
      }
      return { content: [{ type: 'text', text: 'goal goal-77 marked complete at revision 3' }] }
    },
  },
  agents: { currentInitiator: () => agent },
  callId: () => `bridge-${calls.length}`,
})

console.log('桥接到的工具:', bridge?.names, '→', bridge?.allowed)

const append = buildSystemAppend(
  { system: 'You are an AI agent powered by DeepSeek Harness.\n\nUse goal tools for one long-running objective. Call get_goal before update_goal and copy its exact goal_id and revision.' },
  [{ name: 'get_goal' }, { name: 'update_goal' }, { name: 'memory_search' }],
  bridge.names,
)

const q = query({
  prompt: '当前目标已经达成了。请按 DSH 的目标流程把它标记为完成。',
  options: {
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    settingSources: [],
    mcpServers: { dsh: bridge.server },
    allowedTools: bridge.allowed,
    systemPrompt: { type: 'preset', preset: 'claude_code', append },
    maxTurns: 8,
  },
})

for await (const m of q) {
  if (m.type === 'assistant') for (const b of m.message.content ?? []) {
    if (b.type === 'tool_use') console.log('▶ 内层调用:', b.name, JSON.stringify(b.input))
    if (b.type === 'text' && b.text.trim()) console.log('▶ 内层回复:', b.text.trim().slice(0, 160))
  }
}
console.log('--- DSH 侧实际收到的执行请求 ---')
for (const c of calls) console.log('  ', c.name, JSON.stringify(c.arguments), 'agent =', c.agent?.id)
