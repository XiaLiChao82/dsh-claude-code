# probes/

子代理镜像的**冷读验证**探针。改动镜像事件形状后必须跑一遍。

## 为什么离线断言替代不了它

镜像子会话的事件形状有**三层互不覆盖**的校验：

| 层 | 谁做 | 形状错了会怎样 |
| --- | --- | --- |
| 写入 | `session.append` | **不报错** |
| projection fold | `sessionProjections.snapshot` | 多数情况放行 |
| 还原校验 | `sessionQuery.observeSession` 冷读 | 拒绝 → 界面显示「会话记录损坏」 |

`verify-compact.mjs` 只能测到第一层，而第三层的失败**只在冷读暴露**。已经被这个缺口咬过一次：`turn/end` 的 `reason: {kind:'error'}` 写得进、fold 也放行，只在冷读被拒 `malformed pre-react-loop turn/end`——藏了五天，261 项离线断言全绿也没发现（判据见 [../README.md](../README.md) 的「子代理镜像」）。

## 怎么跑

两阶段**必须分进程**：同进程 `inspect` 到的可能来自 live store，证明不了落盘。

```bash
cd llm-claude-code

# 阶段一：用生产的 createMirrorDriver 把流写成真实子会话
dsh --profile headless --patch probes/driver-append.patch.yml exec "noop"
#   期望 RESULT=APPENDED_OK，四个 projection=ok
#   结尾「退出前同进程 inspect: 读不到」是 fiber 生命周期的假故障，不是失败

# 阶段二：全新进程冷读
dsh --profile headless --patch probes/driver-read.patch.yml exec "noop"
#   期望 RESULT=COLD_OK
```

覆盖四条路径：真实录制流（`../fixtures/subagent-stream.json`）走完整生命周期，另三条合成流补真实录制覆盖不到的失败收尾与中断收尾。

## settlement 探针：`live` 模式写进主会话的事件形状

```bash
cd llm-claude-code
dsh --profile headless --patch probes/settlement.patch.yml exec "noop"
#   期望 RESULT=SETTLEMENT_OK
#   两组都必须「符合预期」：GOOD 过、CANARY 抛错
```

单进程跑完，不需要分两阶段——这一层是 projection fold，不是冷读。

与 driver-probe 的分工：driver-probe 验**子会话**（镜像出来的那个），
settlement 验 `live` 模式（v33/v34）直接 append 进**父会话**的那三种事件
（`assistant/message` / `tool/call` / `tool/result`）。后者在 2026-09-14 之前
没有任何探针覆盖，于是 `buildMirrorAssistantEvent` 缺 `stream` 字段这个缺陷
一路通到了界面上：会话热着时 token-meter 的 `usageOf` → `lastAssistantStreamChunk`
里 `stream.length - 1` 抛 TypeError，网关兜底成 `gateway/internal`，显示
「历史加载失败：Cannot read properties of undefined (reading 'length')」；
会话冷了之后 restore 的 `assertAssistantSettlementShape` 直接判整个日志损坏。
同一个根因两副面孔，写入层（`session.append`）全程不报错。

**CANARY 组不是凑数的。** 它故意把 `stream` 删掉，必须失败；GOOD 过而 CANARY
也过，说明这一层压根没在校验，探针已经瞎了。第一版就是这么瞎的：`inject` 只列了
`sessions` + `sessionProjections`，注册的 projection 单元为空，`snapshot()`
什么都不折叠，两组于是一起「通过」。所以探针还有一条自检——折叠单元数为 0
直接判失败。**改 inject 或换 profile 之后，先确认自检那行仍然是非 0。**

## mount 探针：插件到底挂上了没有（重启前的安全检查）

改完 `main.v20.mjs` 之后、重启用户正在用的实例**之前**，先在隔离 profile 上确认
插件能挂起来，避免「重启后起不来、界面全白」。

