# DSH 桌宠（dsh-pet）

让桌面宠物响应 **DeepSeek Harness** 工作状态的插件 + 桌宠应用。

- **plugin/** — DSH 桥接插件 `dsh-pet-bridge`：订阅 DSH 生命周期事件
  （`agent/status`、`session/event`、`approval/*`、`goal/change`），经状态机
  转换为桌宠事件，通过 UDP + 状态文件推送；可随 DSH 启动自动拉起桌宠；
  **Web GUI 侧边栏底部自带桌宠开关按钮**（显示/隐藏，状态持久化）。
- **pet/** — 桌宠应用（Python 3.11 + PySide6）：透明置顶小窗口，按 Codex
  宠物规则播放精灵图动画，气泡展示任务进度/状态，支持拖拽、悬浮、托盘菜单。
- **scripts/** — 安装/卸载/打包脚本。

本仓库以 Codex 桌宠为基板，根据更符合直觉的操作调整重构而来
## 快速开始

### 1. 安装插件

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
# 已安装过、想重写 petPath 等覆盖时：
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Force
```

脚本会：把桌宠应用部署到 `%LOCALAPPDATA%\dsh-pet`，用 `dsh plugin` 把
`dsh-pet-bridge` 装进 web profile，并在 profile 用户层写入桌宠路径覆盖，
最后创建桌面快捷方式。

**重启 DSH（`dsh web`）后生效。** 桌宠将随 DSH 自动启动。

也可以手动安装插件：

```powershell
dsh plugin --profile web add <本仓库绝对路径>/plugin
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml`（用户层，覆盖 bundle 默认值）
中按需配置：

```yaml
- id: pet-bridge
  config:
    petPath: 'C:/tools/dsh-pet/DshPet.exe'   # 随 DSH 启动桌宠
    petArgs: []                              # pythonw 直启时需要：['<绝对路径>/pet_app.py']
    port: 47890                              # 桌宠 UDP 端口（与 pet_config.json 一致）
    autoLaunch: true
    completionQuietMs: 8000                  # 目标完成后的静默去抖窗口
    idleTimeoutMs: 90000                     # 空闲兜底
```

> 安装器（install.ps1）会自动完成部署与覆盖写入；若用 `pythonw` 直接运行
> 桌宠（未打包 exe），`petArgs` 由安装器自动填好，无需手动配置。

### 2. 启动桌宠

```powershell
# 开发模式（需要 Python 3.11+ 与 PySide6）
py -m pip install -r pet/requirements.txt
py pet/pet_app.py

# 打包成绿色单文件
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
# 产出 dist/DshPet.exe（与 pets/、assets/、fonts/ 同目录即可运行）
```

右键桌宠可切换宠物、手动切换状态、调整大小、开关置顶/状态文字/气泡框；
双击托盘图标隐藏/显示桌宠。

### 3. 卸载

```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1 -RemovePlugin -RemovePetDir
```

## 状态映射

| DSH 事件 | 桌宠动画 |
| --- | --- |
| 用户提交消息（`user/message`） | `running`（气泡显示任务文本） |
| 工具调用（`tool/call` / `tool/result`） | `running`（气泡显示工具名/进度） |
| 产出代码变更（`tool/result` 带 diff） | `review` 循环（等待审阅） |
| 请求授权（`approval/asked`） | `jumping` 单次 → `waiting` |
| 授权通过（`allowed-once`） | `running` |
| 拒绝授权（`rejected`） | `idle` |
| 轮次结束（`turn/end` completed/blocked/max-tokens） | `waiting`（等待你的输入，**不庆祝**） |
| 轮次/步骤失败（`turn/end` error、`agent/error`） | `failed` 单次 → `idle` |
| **目标完成**（`goal/change` complete）+ 静默去抖 8s | `waving` 单次 → `waiting`（绿勾气泡 10s） |
| 目标受阻（`goal/change` block） | `failed` 单次 → `idle` |
| 长时间无活动（90s） | `idle` |

### 完成判定（修复原版 bug 的关键）

原版桌宠把 **任何轮次结束** 都当成任务完成，导致多轮任务中途反复出现
“完成”动画。本实现中：

- 轮次结束只进入 `waiting`；
- 只有 **目标完成（goal complete）** 才会触发完成动画，且需经过
  `completionQuietMs`（默认 8s）静默去抖窗口——窗口内出现任何新活动
  （新消息、工具调用、子代理运行）都会取消完成信号。

## 宠物包

结构可参考 Codex，高度兼容codex桌宠 。**本仓库不随源码分发宠物素材**（授权通常不明确），
请放入自己的宠物包：

```text
pets/我的宠物/
  pet.json          # 可选：id / displayName / description / spriteVersionNumber
  spritesheet.webp  # 8 列；9 行（v1，192x208/格）或 11 行（v2）
```

宠物包可放在 `pet/pets/`（应用目录，优先）或 `~/.dsh/pets/`（用户目录，
升级应用不丢失）。安装器会把 `pet/pets/` 内容一并部署到
`%LOCALAPPDATA%\dsh-pet\pets\`。

## 通信协议

插件 → 桌宠：

1. UDP 报文 `127.0.0.1:<port>`：`{"event": "<事件名>", "detail": "<文本>"}`；
2. 状态文件 `~/.dsh/dsh-pet-state.json`（原子写入，同上格式）——桌宠每
   300ms 轮询一次作为兜底。

事件名词汇表（不区分大小写）：`SessionStart`、`UserPromptSubmit`、`Prompt`、
`AgentStart`、`AgentStop`、`PreToolUse`、`PostToolUse`、`SubagentStart`、
`SubagentStop`、`AgentMessage`、`ToolUse`、`PatchApply`、`PermissionRequest`、
`Approval`、`Deny`、`Failed`、`Error`、`Stop`、`SessionEnd`、`Done`、`Idle`、
`Waiting`、`Action`（进度行）。未知事件会被忽略（不再重置为 idle）。

## 测试

```powershell
# 插件状态机单测（14 项）
cd plugin; node --test

# 桌宠监听器/加载器冒烟测试（19 项，无 GUI）
.venv\Scripts\python.exe pet\test_smoke.py
```

## 目录结构

```text
dsh-pet/
├─ plugin/            # DSH 插件（cordis bundle，纯 ESM 无构建）
│  ├─ index.js        # 事件订阅 + 自动拉起桌宠
│  ├─ state.js        # 状态机（纯逻辑，可单测）
│  ├─ channel.js      # UDP + 状态文件通道
│  └─ cordis.patch.yml
├─ pet/               # 桌宠应用（Python + PySide6）
│  ├─ pet_app.py      # 主窗口/动画/气泡/托盘
│  ├─ state_listener.py
│  ├─ pet_loader.py
│  ├─ pet_style.py
│  └─ pets/           # 宠物包
├─ scripts/           # install / uninstall / build / e2e
└─ docs/architecture.md
```

## License

MIT（宠物素材的授权情况见仓库发布说明）。
