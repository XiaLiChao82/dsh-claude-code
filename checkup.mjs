// Post-upgrade checkup for llm-claude-code.
//
// WHY THIS EXISTS, separate from verify-compact.mjs:
//   verify-compact.mjs runs apply() against a FAKE ctx that this repo writes.
//   It proves the plugin's own logic is intact — and it keeps passing even when
//   the real DSH has renamed a service or changed a formula underneath, because
//   the fake ctx still answers to the old names. That is exactly the failure a
//   DSH upgrade produces, and it is silent: a soft ctx.get() that returns
//   undefined degrades to "leave config alone", so plan mode quietly becomes a
//   polite request again instead of an enforced constraint.
//
//   This script reads the REAL DSH tree instead. Every check names the feature
//   it protects, so a FAIL doubles as the triage note.
//
// Usage:
//   node checkup.mjs                    static checks only (seconds)
//   node checkup.mjs --live             also probe Claude Code's output formats
//   node checkup.mjs --root <path>      override the DSH package root
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This bundle's package name, as `dsh plugin add` records it in the profile. */
const PKG_NAME = 'dsh-llm-claude-code'

/** Resolve a path inside THIS package, independent of the caller's cwd. */
function ownPath(rel) {
  return fileURLToPath(new URL(rel, import.meta.url))
}

const DEFAULT_ROOT =
  '/home/sumer/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const argv = process.argv.slice(2)
const rootFlag = argv.indexOf('--root')
const ROOT = rootFlag >= 0 ? argv[rootFlag + 1] : (process.env.DSH_PKG_ROOT ?? DEFAULT_ROOT)
const LIVE = argv.includes('--live')

let pass = 0
const failures = []

/** Record one check. `impact` explains what breaks when it fails. */
function check(group, label, ok, impact, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failures.push({ group, label, impact, detail })
  console.log(`  FAIL  ${label}`)
  console.log(`        影响：${impact}`)
  if (detail !== undefined) console.log(`        实际：${detail}`)
}

function heading(text) {
  console.log(`\n${text}`)
}

