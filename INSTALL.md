# llm-claude-code v29 安装说明

patch.yml 安装后应指向 **main.v29.mjs**（实现仍在 `main.v20.mjs`，
换文件名是为了让 cordis-plugin-loader 重新 import）。本部署的组合热重载
处于禁用状态，**改完必须重启 `dsh web` 并刷新 `http://127.0.0.1:3080`**。

> **别把 vNN 当成"第 NN 版的代码"。** v21 以后的入口文件全是一行
> `export * from './main.v20.mjs'`，而 `main.v20.mjs` 是原地改的。把
> patch.yml 指回旧入口，加载的是**今天**的实现，只是名字旧。v10~v28 那些
> 文件已归档进 `main-versions-v10-v28.tar.gz`（删前逐字节校验过）。
>
> 想退回"不使用 DSH 工具"的状态（即 v25 行为），用配置开关：
> `llm-claude-code.dshTools: false`。它是唯一真正的回退通路，改完下一轮
> 生效，不用重启。

## 升级后怎么办（DSH 或 Claude Code 升级都看这里）

改动分两半，覆盖情况不同：

| 改动 | 位置 | 升级后 |
| --- | --- | --- |
| 4 处界面补丁 | DSH 安装目录内 | **必被覆盖** |
| 插件 + patch.yml | `~/.dsh/profiles/web/` | 不被覆盖 |

两条命令搞定：

```bash
node checkup.mjs                          # 体检：43 项，说明每项坏了影响什么
node dsh-patches/tool-activity/apply.mjs  # 界面补丁被覆盖时重打
```

`checkup.mjs` 输出末尾会直接判断：只有界面补丁 FAIL 就重打即可；
如果 DSH 内部结构变了，它会指名哪一处、影响哪个功能。

### 为什么需要 checkup.mjs，verify-compact.mjs 不够

`verify-compact.mjs` 用的是本仓库自己造的假 ctx。DSH 改名或改公式之后它**照样全绿**，
因为假 ctx 仍然按老名字应答。它证明的是「插件逻辑对不对」，不是「插件对 DSH 的理解还准不准」。
`checkup.mjs` 反过来，直接读真实 DSH 树核对。

失效有两种表现，第二种才是危险的：

| 类别 | 数量 | 失效表现 | 不跑体检能发现吗 |
| --- | --- | --- | --- |
| 硬要求（`inject`） | 4 | 插件加载失败，启动报错 | 能，很吵 |
| 软查询（`ctx.get`） | 7 | 静默退回默认行为 | **不能** |
| 语义假设 | 8 | 结果算错但不报错 | **不能** |

软查询失效的样子：DSH 把 `planMode` 改名，插件读不到状态 → 按「不动配置」处理 →
计划模式退回成一句客气话，内层照样改文件。一声不响。

### 两个升级源，别搞混

| 假设 | 归谁 | 谁升级会影响 |
| --- | --- | --- |
| 服务名、压力公式、三档预设名、错误码表 | DSH | DSH |
| 失败 Bash 首行 `Exit code N` | Claude Code | Claude Code |
| Read 返回「行号 + 制表符 + 内容」 | Claude Code | Claude Code |
| Edit 的前后文本在入参里 | Claude Code | Claude Code |
| `/compact`、`/goal` 是斜杠命令 | Claude Code | Claude Code |
| 内层 assistant 消息自带 usage | Claude Code | Claude Code |

`node checkup.mjs --live` 才会探测 Claude Code 那一列（要真起一次内层会话，约一分钟）。
不加 `--live` 只跑 DSH 那一列，秒级。

基线：DSH `0.1.1-rc.2` + Claude Code `2.1.259`，43 项全通过。

## v24：DSH 与 Claude Code 双方都有的命令/状态，按路由分流

DSH 一共注册 6 个命令。逐个核对过（`supportedCommands()` 实测 Claude Code
侧共 157 个命令）：

| 命令 | Claude Code 侧 | 走 DSH 的后果 |
| --- | --- | --- |
| `/compact` | 同名存在 | v23 已处理 |
| `/goal` | 同名存在 | 见下：目标永远标记不了完成 |
| `/plan` | **没有同名命令**（是 `permissionMode: 'plan'`） | 见下：约束降级成建议 |
| `/permission` | 无 | 切了对内层无效 |
| `/export` `/feedback` | 无 | DSH 自身功能，与内层无关，不处理 |

### `/plan` 与 `/permission`：读状态，翻译成内层权限模式

不接管命令。DSH 的计划模式靠「往请求里加一段引导 + 注册 `exit_plan_mode`
工具」生效；引导能通过 `options.system` 传到内层，但工具不行 ——
`buildSystemAppend` 明确告诉内层「harness 工具一个都不能调」。而内层的
`permissionMode` 是插件配置的固定值（默认 `bypassPermissions`）。
**结果是内层收到一句「请你别动手」的客气话，却没有任何东西拦着它。**

所以 `resolveEffectivePermissionMode()` 在每次请求前读两个 DSH 状态：

```
ctx.planMode.get(agent).active / .pending   →  true      ┐
ctx.permissionPresets.current(events)       →  read-only ┴→ 内层 'plan'
其它情况                                                  →  保持配置值
```

