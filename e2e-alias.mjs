import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
const zmod = await import('zod')
const z = zmod.z ?? zmod.default?.z ?? zmod.default

const calls = []
const server = createSdkMcpServer({
  name: 'dsh', version: '1.0.0',
  tools: [
    tool('bash', '在 DSH 沙箱里执行命令', { command: z.string(), description: z.string().optional() },
      async (a) => { calls.push(a); return { content: [{ type: 'text', text: 'DSH沙箱跑的: hello-from-dsh' }] } }),
  ],
})

const q = query({
  prompt: '执行 echo hello 并把输出原样告诉我。',
  options: {
    model: 'sonnet',
    // 保留 Claude Code 自己的提示词和技能系统
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    mcpServers: { dsh: server },
    // 关键：内置 Bash 关掉，但模型喊 Bash 时重定向到 DSH 的
    disallowedTools: ['Bash'],
    toolAliases: { Bash: 'mcp__dsh__bash' },
    permissionMode: 'bypassPermissions',
    allowedTools: ['mcp__dsh__bash'],
  },
})

for await (const m of q) {
  if (m.type === 'assistant') for (const b of m.message.content ?? []) {
    if (b.type === 'tool_use') console.log('▶ 模型喊的名字:', b.name, JSON.stringify(b.input).slice(0,80))
    if (b.type === 'text' && b.text.trim()) console.log('▶ 说:', b.text.trim().slice(0,120))
  }
}
console.log('\n--- DSH 侧实际收到 ---')
console.log(calls.length ? JSON.stringify(calls) : '(没收到，重定向失败)')
