// dsh-pet-bridge — DeepSeek Harness 桌宠桥接插件。
//
// 订阅 DSH 生命周期事件（agent/status、session/event、agent/error、goal），
// 经 PetBridgeState 状态机转换为桌宠事件，通过 UDP + 状态文件推送
// 给桌宠应用（pet/），并可选在 DSH 启动时自动拉起桌宠。
//
// Web GUI 控制：
//   - 插件自带浏览器端 client bundle（plugin/client.js），在侧边栏底部
//     注册桌宠开关按钮（sidebar.footer.action 插槽）；
//   - 按钮经同源 HTTP 调用本插件注册的 /pet-bridge/* 路由，控制桌宠
//     窗口显示/隐藏（PetVisibility：持久化 + pet/visibility 事件）。
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PetChannel } from "./channel.js";
import { PetBridgeState } from "./state.js";
import { PetVisibility } from "./visibility.js";

export const name = "dsh-pet-bridge";

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;

  const channel = new PetChannel({
    port: config.port ?? 47890,
    stateFile: config.stateFile,
    logger,
  });

  // 桌宠可见性（Web 开关按钮 + 持久化）
  const visibility = new PetVisibility({
    channel,
    onLog: (msg) => logger.info?.(`[dsh-pet-bridge] ${msg}`),
  });
  visibility.load();

  // 诊断快照文件：插件每 5 秒把内部状态（mode/运行集合/最近事件历史）
  // 原子写入该文件。复现"状态错乱"时查看此文件即可定位插件视角。
  const debugStateFile = config.debugStateFile
    ? path.resolve(config.debugStateFile.replace(/^~[\\/]?/, `${os.homedir()}/`))
    : path.join(os.homedir(), ".dsh", "dsh-pet-state.debug.json");
  const writeSnapshot = (snap) => {
    try {
      const tmp = `${debugStateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
      fs.renameSync(tmp, debugStateFile);
    } catch (err) {
      logger.debug?.(`[dsh-pet-bridge] 快照写入失败: ${err.message}`);
    }
  };

  const bridge = new PetBridgeState({
    quietMs: config.completionQuietMs ?? 8000,
    idleMs: config.idleTimeoutMs ?? 90000,
    onEvent: (event, detail) => {
      logger.debug?.(`[dsh-pet-bridge] → ${event} ${detail ? `"${detail.slice(0, 40)}"` : ""}`);
      channel.send(event, detail);
    },
    onAction: (text, status, kind) => {
      logger.debug?.(`[dsh-pet-bridge] → action ${kind} ${status} "${text.slice(0, 40)}"`);
      channel.send("action", text, status, kind);
    },
    onLog: (msg) => logger.info?.(`[dsh-pet-bridge] ${msg}`),
    onSnapshot: writeSnapshot,
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

  // 任一 agent（含子代理）状态变化。agent/status 经 dsh-scope 分发时
  // payload 带 agent 对象；个别路径只 emit {status}，防御性取 id。
  ctx.on("agent/status", ({ agent, status }) => {
    const agentId = agent?.id ?? "unknown";
    logger.debug?.(`[dsh-pet-bridge] agent/status ${agentId} → ${status}`);
    bridge.onAgentStatus(agentId, status);
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

  // —— Web GUI 控制路由（同源 HTTP，由 client.js 按钮调用）——
  let petStartupTimer = null;
  if (ctx.webServer) {
    ctx.effect?.(
      () =>
        ctx.webServer.register({
          kind: "prefix",
          path: "/pet-bridge",
          handler: (req, res) => {
            const respond = (code, body) => {
              res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify(body));
            };
            const url = new URL(req.url ?? "/", "http://dsh.local");
            const p = url.pathname;
            try {
              if (req.method === "GET" && p === "/pet-bridge/state") {
                respond(200, { visible: visibility.current() });
                return;
              }
              if (req.method === "POST" && p === "/pet-bridge/toggle") {
                respond(200, { visible: visibility.toggle() });
                return;
              }
              if (req.method === "POST" && p === "/pet-bridge/show") {
                respond(200, { visible: visibility.setVisible(true) });
                return;
              }
              if (req.method === "POST" && p === "/pet-bridge/hide") {
                respond(200, { visible: visibility.setVisible(false) });
                return;
              }
              respond(404, { error: "not found" });
            } catch (err) {
              logger.warn?.(`[dsh-pet-bridge] /pet-bridge 处理失败: ${err.message}`);
              respond(500, { error: String(err.message ?? err) });
            }
          },
        }),
      "pet-bridge: web routes",
    );
  } else {
    logger.warn?.("[dsh-pet-bridge] webServer 服务不可用，Web 开关按钮将无法工作（仅 UDP 控制可用）");
  }

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
    // 上次退出时桌宠是隐藏的：桌宠进程刚启动（默认显示），稍后应用持久化状态。
    // 延迟 2s 等桌宠完成 UDP 绑定（状态文件通道兜底，确保送达）。
    if (!visibility.current()) {
      petStartupTimer = setTimeout(() => {
        visibility.setVisible(false);
      }, 2000);
      petStartupTimer.unref?.();
    }
  }

  ctx.on("dispose", () => {
    clearInterval(ticker);
    clearInterval(heartbeat);
    if (petStartupTimer) clearTimeout(petStartupTimer);
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