- Claude Code 没有只读权限模式，`plan` 是它唯一真正拒绝写入的模式，所以两个
  DSH 状态都映射到它。
- **刻意只往严的方向收紧。** 把 `workspace-write → acceptEdits`、
  `danger-full-access → bypassPermissions` 也映射上去，会让从不碰
  `/permission` 的人行为静默改变；而「DSH 预设太松」不是需要防的失效方向,
  「内层太松」才是。
- 两个服务都是软依赖（`ctx.get`），读取包在 try 里：投影抛错只意味着这一轮
  不收紧，不能让整个请求失败。

### `/goal`：转发给内层，其它 provider 复用 DSH 原实现

DSH 的目标机制从**外部**驱动轮次：每轮结束由 round-driver 追一句「继续」，
直到模型调用 `update_goal` 报告完成。但 `update_goal` 是 DSH 工具，内层调不
到 —— 活干完了也没法说完成，于是一路烧到 `maxGoalRounds` 上限。

- claude-code 路由：**注入一条普通用户消息** `"/goal <原文>"`，走
  `invocation.agent.followup()`。不在命令 handler 里执行，因为内层的 `/goal`
  是真会干活的（实测它自己循环 2 轮建好文件），塞在 handler 里会让界面卡住
  几分钟再蹦一句总结，中间的工具卡片、思考、增量回复全看不到。followup 会
  唤醒一轮正常对话，整个过程原生流式显示。
- **依赖 nativeResume**：只有 resume 模式把增量当**原文**交给 SDK，斜杠命令
  才会被识别。全量重放走 `serializeConversation`，会包上角色标记，斜杠命令
  落在文稿中间只会被当普通文字。所以 `nativeResume` 关闭、或还没有内层会话
  时，命令明确拒绝并说明原因，而不是静默失效。
- 图片附件：claude-code 路由下明确拒绝（斜杠命令必须是转发消息的开头）。
- 其它 provider：**不重新实现**。用一个 `goals` 代理到真服务的 shim 跑一遍
  `dsh-command-goal` 的 `apply()`，把 DSH 自己的 definition 捕获下来直接调用
  它的 handler，行为、文案、子命令（`clear`/`edit`/`pause`/`resume`）逐字
  照旧。`dsh-command-goal` 是**惰性可选**依赖（顶层 `import().catch()`）：
  解析不到就只让其它 provider 的 `/goal` 报 unavailable，不会连带这个
  provider 一起加载失败。

### 必须同时改 profile

`dsh-base/cordis.patch.yml` 挂了 `dsh-command-goal`，同名注册两次会抛
`command "goal" is already registered`。所以本 profile 的 `cordis.patch.yml`
末尾同时禁用了两行：

```yaml
- id: command-compact
  disabled: true
- id: command-goal
  disabled: true
```

**若移除 llm-claude-code，这两行都要去掉，否则 `/compact` 和 `/goal` 会消失。**

### 代价

- DSH 的目标面板/指示器在 claude-code 路由下不再有内容 —— 目标活在内层。
- 内层目标跑多久就是一轮多久，中途看不到 DSH 的分轮次。
- `/permission` 切到 `workspace-write` 或 `danger-full-access` 时，内层仍是
  配置值（见上「只收紧」）。

### 自检

`node verify-compact.mjs`：工作区 43 项，**profile 目录下 46 项**（那里能解析
`dsh-command-goal`，多测 3 项真实委托）。要验证「其它 provider 照旧」必须在
profile 目录跑。

## v23：`/compact` 按路由分流到内层 Claude Code

- **动机**：DSH 自己的压缩改写的是 DSH 历史（影子化一段 + 插入摘要
  checkpoint）。但在 `nativeResume` 开启时，真正占上下文的是**内层 Claude
  Code 会话**，DSH 看不见它。压内层才真的省 token，而且 DSH 历史一个字不动。
- **实测**（Agent SDK 0.3.220，5 轮真实工具调用后发 `/compact`）：

  ```
  compact_boundary: pre_tokens=32304  post_tokens=5223  duration_ms=42248
  下一轮 cacheRead: 63628 → 15752
  ```

  内层认 `/compact` 斜杠命令，压完 fork 出的新 session 可以继续 resume。
- **实现**：插件自己注册 `/compact`（`inject` 增加 `commands`）：
  - `agent.options.provider === 'claude-code-main'` → 对内层发 `/compact`，
    把 fork 出的新 session id 写回 `resumeState`，**`lastFedMessageId` 原样
    保留**（DSH 历史没变，水印仍然匹配，下一轮继续走 resume 而不是全量重放
    —— 全量重放会让压缩成果立刻作废）。
  - 其它 provider → 原样转发给 `ctx.compaction.compactNow()`，连结果文案和
    `ManualCompactionError` 分类都逐字照抄 dsh-command-compact。
  - `nativeResume` 关闭时直接拒绝并说明原因（没有内层持续会话，压了白压）。
- **必须同时改 profile**：`dsh-base/cordis.patch.yml` 挂了
  `@deepseek-ai/dsh-command-compact`，同名命令注册两次会抛
  `command "compact" is already registered`。所以本 profile 的
  `cordis.patch.yml` 末尾加了：

  ```yaml
  - id: command-compact
    disabled: true
  ```

  `disabled` 是 cordis-plugin-loader 的官方字段，profile patch 在 bundle 之后
  生效。**若移除 llm-claude-code，必须把这行去掉，否则 `/compact` 会消失。**
