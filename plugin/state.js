// dsh-pet-bridge — 状态机（纯逻辑，无 I/O，可单测）
//
// 输入：DSH 事件（已在 index.js 归一化）→ 输出：桌宠事件（event/detail/action）。
//
// 与 Codex 版桌宠相比的关键修复：
// - “完成”只在 目标完成（goal complete）+ 静默去抖窗口（quietMs）内无任何新
//   活动时才触发；轮次结束只进入等待态，绝不中途“庆祝”。
// - 任何新活动都会取消挂起的完成信号。
// - 长时间无活动（idleMs）兜底回到 idle。

const clampDetail = (text, max = 120) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
};

const firstText = (blocks) => {
  if (!Array.isArray(blocks)) return "";
  for (const b of blocks) {
    if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      return b.text.trim();
    }
  }
  return "";
};

export class PetBridgeState {
  /**
   * @param {object} opts
   * @param {number} [opts.quietMs=8000] 完成去抖窗口
   * @param {number} [opts.idleMs=90000] 空闲超时
   * @param {() => number} [opts.now]
   * @param {(fn: () => void, ms: number) => () => void} [opts.schedule]
   * @param {(event: string, detail: string) => void} [opts.onEvent]
   * @param {(text: string, status: string, kind: "action" | "summary") => void} [opts.onAction]
   *   kind: "action"=动作行（工具进度，不锁定）；"summary"=AI 总结（锁定显示）
   */
  constructor(opts = {}) {
    this.quietMs = opts.quietMs ?? 8000;
    this.idleMs = opts.idleMs ?? 90000;
    this.now = opts.now ?? (() => Date.now());
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    this.onEvent = opts.onEvent ?? (() => {});
    this.onAction = opts.onAction ?? (() => {});
    this.onLog = opts.onLog ?? (() => {});

    // —— 镜像状态 ——
    this.hadTurn = false; // 本轮会话是否出现过 turn
    this.mode = "idle"; // idle | running | review | waiting
    this.lastActivityAt = this.now();
    this.lastIdleSentAt = 0;
    this.pendingComplete = null; // 挂起的完成信号 { cancel, detail }
    this.completed = false; // 桌宠正处于完成展示
    this.runningAgents = new Set(); // 正在运行的 agent id 集合（含子代理）
    this.thinking = false; // 思考态节流：每段推理流只提示一次"正在思考"
  }

  // ------------------------------------------------------------------ 工具

  /** 仅刷新活动时间戳（不取消挂起的完成信号）。 */
  _touch() {
    this.lastActivityAt = this.now();
  }

  /** 新活动：刷新时间戳并取消挂起的完成信号。 */
  _activity() {
    this._touch();
    this._cancelPendingComplete();
  }

  _cancelPendingComplete() {
    if (this.pendingComplete) {
      this.pendingComplete.cancel();
      this.pendingComplete = null;
    }
  }

  _armComplete(detail) {
    this._cancelPendingComplete();
    const armedAt = this.now();
    const cancel = this.schedule(() => {
      this.pendingComplete = null;
      // 完成条件：静默窗口已过，且（agent 已空闲 或 更长时间内无任何实际活动）。
      // 第二项是关键兜底：agent/status idle 事件若丢失/状态卡住（anyRunning
      // 卡 true），只要 30s 内没有任何会话活动（chunk/工具/回合），
      // 也判定任务完成，避免"任务结束后永久 running"。
      const quiet = this.now() - armedAt >= this.quietMs;
      const stallMs = Math.max(this.quietMs, 30000);
      const noActivity = this.now() - this.lastActivityAt >= stallMs;
      if (quiet && (!this.anyRunning || noActivity)) {
        this.completed = true;
        this.mode = "waiting";
        this.onLog(`完成确认: anyRunning=${this.anyRunning}, 距上次活动 ${Math.round((this.now() - this.lastActivityAt) / 1000)}s`);
        this.onEvent("done", clampDetail(detail, 80));
      } else if (this.anyRunning) {
        // agent 仍在收尾且窗口内有活动（子代理/工具仍在运行）：继续等待
        this._armComplete(detail);
      }
    }, this.quietMs);
    this.pendingComplete = { cancel, detail };
  }

  // ------------------------------------------------------------------ 输入

  /** 插件启动：通知桌宠进入空闲。 */
  onBoot() {
    this.onEvent("SessionStart", "DSH 已启动");
  }

