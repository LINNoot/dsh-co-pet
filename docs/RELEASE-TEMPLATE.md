# Release 发布说明模板

> 用法：复制本模板到 GitHub Release 的正文，替换 `<...>` 占位内容。
> 附件：上传 `DshPet.exe`（`scripts\build.ps1` 构建产物，约 56MB）。

---

## 🐱 DSH 桌宠 v0.1.0 

让桌面宠物实时响应 **DeepSeek Harness** 的工作状态：任务运行时卖力干活、思考时托腮、等待授权时翘首以盼、任务完成时蹦跳庆祝......

部分沿用codex桌宠设计思路，调整触发逻辑，重构了部分设定，使之更加符合直觉，为 DSH 重新实现状态检测，**开箱即用**。

### ✨ 特性

- **实时状态感知**：细粒度事件（turn/step/tool/chunk/approval/goal）+ `agent/status` + **`agents` 服务轮询校正**
- **完成判定二选一**：普通任务回合结束 → 庆祝；有 goal 的会话 → 只认目标完成；均带 8s 静默去抖
- **气泡**：会话标题 + 状态短语 + AI 总结第二行 + 右侧状态圆圈（hover 光晕，完成时绿勾）
- **中断圆圈**：任务进行中鼠标划过气泡出现灰方块，点击中断当前任务（DSH 无暂停 API，中断保留输入消息）
- **Web GUI 电源开关**：侧边栏按钮，关闭=退出进程、开启=重新拉起，状态持久化
- **完整交互**：拖拽、悬浮、托盘菜单（宠物/大小/置顶/气泡开关）
- **零网络零 LLM 成本**：状态 → 动画全确定性推导
- **自定义桌宠**：高度兼容 codex 及其开源社区桌宠，桌宠格式可参考 codex

### 📦 安装

**前置**：Windows 10/11 + DeepSeek Harness（`dsh web`）。构建 exe 需 Python 3.11+（或使用本 Release 附件）。

**方式一：一键脚本（推荐）**

```powershell
git clone https://github.com/<你的用户名>/dsh-pet.git
cd dsh-pet
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
# 重启 DSH（dsh web）后桌宠随 DSH 自动启动
```

**方式二：使用本 Release 的预构建 exe（无需 Python）**

```powershell
# 下载 DshPet.exe 放到仓库 dist/ 目录，然后：
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
# 或指定路径：
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -PetExe D:\Downloads\DshPet.exe
```

**方式三：手动装插件**

```powershell
dsh plugin --profile web add <仓库路径>/plugin
```

### 🎮 状态 → 桌宠行为

| DSH 信号 | 桌宠行为 |
| --- | --- |
| 用户提交消息 / 推理 / 工具执行 | `running`，气泡显示**会话标题 · 思考中/回复中** + AI 总结 |
| 产出代码变更（diff） | `review` 循环等待审阅 |
| 请求授权 | `jumping` → 等待（授权通过自动恢复运行） |
| **任务完成** | `waving` 庆祝 + 绿勾圆圈 + 完成气泡（10s） |
| 长时间无活动（5 分钟） | `idle` |

### 📸 截图

<!-- 建议放 2-3 张：桌宠工作状态 + 完成气泡 + Web 开关按钮 -->

### 🐱 宠物包

- `pet/pets/yuexinmiao/`（**月薪喵**）已随仓库分发，clone 即用，仅作为效果演示
  （注：此宠物来源：[codex-pet.org](https://codex-pet.org/zh/pets/yuexinmiao/) 开源社区）
- 自定义宠物：按 Codex 契约放入 `pet/pets/<名称>/`（8 列 × 9 行精灵图）

### ⚠️ 已知限制

- 桌宠窗口与脚本为 **Windows 优先**（Linux/macOS 未做适配工作，后续会跟进，暂时不确定效果）
- 中断功能为"停当前回合"（DSH 无 agent 级暂停/恢复 API，中断后保留输入消息，可再发消息继续）
- 若 `npx dsh web` 启动很慢（>1 分钟），检查 `~/.npmrc` 是否残留死代理配置（见 README 故障排查）（可以丢给 AI 修复 :D

### 📜 License

MIT（代码）。宠物素材 `pet/pets/yuexinmiao/` 来自开源社区，仅供学习交流（见包内说明）。

---

## 附：本版本改动清单（changelog 用）

### 功能
- Web GUI 侧边栏桌宠电源开关（关闭=退出进程/开启=重启，状态持久化）
- 气泡第一行显示任务会话标题（跟随正在运行的会话）
- AI 总结第二行（模型回复摘要，20 字截断）
- 完成展示：绿勾圆圈 + 完成气泡（普通任务与 goal 均支持，8s 去抖）
- 中断圆圈：hover 显隐、同心定位、点击中断当前任务
- 单实例锁（防双开）、运行日志落盘 `~/.dsh/dsh-pet.log`、诊断快照 `~/.dsh/dsh-pet-state.debug.json`

### 架构
- 状态机分层：运行门闩（agent/status + 轮询）与展示态（结论事件）分离
- `{global: true}` 订阅跳出作用域过滤（对齐社区实践）
- 安装脚本增强：Python 检测链、dsh 命令缺失时手动注册插件