```bash
# 一次性准备隔离 profile（复制 web 的组合，node_modules / plugins 走软链复用）
dsh --profile cc-verify --from-default-profile web --dump-config >/dev/null
sed 's/"dsh-profile-web"/"dsh-profile-cc-verify"/' ~/.dsh/profiles/web/package.json \
  > ~/.dsh/profiles/cc-verify/package.json
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/cc-verify/
ln -sfn ../web/node_modules ~/.dsh/profiles/cc-verify/node_modules
ln -sfn ../web/plugins      ~/.dsh/profiles/cc-verify/plugins

# 带探针启动（--patch 是启动器参数，必须排在 --port 等 app 参数之前）
dsh --profile cc-verify --patch probes/mount-probe.patch.yml --port 3081 --no-open
#   期望输出 === CC-MOUNT-PROBE ===，其中
#   claude-code-main routed: true / configurable: true
```

**绝不能拿 `web` profile 做这件事**：`dsh --profile web` 哪怕只是 `--help`，
`prepareProfile` 也会重写 `~/.dsh/profiles/web/cordis.yml`——等于在用户对话中途
动他正在用的 profile。

为什么要探针而不是看日志：插件末尾那句 `provider "claude-code-main" registered`
是 `logger.info`，web 形态下被日志级别吃掉，启动输出里一个字都没有。而 cordis 把
每个 fiber 的异常收在自己那层，**apply() 半途抛错的表现同样是「安静地什么都没有」**——
「没报错」证明不了「挂上了」。探针取的是 apply() 最后两行才发生的副作用
（`registerConfigurableProviders` / `registerAdapter`），只有走到底才为 true。

顺带当场证了 v38 的前提：全局工具视图里 `write`/`edit`/`read`/`bash`/`glob`/`grep`
全部 `echo-owned(global)=true`，且全局视图总共只有 15 个工具、真 tool-fs 的
`write` 根本不在里面——它挂在 agent 层。这正是 v37 那个不带 scope 的
`ctx.tools.get(name)` 永远看见自己、守卫永远不触发的原因。

## client 探针：客户端插件与 host 的名字有没有漂移（离线，秒级）

`client-driver-check.mjs` 不起进程、不碰浏览器，只校验 v41 那对分工的三条不变量：

```bash
node probes/client-driver-check.mjs
#   期望 RESULT=CLIENT_DRIVER_OK
```

它管的是：

1. **驱动名一致** —— `src/client/driver-names.js` 注册的 key 必须等于 `main.v20.mjs`
   的 `ECHO_DRIVER`。两边是两个 bundle，谁单独改了名字，卡片就会永远露出来。
2. **驱动名不撞 DSH 命名空间** —— 必须不是小写。撞了就会重演 v38/v39 那两个 bug。
3. **CSS 选择器能插值成形** —— 模板里的 `${MARKER}` 在 bundle 里是**源码形态**，
   运行时才插值；肉眼 grep 会误判成"没替换"，所以要用探针求值。

改完 `src/client/` 记得 `npm run build:client`——DSH 加载的是 `lib/client.js`，
不是源码；而且 bundle 版本号是启动时按内容算的哈希，**必须重启才生效**。

另有一条 v42 绊线在 `echo-ownership-check.mjs` 里：**驱动块不许携带任何原生载荷**
（`command`/`file_path`/`pattern`/`query`/`url`/`description`）。它保留的只有
`claudeActivity`（`isEchoCallBlock` 靠它剔除回喂）、`ccTool`（人工读日志时的可辨识度）
和一个空的 `output` 键（schema `required`）。

这条不只是省字节。`output` 与标记在 `defineEchoTool` 的 schema 里是 `required`，
**载荷齐全的驱动块就是一个「能通过真工具校验」的块**——正是 v37 让回显被执行第二次的
那个形状。把载荷去掉，这扇门就从构造上关死了。

## e2e 探针：真跑一次写/编辑/bash，看卡片落成什么样

`cc-verify` 只回答「起得来吗」，回答不了「写文件还报不报错」。后者要一个真实会话，
用 headless 形态最省：

```bash
# 一次性准备（复制 headless 模板，加上本插件这一行，node_modules 软链复用）
dsh --profile cc-headless --from-default-profile headless --dump-config >/dev/null
#   然后把 package.json 的 bundles 写成 base + headless + dsh-llm-claude-code，
#   dependencies 加 "dsh-llm-claude-code": "link:<本仓库>/llm-claude-code"
ln -sfn ../web/node_modules ~/.dsh/profiles/cc-headless/node_modules

# 先零成本确认内层会拿到真工具还是回显（打印完立即 exit，不发 LLM 请求）
dsh --profile cc-headless --patch probes/e2e-scope.patch.yml "noop"
#   期望 REAL fs tools at agent scope: write, edit, read

# 再真跑
dsh --profile cc-headless "……三步任务……"
```