- **自动压缩保持 DSH 原样**：只接管手动 `/compact`。到阈值自动触发的压缩仍
  由 `dsh-compaction-basic` 处理（改写 DSH 历史）。这是刻意选择，不是漏改。
- **代价（不是 bug）**：
  - **内层压缩的成果会丢。** 它依赖 nativeResume 链不断。用户编辑/删除历史、
    中途切到别的 provider 再切回、内层 session 被 Claude Code 回收，都会让
    `planReplay` 退回全量重放 —— 压掉的上下文瞬间全部回来。DSH 压缩改的是
    DSH 历史，撕掉就是撕掉，不会复活。
  - **两者不能叠加。** DSH 侧压缩替换历史后水印失效，内层必须重建。
  - 内层压缩实测约 40 秒，期间命令一直等待。
  - 压完 DSH 历史仍然完整，界面上的对话不会变短，只有上下文压力条会掉。
- **自检**：`node verify-compact.mjs`（24 项）。用假 ctx 跑一遍 `apply`，抓出
  注册的 handler 直接验分流、文案、异常传递，外加「换了内层 session id 后
  planReplay 仍走 resume」和 v22 用量拆分的回归。

## v22：上下文压力按「最后一次内层调用」上报

- **症状**：上下文进度条虚高，自动压缩过早且反复触发。
- **根因**：DSH 的 `pressureFrom = inputTokens + cacheReadTokens +
  cacheWriteTokens`，注释明写这是「**单次请求**的 prompt 侧压力」。而插件
  上报的 `result.usage` 是**内层所有 API 调用的累加**。实测一轮 5 次内层
  调用：上报 `8 + 114921 + 20216 = 135145`（200k 窗口的 68%），真实上下文
  只有约 36k（18%）。内层工具调用越多，虚报越狠。
- **修复**：`usageOf(usage, last)` 拆成两路——prompt 侧（input / cacheRead /
  cacheWrite）取**最后一条主会话 assistant 消息**自带的 usage，那正是一轮
  结束时的真实上下文占用；`outputTokens` 保持累加，因为它是成本项、不进
  压力公式，且每次内层调用的输出都真实产生了。
- **数据来源选择**：`result.usage.iterations` 最后一项也等于同一组数字，但
  该字段不在 Agent SDK 的类型声明里（API 原样透传），因此改用流里每条
  `assistant` 消息的 `message.usage`——SDK 正式暴露的字段。
  `parent_tool_use_id` 非空的子代理消息不采样：它们有各自独立的上下文。
- **已知代价（有意为之，不是 bug）**：`totals` 里的缓存/输入 token 会少算
  （只记最后一次调用的），成本统计因此偏低；输出 token 仍准确。换来的是
  上下文进度条和压缩阈值反映真实情况。
- **回退保护**：没有任何 assistant 消息带 usage 时，退回累加值而不是报 0；
  `usage` 整个缺失时返回全 0，不抛异常。

## v21：实时 display-only 工具卡，保留官方 Think / Markdown

- **协议**：每个内层 `tool_result` 立即发出 `tool-activity` 块
  （`block-start` + `block-end`）。它不是 `reasoning`，也不是 `tool-call`，
  所以官方 Think / Markdown 渲染器不变，外层 Agent Loop 也不会
  `executeToolCalls()`。
- **默认**：`toolActivityDisplay: 'native'`。`fold` / `card` 仍可显式开启。
- **客户端补丁**（DSH 升级会被覆盖，需重打）：
  1. `dsh-client-runtime/lib/client.js`：`toAssistantBlock` /
     `emptyAssistantBlock` 增加 `tool-activity`
  2. `dsh-client-ui-conversation/lib/client.js`：`AssistantMarkdown` 增加
     一个 case，渲染可展开只读卡片；**不替换** `assistant-step`
  3. `dsh-llm/lib/index.js`：中断流保留已完成的 `tool-activity`
  4. `dsh-client-ui-trajectory/lib/client.js`：`assistantSourceBlock` /
     `timelineBlock` 增加 `tool-activity`
- **四个补丁必须同时在位**，尤其是第 1 个。渲染 switch 判断的是
  `block.kind`（不是 `block.type`），而 `kind` 由 `toAssistantBlock` 给出。
  只打 2 和 3 时，`tool-activity` 会被归为 `kind: "other"`，第 2 步加的
  case 变成死代码，最终落到兜底分支渲染成 `JsonBlock`「未知内容块」。
  这正是 2026-09-03 之前的表现：卡片代码在位但永远匹配不上。
- **第 4 个补丁是第 1 个的必需配套，不是可选优化。** trajectory 的两个
  `switch (block.kind)` 对现有 kind 是穷举的且**没有 `default`**，未命中直接
  返回 `undefined`。打补丁 1 之前这些块以 `kind: "other"` 命中已有分支；改判
  成 `tool-activity` 后就落空，而 `TrajectoryTable` 会对 `sourceBlocks` 做
  `.some(b => b.imageSrc !== undefined)`，数组里混进 `undefined` 直接抛
  TypeError——**原生轨迹面板整个崩掉**。所以 1 和 4 必须成对存在。
