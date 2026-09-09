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

## 跑完要清理

探针会在 `~/.dsh/sessions/<工作区>/` 下留四个真实子会话。id 在阶段一的 `childIds` 里，也存在 `driver-probe-ids.json`（gitignore，两阶段之间的中间文件）。留着无害，但会混在真实会话里。

## 换机器要改一行

`driver-probe.mjs` 里的 `PARENT` 是本机一个真实存在的父会话 id，决定探针产物挂在界面上哪一行底下。取本机任意一个：

```bash
ls ~/.dsh/sessions/<工作区目录名>/
```

其余路径都从 `import.meta.url` 推出来，clone 到别处不用改。两个 patch 里的 `name: ./driver-probe.mjs` 也是相对的——DSH 解析 patch 的 `name` 时，基准是**patch 文件自己所在的目录**，不是当前工作目录。

## headless profile 的既有问题

两个 patch 开头都有 `- id: llm-cursor / disabled: true`。那个 profile 里 `llm-cursor` 指向一个不存在的文件，会让整棵配置树加载失败——与本探针无关，只在本次运行的 overlay 里跳过，不改动任何 profile 文件。
