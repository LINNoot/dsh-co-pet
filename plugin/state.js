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
   * @param {(text: string, status: string) => void} [opts.onAction]
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

    // —— 镜像状态 ——
    this.anyRunning = false; // 任一 agent（含子代理）正在运行
    this.hadTurn = false; // 本轮会话是否出现过 turn
    this.mode = "idle"; // idle | running | review | waiting
    this.lastActivityAt = this.now();
    this.lastIdleSentAt = 0;
    this.pendingComplete = null; // 挂起的完成信号 { cancel, detail }
    this.completed = false; // 桌宠正处于完成展示
    this.lastAgentIdle = false; // 上一帧 agent 全空闲（避免重复发 AgentStop）
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
      if (this.now() - armedAt >= this.quietMs && !this.anyRunning) {
        this.completed = true;
        this.mode = "waiting";
        this.onEvent("done", clampDetail(detail, 80));
      } else if (this.anyRunning) {
        // 目标完成时 agent 仍在收尾（如子代理/工具仍在运行）：
        // 等其空闲后再确认完成。
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

  /** agent/status：任一 agent（含子代理）运行/空闲。 */
  onAgentStatus(status) {
    if (status === "running") {
      this._activity();
      if (!this.anyRunning && !this.completed) {
        this.onEvent("AgentStart", "任务进行中");
      }
      this.anyRunning = true;
      this.lastAgentIdle = false;
      return;
    }
    // idle
    this.anyRunning = false;
    this.lastAgentIdle = true;
  }

  /** agent/error / turn/end(error) 等失败信号。 */
  onFailure(message) {
    this._activity();
    this.completed = false;
    this.mode = "idle";
    this.onEvent("failed", clampDetail(message ?? "发生错误"));
  }

  /** 会话事件（仅顶层会话；index.js 已过滤）。 */
  onSessionEvent(event) {
    const { type, data } = event;
    switch (type) {
      case "turn/start": {
        this.hadTurn = true;
        this._activity();
        this.completed = false;
        break;
      }
      case "user/message": {
        if (data.message?.source?.kind === "user") {
          this.hadTurn = true;
          this.completed = false;
          this._activity();
          this.mode = "running";
          this.onEvent("UserPromptSubmit", clampDetail(firstText(data.message?.content)));
        }
        break;
      }
      case "tool/call": {
        this._activity();
        this.completed = false;
        this.mode = "running";
        this.onEvent("PreToolUse", `调用工具 ${data.name}`);
        this.onAction(`调用 ${data.name}`, "ok");
        break;
      }
      case "tool/result": {
        this._activity();
        this.completed = false;
        if (data.error) {
          this.mode = "running";
          this.onEvent("PostToolUse", `工具出错 ${data.error.code ?? data.error.name ?? ""}`.trim());
          this.onAction(`工具出错：${data.error.code ?? data.error.name ?? ""}`, "error");
          break;
        }
        const diffs = data.meta?.diffs;
        if (Array.isArray(diffs) && diffs.length > 0) {
          // 产出代码变更 → review（循环等待审阅）
          this.mode = "review";
          const files = diffs.map((d) => d.path).filter(Boolean);
          const detail = files.length > 0 ? `已修改 ${files.length} 个文件` : "已应用代码变更";
          this.onEvent("patch_apply", detail);
          this.onAction(detail, "ok");
        } else {
          this.mode = "running";
          const name = data.message?.content?.[0]?.name ?? data.message?.name ?? "";
          this.onEvent("PostToolUse", name ? `工具 ${name} 完成` : "工具执行完成");
          this.onAction(name ? `${name} 完成` : "工具执行完成", "ok");
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
        this.onAction(`等待授权：${data.toolName ?? "工具"}`, "warn");
        break;
      }
      case "approval/decided": {
        const outcome = data.outcome;
        if (outcome === "allowed-once") {
          this._activity();
          this.completed = false;
          this.mode = "running";
          this.onEvent("agent_message", "已授权，继续执行");
          this.onAction("已授权，继续执行", "ok");
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
          this.onAction(clampDetail(goal?.objective, 40), "ok");
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
          this.onAction(clampDetail(item.content, 40), "ok");
        }
        break;
      }
      default:
        break;
    }
  }

  /** 周期心跳（每 5 秒）：空闲兜底。 */
  onTick() {
    if ((this.mode === "running" || this.mode === "review") && !this.anyRunning) {
      if (this.now() - this.lastActivityAt > this.idleMs) {
        this.mode = "idle";
        this.onEvent("idle", "长时间无活动");
      }
    }
  }

  /** 插件卸载：清理定时器。 */
  dispose() {
    this._cancelPendingComplete();
  }
}