- **对原生 UI 的影响面**（每次改补丁都应重新确认）：
  - 四个文件里只有 3 行被替换（都是原行的扩写），其余全是新增分支，
    没有删除任何原生逻辑。
  - 新加的 case 只匹配 `tool-activity`，而这个块类型只有本插件会发；
    其它路由（deepseek 等）的消息流一个字节都不变。
  - 新增的顶层标识符（`toolActivity*` / `TOOL_ACTIVITY_*` /
    `ToolActivityRow`）在原始 bundle 里出现次数均为 0，不会遮蔽原生函数。
  - CSS 类名前缀 `dsh-ta`，全 DSH（含前端 dist）无同名类；原始 bundle 里的
    `dsh-ta` 只是 `--dsh-table-lead` 这类自定义属性，类选择器匹配不到。
  - 全 DSH 仅四处 `switch (block.kind)`：trajectory 两处（已由补丁 4 覆盖）、
    conversation 一处（有 default）、`dsh-llm-deepseek` 一处（是该适配器自己
    的内部块累加器，与客户端 kind 无关，也永远收不到 `tool-activity`）。
- **卡片外观**：复用官方 `DisclosureRow`（Think 行与原生工具行同一个
  primitive），所以 hover / chevron / 折叠动画与原生一致；配色全部走
  `--dsw-alias-*` token，明暗主题自动跟随。按工具名分图标
  （Read/Glob/Grep→browse，Edit/Write→edit，TodoWrite→checklist，
  Task→queue，其余→api），失败时换成红色 warning 图标并把摘要标红。
  展开区**按工具选 primitive，和原生 ToolRow 一一对应**：
  Edit / Write / MultiEdit / NotebookEdit → `DiffBlock`（`maxLines: 8`），
  Read → `ReadBlock`（`maxLines: 8`），其余 → `TerminalBlock`。
  失败的调用一律走 `TerminalBlock`：编辑没真的发生、读取结果是错误信息，
  只有终端视图能把失败状态画出来。
- **两个文件卡的数据来源**（都用 Agent SDK 实测过）：
  - `ReadBlock`：Read 的结果是每行 `<行号>\t<内容>`，末尾多一行编号空行
    （最后一个换行之后的空串），解析时丢掉这一行。解析不出这个形状
    （错误信息、图片结果）就退回 `TerminalBlock`。
    `lang` 直接传文件扩展名——高亮器的别名表本来就按扩展名索引
    （`ts`/`py`/`rs`…），不认识的扩展名自动不高亮。
  - `DiffBlock`：hunk 来自**入参**而不是结果。Edit 的返回值只有一句
    「The file ... has been updated successfully」，`old_string` /
    `new_string` 是这对前后文本唯一的存在处。Write 走
    `oldText: null`（新建文件），MultiEdit 的 `edits` 逐条展开。
  - 差异：`ReadBlock` 的 label 用绝对路径，原生会相对 cwd 并把 home 缩成 `~`
    （需要 session store 里的 cwd/home，接进 `AssistantMarkdown` 代价过大）。
- 其余工具的展开区用原生 Bash 卡片那个 primitive：**`TerminalBlock`**。它自带状态
  点、命令行、一条横线分隔、输出区、退出码后缀、复制按钮、「… 其余 N 行 /
  收起」折叠和 ANSI 上色，内置文案本来就是中文，常规路径不需要传 `labels`。
  三个 CSS 变量（字体、行高、输出区 224px 上限）与原生 ToolRow 一致。
  命令行内容：shell 工具显示命令原文，其它工具显示格式化入参 JSON（截断
  2000 字），都没有则退回工具名。
- **退出码的唯一来源是输出文本的第一行**。SDK 的 `tool_result` 只给
  `is_error` 布尔值，不给退出码；但 Claude Code 会给失败的 Bash 结果加一行
  `Exit code <n>`（用 Agent SDK 实测：失败 `"Exit code 3\nhello"` + is_error，
  成功 `"hello"`）。`toolActivityExit` 把这一行解析出来并从显示的输出里剔除。
  解析不到又确实失败时（所有非 Bash 工具），只传 `exitCode: 1` 让状态点变红，
  同时用 `labels.exitCode` 覆盖成「执行失败」——**不编造具体数字**。
  `TerminalBlock` 的红点判定是 `exitCode !== 0 || signal !== undefined`，
  所以不传非零码的话失败会被画成绿色「已完成」。
- **必须传 `keepContentWhenOpen: true`**。`DisclosureRow` 内部是
  `(keepContentWhenOpen || !open) && collapsedContent`，默认 `false`，
  所以不传的话摘要一展开就消失。原生工具行（`dsh-client-ui-tool`）传的是
  `true`；只有 Think 行故意不传，因为它展开后的正文就是那段思考文本本身，
  再重复一遍摘要是噪音。工具卡的摘要和输出是两回事，要一直显示。
- **安装**：在工作区执行 `node dsh-patches/tool-activity/apply.mjs`
  （需能写 volta 安装目录）。脚本幂等：首次运行为每个目标存一份
  `*.tool-activity.bak` 原始副本，之后每次都从该副本重新推导；若检测到
  目标文件已被 DSH 升级覆盖（不含补丁标记），会先用新的原始文件刷新
  `.bak` 再打补丁。锚点匹配次数不等于 1 时**直接报错退出**，不做猜测。
