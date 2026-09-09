# dsh-llm-claude-code

`dsh-llm-claude-code` 是一个 DSH Host 插件，用于将 Claude Code 通过 Claude Agent SDK 注册为 DSH 的可选 LLM Provider。

插件保留 DSH 的会话管理、模型选择、消息展示、取消控制、权限预设和工具执行基础设施；模型推理及 Claude Code 原生工具循环由 Claude Agent SDK 驱动。认证与计费沿用本机 Claude Code CLI 的登录状态和订阅环境，本插件不直接配置 Anthropic API Key。

## 功能范围

插件注册 Provider `claude-code-main`，并提供以下集成能力：

- 将 Claude Code 的文本、推理、用量及工具活动转换为 DSH LLM 流事件。
- 通过进程内 MCP Server 将部分 DSH 工具暴露给 Claude Code。
- 用 DSH 的 `bash`、`read`、`write`、`edit` 和 `todo_write` 替换对应的 Claude Code 原生工具。
- 将 DSH 的计划模式和只读权限预设映射为 Claude Agent SDK 的 `plan` 权限模式。
- 将 Claude Code 的 `AskUserQuestion` 请求转交给 DSH 原生提问界面。
- 在同一 DSH 会话内续接 Claude Code 原生会话，避免每轮完整重放历史。
- 根据当前 Provider 分发 `/compact` 和 `/goal` 命令。
- 支持 DSH 图片附件，并转换为 Anthropic Messages API 接受的图片内容块。
- 将 Claude Code 用 `Agent` 工具派发的子代理镜像为 DSH 子会话，使其出现在会话头部的子代理目录中。

## 系统架构

```text
DSH Web / Agent Session
        │
        │ LLM adapter stream
        ▼
dsh-llm-claude-code
        ├── Claude Agent SDK query()
        │       └── Claude Code executable
        │
        ├── in-process MCP server
        │       └── DSH tools.execute()
        │               ├── permission / approval
        │               ├── filesystem observation policy
        │               └── tool result events
        │
        ├── permission-state mapping
        ├── native-session resume state
        └── DSH message / activity projection
```

### 组件职责

| 组件 | 职责 |
| --- | --- |
| DSH | 管理外层会话、消息持久化、模型选择、权限预设、工具注册、取消信号和 Web 界面 |
| 本插件 | 实现 LLM Adapter、消息格式转换、工具桥接、权限映射、会话续接和命令分发 |
| Claude Agent SDK | 启动 Claude Code、驱动模型与原生工具循环、产生流式 SDK 消息 |
| Claude Code | 执行推理、调用工具、维护内层会话上下文 |

## 工具桥接

### 执行路径

插件使用 Claude Agent SDK 的 `createSdkMcpServer()` 和 `tool()` 创建进程内 MCP Server。桥接工具的调用路径如下：

```text
Claude Code
  → mcp__dsh__<tool-name>
  → SDK in-process MCP server
  → DSH tools.execute()
  → DSH 权限检查、审批和工具实现
  → MCP result
  → Claude Code
```

该路径不创建额外的 MCP 子进程，也不通过网络传输。工具参数由 DSH JSON Schema 转换为 Zod Schema；工具结果转换为 MCP 文本结果，同时保留错误状态。

### 默认桥接工具

| 类别 | 工具 |
| --- | --- |
| 目标管理 | `get_goal`、`create_goal`、`update_goal` |
| 命令执行 | `bash`、`job_output`、`job_kill` |
| 文件访问 | `read`、`read_image`、`write`、`edit` |
| 任务列表 | `todo_write` |

对于存在 Claude Code 原生对应项的工具，插件同时执行两项配置：

1. 通过 `disallowedTools` 禁用原生 `Bash`、`Read`、`Write`、`Edit` 和 `TodoWrite`。
2. 通过 `toolAliases` 将原生工具名定向到相应的 DSH MCP 工具。

这样可以避免同一操作存在两套执行入口，并确保命令执行、文件写入和任务列表更新进入 DSH 的策略及事件体系。

桥接只替换实际注册成功的工具。如果某个 DSH 工具不存在或桥接初始化失败，对应的 Claude Code 原生工具不会被禁用。

### 未桥接工具

`Glob` 和 `Grep` 保留 Claude Code 原生实现。它们属于只读操作，且 Claude Code 原生 `Grep` 的参数能力多于 DSH `grep`。

因此，DSH 文件策略主要约束通过桥接入口发生的写操作；Claude Code 原生只读工具及第三方 MCP Server 的读取范围仍由其自身运行环境决定。

## 权限模型