/** grep -rl over the DSH tree; [] when nothing matches. */
function grepFiles(pattern, glob = '*/lib/index.js') {
  try {
    const out = execFileSync('grep', ['-rl', '--include', basename(glob), '-F', pattern, ROOT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\n').filter((line) => line.length > 0)
  } catch {
    return []
  }
}

function readIf(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

console.log('llm-claude-code 升级体检')
console.log(`DSH 包根目录: ${ROOT}`)
if (!existsSync(ROOT)) {
  console.log('\n找不到 DSH 包根目录 — 用 --root 指定，或确认 DSH 是否换了安装位置。')
  process.exit(1)
}

// ---------------------------------------------------------------- services
// A cordis Service registers itself as `super(ctx, "<name>")`. The plugin
// addresses every DSH capability by that string, so a rename is the single
// most likely upgrade break. Searching the whole tree (not one package) keeps
// this check alive across package renames — only the service NAME matters.
const HARD_SERVICES = [
  ['llm', '插件整个加载失败（注册模型路由用它）'],
  ['subprocess', '插件整个加载失败（解析 claude 可执行文件用它）'],
  ['tools', '插件整个加载失败（接收 DSH 工具目录用它）'],
  ['commands', '插件整个加载失败（注册 /compact 和 /goal 用它）'],
]
const SOFT_SERVICES = [
  ['planMode', '计划模式静默退化成一句建议 — 内层照样改文件（v24）'],
  ['permissionPresets', '切到只读预设后内层照样改文件（v24）'],
  ['compaction', '其他模型的 /compact 报「服务不可用」（v23）'],
  ['goals', '其他模型的 /goal 失效（v24）'],
  ['agents', '读不到当前会话 → 计划模式和权限映射双双失效（v24）'],
  ['attachments', '发图片报错（历史功能）'],
  ['userQuestions', '内层的 AskUserQuestion 问不出来（历史功能）'],
]

heading('DSH 服务名（插件按名字找它们，改名即失效）')
for (const [service, impact] of [...HARD_SERVICES, ...SOFT_SERVICES]) {
  const hits = grepFiles(`super(ctx, "${service}")`)
  check('services', `服务 ${service} 仍注册`, hits.length > 0, impact, hits.length === 0 ? '整个 DSH 树里搜不到这个服务名' : undefined)
}

// ---------------------------------------------------------------- methods
// Locate the file that registers each service, then look for the exact method
// the plugin calls on it. Locating first means a package rename cannot produce
// a false alarm here.
function serviceSource(service) {
  const hits = grepFiles(`super(ctx, "${service}")`)
  return hits.length === 0 ? undefined : readIf(hits[0])
}

heading('DSH 服务的方法名（插件直接调用它们）')
const planSrc = serviceSource('planMode')
check('methods', 'planMode.get(agent) 存在', planSrc !== undefined && planSrc.includes('get(agent) {'),
  '计划模式读不到状态 → 静默退化成建议（v24）')

const presetSrc = serviceSource('permissionPresets')
check('methods', 'permissionPresets.current(session) 存在', presetSrc !== undefined && presetSrc.includes('current(session) {'),
  '只读预设读不出来 → 内层照样改文件（v24）')

const goalSrc = serviceSource('goals')
for (const method of ['get', 'create', 'edit', 'pause', 'resume', 'clear']) {
  check('methods', `goals.${method}() 存在`, goalSrc !== undefined && goalSrc.includes(`\n\t\t${method}(agent`),
    `其他模型的 /goal 的 ${method} 子命令失效（v24）`)
}

// The seam package only declares CompactionEngine; compactNow() is implemented
// by whichever engine the composition mounts, so search the whole tree.
check('methods', 'compaction.compactNow() 有实现', grepFiles('compactNow(').length > 0,
  '其他模型的 /compact 无法委托给 DSH（v23）')

const agentSrc = serviceSource('agents')
check('methods', 'agents.currentInitiator() 存在', agentSrc !== undefined && agentSrc.includes('currentInitiator('),
  '拿不到当前会话 → 计划模式和权限映射双双失效（v24）')

// ---------------------------------------------------------------- semantics
heading('DSH 的语义假设（改了不报错，但结果算错）')

// v22 split prompt-side from cumulative usage because DSH treats the
// prompt-side fields as ONE request's context occupancy. If the formula stops
// summing cache traffic, that split turns from a fix into a new bug.
const meterSrc = readIf(join(ROOT, 'dsh-token-meter/lib/index.js'))
const PRESSURE = 'usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)'
check('semantics', '上下文压力公式未变', meterSrc !== undefined && meterSrc.includes(PRESSURE),
  '进度条和自动压缩阈值又变得不准（v22 的拆分基于这个公式）',
  meterSrc === undefined ? '找不到 dsh-token-meter' : '公式原文变了，需要重新推导拆分逻辑')

// v24 maps DSH's read-only preset onto the inner `plan` mode. The preset table
// is composition config, not code, so a bundle edit can silently rename a tier.
const bundleYmls = grepFiles('permission-presets', '*/cordis.patch.yml').map((f) => readIf(f) ?? '')
const hasTier = (tier) => bundleYmls.some((src) => src.includes(`${tier}:`))
for (const tier of ['read-only', 'workspace-write', 'danger-full-access']) {
  check('semantics', `权限档位 ${tier} 仍存在`, hasTier(tier),
    tier === 'read-only'
      ? '只读档识别不出来 → 内层照样改文件（v24 的映射靠这个名字）'
      : `${tier} 档识别不出来 → 权限映射判断失准（v24）`)
}

// v23 reproduces dsh-command-compact's error copy verbatim so other providers
// see no behavioural change. A new error code falls through to a generic
// message — not a crash, but a wording drift worth knowing about.
const compactCmdSrc = readIf(join(ROOT, 'dsh-command-compact/lib/index.js'))
const dshCodes = compactCmdSrc === undefined ? [] : [...new Set([...compactCmdSrc.matchAll(/case "([a-z-]+)"/g)].map((m) => m[1]))]
const pluginCodes = ['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence']
const missingCodes = dshCodes.filter((code) => !pluginCodes.includes(code))
check('semantics', '压缩错误码表覆盖完整', compactCmdSrc !== undefined && missingCodes.length === 0,
  '其他模型压缩失败时，文案退回成通用错误（不崩，但与 DSH 原版不一致，v23）',
  missingCodes.length > 0 ? `DSH 新增了未覆盖的错误码: ${missingCodes.join(', ')}` : undefined)

// v24 reuses dsh-command-goal's own definition instead of re-implementing it,
// so other providers keep DSH's exact copy and subcommands. Import failure is
// handled gracefully by the plugin, but it does mean other providers lose /goal.
const goalCmdDir = join(ROOT, 'dsh-command-goal')
const goalCmdSrc = readIf(join(goalCmdDir, 'lib/index.js'))
check('semantics', 'dsh-command-goal 仍存在', goalCmdSrc !== undefined,
  '其他模型的 /goal 降级为「不可用」（v24 复用的是它自己的定义）')
check('semantics', 'dsh-command-goal 仍注册名为 goal 的命令', goalCmdSrc !== undefined && goalCmdSrc.includes('name: "goal"'),
  '抓取 DSH 原命令定义失败 → 其他模型的 /goal 降级（v24）')

// v23/v24 key the inner-session map by options.sessionId, and the command
// handler looks it up by agent.session.id. Those must stay the same value.
const loopSrc = readIf(join(ROOT, 'dsh-agent-loop/lib/index.js'))
check('semantics', '会话 id 传参未变', loopSrc !== undefined && loopSrc.includes('sessionId: this.session.id'),
  '/compact 和 /goal 找不到内层会话 → 一律报「先说句话」（v23/v24）',
  loopSrc === undefined ? '找不到 dsh-agent-loop' : '外层传的 sessionId 不再等于 session.id')

// v30 bridges DSH's todo_write and switches the native TodoWrite off, so the
// inner agent's plan lands in the panel the user already reads for every other
// agent. The bridge picks the tool out of DSH's catalog BY NAME, and a missing
// name fails silently in the worst possible direction: BRIDGED_TOOL_NAMES finds
// nothing while REPLACED_NATIVE_TOOLS has already removed the native tool, so
// the inner agent ends up with no todo tool at all. Searched tree-wide, like
// the service names above, so a package rename alone cannot fail this.
//
// Deliberately NOT checked here: the `todo/write` event name, the `todos`
// projection and the argument schema. Those are internal to dsh-tool-todo or
// derived from its tool definition at runtime — the plugin hardcodes none of
// them, so they are DSH's business to keep consistent, not assumptions to guard.
const todoToolHits = grepFiles('name: "todo_write"')
check('semantics', 'DSH 仍注册 todo_write 工具', todoToolHits.length > 0,
  '桥接按名字挑不到工具，而内层原生 TodoWrite 已被关掉 → 内层一个 todo 工具都没有，计划面板全程空白（v30）',
  todoToolHits.length === 0 ? '整个 DSH 树里搜不到这个工具名 — BRIDGED_TOOL_NAMES 要跟着改' : undefined)

// ---------------------------------------------------------------- llm api
// 上面每一节都是「按名字查表」——服务名、方法名、工具名，插件用字符串找它们。
// 这一节不是：main.v20.mjs 直接 `import { ... } from '@deepseek-ai/dsh-llm'`，
// 是编译期绑定。两种漂移的可见度天差地别：
//
//   名字没了       → 插件加载时立刻炸，一眼能看见，谁也漏不掉。
//   签名变了       → 加载照常成功，要等真正走到那条代码路径才炸。
//
// 后者是这一节存在的唯一理由。真实案例：requestImageHandleText 从 (version)
// 变成 (ref, version, access?) 之后，只有「带图片发一条消息」会踩到，报
// `Cannot read properties of undefined (reading 'width')`；静态体检、冒烟测试、
// 日常纯文本对话全部照常通过，问题被藏了整整一个版本。
//
// 注意这一节读的是 NODE 解析出来的那份 dsh-llm，不是 --root 指的那棵树 —— 插件
// 运行时加载的就是前者，两者不一致时前者才是真相。
heading('dsh-llm 的导出契约（编译期绑定，签名漂移要到运行时才炸）')

const LLM_PKG = '@deepseek-ai/dsh-llm'
let llm
try {
  llm = await import(LLM_PKG)
} catch (error) {
  check('llm-api', `${LLM_PKG} 可导入`, false,
    '插件加载时就会失败 — 确认 node_modules/@deepseek-ai/dsh-llm 的 symlink 还指向当前 DSH 安装',
    String(error?.code ?? error?.message ?? error))
}

if (llm !== undefined) {
  // 导入清单从源码现读，不在这里再抄一份：抄一份迟早跟源码分家，
  // 那时这节检查的就是一份过期名单，比不检查更糟。
  const mainSrc = readIf(ownPath('main.v20.mjs')) ?? ''
  const importLine = /import\s*\{([^}]*)\}\s*from\s*'@deepseek-ai\/dsh-llm'/.exec(mainSrc)
  const imported = importLine === null
    ? []
    : importLine[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter((n) => n.length > 0)

  check('llm-api', '能从 main.v20.mjs 解析出 dsh-llm 的导入清单', imported.length > 0,
    '这一节等于没跑 — import 的写法变了，把这里的正则跟着改',
    importLine === null ? '匹配不到 import 语句' : undefined)

  for (const name of imported) {
    check('llm-api', `dsh-llm 仍导出 ${name}`, llm[name] !== undefined,
      '插件 import 失败 → 整个插件加载不了（main.v20.mjs 直接 import 了它）')
  }

  // --- requestImageHandleText：唯一一个已经真实咬过人的签名 ---------------
  // 两条检查刻意分开，因为它们抓的是不同的漂移，谁也替代不了谁。
  const handleText = llm.requestImageHandleText

  // 个数：抓「多一个 / 少一个参数」。可选参数只要没写默认值就计入
  // Function.length，所以上游哪天给 access 加个默认值，这里也会响一声 ——
  // 对这种一响就要人去核对的检查，保守误报远好过漏报。
  check('llm-api', 'requestImageHandleText 仍是 3 参数 (ref, version, access?)',
    typeof handleText === 'function' && handleText.length === 3,
    '带图片发送时报 Cannot read properties of undefined — prepareImageBlocks 的调用点要跟着改',
    typeof handleText === 'function' ? `实际参数个数: ${handleText.length}` : '不是函数')

  // 顺序：参数个数不变的对调，上面那条一点办法都没有，只能真调一次。
  // 探针的 ref 和 version 刻意给不同的尺寸（1600x1200 vs 800x600），参数一旦
  // 对调，断言的 800x600 立刻落空。
  if (typeof handleText === 'function') {
    const probeRef = {
      attachmentId: 'sha256:checkup',
      name: 'checkup.png',
      mediaType: 'image/png',
      width: 1600,
      height: 1200,
    }
    const probeVersion = { mediaType: 'image/png', width: 800, height: 600 }
    let text
    try {
      text = handleText(probeRef, probeVersion)
    } catch (error) {
      text = `抛错: ${String(error?.message ?? error)}`
    }
    check('llm-api', 'requestImageHandleText 的标识取自 ref、尺寸取自 version',
      text.includes('sha256:checkup') && text.includes('800x600'),
      '带图片发送时文案错乱或直接抛错（参数对调了，个数没变，上一条抓不到）',
      `实际返回: ${text.slice(0, 120)}`)
  }
}

// ---------------------------------------------------------------- ui patches
// These four live INSIDE the DSH install, so an upgrade always wipes them.
heading('界面补丁（在 DSH 目录内，升级必被覆盖）')
const MARKER = 'tool-activity'
// 0.1.2-rc.1 起 dsh-client-runtime 包被上游删除（be531688f3），分类器被内联进
// 每个消费者 bundle：chat 一份、trajectory 一份，两份都得打；卡片也从
// dsh-client-ui-conversation 搬到了 dsh-client-ui-chat。
const UI_TARGETS = [
  ['dsh-client-ui-chat/lib/client.js', '工具卡退回「未知内容块」/ 不渲染'],
  ['dsh-llm/lib/index.js', '中断后已完成的工具卡丢失'],
  ['dsh-client-ui-trajectory/lib/client.js', '轨迹面板崩溃（TypeError）'],
]
for (const [rel, impact] of UI_TARGETS) {
  const src = readIf(join(ROOT, rel))
  const hits = src === undefined ? 0 : src.split(MARKER).length - 1
  check('ui', `${basename(dirname(dirname(rel)))} 补丁在位`, hits > 0,
    `${impact} — 跑 node dsh-patches/tool-activity/apply.mjs 重打`,
    src === undefined ? '文件不存在' : hits === 0 ? '补丁已被升级覆盖' : undefined)
}

// ---------------------------------------------------------------- install
// v30 起本插件是正规组合包（见 DSH docs/user/develop/basic/publish.zh.md）：
// `dsh plugin --profile web add <本目录>` 装进 profile，包自带的
// cordis.patch.yml 负责自注册。所以这些检查校验的是 BUNDLE 安装是否成立，
// 不再检查旧的手工痕迹（往 plugins/ 拷文件 + 手改 profile 的 patch.yml）。
//
// 注意分工：profile 侧只证明"装了"，包侧证明"装进去的东西是对的"。两者都读
// 文件而不跑 `dsh --dump-config`，因为后者要在 profile 目录写 cordis.yml。
heading('安装状态（组合包）')
const PROFILE = join(process.env.HOME ?? '', '.dsh/profiles/web')

function readJson(path) {
  const raw = readIf(path)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

const bundles = readJson(join(PROFILE, 'package.json'))?.dsh?.profile?.bundles
check('install', `${PKG_NAME} 在 profile 的 bundles 列表里`, Array.isArray(bundles) && bundles.includes(PKG_NAME),
  '插件根本没加载 — 跑 dsh plugin --profile web add <本目录>',
  Array.isArray(bundles) ? `当前列表: ${bundles.join(', ')}` : '读不到 dsh.profile.bundles')

// 自带 patch 是自注册的唯一来源：声明丢了，dsh plugin 会把它当普通依赖装，
// 打一句警告然后不激活任何层——插件静默地不存在。
const ownPkg = readJson(ownPath('package.json'))
const patchRel = ownPkg?.dsh?.bundle?.patch
check('install', 'package.json 声明了 dsh.bundle.patch', typeof patchRel === 'string',
  '包不再是组合包 — dsh plugin 会当普通依赖装，不激活任何层')

const ownPatch = typeof patchRel === 'string' ? readIf(ownPath(patchRel)) : undefined
check('install', '自带 patch 注册了插件行', ownPatch !== undefined && /id:\s*llm-claude-code/.test(ownPatch),
  '插件不会被挂进任何 profile')
check('install', '自带 patch 关掉 DSH 的 /compact', ownPatch !== undefined && /id:\s*command-compact[\s\S]{0,40}disabled:\s*true/.test(ownPatch),
  '同名命令注册两次 → DSH 启动直接报错（v23）')
check('install', '自带 patch 关掉 DSH 的 /goal', ownPatch !== undefined && /id:\s*command-goal[\s\S]{0,40}disabled:\s*true/.test(ownPatch),
  '同名命令注册两次 → DSH 启动直接报错（v24）')

// 旧的手工挂载若残留，会和自带 patch 插入同一个 id 两次。
const profilePatch = readIf(join(PROFILE, 'cordis.patch.yml'))
check('install', 'profile 里没有残留的手写挂载', profilePatch === undefined || !/plugins\/llm-claude-code/.test(profilePatch),
  '同一个 id 被插入两次 — 删掉 profile cordis.patch.yml 里那段手写 insert')

// ---------------------------------------------------------------- live
// These assumptions belong to CLAUDE CODE, not DSH — a DSH upgrade cannot break
// them, and a Claude Code upgrade can. They are behind --live because verifying
// them means actually running an inner session.
//
//   · the exit code rides in the FIRST LINE of a failed Bash result
//     ("Exit code 3\nhello") — there is no separate field (v23)
//   · Read returns "<n>\t<text>" per line, which the read card parses back
//     into a gutter (v24)
//   · every inner assistant message carries its own message.usage, which is
//     where the prompt-side split reads the true context size from (v22)
//   · /compact and /goal are real slash commands the inner session answers to
//     (v23 forwards the first, v24 the second)
async function liveChecks() {
  heading('Claude Code 的输出格式（DSH 升级不影响，Claude Code 升级才影响）')
  let query
  try {
    ;({ query } = await import('@anthropic-ai/claude-agent-sdk'))
  } catch (error) {
    check('live', 'Agent SDK 可导入', false,
      '探测不了 Claude Code 侧的假设 — 换到装了依赖的目录跑（工作区或 profile 的 plugins 目录）',
      String(error?.code ?? error?.message ?? error))
    return
  }

  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'lcc-checkup-'))
  const sample = join(dir, 'sample.txt')
  writeFileSync(sample, 'alpha\nbeta\ngamma\n')

  const uses = new Map()
  const results = []
  let assistantUsage
  let resultUsage
  let commands

  try {
    const q = query({
      prompt:
        `Do exactly these two things with no explanation: `
        + `(1) run this shell command with Bash: bash -c "echo probe; exit 7"  `
        + `(2) read the file ${sample} with Read. Then stop.`,
      options: { cwd: dir, permissionMode: 'bypassPermissions', maxTurns: 6 },
    })

    // Ask before consuming: the command list is served from the session's init,
    // so it resolves without waiting for the turn to finish.
    try {
      commands = await q.supportedCommands()
    } catch {
      commands = undefined
    }

    for await (const message of q) {
      if (message?.type === 'assistant') {
        const usage = message.message?.usage
        if (usage !== undefined) assistantUsage = usage
        for (const block of message.message?.content ?? []) {
          if (block?.type === 'tool_use') uses.set(block.id, block.name)
        }
        continue
      }
      if (message?.type === 'user') {
        for (const block of message.message?.content ?? []) {
          if (block?.type === 'tool_result') {
            results.push({ tool: uses.get(block.tool_use_id), block })
          }
        }
        continue
      }
      if (message?.type === 'result') resultUsage = message.usage
    }
  } catch (error) {
    check('live', '探测会话跑通', false,
      '探测失败，无法判断格式假设是否成立 — 先确认 claude 能正常启动',
      String(error?.message ?? error))
    rmSync(dir, { recursive: true, force: true })
    return
  }
  rmSync(dir, { recursive: true, force: true })

  // --- slash commands (v23 forwards /compact, v24 forwards /goal)
  const names = (commands ?? []).map((c) => c?.name).filter((n) => typeof n === 'string')
  check('live', '拿到内层命令列表', names.length > 0,
    '判断不了 /compact 和 /goal 还是不是斜杠命令')
  if (names.length > 0) {
    check('live', '/compact 仍是内层斜杠命令', names.includes('compact'),
      'Claude Code 路由下的 /compact 转发失效 — 内层收到的会被当成普通文字（v23）')
    check('live', '/goal 仍是内层斜杠命令', names.includes('goal'),
      'Claude Code 路由下的 /goal 转发失效 — 内层收到的会被当成普通文字（v24）')
  }

  // --- failed Bash carries its exit code in the first line (v23)
  const bashFail = results.find((r) => r.tool === 'Bash' && r.block?.is_error === true)
  check('live', '失败的 Bash 结果第一行带退出码', (() => {
    const text = typeof bashFail?.block?.content === 'string' ? bashFail.block.content : ''
    return /^Exit code \d+/.test(text)
  })(),
    '终端卡的退出码显示不出来，红点也判断不准（v23 是从第一行解析的）',
    bashFail === undefined
      ? '这次探测没拿到失败的 Bash 结果（模型可能没照做，重跑一次）'
      : `实际首行: ${String(bashFail.block.content).split('\n')[0].slice(0, 60)}`)

  // --- Read returns numbered lines (v24)
  const read = results.find((r) => r.tool === 'Read')
  check('live', 'Read 结果是「行号 + 制表符 + 内容」', (() => {
    const text = typeof read?.block?.content === 'string' ? read.block.content : ''
    return /^\s*\d+\t/.test(text)
  })(),
    'Read 的行号卡解析不出来，会退回成终端视图（v24）',
    read === undefined
      ? '这次探测没拿到 Read 结果（模型可能没照做，重跑一次）'
      : `实际首行: ${String(read.block.content).split('\n')[0].slice(0, 60)}`)

  // --- per-message usage is what v22's prompt-side split reads
  check('live', '内层 assistant 消息自带用量', assistantUsage !== undefined && typeof assistantUsage.input_tokens === 'number',
    '上下文压力又退回成累加值 → 进度条虚高、自动压缩提前触发（v22）')
  check('live', 'result 仍带累计用量', resultUsage !== undefined && typeof resultUsage.output_tokens === 'number',
    '成本统计拿不到输出 token（v22）')
}

if (LIVE) await liveChecks()

// ---------------------------------------------------------------- summary
console.log('')
if (failures.length === 0) {
  console.log(`全部通过（${pass} 项）— 插件对 DSH 的假设仍然成立。`)
  if (!LIVE) console.log('提示：加 --live 还会探测 Claude Code 的输出格式（要真起一次会话，慢）。')
  process.exit(0)
}
console.log(`${failures.length} 项未通过（${pass} 项通过）`)
const uiOnly = failures.every((f) => f.group === 'ui')
console.log(uiOnly
  ? '\n只有界面补丁被覆盖 — 跑 node dsh-patches/tool-activity/apply.mjs 就能全部复原，不需要重新改插件。'
  : '\nDSH 内部结构变了，上面列出的功能需要按新版本重新推导。把这份输出给我即可。')
process.exit(1)
