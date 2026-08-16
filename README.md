# DSH 桌宠（dsh-pet）

让桌面宠物实时响应 **DeepSeek Harness** 的工作状态：任务运行时卖力干活、思考时托腮、等待授权时翘首以盼、任务完成时蹦跳庆祝并弹出绿色对勾 + AI 总结气泡。

沿用 Codex 桌宠的精灵图契约与交互设计，为 DSH 重新实现状态检测（事件 + agents 轮询双通道），**Web GUI 侧边栏自带电源开关**（关闭=退出进程，开启=重新拉起）。

## ✨ 特性

- **实时状态感知**：`session/event` 细粒度事件（turn/step/tool/chunk/approval/goal）+ `agent/status` + **`agents` 服务轮询校正**（社区实测 agent/status 事件在部分部署可能丢失——轮询兜底，杜绝"卡 running/莫名 running"）
- **完成判定二选一**：无 goal 的普通任务回合正常结束 → 庆祝；有 goal 的会话 → 只认 goal complete（避免每轮庆祝）；均带 8s 静默去抖
- **原版 Codex 气泡**：白色胶囊 + 状态短语 + AI 总结第二行 + 右侧状态圆圈（hover 光晕，完成时绿勾）
- **Web GUI 电源开关**：侧边栏底部按钮，关闭=桌宠进程退出、开启=重新启动，状态持久化
- **拖拽/悬浮/托盘**：完整交互，双击托盘图标切换显示
- **零网络零 LLM 成本**：状态 → 动画全确定性推导

## 📦 安装

### 方式一：一键安装脚本（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

脚本自动完成：① 用 PyInstaller 构建 `DshPet.exe`；② 部署到 `%LOCALAPPDATA%\dsh-pet`；③ 用 `dsh plugin` 把 `dsh-pet-bridge` 装进 web profile；④ 写入 petPath 覆盖；⑤ 创建桌面快捷方式。

**重启 DSH（`dsh web`）后生效**，桌宠随 DSH 自动启动。

### 方式二：手动安装插件

```powershell
dsh plugin --profile web add <本仓库路径>/plugin
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 配置：

```yaml
- id: pet-bridge
  config:
    petPath: 'C:/Users/<你>/AppData/Local/dsh-pet/DshPet.exe'  # 桌宠可执行文件
    autoLaunch: true        # 随 DSH 启动桌宠
    port: 47890             # UDP 端口（与 pet_config.json 一致）
    completionQuietMs: 8000 # 完成静默去抖窗口
    idleTimeoutMs: 90000    # 空闲兜底
```

若用 `pythonw` 直启（未打包），`petArgs: ['<路径>/pet_app.py']`。

### 开发模式运行桌宠（不打包）

```powershell
py -m pip install -r pet/requirements.txt
py pet/pet_app.py
```

### 卸载

```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1 -RemovePlugin -RemovePetDir
```

## 🎮 状态 → 桌宠行为

| DSH 信号 | 桌宠行为 |
| --- | --- |
| 用户提交消息 / 回合开始 | `running`，气泡显示任务文本 |
| 推理（step/start、assistant/chunk） | `running`，气泡"正在思考" |
| 模型完整回复（assistant/message） | 气泡第二行 **AI 总结**（≤20 字） |
| 工具调用 / 完成 | `running`，气泡"调用 X / X 完成" |
| 产出代码变更（diff） | `review` 循环等待审阅 |
| 请求授权 / 拒绝 | `jumping` → `waiting` / `idle` |
| 轮次异常结束（blocked/max-tokens/error） | `waiting` / `failed`（不庆祝） |
| **任务完成**（turn/end completed 或 goal complete + 8s 静默） | `waving` 庆祝 + 绿勾圆圈 + "任务完成"气泡（10s） |
| 长时间无活动（90s） | `idle` |

## 🐱 宠物包

沿用 Codex 桌宠契约（**不随仓库分发素材**，请放入自己的宠物包）：

```text
pets/我的宠物/
  pet.json          # 可选：id / displayName / description / spriteVersionNumber
  spritesheet.webp  # 8 列；9 行（v1，192x208/格）或 11 行（v2）
```

宠物包放 `pet/pets/`（应用目录）或 `~/.dsh/pets/`（用户目录，升级不丢）。

## 🔌 通信协议

插件 → 桌宠（双通道）：
1. UDP `127.0.0.1:<port>`：`{"src":"dsh-pet-bridge","event":"<事件>","detail":"<文本>"}`（`src` 标记隔离旧 Codex 报文）
2. 状态文件 `~/.dsh/dsh-pet-state.json`（原子写，桌宠 300ms 轮询兜底）

另有控制事件：`pet/visibility`（窗口显隐）、`pet/quit`（进程退出）；Web 开关状态持久化于 `~/.dsh/dsh-pet-visibility.json`。

## 🧪 测试

```powershell
# 插件：状态机 43 项 + 开关 8 项 + cordis 注入回归 2 项
cd plugin; node test/state.test.mjs; node test/visibility.test.mjs; node test/inject.test.mjs

# 桌宠：监听器/加载器冒烟 + 气泡排版（无 GUI）
.venv\Scripts\python.exe pet\test_smoke.py
.venv\Scripts\python.exe pet\test_bubble.py
```

## 📁 目录结构

```text
dsh-pet/
├─ plugin/            # DSH 插件（cordis bundle，纯 ESM 无构建）
│  ├─ index.js        # 事件订阅（global:true）+ agents 轮询 + webServer 路由 + 生命周期
│  ├─ state.js        # 状态机（纯逻辑，可单测）：门闩/展示态分层 + 完成去抖
│  ├─ visibility.js   # Web 开关（开启=spawn/关闭=pet/quit，持久化）
│  ├─ channel.js      # UDP + 状态文件双通道
│  ├─ client.js       # 浏览器端：侧边栏电源开关按钮（__ModuleLoader__ bundle）
│  └─ cordis.patch.yml
├─ pet/               # 桌宠应用（Python 3.11 + PySide6）
│  ├─ pet_app.py      # 主窗口/动画/气泡/托盘/单实例锁
│  ├─ state_listener.py
│  ├─ pet_loader.py
│  ├─ pet_style.py
│  └─ pets/           # 宠物包（不随仓库分发）
├─ scripts/           # install / uninstall / build
└─ docs/architecture.md
```

## 🔍 故障排查

- **桌宠状态不对**：看 `~/.dsh/dsh-pet-state.debug.json`（插件每 5s 快照：mode/运行集合/最近 40 条输入输出事件）与 `~/.dsh/dsh-pet.log`（桌宠收到的每条事件）。
- **按钮无效**：确认只有一个桌宠实例（进程自带单实例锁）；`http://127.0.0.1:3080/pet-bridge/state` 应返回 `{"visible":true}`。
- **完成不庆祝**：确认任务确实结束（GUI 无进行中任务）；goal 会话只认 goal complete。

## License

MIT（宠物素材授权情况见发布说明，不随仓库分发）。