配置项 `permissionMode` 决定 Claude Agent SDK 的基础权限模式，默认值为 `bypassPermissions`。

在每次请求前，插件读取当前 DSH 会话的限制状态，并按以下规则计算实际模式：

| DSH 状态 | Claude Agent SDK 实际模式 |
| --- | --- |
| 计划模式启用 | `plan` |
| 权限预设为 `read-only` | `plan` |
| 其他状态 | 保持 `permissionMode` 配置值 |

映射是单向收紧的。`workspace-write` 和 `danger-full-access` 不会覆盖插件配置为更宽松的模式。

Claude Code 没有独立的只读权限模式；`plan` 是可用于阻止文件修改的 SDK 权限模式，因此 DSH 的计划模式和只读预设均映射到 `plan`。

> 当 `dshTools: false` 时，Claude Code 原生工具不经过 DSH 工具执行入口。此时 DSH 的工具沙箱和审批机制不能约束这些原生工具。

## 会话与历史记录

### 原生续接

`nativeResume` 默认启用。插件为每个 DSH 会话在内存中记录：

- Claude Code Session ID；
- 已发送到 Claude Code 的最后一条 DSH 用户消息 ID；
- 解析 Claude Code 会话文件所需的工作目录。

插件会记录“最近一次已发送给 Claude Code 的 DSH 用户消息 ID”。下一轮请求到来时，它会检查这条消息是否仍存在于当前历史中，以及该消息之后是否只有本插件生成的回复和新增加的用户消息。如果检查通过，插件使用 SDK 的 `resume` 和 `forkSession`，只发送尚未交给 Claude Code 的新增消息。出现下列情况时，插件回退为完整历史重放：

- 用户编辑或删除了历史消息；
- 会话分支发生变化；
- 最近一次已发送的用户消息之后包含其他 Provider 的回复；
- Claude Code Session 已不存在；
- DSH Host 重启后内存状态丢失。

续接要求 Claude Code 将会话写入磁盘，因此启用 `nativeResume` 时，插件会强制向 SDK 传入 `persistSession: true`。

### 工作目录解析

工作目录按以下优先级确定：

1. 配置项 `workspace`；
2. DSH System Prompt 中的绝对工作目录；
3. DSH Host 进程的当前目录。

当前从 System Prompt 解析的路径不支持空格。包含空格的目录应显式设置 `workspace`。

## 命令分发

插件注册 `/compact` 和 `/goal`，因此 bundle 自带的 `cordis.patch.yml` 会禁用 DSH 内置的同名命令，避免重复注册。

### `/compact`

- 当前 Provider 为 `claude-code-main`：向当前 Claude Code 会话发送原生 `/compact`，并将续接状态切换到压缩后产生的新 Session ID。
- 其他 Provider：调用 DSH 的 `compaction.compactNow()`，保持 DSH 原有行为。

Claude Code 路由下的 `/compact` 依赖 `nativeResume`，且必须先建立一次内层会话。该操作压缩的是 Claude Code 上下文，不会修改 DSH 界面中的历史记录。

### `/goal`

- 当前 Provider 为 `claude-code-main`：将命令作为后续用户消息发送给 Claude Code 的原生目标机制。
- 其他 Provider：委托给 `dsh-command-goal` 的原处理器。

Claude Code 路由下的 `/goal` 依赖 `nativeResume`，且必须先建立一次内层会话。该路由的目标状态保存在 Claude Code 内部，不显示在 DSH 目标面板中。当前不支持在 `/goal` 命令消息中附带图片。

## 工具活动显示

配置项 `toolActivityDisplay` 支持三种模式：

| 模式 | 行为 | 界面补丁 |
| --- | --- | --- |
| `native` | 按 SDK 消息顺序输出专用 `tool-activity` 内容块；默认值 | 需要 |
| `fold` | 将已完成的工具活动输出为可折叠的 reasoning 内容块 | 不需要 |
| `card` | 输出标准 DSH `tool-call` 回显卡片；卡片在外层 LLM 流结束后统一执行和显示 | 不需要 |

`native` 模式依赖 `dsh-patches/tool-activity/` 中的 DSH Web 补丁，使 Chat 与 Trajectory 客户端能够识别并渲染 `tool-activity` 内容块，同时使中断处理保留已完成的活动块。`fold` 使用现有 reasoning 渲染路径；`card` 使用标准 `tool-call` 回显路径。

当前源码中的补丁探测和自动降级逻辑仍以 `card` 为检测条件，与实际内容块路径不一致。因此部署时不能依赖自动降级来判断 `native` 模式是否可用，应通过 `verify.mjs` 或 `checkup.mjs` 显式验证补丁状态。