- **自检**：`node dsh-patches/tool-activity/verify.mjs`。它把补丁后的纯
  函数从 bundle 里切出来实际执行（分类器、摘要、入参面板），再静态校验
  接线（case 存在且位于 `default` 之前、CSS 已注入、中断流保留逻辑在位）。

## v20：默认恢复 Think → Bash → Think → Bash 顺序

- **根因**：DSH 的 `tool-call` 是执行请求，不是展示事件。`dsh-agent-loop`
  会先收完整条 LLM stream，之后才调用 `executeToolCalls()`；因此把内层
  Bash 投影为 tool-call 时，所有 Bash 卡必然在整段 Think 之后集中出现。
- **修复**：默认 `toolActivityDisplay: 'fold'`，在每个内层 `tool_result`
  到达时立即发出 reasoning block。DSH 原生 DisclosureRow 会折叠显示，且
  不会执行，因此顺序保持为 `Think → Bash → Think → Bash`。
- **兼容**：`toolActivityDisplay: 'card'` 仍可显式开启原生 Bash 卡，但
  接受它们在外层 stream 结束后批量出现的时序代价。未知配置值安全回退到
  `fold`，避免再次悄悄恢复错序卡片。
- 单测已覆盖默认 fold、显式 card 和嵌套 subagent 结果隔离。

## v19：用 PreToolUse 可靠映射 Claude Code AskUserQuestion

v18 使用 `canUseTool` 作为唯一桥接，但 SDK 在 bypassPermissions 下会发出
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告：普通工具会被 bypass 提前自动放行，
不能把 canUseTool 当稳定的门控点。v19 改为 SDK `hooks.PreToolUse`，匹配
`AskUserQuestion`，在工具执行前调用 DSH `userQuestions.ask()`，返回
`permissionDecision: 'allow' + updatedInput`；取消/异常返回 deny。独立 CLI
smoke 已确认 hook 实际收到 AskUserQuestion、Claude 收到 Blue 答案并以
`result.subtype=success` 完成；单测 **22/22**。

## v18：Claude Code AskUserQuestion 映射到 DSH 原生问题卡

- **实现**：官方 Agent SDK 的 `canUseTool(toolName, input, options)` 收到
  `toolName === 'AskUserQuestion'` 时，适配器把 `{questions:[...]}` 转换为
  DSH `ctx.userQuestions.ask({ questions, agent, signal })`，复用当前 GUI 的
  原生问题卡；用户提交后再返回
  `{behavior:'allow', updatedInput:{questions, answers}}`。
- **字段转换**：DSH 问题使用稳定 `id`；答案按 DSH 的
  `{answers:[{id, selected, custom?}]}` 接收，转换为 Claude 要求的
  `{[questionText]: selectedLabel}`；多选用 `, ` 连接，自定义文本优先。
- **与 bypass 的关系**：`AskUserQuestion` 是交互型工具，即使
  `permissionMode: 'bypassPermissions'` 也会进入 `canUseTool`；普通 Bash/
  文件操作仍由 v17 的 bypass 直接执行。v18 已从 `disallowedTools` 移除
  AskUserQuestion，否则 callback 根本收不到它。
- **失败保护**：没有 DSH user-question provider、问题为空、用户取消或
  provider 抛错时，返回清晰的 deny 结果，不把 headless Claude 永久挂住。
- **开关**：`askUserQuestion: true`（默认）；设为 false 则重新将
  AskUserQuestion 放入 `disallowedTools`。
- **运行态验证**：SDK 0.3.220 + Claude CLI 2.1.258 的独立 smoke test
  已确认 canUseTool 收到 AskUserQuestion，返回 updatedInput 后 Claude
  成功继续；工作区单测 **22/22** 通过。

## v17：内层会话显式权限模式，命令不再被沙箱/确认卡死

- **症状**：claude-code-main 路由的内层 Claude Code 连
  `python3 -c "print(1)"` 都跑不了——命令死在 Claude Code 沙箱里，而
  免沙箱重试需要权限确认，无头内层会话（AskUserQuestion 被 disallow）
  永远弹不出确认框。当时内层 CLI 吃的是用户设置
  `permissions.defaultMode: "auto"`（分类器审批），对不透明命令/沙箱
  升级一律卡死。
- **修复**：适配器显式传 SDK 权限选项，默认
  `permissionMode: 'bypassPermissions'` + 必配的
  `allowDangerouslySkipPermissions: true`——内层会话确定性跳过一切权限
  确认与沙箱升级弹窗（这条路由的本意就是 Claude Code 自主拥有工具循环；
  内层工具本来也不经过 DSH 审批栈）。
- **可配**：`llm-claude-code.permissionMode` ∈
  `default | acceptEdits | bypassPermissions | plan | dontAsk | auto`
  （sdk.d.ts 的 PermissionMode 全集）；非法值回退默认。只有 bypass 会
  附带 allowDangerouslySkipPermissions，其余模式不带该旗标。
- 测试 **20/20**（含 resolvePermissionMode 钳制与 buildPermissionOptions
  形状断言）。
- **安全提示**：bypass 下内层 Claude 以当前用户身份无确认执行任意命令、
  沙箱不再拦截；这是该路由的预期语义，但请勿在不可信任务里随意使用。

