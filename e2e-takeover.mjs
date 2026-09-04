import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
const zmod = await import('zod')
const z = zmod.z ?? zmod.default?.z ?? zmod.default

// 假装这是 DSH 的两个工具
const calls = []
const server = createSdkMcpServer({
  name: 'dsh',
  version: '1.0.0',
  tools: [
    tool('dsh_read', '读取一个文本文件的内容', { path: z.string() },
      async (args) => {
        calls.push(['dsh_read', args])
        return { content: [{ type: 'text', text: '第一行\n第二行\n第三行' }] }
      }),
    tool('dsh_bash', '在 DSH 沙箱里执行 shell 命令', { command: z.string() },
      async (args) => {
        calls.push(['dsh_bash', args])
        return { content: [{ type: 'text', text: 'DSH沙箱执行结果: 3' }] }
      }),
  ],
})

const MY_SYSTEM = `你是 DSH 的执行代理。你只有 dsh_read 和 dsh_bash 两个工具。
回答一律用中文。每次动手前先说一句你要干什么。`

const q = query({
  prompt: '读一下 /tmp/demo.txt，然后用 shell 统计它有几行。',
  options: {
    model: 'sonnet',
    systemPrompt: MY_SYSTEM,          // ① 换掉 Claude Code 自己的提示词
    tools: [],                         // ② 关掉全部内置工具
    settingSources: [],                // ③ 不加载 CLAUDE.md
    mcpServers: { dsh: server },       // ④ 只给 DSH 的工具
    permissionMode: 'bypassPermissions',
    allowedTools: ['mcp__dsh__dsh_read', 'mcp__dsh__dsh_bash'],
  },
})

const used = new Set()
for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message.content ?? []) {
      if (b.type === 'tool_use') { used.add(b.name); console.log('▶ 调用:', b.name, JSON.stringify(b.input)) }
      if (b.type === 'text' && b.text.trim()) console.log('▶ 说:', b.text.trim().slice(0, 100))
    }
  }
}
console.log('\n--- 它用过的工具 ---')
console.log([...used].join('\n') || '(一个都没用)')
console.log('--- DSH 侧实际收到 ---')
for (const c of calls) console.log('  ', c[0], JSON.stringify(c[1]))