`showToolActivity: false` 可完全关闭工具活动投影。`toolResultDisplayChars` 控制单次工具结果在界面中的最大展示字符数。

## 子代理镜像

Claude Code 用自己的 `Agent` 工具派发的子代理运行在 SDK 消息流的子流中（`parent_tool_use_id` 非 `null`）。这些消息不参与父会话的上下文占用采样，也不在父会话中显示工具活动；`mirrorSubagents` 启用时，插件额外把它们写成 DSH 子会话。

镜像出的子会话与 DSH 原生子代理具有相同的可见性：出现在会话头部的子代理目录中，可点开查看完整内容。

| SDK 事件 | 镜像动作 |
| --- | --- |
| 主流出现 `Agent` 工具调用 | 建子会话，落 `subagent/descriptor`，写入 `turn/start` + 派发提示 + `step/start` |
| 子流的 assistant 消息 | 写入 `assistant/message`（推理、正文、工具调用块） |
| 子流的工具结果 | 写入 `tool/result` |
| 主流返回该 `Agent` 调用的结果 | 写入 `step/end` + `turn/end` + `session/title` |

镜像不写父会话记录，不重复执行任何工具，也不调用 LLM——被镜像的工作已由内层完成。持久化由 DSH 的 `sessionPersistence` 通过 `session/event` 订阅自行完成，插件不直接写盘。

### 派发工具名

派发工具的名字是实测值，不是约定值。claude 2.1.263 用的是 `Agent`；`MIRROR_TASK_TOOLS` 同时接受 `Agent` 与 `Task`（CLI 二进制中两个字符串均存在），并要求 `input.prompt` 存在，以免第三方同名工具开出空子会话。

这个名字曾被假设为 `Task`，导致镜像完全静默失效：名字不匹配则不产生 `open` 动作，既无子会话也无任何报错，而离线断言因使用同一错误假设构造的 fixture 而全部通过。因此该假设由两处对真实数据的校验守护：

- `checkup.mjs --live` 起一次真实内层会话，把 CLI 实际发出的 tool_use 块交给生产判定函数 `isMirrorTaskCall` 校验（模型偶尔不派发子代理，故重试 3 次）。
- `fixtures/subagent-stream.json` 是一次真实派发的完整 SDK 消息流录制，`verify-compact.mjs` 的 ⑪ 组以它为形状锚点离线校验，无需起会话。

Claude Code 升级后若怀疑镜像失效，先跑 `node checkup.mjs --live`。需要重新录制 fixture 时，用 SDK 跑一次派发子代理的会话并保留 `type`、`parent_tool_use_id` 及内容块的 `type`/`id`/`name`/`input`/`tool_use_id`/`content`/`is_error` 字段。

约束与已知取舍：

- 镜像子会话没有 live Agent，因此父行的「N 个子代理运行中」活动指示器不会亮。子代理可列出、可点开，但没有实时运行状态。
- 所有子事件折叠到 turn 1 / step 1。这是经真实 projection fold 与冷读验证过的形状；按内层每次模型调用拆分 step 的形态未经验证。
- 中断、内层报错或进程被杀时，未返回结果的子会话由插件补 `turn/end`（`reason.kind: interrupted`）收尾。
- 子会话事件形状的错误不会在写入时报错，只在冷读时表现为「会话记录损坏」。修改事件形状后必须重跑 `probes/driver-probe.mjs` 的两阶段验证。

## 图片处理

插件从 DSH 的持久化附件服务读取用户消息中的图片，并转换为 SDK 流式输入。支持的媒体类型为：

- `image/png`
- `image/jpeg`
- `image/gif`
- `image/webp`

单张图片受 `imageMaxPixels` 和 `imageMaxBytes` 限制。每次请求中重新编码的历史图片总量上限为 20 MiB。缺少附件服务、媒体类型不受支持或图片超过限制时，请求会以明确错误结束。

## 配置