## v16：工具活动挂到原生 tool_call 卡片下（同次重启生效）

- **动机**：用户要求把内层工具输出挂在 bash / tool_call 卡片下，而不是
  v15 的 Think 风格折叠行。
- **机制**：每个完成的内层工具调用在流内重发为一个**真实 DSH tool-call
  块**，指向一个无副作用的回声工具；DSH 在整条 LLM 流结束后调度它
  （协议下限：tool/call 事件只在 executeToolCalls 追加，流中不可能出卡），
  回声 `concludeTurn()` 不触发后续请求，转录获得一张原生可折叠工具卡，
  Output 区显示原始输出。
- **卡片观感（对 v12 的修正 1）**：客户端按调用 NAME + 参数推导卡片变体
  （dsh-client-ui-tool 的 TOOL_VARIANTS/SUMMARY_KEYS）。v16 按**变体兼容的
  小写名**注册回声工具——bash/read/edit/write/glob/grep/web_fetch/
  web_search，外加通用 claude_tool——并发原生形状参数
  （command/file_path/pattern/query/url + description），Bash 运行得到
  真正 bash 风格的卡（标题 Bash、摘要=description/command、结果可折叠）。
- **防双重执行（关键）**：注册前用 `ctx.tools.get(name)` 查重，名字被占用
  就**绝不注册、绝不发该名字的块**——真实的 harness Bash 工具不可能被
  回声遮蔽导致命令跑两遍；取不到名字的运行回退为折叠行。
- **重放完整性（对 v12 的修正 2）**：回声参数带 `claudeActivity` 标记；
  planReplay / serializeConversation 跳过这类调用/结果对——合成展示行
  不会在每轮强制全量重放（否则回声 tool-result 的 user 消息会被当成真实
  DSH 执行边界打断 native resume），也不会重放进 Claude 的提示词。
- **时序代价（诚实说明）**：卡片出现在**整条流结束时**（一次性弹齐），
  不是实时的；v20 默认使用折叠行来保持 Think/工具顺序。两者取舍：
  - `toolActivityDisplay: 'fold'`（默认）— 实时折叠行（`▸ Bash ✓ · cmd`），保持原始顺序
  - `toolActivityDisplay: 'card'` — 原生卡片，流末弹齐
  - `showToolActivity: false` — 完全不显示
- **清理**：删除 v14 残留的死代码回声注册（未导入的 defineTool/
  ACTIVITY_TOOL，每次 apply 必抛 ReferenceError 进 catch）。
- **模型可见性注意**：回声工具 schema 会出现在所有路由的工具目录里
  （描述已声明 internal、never call）。与 v12 的 claude_activity 同类
  取舍，只是数量从 1 变 9。
- v16 历史回归测试为 **19/19**（现由 v20 测试文件继续覆盖），已用 harness
  模块解析验证 import 可加载。

## v15：工具活动可折叠（reasoning 通道投影；现为 toolActivityDisplay='fold'）

## v15：工具活动可折叠（reasoning 通道投影）

- **动机**：用户反馈 v13/v14 的工具输出卡不能折叠。转录里 assistant
  **text** 块渲染为纯 Markdown（客户端 markdown 渲染器把 html 节点按
  字面文本返回，无 `<details>` 折叠）；唯二可折叠的块是 `reasoning`
  （Think 风格 DisclosureRow，默认收起）和 `tool-call`（执行请求，DSH 在
  整个 LLM 流结束后才调度 → v12 回声卡的「回合末弹卡」正是因此被 v13
  废弃）。
- **机制**：每个完成的内层工具调用投影为一个 **reasoning 块**
  （block-start/reasoning-delta/block-end，在 `tool_result` 到达的同一流内
  实时发出）。转录渲染为默认收起的折叠行：
  - 收起摘要（首行）：`▸ Bash ✓ · git status --short`（✗ 表失败）
  - 展开正文：`$ <命令>` + 输出全文（仍受 `toolResultDisplayChars`
    头 60%+尾 30% 截断），纯文本 pre-wrap 渲染
  - 实时、绝不执行、不产生 DSH tool-call 记录；不占用 emittedText，
    纯工具轮的最终答案兜底（result.result）不受影响
- **重放限长**：`▸ ` 前缀的 reasoning 块在文本历史重放时与旧 `‹ ` 块
  一样钳到 800 字符；真实 Claude 思考（无哨兵前缀）不受影响。
- **配置**：`toolActivityFold`（默认 **true**）。设为 false 回到 v14 的
  平铺 Markdown 卡。`showToolActivity: false` 仍然完全不显示活动。
- **清理**：移除 v12→v13 移植残留的死代码——v14 每次启动都执行
  `ctx.tools.register(defineTool(...))`，但 `defineTool`/`ACTIVITY_TOOL`
  均未导入，必然抛 ReferenceError 进 catch 并打 warn。
- **已知小瑕疵**：流式期间最后一个折叠行会短暂带「running」扫光样式
  （客户端给流中最后一个 reasoning 块统一加的状态），内容静止、下一个
  块出现后即恢复收起样式；回合结束必然恢复。

## v14：完成时显示单张 native 工具活动卡（现为 toolActivityFold=false 的回退样式）