  /**
   * agent/status：任一 agent（含子代理）运行/空闲。
   * @param {string} agentId agent 标识（agent.id / session id）
   * @param {string} status 'running' | 'idle'
   */
  onAgentStatus(agentId, status) {
    if (status === "running") {
      const wasIdle = this.runningAgents.size === 0;
      this.runningAgents.add(agentId);
      this._activity();
      if (wasIdle && !this.completed) {
        this.onEvent("AgentStart", "任务进行中");
      }
      return;
    }
    // idle：只移除该 agent；其他 agent 仍在运行则保持 anyRunning
    this.runningAgents.delete(agentId);
  }

  /** 是否有任一 agent（含子代理）正在运行。 */
  get anyRunning() {
    return this.runningAgents.size > 0;
  }

  /** agent/error / turn/end(error) 等失败信号。 */
  onFailure(message) {
    this._activity();
    this.completed = false;
    this.mode = "idle";
    this.onEvent("failed", clampDetail(message ?? "发生错误"));
  }

  /**
   * 任意会话的活动事件（含子代理）：只刷新活动时间与运行状态，
   * 不产生任何桌宠事件。用于让长推理/子代理运行期间插件端
   * 空闲兜底（90s）不会误触发。
   * @param {string} type 会话事件类型（turn/start、step/start、assistant/chunk 等）
   */
  onActivity(type) {
    this._touch();
    if (
      type === "turn/start" ||
      type === "step/start" ||
      type === "assistant/chunk" ||
      type === "assistant/message" ||
      type === "request/header"
    ) {
      if (this.mode !== "waiting") {
        this.mode = "running";
      }
    }
  }

  /**
   * 活动心跳（index.js 每 30 秒调用一次）：running/review 期间向桌宠
   * 发送空 detail 的 agent_message，刷新桌宠端空闲兜底计时器——
   * 这是原版 rollout 高频事件（token_count/reasoning 等）的 DSH 等价物。
   *
   * 注意：心跳**不刷新插件端 lastActivityAt**——插件端兜底只认真实
   * 会话活动（chunk/工具/回合/子代理），否则"agent 状态卡 running 但
   * 实际已无活动"时心跳会无限保活，导致任务结束后永久 running。
   */
  heartbeat() {
    if (this.mode === "running" || this.mode === "review") {
      this.onEvent("agent_message", "");
    }
  }