配置命名空间为 `llm-claude-code`，由插件注册到 DSH Settings 服务。配置变更在后续请求中读取；通常不需要重启 DSH。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `providerName` | `Claude Code · 订阅` | DSH 模型选择器中显示的 Provider 名称 |
| `binary` | 空 | Claude Code 可执行文件路径；为空时通过 DSH subprocess 服务解析 `claude` |
| `workspace` | 空 | 固定工作目录；为空时从请求上下文解析 |
| `contextWindow` | `200000` | 未被模型条目覆盖时使用的上下文窗口 |
| `partialMessages` | `true` | 请求 SDK 输出增量消息 |
| `showThinking` | `true` | 请求并显示摘要化推理内容 |
| `persistSession` | `false` | SDK 会话持久化配置；`nativeResume` 开启时会被强制为 `true` |
| `showToolActivity` | `true` | 是否显示 Claude Code 工具活动 |
| `toolActivityDisplay` | `native` | 工具活动展示模式：`native`、`fold` 或 `card` |
| `permissionMode` | `bypassPermissions` | Claude Agent SDK 权限模式 |
| `askUserQuestion` | `true` | 是否将 `AskUserQuestion` 接入 DSH 提问界面 |
| `imageMaxPixels` | `4194304` | 单张图片最大像素数 |
| `imageMaxBytes` | `1048576` | 单张图片编码后的最大字节数 |
| `toolResultDisplayChars` | `3000` | 工具结果的界面展示字符上限 |
| `nativeResume` | `true` | 是否续接 Claude Code 原生会话 |
| `dshTools` | `true` | 是否启用全部 DSH 工具桥接与原生工具替换 |
| `mirrorSubagents` | `true` | 是否把内层子代理镜像为 DSH 子会话 |

`dshTools: false` 只关闭 DSH 工具桥接、相应原生工具替换和相关提示调整，不会回滚 Provider、图片、会话续接或命令分发等其他功能。

支持的 `permissionMode` 值：

```text
default | acceptEdits | bypassPermissions | plan | dontAsk | auto
```

未知值会回退到 `bypassPermissions`。

## 模型目录

插件当前暴露以下 Claude Code 模型别名：

| 模型 ID | 显示名称 | 声明的上下文窗口 |
| --- | --- | --- |
| `fable` | Claude Fable | 1M |
| `opus` | Claude Opus | 1M |
| `sonnet` | Claude Sonnet | 1M |
| `haiku` | Claude Haiku | 200K |
| `haiku[1m]` | Claude Haiku · 1M | 1M |

推理强度支持 `low`、`medium`、`high`、`xhigh` 和 `max`，默认值为 `high`。模型别名及上下文能力依赖所安装的 Claude Code 版本和当前订阅权限。

## 安装

### 前置条件

- Node.js 20 或更高版本；
- 已安装并登录 Claude Code CLI；
- DSH 版本与插件分支兼容；
- 当前主线已验证 DSH `0.1.2-rc.1`。

已验证环境：

| 组件 | 版本 |
| --- | --- |
| DSH | `0.1.2-rc.1` |
| Claude Code | `2.1.260` |
| Claude Agent SDK | `0.3.220` |
| Node.js | `24.15.0` |

### 安装到 DSH Profile

```bash
dsh --version
dsh plugin --profile web add /path/to/llm-claude-code
```

安装后重启 `dsh web`，再刷新 Web 页面。包内 `cordis.patch.yml` 会自动：

1. 注册 `dsh-llm-claude-code` 插件行；
2. 禁用 DSH 内置 `/compact`；
3. 禁用 DSH 内置 `/goal`。

无需手工修改 Profile 或全局 Cordis 配置。

卸载命令：

```bash
dsh plugin --profile web remove dsh-llm-claude-code
```

## DSH 版本兼容

DSH `0.1.1-rc.2` 与 `0.1.2-rc.1` 的相关内部接口不兼容。主线代码面向 `0.1.2-rc.1`。

如需在 `0.1.1-rc.2` 上使用源码仓库版本，先应用兼容补丁。该文件当前未包含在 `package.json` 的发布文件清单中，因此从打包产物安装时可能不可用：

```bash
git apply compat/dsh-0.1.1-rc.2.patch
```

升级回 `0.1.2-rc.1` 后撤销补丁：

```bash
git apply -R compat/dsh-0.1.1-rc.2.patch
```

主要差异包括：

| 接口 | `0.1.1-rc.2` | `0.1.2-rc.1` |
| --- | --- | --- |
| 工具调用 ID 类型 | `CallId` | `ToolCallId` |
| Settings 注册 | `installSettingsSection()` / `settingsNamespace()` | `settings.installSection()` |
| 权限预设查询 | `permissionPresets.current(events)` | `permissionPresets.current(session)` |
| Web 补丁目标包 | runtime / conversation / trajectory | chat / trajectory |

前三项会影响插件加载或权限映射；最后一项影响 `native` 工具活动内容块的界面渲染。

## Web 补丁

使用默认 `toolActivityDisplay: native` 时需要应用补丁：

```bash
node dsh-patches/tool-activity/apply.mjs
node dsh-patches/tool-activity/verify.mjs
```