- **呈现**：每个完成的 Claude Code 内层工具调用渲染为一张 Markdown shell
  代码卡，包含工具名、完成/失败状态、命令（或输入）及完整/截断输出。例如：

  ```text
  Bash · completed
  ┌─────────────────────────
  │ $ echo v14-card-ok
  │
  │ v14-card-ok
  └─────────────────────────
  ```

- **时序与安全**：卡片在 SDK 报告 native `tool_result` 的同一流内生成；它不是
  DSH 的 `tool-call`，不会在会话结束后被调度，更不会二次执行命令。为避免把未
  完成调用伪装成卡片，命令运行期间不显示独立的临时行，完成后才出现整张卡。
- **边界**：这是一张 Markdown 视觉卡，不是原生 DSH 工具执行卡。后者的协议
  固定意味着「由 DSH 在 stream 结束后执行」，不能安全复用来表示已执行的
  Claude Code 内层工具。

## v11 新增：原生会话 resume（不再全量文本重放）

- **机制**：适配器按 DSH 会话跟踪 CC session id + 水位（最后投递的
  user 消息 id）。下轮请求若历史仍是纯延伸（水位消息仍在、其后只有
  本路由的 assistant 回复 + 尾部新 user 消息），则
  `resume + forkSession` 只投递 **delta**；任何分歧（编辑/删除/重新
  生成/中途换路由/带 DSH 工具结果）自动回退全量文本重放。
  CC 会话被清理导致 resume 失败时透明重试一次全量。
- **收益**：内层工具结果/思考/图片原生保留在 CC 会话里（‹ 块的 800
  字符重放截断不再适用）；图片不再每轮重编码重发；每轮 prompt 体积
  大幅下降。
- **代价/注意**：`persistSession` 在 nativeResume 开启时强制 true
  （resume 需要会话文件）；CC 侧每轮 fork 出新会话文件
  （~/.claude/projects/ 下积累，长会话有磁盘增长）；跟踪态在内存，
  dsh web 重启后第一轮自动回退全量重放重建。`nativeResume: false`
  可关（回到 v10 行为）。
- **验证**：turn1 种暗号 → turn2 仅投递新消息却答出暗号（原生会话
  记忆）→ turn3 编辑历史回退全量重放仍答对。

## v10 新增

- **全宽工具活动显示**（用户反馈输入输出显示不全）：
  - `▸` 调用行：80 → **500 字符**
  - `‹` 结果块：240 字符单行 → **保留换行的多行渲染**，上限
    `toolResultDisplayChars`（默认 **3000**，settings.yaml 可调，0 = 不限）；
    超限走「头 60% + `… [N chars omitted] …` + 尾 30%」策略
  - **重放侧独立限长**：转录显示全量，但下一轮喂回 Claude 的历史里每个
    `‹` 块钳到 800 字符（`… [replay truncated]`）——显示放宽不会推爆
    后续 prompt
  - 运行态已验证：`seq 1 40` 的 40 行输出完整逐行显示

## v9 新增

- **上下文窗口对齐 CLI 2.1.258 注册表**：fable / opus / sonnet
  （当代全系 fable-5 / opus-5 / sonnet-5，`window:1e6, native_1m`）
  均为**原生 1M**——`fable[1m]` 条目已删除（基础别名即 1M）；
  haiku 保持 200k，新增 `haiku[1m]` 后缀变体
  （注册表 `supports_1m_suffix:true`）。目录经 /api/llm.models 验证。

## v8 新增

- **工具结果投影**：内层工具调用现在投影两行状态文本——
  `▸ Bash · <命令/参数>`（调用）+ `‹ Bash ✓ <输出摘要>`（结果，✗ 表
  错误，240 字符单行截断）。运行态已验证（haiku 真实 Bash 调用）。
- **为什么不能转成原生 DSH 工具卡片**（源码级结论）：
  `dsh-agent-loop/lib/index.js:684` 对 assembled 消息里**每一个**
  `tool-call` 块无条件 `executeToolCalls` 调度执行——chunk 协议里没有
  「仅展示/已执行」语义。把 Claude 内层已跑过的工具转成
  `tool-call-delta` 会导致 DSH 再执行一遍（写操作跑两次，不可接受）。
  根治需要 DSH 上游新增观察型 tool 记录 chunk 类型。
- 附带收益：每轮都是全新 CLI 会话，Claude 原生记不住上一轮内层工具；
  结果行随文本重放回去，等于给它的内层工具活动加了记忆。

## v7 新增

- **模型目录**：`fable`（Claude Fable 5 别名，订阅旗舰，effort 全档含
  xhigh/max）与 `fable[1m]`（1M 上下文变体，per-model contextWindow
  1000000）。CLI 2.1.252 的快捷切换别名表：haiku / fable / best /
  sonnet[1m] / opus[1m] / fable[1m] / opusplan；`fable` 已在本订阅实测
  （`claude -p --model fable` → success）。目录经 /api/llm.models 验证可见。
  如需 best/opusplan 等其它别名，往 MODELS 表加条目即可（改文件名+patch.yml
  name 触发热重载）。

## v6 相对 v2 的变化

