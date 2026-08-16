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
// Cordis 4 服务依赖声明（模块级导出 = plugin.inject，loader 经
// Inject.resolve 解析进 fiber）：访问 ctx.webServer 前必须声明，
// 否则 cordis 的 ctx 代理会抛 "cannot get property without inject"，
// 且插件加载失败会拖垮整个 DSH（plugin tree failed to load）。
// 注意：这是硬依赖——若运行在无 webServer 服务的 profile（如纯
// headless），插件会加载失败；web/桌面 GUI profile 均自带该服务。
export const inject = ["webServer"];

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;

  const channel = new PetChannel({
    port: config.port ?? 47890,
    stateFile: config.stateFile,
    logger,
  });

  // —— 桌宠进程生命周期（autoLaunch / Web 开关共用）——
  let petProc = null;
  let disposing = false; // DSH 卸载中：kill 桌宠不算"非主动退出"，不同步开关状态
  const petPath = config.petPath || process.env.DSH_PET_PATH;
  const launchPet = () => {
    if (!petPath || petProc && !petProc.killed) return petProc;
    try {
      const proc = spawn(path.resolve(petPath), config.petArgs ?? [], {
        stdio: "ignore",
        windowsHide: true,
        detached: false,
      });
      proc.on("error", (err) => {
        logger.warn?.(`[dsh-pet-bridge] 启动桌宠失败: ${err.message}`);
      });
      proc.on("exit", () => {
        petProc = null;
        // 桌宠退出（手动退出/崩溃/被关闭）：同步 GUI 开关状态；
        // DSH 自身卸载时的 kill 除外（下次启动仍按上次意图恢复）。
        if (!disposing) visibility.onPetExited();
      });
      petProc = proc;
      // 桌宠刚启动：延迟同步当前状态（等它完成 UDP 绑定；状态文件通道兜底）。
      // 先发 SessionStart（idle 基准），再按当前 mode 发对应事件——
      // 否则新桌宠只能等 30s 心跳才知道状态，且状态文件残留的
      // agent_message 会把桌宠带进 running。
      setTimeout(() => {
        if (disposing || petProc !== proc) return; // 已被清理或换新实例
        channel.send("SessionStart", "DSH 已启动");
        if (bridge.mode === "running" || bridge.mode === "review") {
          channel.send("AgentStart", "任务进行中");
        } else if (bridge.mode === "waiting") {
          channel.send("AgentStop", "等待你的输入");
        }
      }, 1500).unref?.();
      return proc;
    } catch (err) {
      logger.warn?.(`[dsh-pet-bridge] 启动桌宠失败: ${err.message}`);
      return null;
    }
  };

  // 桌宠开关（Web 按钮 + 持久化；开启=进程运行，关闭=进程退出）
  const visibility = new PetVisibility({
    file: config.visibilityFile
      ? path.resolve(config.visibilityFile.replace(/^~[\\/]?/, `${os.homedir()}/`))
      : undefined,
    channel,
    spawn: launchPet,
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
  // { global: true }：跳出 scoped 上下文过滤，确保收到所有 agent 的
  // 状态（参考官方社区插件 dsh-desktop-pet 的 HarnessBridge 写法）。
  ctx.on(
    "agent/status",
    ({ agent, status }) => {
      const agentId = agent?.id ?? "unknown";
      logger.debug?.(`[dsh-pet-bridge] agent/status ${agentId} → ${status}`);
      bridge.onAgentStatus(agentId, status);
    },
    { global: true },
  );

  // 会话日志事件（仅实时追加；重放/种子不触发）。
  // { global: true }：同 agent/status——不依赖作用域过滤，所有会话
  // （含非当前/子代理）的事件都可达，由 isRootSession 区分。
  ctx.on(
    "session/event",
    (session, event) => {
      if (!event?.type) return;
      const type = event.type;
      // 输入记录携带 session id 与 header 判定结果，快照可直接回溯
      // "某事件来自哪个会话、为何被路由为活动/顶层"。
      const sessionId = session.id ?? String(session);
      // 顶层判定：agents.roots() 运行时事实优先（恢复会话 header 可能带
      // origin 残留导致误判），header 判定兜底（roots 集合尚未建立时）。
      const root = bridge.isRootSessionId(sessionId) || isRootSession(session);
      logger.debug?.(`[dsh-pet-bridge] session/event ${type} root=${root} session=${sessionId}`);
      if (root) {
        bridge.onSessionEvent({ type, data: event.data, sessionId });
      } else if (ACTIVITY_TYPES.has(type)) {
        // 子代理的活动事件：刷新活动时间与运行态，防止长任务期间
        // 空闲兜底误触发（原版 rollout 高频事件的等价物）
        bridge.onActivity(type, sessionId);
      }
    },
    { global: true },
  );

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

  // agents 服务轮询（权威状态源，1s）：agent/status 事件可能丢失/不送达
  // （社区实测 dsh-kun-like-pet v4：831 次观测 status 类事件 0 次），
  // 轮询校正 runningAgents——补事件丢失、除"卡 running"。
  let agentsService = null;
  let titleService = null;
  try {
    agentsService = ctx.get("agents");
    titleService = ctx.get("sessionTitle");
  } catch {
    agentsService = null;
    titleService = null;
  }
  const agentsPoll = setInterval(() => {
    try {
      const list = agentsService?.list?.();
      if (Array.isArray(list)) {
        bridge.onAgentsSnapshot(list.map((a) => ({ id: a?.id, status: a?.status })));
      }
      // 顶层 agent 集合（agents.roots()）：会话路由判定用——比 header
      // 判定可靠（恢复会话 header 可能带 origin 残留，导致顶层会话被
      // 误判为子代理，AI 总结/完成永不触发——本环境已实测复现）。
      const roots = agentsService?.roots?.();
      if (Array.isArray(roots)) {
        bridge.setRootAgents(roots.map((a) => a?.id).filter(Boolean));
      }
      // 会话标题同步（气泡第一行黑体 = 侧边栏标题）：跟随"正在运行的
      // 顶层会话"，无运行中时跟随"最近活动的顶层会话"（避免多会话
      // 并存时取错标题），全都没有时保持上次值。
      if (titleService && Array.isArray(roots) && roots.length > 0) {
        let chosen = roots.find((a) => a?.status === "running");
        if (!chosen) {
          const recentId = bridge.getMostRecentRootId();
          chosen = roots.find((a) => a?.id === recentId) ?? roots[0];
        }
        if (chosen) {
          try {
            const snap = titleService.get(chosen.session);
            if (snap?.title) {
              bridge.onSessionTitle(snap.title);
            }
          } catch {
            // 标题读取失败：保持上次值
          }
        }
      }
    } catch {
      // 服务暂时不可用：跳过本轮
    }
  }, 1000);
  agentsPoll.unref?.();

  // 活动心跳：running/review 期间每 30 秒向桌宠发一次空事件，
  // 刷新桌宠端 90s 空闲兜底（长推理/子代理长跑时桌面端无语义事件可收）
  const heartbeat = setInterval(() => bridge.heartbeat(), 30000);
  heartbeat.unref?.();

  // —— 桌宠用户命令（暂停/恢复）——
  // 桌宠点击气泡右侧暂停圆圈 → 写 ~/.dsh/dsh-pet-command.json → 本插件
  // 轮询执行：有 active goal 用 goals.pause/resume（真正暂停，可恢复）；
  // 无 goal 用 agent.cancel(keepInbox) 停当前回合（保留输入消息）。
  const COMMAND_FILE = path.join(os.homedir(), ".dsh", "dsh-pet-command.json");
  let goalService = null;
  try {
    goalService = ctx.get("goals");
  } catch {
    goalService = null;
  }
  const runPetCommand = (cmd) => {
    if (cmd === "pause") {
      const running = agentsService
        ?.list?.()
        ?.find((a) => a?.status === "running");
      if (!running) {
        logger.info?.("[dsh-pet-bridge] 暂停命令：无运行中的 agent，忽略");
        return;
      }
      try {
        const view = goalService?.get?.(running);
        if (view && view.phase === "active") {
          goalService.pause(running, { id: view.id, revision: view.revision });
          logger.info?.("[dsh-pet-bridge] 已暂停目标（goal）");
        }
      } catch (err) {
        logger.warn?.(`[dsh-pet-bridge] goal 暂停失败: ${err.message}`);
      }
      // 立即停当前回合（保留 inbox 输入，近似暂停；goal 暂停后不再自动续跑）
      try {
        running.cancel?.({ kind: "user" }, { keepInbox: true });
        logger.info?.("[dsh-pet-bridge] 已中断当前回合（保留输入）");
      } catch (err) {
        logger.warn?.(`[dsh-pet-bridge] 回合中断失败: ${err.message}`);
      }
    } else if (cmd === "resume") {
      const agent = agentsService?.list?.()?.[0];
      if (agent) {
        try {
          const view = goalService?.get?.(agent);
          if (view && view.phase === "paused") {
            goalService.resume(agent, { id: view.id, revision: view.revision });
            logger.info?.("[dsh-pet-bridge] 已恢复目标（goal）");
          }
        } catch (err) {
          logger.warn?.(`[dsh-pet-bridge] goal 恢复失败: ${err.message}`);
        }
      }
      logger.info?.("[dsh-pet-bridge] 恢复命令已处理（发送消息继续任务）");
    }
  };
  const commandPoll = setInterval(() => {
    try {
      const stat = fs.statSync(COMMAND_FILE);
      const sig = `${stat.mtimeMs}:${stat.size}`;
      if (sig === lastCommandSig) return;
      const data = JSON.parse(fs.readFileSync(COMMAND_FILE, "utf8"));
      lastCommandSig = sig;
      if (data && typeof data.cmd === "string") {
        runPetCommand(data.cmd);
      }
    } catch {
      // 文件不存在或解析失败：忽略
    }
  }, 500);
  commandPoll.unref?.();
  let lastCommandSig = null;

  // 启动：通知桌宠进入空闲
  bridge.onBoot();

  // —— Web GUI 控制路由（同源 HTTP，由 client.js 按钮调用）——
  // inject 已声明 webServer（见文件头），此处防御性判断保留：即使将来
  // 有人把 inject 改为可选，也能降级为仅 UDP 控制而不至于加载失败。
  if (ctx.webServer) {
    ctx.effect?.(
      () => {
        // 注册失败（路由冲突等）只告警，绝不让插件加载失败拖垮 DSH。
        try {
          return ctx.webServer.register({
            kind: "prefix",
            path: "/pet-bridge",
            handler: (req, res) => {
              const respond = (code, body) => {
                // 状态接口不可缓存：按钮图标依赖实时可见性
                res.writeHead(code, {
                  "content-type": "application/json; charset=utf-8",
                  "cache-control": "no-store",
                });
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
                  respond(200, { visible: visibility.setEnabled(true) });
                  return;
                }
                if (req.method === "POST" && p === "/pet-bridge/hide") {
                  respond(200, { visible: visibility.setEnabled(false) });
                  return;
                }
                respond(404, { error: "not found" });
              } catch (err) {
                logger.warn?.(`[dsh-pet-bridge] /pet-bridge 处理失败: ${err.message}`);
                respond(500, { error: String(err.message ?? err) });
              }
            },
          });
        } catch (err) {
          logger.warn?.(`[dsh-pet-bridge] webServer 路由注册失败: ${err.message}`);
          return () => {};
        }
      },
      "pet-bridge: web routes",
    );
  } else {
    logger.warn?.("[dsh-pet-bridge] webServer 服务不可用，Web 开关按钮将无法工作（仅 UDP 控制可用）");
  }

  // —— 随 DSH 启动桌宠（仅当上次开关状态为"开启"）——
  if (config.autoLaunch !== false && visibility.current()) {
    launchPet();
  }

  // 清理：cordis 4 没有 "dispose" 事件——插件卸载清理必须用 ctx.effect
  // 注册 disposer（ctx.on("dispose") 永远不会触发，会导致 UDP socket/
  // 定时器/桌宠进程在热卸载时泄漏）。
  ctx.effect(
    () => () => {
      disposing = true; // 主动收尾：kill 桌宠不触发开关状态同步
      clearInterval(ticker);
      clearInterval(heartbeat);
      clearInterval(agentsPoll);
      clearInterval(commandPoll);
      bridge.dispose();
      channel.close();
      if (petProc && !petProc.killed) {
        try {
          petProc.kill();
        } catch {
          // 忽略
        }
      }
    },
    "pet-bridge: cleanup",
  );
}
