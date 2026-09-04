# dsh-claude-code

把 Claude Code 变成 DSH 里的一个「模型选项」。选中它以后，你照常在 DSH 界面里聊天，
真正干活的是 Claude Code —— 用的是你的 Claude 订阅，不是 API 计费。

## 它在解决什么问题

DSH 和 Claude Code 都是「会用工具的助手」。硬凑在一起，两边会打架：

```
                    没有这个插件                有了这个插件
执行命令            两边各有一套，可能跑两遍      只有一套，DSH 的
权限设置            内层不知道外层调成了什么      外层调紧，内层跟着紧
/compact、/goal     同名命令，走错一边就出错      按路由自动分流
工具做了什么        界面上看不见，只有最终结果    实时显示成卡片
待办清单            内层自己记，DSH 面板空着      写进 DSH 的计划面板
```

这张表在说：插件干的活是「调停」—— 让两套系统对外表现得像一套。

## 分工

```
┌──────────────────────────────────────────────┐
│  DSH（外壳）                                  │
│  会话记录、模型选择、取消按钮、界面卡片          │
├──────────────────────────────────────────────┤
│  本插件（中间层）                              │
│  翻译两边的工具、命令、权限、状态               │
├──────────────────────────────────────────────┤
│  Claude Agent SDK → Claude Code（干活的）      │
│  真正的思考和工具调用循环                       │
└──────────────────────────────────────────────┘
```

这张图在说：上面管界面，下面管干活，插件夹在中间做翻译。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 工具桥接 | 把 DSH 的 `bash` / `read` / `write` / `edit` / 目标工具 / `todo_write` 交给内层用，同时关掉内层同名的原生工具，避免一件事做两遍 |
| 实时工具卡 | 内层每调一次工具就在界面上出一张卡，不用等整轮结束 |
| 权限只收紧不放松 | 外层调成只读，内层跟着只读；外层放开，内层维持配置值 |
| 命令分流 | `/compact`、`/goal` 这类两边重名的命令按路由送到正确的一边 |
| 提问卡 | 内层想问你问题时，弹的是 DSH 的原生问题卡 |
| 会话续接 | 用原生 resume，不是把历史全文重放一遍 |
| 一键回退 | 配置项 `llm-claude-code.dshTools: false` 可关掉全部工具桥接，下一轮生效，不用重启 |

## 文件都是干什么的

| 文件 | 作用 |
| --- | --- |
| `package.json` | 组合包清单：`dsh.bundle.patch`、入口、依赖 |
| `index.js` | 包入口，一行转发到 `main.v20.mjs`（发布用的固定入口） |
| `cordis.patch.yml` | 自带配置层：注册插件行 + 关掉 DSH 内置的 `/compact`、`/goal` |
| `main.v20.mjs` | 全部实现都在这里，原地修改 |
| `main.v29.mjs` | 只有一行 `export * from './main.v20.mjs'`，手工挂载开发时用，不随包发布 |
| `INSTALL.md` | 历次改动的来龙去脉与排障记录（其中的手工安装步骤已被上面的组合包方式取代） |
| `checkup.mjs` | 体检：直接读真实 DSH 目录，核对插件的假设还成不成立 |
| `verify-compact.mjs` | 自检：用假环境跑一遍插件逻辑 |
| `e2e-*.mjs` | 针对单项功能的端到端检查 |
| `dsh-patches/tool-activity/` | 界面补丁，让工具卡能正常渲染 |
| `main-versions-v10-v28.tar.gz` | 早期版本归档 |

> **别把 `vNN` 当成「第 NN 版的代码」。** v21 以后的入口文件全是一行转发，
> 实现始终在 `main.v20.mjs` 里原地改。把配置指回旧文件名，加载的还是今天的代码，
> 只是名字旧。真正的回退开关是 `dshTools`。

## 安装

本插件是标准**组合包**（bundle），按 DSH 官方约定安装
（[docs/user/develop/basic/publish.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)）：

0. **先确认 DSH 版本**：`dsh --version`。不是 `0.1.2-rc.1` 就先看下面的
   「DSH 版本兼容」—— 版本对不上会直接启动失败。
1. 装进 profile：

   ```sh
   dsh plugin --profile web add /path/to/llm-claude-code
   ```

2. 重启 `dsh web`，刷新页面。

包自带 `cordis.patch.yml`，会自己注册插件行、并关掉 DSH 内置的 `/compact` 与
`/goal`（本插件提供同名替代，注册两次会抛错）——**不需要手改任何全局配置**。
卸载用 `dsh plugin --profile web remove dsh-llm-claude-code`，依赖和配置层一起摘掉。

