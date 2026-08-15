// dsh-pet-bridge — DeepSeek Harness 桌宠桥接插件。
//
// 订阅 DSH 生命周期事件（agent/status、session/event、agent/error、goal），
// 经 PetBridgeState 状态机转换为桌宠事件，通过 UDP + 状态文件推送
// 给桌宠应用（pet/），并可选在 DSH 启动时自动拉起桌宠。
//
// 安装：
//   dsh plugin --profile web add <本插件目录或包名>
// 配置（profile 的 cordis.patch.yml 或插件 config）：
//   port: 47890                桌宠 UDP 端口
//   stateFile: ~/.dsh/dsh-pet-state.json
//   petPath: <DshPet.exe 路径>  随 DSH 启动桌宠（也可用环境变量 DSH_PET_PATH）
//   autoLaunch: true
//   completionQuietMs: 8000    目标完成后的静默去抖窗口
//   idleTimeoutMs: 90000       空闲兜底
import { spawn } from "node:child_process";
import path from "node:path";
import { PetChannel } from "./channel.js";
import { PetBridgeState } from "./state.js";

export const name = "dsh-pet-bridge";

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;

  const channel = new PetChannel({
    port: config.port ?? 47890,
    stateFile: config.stateFile,
    logger,
  });

  const bridge = new PetBridgeState({
    quietMs: config.completionQuietMs ?? 8000,
    idleMs: config.idleTimeoutMs ?? 90000,
    onEvent: (event, detail) => {
      logger.debug?.(`[dsh-pet-bridge] → ${event} ${detail ? `"${detail.slice(0, 40)}"` : ""}`);
      channel.send(event, detail);
    },
    onAction: (text, status) => {
      logger.debug?.(`[dsh-pet-bridge] → action ${status} "${text.slice(0, 40)}"`);
      channel.send("action", text, status);
    },
    onLog: (msg) => logger.info?.(`[dsh-pet-bridge] ${msg}`),
  });

  // 顶层会话判定：子代理会话 header 带 origin:'subagent' / delegationDepth
  const isRootSession = (session) =>
    !session.header?.origin && session.header?.delegationDepth === undefined;

  // 子代理会话中同样代表“有工作在发生”的活动事件（不产生状态事件）
  const ACTIVITY_TYPES = new Set([
    "turn/start",
    "step/start",
    "step/end",
    "assistant/chunk",
    "assistant/message",
    "request/header",
    "request/context",
    "tool/call",
    "tool/result",
    "todo/write",
  ]);

  // 任一 agent（含子代理）状态变化
  ctx.on("agent/status", ({ agent, status }) => {
    bridge.onAgentStatus(agent.id, status);
  });

  // 会话日志事件（仅实时追加；重放/种子不触发）
  ctx.on("session/event", (session, event) => {
    if (!event?.type) return;
    const type = event.type;
    if (isRootSession(session)) {
      bridge.onSessionEvent({ type, data: event.data });
    } else if (ACTIVITY_TYPES.has(type)) {
      // 子代理的活动事件：刷新活动时间与运行态，防止长任务期间
      // 空闲兜底误触发（原版 rollout 高频事件的等价物）
      bridge.onActivity(type);
    }
  });

  // 步骤/轮次错误（agent/error 与 turn/end(error) 双保险）
  ctx.on("agent/error", ({ error }) => {
    if (error instanceof Error) {
      bridge.onFailure(error.message);
    } else {
      bridge.onFailure(String(error));
    }
  });

  // 空闲兜底心跳
  const ticker = setInterval(() => bridge.onTick(), 5000);
  ticker.unref?.();

  // 活动心跳：running/review 期间每 30 秒向桌宠发一次空事件，
  // 刷新桌宠端 90s 空闲兜底（长推理/子代理长跑时桌面端无语义事件可收）
  const heartbeat = setInterval(() => bridge.heartbeat(), 30000);
  heartbeat.unref?.();

  // 启动：通知桌宠进入空闲
  bridge.onBoot();

  // —— 随 DSH 启动桌宠 ——
  let petProc = null;
  const petPath = config.petPath || process.env.DSH_PET_PATH;
  if (config.autoLaunch !== false && petPath) {
    try {
      petProc = spawn(path.resolve(petPath), config.petArgs ?? [], {
        stdio: "ignore",
        windowsHide: true,
        detached: false,
      });
      petProc.on("error", (err) => {
        logger.warn?.(`[dsh-pet-bridge] 启动桌宠失败: ${err.message}`);
      });
    } catch (err) {
      logger.warn?.(`[dsh-pet-bridge] 启动桌宠失败: ${err.message}`);
    }
  }

  ctx.on("dispose", () => {
    clearInterval(ticker);
    clearInterval(heartbeat);
    bridge.dispose();
    channel.close();
    if (petProc && !petProc.killed) {
      try {
        petProc.kill();
      } catch {
        // 忽略
      }
    }
  });
}
