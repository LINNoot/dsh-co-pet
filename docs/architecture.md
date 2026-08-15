# 架构说明

本文档描述 dsh-pet 的组成、数据流与状态机设计。整体思路：**插件是大脑，
桌宠是脸**——DSH 插件在进程内订阅真实事件（单一事实源），桌宠应用只负责
播放动画与展示气泡。

## 数据流

```text
┌─────────────────────────── DSH 进程 ───────────────────────────┐
│  Cordis 事件总线                                                 │
│   agent/status · session/event · agent/error · goal/changed      │
│        │                                                          │
│        ▼                                                          │
│  dsh-pet-bridge (plugin/)                                         │
│   index.js   订阅事件 → 归一化                                     │
│   state.js   状态机（去抖/完成判定）                               │
│   channel.js UDP 报文 + 原子写 ~/.dsh/dsh-pet-state.json           │
│        │                                                          │
│        │ 自动拉起（autoLaunch）                                    │
│        ▼                                                          │
└───────────┬───────────────────────────────────────────────────────┘
            │ {event, detail}（UDP + 状态文件双通道）
            ▼
┌─────────────────────────── 桌宠进程 ────────────────────────────┐
│  state_listener.py  300ms 轮询 UDP/文件 → 词汇表 → Qt 信号        │
│  pet_app.py         state_changed/action_changed → 动画/气泡      │
└──────────────────────────────────────────────────────────────────┘
```

## 插件状态机（plugin/state.js）

分层状态机：**运行门闩（gate）与展示态（mode）分离**。

### 分层设计

```text
运行门闩 gateRunning（“有没有 agent 在工作”）      展示态 mode（“桌宠该演什么”）
  只由 agent/status 开合（DSH 内核维护的权威信号）     只由结论事件设置：
  running ──► 开（含子代理）                         turn/end reason → waiting/failed/idle
  idle    ──► 关                                      approval 结果 → waiting/idle
  turn/start / user/message ──► 兜底开                goal 结论 → running/waiting/failed/done
  （agent/status 缺失时自动降级）                     review（工具产出 diff）
```

- **内容事件（chunk / step / tool / todo / request）只刷新活动时间 + 出气泡，
  永不改写 mode**——杜绝“推理流把状态拉回 running”掩盖真实状态的问题；
- `agent/status idle` 到达即收状态（等待输入），**不再依赖 90s 兜底**；
  90s 兜底降级为极端防御：触发即显式日志（暴露事件流漏洞），并用快照回溯；
- 快照：每 5s 原子写 `~/.dsh/dsh-pet-state.debug.json`（mode / gate /
  runningAgents / 最近 20 条事件历史），复现状态问题时直接查档定位。

### 完成判定（核心修复）

```text
goal/change(complete) ──► armComplete（8s 去抖窗口）
                              │
       窗口内任何新活动 ──► 取消（用户继续追问、工具调用、子代理运行……）
       窗口到期且（无 agent 运行 或 30s 无任何活动）──► done → waving 单次 → waiting
```

- **轮次结束（turn/end completed）绝不触发完成**，只发 `AgentStop`
  （桌宠进入 waiting 等待输入）；
- 子代理会话（`header.origin === 'subagent'` 或带 `delegationDepth`）的
  turn/goal 事件被过滤，避免子任务完成误触发父任务完成；
- `agent/status` 监听所有 agent（含子代理）：任一 running 即保持门闩打开；
- “30s 无活动”兜底覆盖 agent/status idle 事件丢失（状态卡 running）的极端场景。

### 事件映射表

| DSH 输入 | 输出事件 | 桌宠状态 |
| --- | --- | --- |
| `user/message`（source.kind=user） | `UserPromptSubmit` | running |
| `tool/call` | `PreToolUse` | running |
| `tool/result`（无 diff） | `PostToolUse` | running |
| `tool/result`（meta.diffs 非空） | `patch_apply` | review |
| `approval/asked` | `PermissionRequest` | jumping 单次 → waiting |
| `approval/decided` allowed-once | `agent_message` | running |
| `approval/decided` rejected | `deny` | idle |
| `approval/decided` cancelled | `idle` | idle |
| `turn/end` completed/blocked/max-tokens | `AgentStop` | waiting |
| `turn/end` error / `agent/error` | `failed` | failed 单次 → idle |
| `turn/end` aborted | `idle` | idle |
| `goal/change` complete | （去抖后）`done` | waving 单次 → waiting |
| `goal/change` block | `failed` | failed 单次 → idle |
| `goal/change` create/edit/resume | `agent_message` | running |
| `todo/write`（in_progress） | `action` | 气泡进度行 |
| `agent/status` idle（无 turn/end） | `AgentStop` | waiting（立即反映，不等兜底） |
| 门闩开且 90s 无活动（tick，极端防御） | `idle` | idle |

## 桌宠词汇表（pet/state_listener.py）

与 Codex 版相比的修复：

1. **`agentstop` 进入等待态**——原版词汇表缺失该事件，任何 `AgentStop`
   都落到 unknown 分支把桌宠打回 idle；
2. **未知事件直接忽略**（仅 stderr 记录）——原版会把未知事件重置为 idle；
3. **`patch_apply` 真正触发 review**——原版 hooks 通道没接 patch 事件、
   rollout 通道又把 `patch_apply_end` 错映射为 `agent_message`，review
   状态实际不可达；
4. **移除 rollout JSONL 通道**——DSH 会话日志是 zstd 压缩的
   `session.jsonl.zstd`，外部 tail 不可行；插件在进程内订阅事件，无需
   文件轮询兜底；
5. **完成态可被任何新业务事件取消**——插件是唯一事件源，目标自动续跑时
   不会卡在完成展示。

## 为什么不用轮询会话日志

- DSH 会话日志按 `~/.dsh/sessions/<workspace>/<session-id>/session.jsonl.zstd`
  存储，zstd 压缩且分片，外部读取需解压 + 维护游标 + 处理多会话切换；
- 插件订阅 `session/event`（每个实时追加的日志事件都会广播）即可获得
  完整事件流，无轮询、无竞争、无 last-wins 问题（原版三通道竞争的根因）。

## 自动启动

插件 `apply()` 时若配置了 `petPath`（或环境变量 `DSH_PET_PATH`）且
`autoLaunch: true`，用 `child_process.spawn` 拉起桌宠；`dispose` 时终止
自己拉起的进程。取代原版 `pet_watcher.exe`（tasklist 轮询 Codex 进程）。