> **没打界面补丁也能正常用。** `toolActivityDisplay` 默认 `native`，不依赖补丁；
> 只有显式设成 `card` 时才需要。补丁不在位时插件会自动回退到 `fold` 并在日志里
> 说明原因，不会让轨迹面板抛 TypeError。补丁怎么打见下面「界面补丁」。

> ⚠️ 改完代码**必须重启** `dsh web`。插件加载器只在文件名变化时才重新读代码，
> 改内容它不管。

## 测试

```bash
node verify-compact.mjs   # 自检，171 项（无条件分支，从哪跑都一样）
node checkup.mjs          # 体检，39 项（打了 rc.2 回退补丁后是 40 项）
node checkup.mjs --live   # 额外探测 Claude Code 的输出格式，要真起一次会话，约一分钟
```

两个都要跑，因为它们查的不是一回事：

```
verify-compact.mjs   用假环境      查「插件逻辑对不对」
checkup.mjs          读真实目录    查「插件对 DSH 的理解还准不准」
```

DSH 改了名字或公式之后，前者照样全绿 —— 因为假环境仍按老名字应答。
只有后者能发现。

## DSH 版本兼容

> ⚠️ **DSH `0.1.1-rc.2` 和 `0.1.2-rc.1` 互不兼容，代码只能二选一。**
> 装错版本不是「功能少几个」，而是插件加载直接抛异常。

主线（`main` 分支）适配 **0.1.2-rc.1**。已验证的组合：

| 组件 | 版本 |
| --- | --- |
| DSH | 0.1.2-rc.1 |
| Claude Code | 2.1.260 |
| Claude Agent SDK | 0.3.220 |
| Node.js | 24.15.0 |

### 用 0.1.1-rc.2 的话，先打回退补丁

```bash
dsh --version                              # 先确认，是 0.1.1-rc.2 才需要打

git apply compat/dsh-0.1.1-rc.2.patch      # 回退到 0.1.1-rc.2
git apply -R compat/dsh-0.1.1-rc.2.patch   # 撤销回退，回到 0.1.2-rc.1
```

打完再按上面的「安装」走。补丁是可逆的，升级 DSH 之后用 `-R` 撤销即可，
不需要重新拉仓库。

如果 `git apply` 报冲突（说明主线已经往前走了），退回到这个补丁对应的提交再打：

```bash
git log --oneline -- compat/dsh-0.1.1-rc.2.patch   # 找到补丁最后一次更新的提交
git checkout <该提交> && git apply compat/dsh-0.1.1-rc.2.patch
```

### 两个版本差在哪

补丁覆盖 4 个文件，差异来自 DSH 上游的 4 处变更：

| 变更 | 0.1.1-rc.2 | 0.1.2-rc.1 |
| --- | --- | --- |
| 工具调用 ID 类型 | `CallId` | `ToolCallId` |
| 配置项注册 | `installSettingsSection()` + `settingsNamespace()` | `ctx.inject(['settings'])` → `settings.installSection()` |
| 权限预设查询入参 | `permissionPresets.current(events)` | `permissionPresets.current(session)` |
| 界面补丁的目标包 | `dsh-client-runtime`、`dsh-client-ui-conversation`、`dsh-client-ui-trajectory` 三处 | `dsh-client-runtime` 被上游删除，分类器内联进各消费者 bundle；卡片从 conversation 搬到 `dsh-client-ui-chat`。变成 `dsh-client-ui-chat` + `dsh-client-ui-trajectory` 两处 |

（`dsh-llm` 那处补丁两个版本都要打，没变化。）

前三处让插件在错误版本上**加载即崩**，第四处只让工具卡渲染不出来。
体检项数也因此差 1：rc.2 是 40 项，rc.1 是 39 项。

功能上两个版本没有差别 —— 包括 `todo_write` 桥接，`dsh-tool-todo` 在
0.1.1-rc.2 里就已经有了。

## 已知的坑

- **升级 DSH 会冲掉界面补丁。** 插件本体在 `~/.dsh/profiles/` 下不受影响，
  但界面补丁打在 DSH 安装目录里，升级必被覆盖。跑
  `node dsh-patches/tool-activity/apply.mjs` 重打即可。
- **计划面板每轮开头会清空。** 这是 DSH 的设计，不是故障 —— 它在新一轮开始时
  收掉上一轮的清单，而 Claude Code 原本的清单是跨轮保留的。
- **有些失效是不报错的。** 插件对 DSH 的「软查询」有 7 处，DSH 改名之后它们会
  静默退回默认行为。这正是需要定期跑 `checkup.mjs` 的原因。