1. **图片输入**：user 角色消息里的图片附件经持久附件服务
   `readImageRequest`（与 dsh-llm-pi-ai 相同的 `{maxPixels, maxBytes}`
   policy 形状，默认 2048×2048 / 1MiB，聚合上限 20MiB）重编码为
   Anthropic base64 图片块，经 SDK 流式输入通道
   （`AsyncIterable<SDKUserMessage>`）投递。所有 user 角色历史图片每轮
   重发（与 pi-ai 重放语义一致），追问旧截图仍然有效。
   运行态已验证：三色竖条测试图 → haiku 正确回答「红、绿、蓝」。
2. **内层工具活动投影**：SDK 完整 `assistant` 消息中的 `tool_use` 块
   投影为紧凑状态文本块（`▸ Bash · echo xxx`），内层长循环期间 DSH
   转录不再静默。纯文本、绝不发 `tool-call-delta`，不会双重执行；
   子代理活动不投影。`showToolActivity: false` 可关。
   运行态已验证：状态块 + 真实工具输出都出现在流式转录里。
3. **resolveWorkspace 正则修复（关键 bug）**：v2 的贪婪捕获会回溯到行内
   最后一个 `.`，把 "Working directory is /tmp. Answer in one sentence."
   的整句当 cwd → execve ENOENT → SDK 在 dsh web 进程内 spawn 必败
   （报错还是误导性的 libc-mismatch 文案）。v6 改为捕获以 `/` 开头的
   连续非空白 token 再剥尾部标点。含空格路径不受支持（DSH 系统提示
   中不会出现）。
4. **spawnClaudeCodeProcess 钩子**：adapter 用 node:child_process 直接
   spawn（detached，与 dsh subprocess 服务同构），spawn 失败时把真实
   `code/syscall/message` 拼进 LlmError —— SDK 默认包装会吞掉 errno。

新增配置项（settings.yaml `llm-claude-code:` 分节，活读免重启）：
`showToolActivity`（默认 true）、`imageMaxPixels`（默认 4194304）、
`imageMaxBytes`（默认 1048576）。

## 安装（改名 + patch.yml 指向；本部署 hmr 禁用，需重启 dsh web 生效）

```sh
cp /home/sumer/Workspaces/Chat/1/llm-claude-code/main.v20.mjs \
   /home/sumer/.dsh/profiles/web/plugins/llm-claude-code/main.v20.mjs
# ~/.dsh/profiles/web/cordis.patch.yml 中 llm-claude-code 行的 name 改指
# ./plugins/llm-claude-code/main.v20.mjs，然后重启 dsh web。
# （本部署 include:hmr 行已禁用，patch.yml 改动不会热重载，必须重启。）
```

本机已完成工作区测试与 profile 文件准备（2026-09-02）；等下一次 dsh web
重启自动换血 v16+v17+v19+v20。

## 测试

```sh
node --check /home/sumer/Workspaces/Chat/1/llm-claude-code/main.v20.mjs
node --test /home/sumer/Workspaces/Chat/1/llm-claude-code.test.mjs
```

2026-09-02：**22/22 通过**——v19 AskUserQuestion → DSH 问题卡的字段/答案
转换、取消/无 provider 失败保护、PreToolUse hook envelope 与真实 Claude
CLI smoke test（收到 AskUserQuestion、回填 Blue、success）；并覆盖 v16
回声卡（bash 变体参数形状、claudeActivity 标记、输出钳制、名字占用回退
折叠）、planReplay/序列化跳过回声对（真实 tool-result 仍会打断 resume）、
fold 模式、showToolActivity 关闭、native resume，以及既有 workspace、图片、
目录和流式投影回归用例。

## 调试经验（本轮排障沉淀）

- **动态探针报告通道**：动态 host 插件里 bash 服务不可用（ctx.get('bash')
  为 undefined）、fs/process/Buffer 均无。可靠通道是
  `harness.defineTool`（output 必须是 `{schema, render}`，parameters 根
  必须开放、不能 additionalProperties:false）注册一个只读状态工具，再由
  子代理调用取回 JSON。
- **沙箱 atob 是 UTF-8 文本解码**：二进制 base64 必须手写解码器，且字母表
  必须是完整 64 字符（少了 `/` 会让 indexOf 返回 -1，低位置 1 产生
  0xFF 型腐坏）。
- **附件存储是内容寻址的**：`~/.dsh/attachments/v1/objects/<sha[0:2]>/<sha>`，
  ref 形如 `{attachmentId: 'sha256:<hex>', mediaType, bytes, width, height}`，
  readImageFile 只校验摘要与元数据一致性 —— 可手工种入对象绕过
  saveImages 做链路验证。
- **SDK spawn 报 "binary ... failed to launch ... libc" 时先查 cwd**：
  该文案掩盖一切 spawn errno（真实 ENOENT 来自不存在的 cwd）。

## 归档：v2 相对 main.mjs 的三处修复

1. `resolveWorkspace` 懒惰捕获在路径中间含 `.` 时截断路径 → 改贪婪捕获
   （v6 又修了贪婪捕获的整句回溯 bug，见上）。
2. settings 集成：`installSettingsSection` 传给 `setSource` 的是函数，
   旧 `config()` 的 `{...current}` 展开恒为 `{}`，settings.yaml 覆盖从未
   生效；改为 `current()` 调用。
3. 新增 `buildSystemAppend`：把 DSH 工具目录指令桥接到原生 Claude Code 工具。
