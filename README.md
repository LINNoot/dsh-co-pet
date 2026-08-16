# DSH 桌宠（dsh-co-pet）

让桌面宠物实时响应 **DeepSeek Harness** 的工作状态：任务运行时卖力干活、思考时托腮、等待授权时翘首以盼、任务完成时蹦跳庆祝并弹出绿色对勾 + AI 总结气泡。

沿用 Codex 桌宠的精灵图契约与交互设计，为 DSH 重新实现状态检测（事件 + agents 轮询双通道），**Web GUI 侧边栏自带电源开关**（关闭=退出进程，开启=重新拉起）。

## ✨ 特性

- **实时状态感知**：`session/event` 细粒度事件（turn/step/tool/chunk/approval/goal）+ `agent/status` + **`agents` 服务轮询校正**（社区实测 agent/status 事件在部分部署可能丢失——轮询兜底，杜绝"卡 running/莫名 running"）
- **完成判定二选一**：无 goal 的普通任务回合正常结束 → 庆祝；有 goal 的会话 → 只认 goal complete（避免每轮庆祝）；均带 8s 静默去抖
- **原版 Codex 气泡**：白色胶囊 + 会话标题 + 状态短语 + AI 总结第二行 + 右侧状态圆圈（hover 光晕，完成时绿勾）
- **中断圆圈**：任务进行中鼠标划过气泡出现灰方块，点击中断当前任务（DSH 无暂停 API，中断保留输入消息）
- **Web GUI 电源开关**：侧边栏底部按钮，关闭=桌宠进程退出、开启=重新启动，状态持久化
- **拖拽/悬浮/托盘**：完整交互，双击托盘图标切换显示
- **零网络零 LLM 成本**：状态 → 动画全确定性推导

## 📦 安装

### 前置要求

| 依赖 | 说明 |
|---|---|
| DeepSeek Harness（`dsh web`） | 已在运行即可；插件面向 v0.1.0-rc.6 系列 |
| Windows 10/11 | 桌宠窗口与脚本均为 Windows 优先 |
| Python 3.11+（可选） | 仅自动构建 `DshPet.exe` 需要；也可使用 GitHub Release 的预构建 exe（`install.ps1 -PetExe <路径>`） |
| 宠物包素材 | 自带 `yuexinmiao`（月薪喵），可自定义（见下文"宠物包"）；其余素材需自备 |

### 方式一：一键安装脚本（Windows，无需 Python）

```powershell
# ① 从 Releases 页面下载 DshPet.exe 附件（存到任意位置，如 D:\Downloads\）
# ② 一键安装（-PetExe 直接指定下载好的 exe，跳过构建）：
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -PetExe D:\Downloads\DshPet.exe
```

脚本自动完成：① 部署到 `%LOCALAPPDATA%\dsh-pet`（含宠物目录链接）；② 注册 `dsh-pet-bridge` 到 web profile（`dsh` 命令不可用时自动改写 profile 文件）；③ 写入 petPath 覆盖；④ 创建桌面快捷方式。

**前置条件：本机已安装 DeepSeek Harness 并至少运行过一次 `dsh web`**（脚本需要 `~/.dsh/profiles/web` 存在才能注册插件）。有 Python 3.11+ 时可以不带 `-PetExe` 跑，脚本会自动构建 exe（较慢，首次要装 PyInstaller）。

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
    idleTimeoutMs: 300000   # 空闲兜底（5 分钟无活动）
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
| 长时间无活动（5 分钟） | `idle` |

## 🐱 宠物包

