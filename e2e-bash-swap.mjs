// 端到端：把内层的 Bash 换成 DSH 的，确认 Skill 系统不受影响。
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { buildNativeToolOverride } from './main.v20.mjs'
const zmod = await import('zod')
const z = zmod.z ?? zmod.default?.z ?? zmod.default

const dshCalls = []
const server = createSdkMcpServer({ name: 'dsh', version: '1.0.0', tools: [
  tool('bash', 'Execute a bash command and return its stdout/stderr.',
    { command: z.string(), description: z.string() },
    async (a) => { dshCalls.push(a.command); return { content: [{ type: 'text', text: '[DSH沙箱] ' + a.command + ' -> ok' }] } }),
]})

const override = buildNativeToolOverride(['bash'], [])
console.log('生效的开关:', JSON.stringify(override))

async function ask(prompt) {
  const q = query({ prompt, options: {
    model: 'sonnet',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    mcpServers: { dsh: server },
    permissionMode: 'bypassPermissions',
    allowedTools: ['mcp__dsh__bash'],
    ...override,
  }})
  let text = ''
  for await (const m of q) if (m.type === 'assistant') for (const b of m.message.content ?? []) {
    if (b.type === 'tool_use') console.log('  ▶ 调用:', b.name)
    if (b.type === 'text') text += b.text
  }
  return text.trim()
}

console.log('\n--- 问它有哪些工具 ---')
console.log((await ask('把你能用的工具名字全列出来，一行一个，不要解释。')).slice(0, 400))

console.log('\n--- 让它跑个命令 ---')
console.log((await ask('执行 echo hi，把工具返回的内容原样贴给我。')).slice(0, 200))
console.log('\n--- DSH 侧实际收到的命令 ---')
console.log(dshCalls.length ? dshCalls.join('\n') : '(没收到)')