  /** 会话事件（仅顶层会话；index.js 已过滤）。 */
  onSessionEvent(event) {
    const { type, data } = event;
    // 任何会话事件都算活动信号：长推理（assistant/chunk）、子代理运行期间、
    // 工具长调用等场景都靠它防止空闲兜底误触发（90s 无活动才回 idle）。
    this._touch();
    switch (type) {
      case "turn/start": {
        this.hadTurn = true;
        this.thinking = false;
        this._activity();
        this.completed = false;
        this.mode = "running";
        break;
      }
      case "step/start":
      case "assistant/chunk":
      case "request/header": {
        // 模型推理/请求期间保持运行态（防止 mode 残留导致兜底误判）
        if (this.mode !== "waiting") {
          this.mode = "running";
        }
        // 思考态动作行：每段推理流只提示一次"正在思考"（节流）
        if (type === "assistant/chunk" && !this.thinking) {
          this.thinking = true;
          this.onAction("正在思考", "ok", "action");
        }
        break;
      }
      case "assistant/message": {
        // 模型完整回复 → AI 总结（气泡第二行，kind=summary，锁定显示）
        if (this.mode !== "waiting") {
          this.mode = "running";
        }
        this.thinking = false;
        const summary = firstText(data.message?.content);
        if (summary) {
          this.onAction(clampDetail(summary, 20), "ok", "summary");
        }
        break;
      }
      case "user/message": {
        if (data.message?.source?.kind === "user") {
          this.hadTurn = true;
          this.thinking = false;
          this.completed = false;
          this._activity();
          this.mode = "running";
          this.onEvent("UserPromptSubmit", clampDetail(firstText(data.message?.content)));
          // 新指令：动作行"收到指令"并重置 AI 总结锁定（原版语义）
          this.onAction("收到指令", "ok", "action");
        }
        break;
      }
      case "tool/call": {
        this.thinking = false;
        this._activity();
        this.completed = false;
        this.mode = "running";
        this.onEvent("PreToolUse", `调用工具 ${data.name}`);
        this.onAction(`调用 ${data.name}`, "ok", "action");
        break;
      }
      case "tool/result": {
        this.thinking = false;
        this._activity();
        this.completed = false;
        if (data.error) {
          this.mode = "running";
          this.onEvent("PostToolUse", `工具出错 ${data.error.code ?? data.error.name ?? ""}`.trim());
          this.onAction(`工具出错：${data.error.code ?? data.error.name ?? ""}`, "error", "action");
          break;
        }
        const diffs = data.meta?.diffs;
        if (Array.isArray(diffs) && diffs.length > 0) {
          // 产出代码变更 → review（循环等待审阅）
          this.mode = "review";
          const files = diffs.map((d) => d.path).filter(Boolean);
          const detail = files.length > 0 ? `已修改 ${files.length} 个文件` : "已应用代码变更";
          this.onEvent("patch_apply", detail);
          this.onAction(detail, "ok", "action");
        } else {
          this.mode = "running";
          const name = data.message?.content?.[0]?.name ?? data.message?.name ?? "";
          this.onEvent("PostToolUse", name ? `工具 ${name} 完成` : "工具执行完成");
          this.onAction(name ? `${name} 完成` : "工具执行完成", "ok", "action");
        }
        break;
      }
      case "turn/end": {
        const kind = data.reason?.kind;
        if (kind === "error") {
          const err = data.reason?.error;
          this.onFailure(err?.message ?? err?.code ?? "任务失败");
          break;
        }
        if (kind === "aborted") {
          this.completed = false;
          this._activity();
          this.mode = "idle";
          this.onEvent("idle", "已取消");
          break;
        }
        this.thinking = false;
        // completed / blocked / max-tokens / interrupted → 等待态（不庆祝）
        this.hadTurn = true;
        // 仅刷新活动时间戳；不取消 goal 完成挂起的完成信号
        // （goal complete 通常先于收尾 turn/end 到达）
        this._touch();
        this.completed = false;
        this.mode = "waiting";
        const detail =
          kind === "blocked" ? "等待处理" : kind === "max-tokens" ? "已达输出上限" : "等待你的输入";
        this.onEvent("AgentStop", detail);
        break;
      }
      case "approval/asked": {
        this._activity();
        this.completed = false;
        this.mode = "waiting";
        this.onEvent("PermissionRequest", clampDetail(data.toolName ?? "需要授权", 60));
        this.onAction(`等待授权：${data.toolName ?? "工具"}`, "warn", "action");
        break;
      }
      case "approval/decided": {
        const outcome = data.outcome;
        if (outcome === "allowed-once") {
          this._activity();
          this.completed = false;
          this.mode = "running";
          this.onEvent("agent_message", "已授权，继续执行");
          this.onAction("已授权，继续执行", "ok", "action");
        } else if (outcome === "rejected") {
          this.completed = false;
          this.mode = "idle";
          this.onEvent("deny", "已拒绝授权");
        } else if (outcome === "cancelled") {
          this.completed = false;
          this.mode = "idle";
          this.onEvent("idle", "授权已取消");
        } else {
          // unavailable：无可用的回答者 → 保持等待
          this.mode = "waiting";
          this.onEvent("AgentStop", "等待授权");
        }
        break;
      }
      case "goal/change": {
        const operation = data.operation;
        const goal = data.goal;
        if (operation === "complete" || goal?.phase === "complete") {
          this.hadTurn = true;
          this._activity();
          this._armComplete(goal?.objective ?? "目标完成");
        } else if (operation === "block" || goal?.phase === "blocked") {
          this.onFailure(goal?.blockedReason ?? "目标受阻");
        } else if (operation === "create") {
          this._activity();
          this.completed = false;
          this.mode = "running";
          this.onEvent("agent_message", "目标已创建，开始执行");
          this.onAction(clampDetail(goal?.objective, 40), "ok", "action");
        } else if (operation === "edit") {
          this._activity();
          this.completed = false;
          this.mode = "running";
          this.onEvent("agent_message", "目标已更新");
        } else if (operation === "pause") {
          this.mode = "waiting";
          this.onEvent("AgentStop", "目标已暂停");
        } else if (operation === "resume") {
          this._activity();
          this.completed = false;
          this.mode = "running";
          this.onEvent("agent_message", "目标已恢复");
        }
        // clear：忽略
        break;
      }
      case "todo/write": {
        const item = (data.todos ?? []).find((t) => t.status === "in_progress");
        if (item) {
          this.onAction(clampDetail(item.content, 40), "ok", "action");
        }
        break;
      }
      default:
        break;
    }
  }

  /** 周期心跳（每 5 秒）：空闲兜底。 */
  onTick() {
    if (this.mode === "running" || this.mode === "review") {
      if (this.now() - this.lastActivityAt > this.idleMs) {
        this.mode = "idle";
        this.onLog(
          `空闲兜底触发: mode=${this.mode}, 距上次活动 ${Math.round((this.now() - this.lastActivityAt) / 1000)}s (>${this.idleMs / 1000}s), runningAgents=${this.runningAgents.size}`,
        );
        this.onEvent("idle", "长时间无活动");
      }
    }
  }

  /** 插件卸载：清理定时器。 */
  dispose() {
    this._cancelPendingComplete();
  }
}