沿用 Codex 桌宠契约。**`pet/pets/yuexinmiao/`（月薪喵）已随仓库分发**——来自 [codex-pet.org](https://codex-pet.org/zh/pets/yuexinmiao/) 开源社区，仅做演示使用，clone 即开箱可用。

自定义宠物：

```text
pets/我的宠物/
  pet.json          # 可选：id / displayName / description / spriteVersionNumber
  spritesheet.webp  # 8 列；9 行（v1，192x208/格）或 11 行（v2）
```

获取方式：
- **从 Codex 桌宠导入**：把 `~/.codex/pets/<名称>/` 文件夹复制到 `pet/pets/`；
- **Petdex 社区**：下载社区宠物包复制进去；
- **自制**：按契约生成精灵图（8 列 × 9 行）。

宠物包放 `pet/pets/`（桌宠部署目录，junction 指向源码 `pet/pets/`）。
**注意：`pet/pets/` 下没有宠物时，桌宠窗口将无形象可显示**。

## 🔌 通信协议

插件 → 桌宠（双通道）：
1. UDP `127.0.0.1:<port>`：`{"src":"dsh-pet-bridge","event":"<事件>","detail":"<文本>"}`（`src` 标记隔离旧 Codex 报文）
2. 状态文件 `~/.dsh/dsh-pet-state.json`（原子写，桌宠 300ms 轮询兜底）

另有控制事件：`pet/visibility`（窗口显隐）、`pet/quit`（进程退出）；Web 开关状态持久化于 `~/.dsh/dsh-pet-visibility.json`。

## 🧪 测试

```powershell
# 插件：状态机 48 项 + 开关 8 项 + cordis 注入回归 2 项（需要 Node 20+）
cd plugin; node test/state.test.mjs; node test/visibility.test.mjs; node test/inject.test.mjs
# inject 测试会自动探测 DSH 的 cordis（npx 缓存），找不到时跳过；
# 也可用环境变量显式指定：$env:DSH_CORDIS_LIB = "<cordis 入口 index.js 路径>"

# 桌宠：先安装依赖（一次性），再跑 4 个无 GUI 测试
py -m pip install -r pet/requirements.txt
py pet\test_smoke.py
py pet\test_bubble.py
py pet\test_refresh.py
py pet\test_style.py
```

## 📁 目录结构

```text
dsh-pet/
├─ plugin/            # DSH 插件（cordis bundle，纯 ESM 无构建）
│  ├─ index.js        # 事件订阅（global:true）+ agents 轮询 + sessionTitle + webServer 路由 + 生命周期
│  ├─ state.js        # 状态机（纯逻辑，可单测）：门闩/展示态分层 + 完成去抖 + 会话标题
│  ├─ visibility.js   # Web 开关（开启=spawn/关闭=pet/quit，持久化）
│  ├─ channel.js      # UDP + 状态文件双通道
│  ├─ client.js       # 浏览器端：侧边栏电源开关按钮（__ModuleLoader__ bundle）
│  ├─ cordis.patch.yml
│  └─ test/           # 插件单测（state 48 / visibility 8 / inject 2）
├─ pet/               # 桌宠应用（Python 3.11 + PySide6）
│  ├─ pet_app.py      # 主窗口/动画/气泡/托盘/单实例锁
│  ├─ state_listener.py  # 事件监听（UDP+文件）、词汇表、日志落盘
│  ├─ pet_loader.py   # 宠物包扫描与精灵图加载
│  ├─ pet_style.py    # Codex 样式与 QSS
│  ├─ test_*.py       # 冒烟 / 气泡 / 刷新 / 样式测试（无 GUI）
│  └─ pets/           # 宠物包（yuexinmiao 随仓库分发）
├─ scripts/           # install / uninstall / build / e2e_feed
└─ docs/architecture.md
```

## 🔍 故障排查

- **DSH 启动很慢（`npx ... dsh web` 卡 1 分钟+）**：检查 `~/.npmrc` 是否残留死代理配置（`proxy` / `https-proxy` 指向未运行的本地代理，如 `127.0.0.1:7892`）——npx 每次启动都会等代理连接超时（实测 70s）。删除或注释对应行即可；或用 `node <npx缓存路径>/node_modules/@deepseek-ai/dsh/lib/bin.js web` 直启绕过（0.1s）。
- **桌宠状态不对**：看 `~/.dsh/dsh-pet-state.debug.json`（插件每 5s 快照：mode/运行集合/最近 40 条输入输出事件）与 `~/.dsh/dsh-pet.log`（桌宠收到的每条事件）。
- **按钮无效**：确认只有一个桌宠实例（进程自带单实例锁）；`http://127.0.0.1:3080/pet-bridge/state` 应返回 `{"visible":true}`。
- **完成不庆祝**：确认任务确实结束（GUI 无进行中任务）；goal 会话只认 goal complete。

## License

MIT（宠物素材授权情况见发布说明，不随仓库分发）。