判据在会话日志里，不在终端输出里：

```bash
zstd -dc ~/.dsh/sessions/<工作区>/session-<id>/session.v3.jsonl.zstd \
  | grep -o '"type":"tool/[a-z]*"' | sort | uniq -c
```

按模式分别看：

- **`live`**：callId 全带 `cc-live-` 前缀；`tool/call` 与 `tool/result` 数量相等且
  `sourceEventSeqs` 一一对应；`write` 卡片带 `content`、`edit` 卡片带
  `old_string`/`new_string`；整轮只有一个 `step/start`。
- **`interleave`**（v41 起）：每次工具调用产生**两条** `tool/call`，必须成对出现，
  缺一条就说明有 bug：
  - **富卡片**：callId 带 `cc-live-` 前缀，名字**小写**（`write`/`edit`/`bash`），
    参数是真实参数。小写才命中 DSH 原生 keyed toolview，富卡片就是这么来的。
  - **驱动块**：callId 普通，名字恒为 `ClaudeCodeActivity`，参数是 echo 载荷。它
    只负责让 loop 开新 step，由客户端插件渲染成不可见。
  - `step/start` 数量 ≈ 驱动块数（一块一步，这正是交错的机制）；富卡片走 append
    不占 step，所以它的 `step` 恒为 1。`isError` 全 false。

  两条判据容易看反，记牢：**小写=可见的富卡片，大写=不可见的驱动块**。若日志里出现
  大写的 `Bash`/`Write`（v40 形态），说明跑的是旧代码。

两种模式共同的判据：**`tool/call` 与 `tool/result` 数量相等**——回显若被当成真工具
执行，会多出一对。v40 起结构上已不可能发生（回显名不占 DSH 的小写命名空间，DSH 只
能解析到我们的回显），但这条判据留着，因为它同时也能抓住卡片丢失。

### e2e-live.patch.yml 为什么最后没用上

它本来是想把 headless 的工具平面对齐成 web 的（关掉 host 层 tool-fs/tool-bash、
补一行 `agent-presets`）。实测**对不齐**：headless 的会话创建路径不走 preset 组合，
`agent-presets` 那一行挂上了也不会把 tool-fs 挂到 agent 平面，结果 agent 手里只剩
回显工具，内层根本没法写文件（`e2e-scope.patch.yml` 会当场把这个照出来）。

保留这个文件是因为它记录了两个 profile 的真实差异，也是 v39 那个 boot 崩溃的复现
入口——正是用它跑的时候，`tool "read" is already registered` 才第一次暴露出来。

## 跑完要清理

探针会在 `~/.dsh/sessions/<工作区>/` 下留四个真实子会话。id 在阶段一的 `childIds` 里，也存在 `driver-probe-ids.json`（gitignore，两阶段之间的中间文件）。留着无害，但会混在真实会话里。

mount 探针只读，不留产物；`~/.dsh/profiles/cc-verify/` 建议留着复用（它只有三个小文件加两个软链），下次改完插件直接再起一次即可。

settlement 探针不用清理：它跑完直接退出，批量落盘的定时器还没到，会话留在内存里没落过盘（实测 `~/.dsh/sessions/` 无新增）。

## 换机器要改一行

`driver-probe.mjs` 里的 `PARENT` 是本机一个真实存在的父会话 id，决定探针产物挂在界面上哪一行底下。取本机任意一个：

```bash
ls ~/.dsh/sessions/<工作区目录名>/
```

其余路径都从 `import.meta.url` 推出来，clone 到别处不用改。两个 patch 里的 `name: ./driver-probe.mjs` 也是相对的——DSH 解析 patch 的 `name` 时，基准是**patch 文件自己所在的目录**，不是当前工作目录。

## headless profile 的既有问题

两个 patch 开头都有 `- id: llm-cursor / disabled: true`。那个 profile 里 `llm-cursor` 指向一个不存在的文件，会让整棵配置树加载失败——与本探针无关，只在本次运行的 overlay 里跳过，不改动任何 profile 文件。