补丁修改 DSH 安装目录中的 Web Bundle。升级或重新安装 DSH 后，这些修改会被覆盖，需要重新执行。应用补丁后必须重启 `dsh web` 并刷新页面。

不应用补丁时，应将 `toolActivityDisplay` 显式设置为 `fold` 或 `card`。

## 验证与维护

```bash
node verify-compact.mjs
node checkup.mjs
node checkup.mjs --live
```

| 命令 | 验证范围 |
| --- | --- |
| `verify-compact.mjs` | 在模拟 Cordis/DSH 环境中执行综合离线回归，验证命令分发、权限映射、工具桥接、消息结构和子代理镜像；当前为 261 项 |
| `checkup.mjs` | 读取当前 DSH 安装目录，检查服务名、方法签名、语义假设、补丁状态和安装状态 |
| `checkup.mjs --live` | 在静态检查之外启动真实 Claude Code 会话，验证 SDK 输出格式及原生工具行为 |
| `probes/`（两阶段，见 [probes/README.md](probes/README.md)） | 用生产驱动写出真实子会话再由全新进程冷读，验证镜像事件形状能过还原校验 |

升级 DSH、Claude Code 或 Claude Agent SDK 后，至少运行前两项。模拟测试无法发现 DSH 内部服务改名等兼容性变化，因此不能替代 `checkup.mjs`；`checkup.mjs` 也不检查会话事件形状能否被还原校验接受，那一层只有 `probes/` 覆盖。

如 DSH 安装位置不同，可指定包根目录：

```bash
node checkup.mjs --root /path/to/dsh/node_modules/@deepseek-ai
```

## 源码结构

| 路径 | 说明 |
| --- | --- |
| `index.js` | npm 包稳定入口，导出 `main.v20.mjs` 的命名导出 |
| `main.v20.mjs` | 插件实现：Adapter、消息转换、工具桥接、权限映射、续接及命令处理 |
| `main.v29.mjs` | 手工挂载开发使用的兼容转发入口，不包含独立实现 |
| `cordis.patch.yml` | DSH bundle 配置补丁，负责插件注册和同名命令替换 |
| `checkup.mjs` | 面向真实 DSH 安装的兼容性检查 |
| `verify-compact.mjs` | 面向模拟环境的逻辑与回归测试 |
| `e2e-*.mjs` | 针对工具桥接、权限切换和别名行为的专项测试 |
| `dsh-patches/tool-activity/` | `native` 显示模式所需的 DSH Web 补丁及验证脚本 |
| `compat/dsh-0.1.1-rc.2.patch` | DSH `0.1.1-rc.2` 兼容补丁 |
| `INSTALL.md` | 历史实现记录、实验依据和详细排障信息 |
| `main-versions-v10-v28.tar.gz` | 早期开发入口归档 |

`main.vNN.mjs` 文件名是早期手工挂载场景下用于触发模块重新加载的开发机制，不代表独立发布版本。当前发布入口固定为 `index.js`，实际实现位于 `main.v20.mjs`。代码内容修改后仍应重启 `dsh web`。

## 已知限制

- `nativeResume` 状态保存在内存中；重启 DSH 后，首轮请求会使用完整历史重建关联。
- 编辑历史、切换 Provider 或 Claude Code Session 丢失会中断续接链，并触发完整重放。
- Claude Code 路由下的 `/goal` 不使用 DSH 目标面板。
- Claude Code 路由下的 `/compact` 只压缩内层上下文，不修改 DSH 历史记录。
- DSH 自动上下文压缩仍由 DSH 自身处理；它与手动内层 `/compact` 作用于不同历史层。
- DSH 每轮开始时会清空任务列表投影，因此 `todo_write` 在 DSH 面板中的生命周期与 Claude Code 原生 TodoWrite 不同。
- DSH `read` / `read_image` 不覆盖 Claude Code 原生 Read 对 PDF 和 Jupyter Notebook 的处理能力。
- `native` 模式的 Web 补丁不属于 npm 包可持久维护的文件，DSH 升级后需要重新应用。
- 当前补丁探测逻辑与实际需要补丁的显示模式不一致；这是已记录的实现问题，部署检查应以补丁验证脚本和 `checkup.mjs` 为准。
- `checkup.mjs` 的默认 DSH 包路径与当前开发环境相关；其他环境应使用 `--root`。
- 镜像子会话不显示实时运行状态，且不随父会话的历史编辑或分支切换回滚。
- `turn/end` 的 `reason` 只有 `completed`、`blocked`、`max-tokens`、`interrupted` 四个单键取值能通过 DSH 的还原校验；`error` 与 `aborted` 需要额外字段，写错只在冷读时暴露。

## License

MIT
