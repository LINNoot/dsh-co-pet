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
    onEvent: (event, detail) => channel.send(event, detail),
    onAction: (text, status) => channel.send("action", text, status),
  });

  // 顶层会话判定：子代理会话 header 带 origin:'subagent' / delegationDepth
  const isRootSession = (session) =>
    !session.header?.origin && session.header?.delegationDepth === undefined;

  // 任一 agent（含子代理）状态变化
  ctx.on("agent/status", ({ agent, status }) => {
    bridge.onAgentStatus(agent.id, status);
  });

  // 会话日志事件（仅实时追加；重放/种子不触发）
  ctx.on("session/event", (session, event) => {
    if (!event?.type) return;
    const type = event.type;
    const rootOnly = !(
      type === "approval/asked" ||
      type === "approval/decided" ||
      type === "tool/call" ||
      type === "tool/result"
    );
    if (rootOnly && !isRootSession(session)) return;
    bridge.onSessionEvent({ type, data: event.data });
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
