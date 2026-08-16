// dsh-pet-bridge — 状态机（纯逻辑，无 I/O，可单测）
//
// 输入：DSH 事件（已在 index.js 归一化）→ 输出：桌宠事件（event/detail/action）。
//
// 架构（分层状态机）：
// - 运行门闩 gateRunning：只由 agent/status 开合（DSH 内核自己维护的
//   running⇄idle，进程内原子 emit，与内核实际状态永远一致）；turn/start
//   作为兜底打开（实证 agent/status 不可靠时自动降级为回合级信号）。
// - 展示态 mode（idle|running|review|waiting）：只由结论事件设置——
//   turn/end reason、approval 结果、goal/change 结论、失败信号。
// - 内容事件（chunk/step/tool/todo/user/request）只刷新活动时间 + 出气泡，
//   永不改写 mode——杜绝"内容事件把状态拉回 running"掩盖真实状态的问题。
// - “完成”只在 目标完成（goal complete）+ 静默去抖窗口（quietMs）内无任何新
//   活动时才触发；轮次结束只进入等待态，绝不中途“庆祝”。
// - 长时间无活动（idleMs）兜底是极端防御，触发即显式日志（暴露事件流漏洞）。

const clampDetail = (text, max = 120) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
};

const firstText = (blocks) => {
  // 防御性读取：content 可能是 block 数组（text/reasoning/tool-call）、
  // 字符串、或空；text block 字段可能是 text/content 变体。
  if (typeof blocks === "string") return blocks.trim();
  if (!Array.isArray(blocks)) return "";
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") {
      const t = typeof b.text === "string" ? b.text : typeof b.content === "string" ? b.content : "";
      if (t.trim()) return t.trim();
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
    this.onLog = opts.onLog ?? (() => {});

    // 事件/动作历史（环形缓冲）：诊断快照用，用户复现问题时
    // 可以从 ~/.dsh/dsh-pet-state.debug.json 直接看到插件收到了什么、发了什么。
    // kind: "event"/"action"=发出（桌宠侧）；"in"=收到（agent/status、会话事件）。
    this.history = [];
    const push = (entry) => {
      this.history.push(entry);
      if (this.history.length > 40) this.history.shift();
    };
    this._pushIn = (name, detail = "") => push({ ts: this.now(), kind: "in", name, detail });
    this.onEvent = (event, detail) => {
      push({ ts: this.now(), kind: "event", name: event, detail });
      opts.onEvent?.(event, detail);
    };
    this.onAction = (text, status, kind) => {
      push({ ts: this.now(), kind: "action", text, status });
      opts.onAction?.(text, status, kind);
    };
    this.onSnapshot = opts.onSnapshot ?? (() => {});

    // —— 镜像状态 ——
    this.hadTurn = false; // 本轮会话是否出现过 turn
    this.mode = "idle"; // 展示态：idle | running | review | waiting
    this.gateRunning = false; // 运行门闩：由 agent/status 开合（turn/start 兜底开）
    this.gateSource = null; // 门闩最近一次变迁来源（诊断）
    this.lastActivityAt = this.now();
    this.lastIdleSentAt = 0;
    this.pendingComplete = null; // 挂起的完成信号 { cancel, detail }
    this.completed = false; // 桌宠正处于完成展示
    this.runningAgents = new Set(); // 正在运行的 agent id 集合（含子代理）
    this.thinking = false; // 思考态节流：每段推理流只提示一次"正在思考"
    this.hasActiveGoal = false; // 会话是否有进行中的 goal（有则回合完成不庆祝）
    this.rootAgentIds = new Set(); // 顶层 agent id 集合（agents.roots()，路由判定用）
    this.taskTitle = ""; // 当前任务会话标题（sessionTitle 服务，气泡第一行黑体）
    this.rootActivity = new Map(); // 顶层会话最近活动时间（sessionId → ts，标题跟随用）
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

  /** 打开运行门闩（有 agent 在工作）。 */
  _openGate(source) {
    const wasClosed = !this.gateRunning;
    this.gateRunning = true;
    this.gateSource = source;
    // 门闩从关到开的瞬间：任何非 review 展示态都回 running
    // （含 waiting——如主 agent 空闲等待期间子代理启动）。
    // 门闩保持打开时（如授权等待中）不动展示态。
    if (wasClosed && this.mode !== "review") {
      this.mode = "running";
    }
  }

  /** 关闭运行门闩（无 agent 在工作）。不改展示态——由结论事件设置。 */
  _closeGate(source) {
    if (!this.gateRunning) return;
    this.gateRunning = false;
    this.gateSource = source;
    // 若结论事件（turn/end 等）缺失，兜底把仍在 running/review 的展示态
    // 收为 waiting，避免"任务结束还显示运行中"。
    if (this.mode === "running" || this.mode === "review") {
      this.mode = "waiting";
      this.onEvent("AgentStop", "等待你的输入");
    }
  }

  /**
   * 内容事件的防御性恢复：仅当展示态卡在 idle/failed 时回到 running。
   * 正常情况下展示态由权威信号维护，此方法只在信号链断裂时兜底，
   * 绝不把 waiting/review（等待类展示）拉回 running。
   */
  _defensiveRunning() {
    if (this.mode === "idle" || this.mode === "failed") {
      this.mode = "running";
    }
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
   * agent/status：任一 agent（含子代理）运行/空闲。这是运行门闩的
   * 唯一权威信号（DSH 内核维护），展示态由结论事件负责。
   * @param {string} agentId agent 标识（agent.id / session id）
   * @param {string} status 'running' | 'idle'
   */
  onAgentStatus(agentId, status) {
    this._pushIn("agent/status", `${agentId} → ${status}`);
    if (status === "running") {
      const wasIdle = this.runningAgents.size === 0;
      this.runningAgents.add(agentId);
      this._activity();
      this._openGate("agent/status");
      if (wasIdle && !this.completed) {
        this.onEvent("AgentStart", "任务进行中");
      }
      return;
    }
    // idle：只移除该 agent；其他 agent 仍在运行则保持门闩打开
    this.runningAgents.delete(agentId);
    if (this.runningAgents.size === 0) {
      this._closeGate("agent/status");
    }
  }

  /** 是否有任一 agent（含子代理）正在运行。 */
  get anyRunning() {
    return this.runningAgents.size > 0;
  }

  /**
   * agents 服务轮询快照（index.js 每秒调用）：校正 runningAgents。
   *
   * 轮询是权威状态源——社区插件实测（dsh-kun-like-pet v4）：部分部署里
   * agent/status 事件不流经总线（831 次观测 0 次），事件监听会永久漏掉
   * 完成信号；即便事件可达，idle 事件也可能丢失导致"卡 running"。
   * 校正规则：
   *   - 轮询 running 但集合没有 → 补入（事件丢失兜底）；
   *   - 轮询 idle 但集合有 → 移除（卡 running 兜底）；
   *   - 轮询未出现的 agent → 移除（已销毁/不可见）。
   * @param {Array<{id?: string, status?: string}>} agents agents.list() 快照
   */
  onAgentsSnapshot(agents) {
    if (!Array.isArray(agents)) return;
    const seen = new Set();    for (const a of agents) {
      const id = a?.id;
      if (typeof id !== "string" || !id) continue;
      seen.add(id);
      const running = a?.status === "running";
      const inSet = this.runningAgents.has(id);
      if (running && !inSet) {
        const wasIdle = this.runningAgents.size === 0;
        this.runningAgents.add(id);
        this._pushIn("poll", `${id} running（轮询补入）`);
        this._activity();
        this._openGate("poll");
        if (wasIdle && !this.completed) {
          this.onEvent("AgentStart", "任务进行中");
        }
      } else if (!running && inSet) {
        this.runningAgents.delete(id);
        this._pushIn("poll", `${id} idle（轮询校正）`);
        if (this.runningAgents.size === 0) {
          this._closeGate("poll");
        }
      }
    }
    // 轮询中不再出现的 agent（已销毁等）：从集合移除
    for (const id of [...this.runningAgents]) {
      if (!seen.has(id)) {
        this.runningAgents.delete(id);
        this._pushIn("poll", `${id} 消失（轮询移除）`);
        if (this.runningAgents.size === 0) {
          this._closeGate("poll");
        }
      }
    }
  }

  /**
   * 顶层 agent id 集合（index.js 轮询 agents.roots() 时更新）。
   * 会话事件路由用它判定"是否顶层会话"——比 header 判定可靠：
   * 恢复的会话 header 可能带 origin/delegationDepth 残留，导致顶层会话
   * 被误判为子代理（事件全部降级为 activity，AI 总结/完成永不触发）。
   * @param {string[]} ids 顶层 agent id 列表
   */
  setRootAgents(ids) {
    this.rootAgentIds = new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : []);
  }

  /** 该会话 id 是否为顶层会话（运行时事实优先，header 判定由 index.js 兜底）。 */
  isRootSessionId(sessionId) {
    return this.rootAgentIds.has(sessionId);
  }

  /**
   * 最近活动的顶层会话 id（标题跟随用）：
   * 取 rootActivity 中时间最新的、且仍在 rootAgentIds 集合里的会话。
   * 返回 undefined 表示尚无记录。
   */
  getMostRecentRootId() {
    let best = undefined;
    let bestTs = -1;
    for (const [id, ts] of this.rootActivity) {
      if (ts > bestTs && this.rootAgentIds.has(id)) {
        best = id;
        bestTs = ts;
      }
    }
    return best;
  }

  /**
   * 会话标题更新（index.js 轮询 sessionTitle 服务时调用）。
   * 气泡第一行黑体显示任务会话标题（侧边栏那个），如
   * "审查codex桌宠代码准备移植"；无标题时回退用户消息文本。
   * @param {string} title 归一化标题（空串表示尚无标题）
   */
  onSessionTitle(title) {
    const t = String(title ?? "").trim();
    if (t && t !== this.taskTitle) {
      this.taskTitle = t;
      this._pushIn("session/title", t);
    }
  }

  /** agent/error / turn/end(error) 等失败信号。 */
  onFailure(message) {
    this._activity();
    this.completed = false;
    this.mode = "idle";
    this.onEvent("failed", clampDetail(message ?? "发生错误"));
  }

  /**
   * 任意会话的活动事件（含子代理）：只刷新活动时间，不产生任何桌宠事件、
   * 不改变状态。用于让长推理/子代理运行期间插件端空闲兜底（90s）不会误触发。
   * @param {string} type 会话事件类型（turn/start、step/start、assistant/chunk 等）
   * @param {string} [sessionId] 来源会话 id（诊断）
   */
  onActivity(type, sessionId = "") {
    this._pushIn(`activity:${type}`, sessionId);
    this._touch();
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
    this._pushIn(
      `session:${type}`,
      `${event.sessionId ?? ""} ${String(data?.reason?.kind ?? data?.name ?? data?.operation ?? "")}`.trim(),
    );
    // 记录顶层会话最近活动（标题跟随"正在跑/最近活动的会话"，
    // 避免多会话时取错标题）。
    if (event.sessionId) {
      this.rootActivity.set(event.sessionId, this.now());
    }
    // 任何会话事件都算活动信号：长推理（assistant/chunk）、子代理运行期间、
    // 工具长调用等场景都靠它防止空闲兜底误触发（90s 无活动才回 idle）。
    this._touch();
    switch (type) {
      case "turn/start": {
        this.hadTurn = true;
        this.thinking = false;
        this._activity();
        this.completed = false;
        // 新回合一定在工作：开运行门闩（agent/status 缺失时的兜底）+ 展示态
        this._openGate("turn/start");
        this.mode = "running";
        break;
      }
      case "step/start":
      case "assistant/chunk":
      case "request/header": {
        // 内容事件不改写展示态；仅当展示态卡在 idle/failed 时防御性恢复
        this._defensiveRunning();
        // 思考态动作行：每段推理流只提示一次"正在思考"（节流）
        if (type === "assistant/chunk" && !this.thinking) {
          this.thinking = true;
          this.onAction("正在思考", "ok", "action");
        }
        break;
      }
      case "assistant/message": {
        // 模型完整回复 → AI 总结（气泡第二行，kind=summary，锁定显示）
        this._defensiveRunning();
        this.thinking = false;
        const summary = firstText(data.message?.content);
        if (summary) {
          this.onAction(clampDetail(summary, 20), "ok", "summary");
        }
        break;
      }
      case "user/message": {
        // 注意：DSH 的 user/message 事件 data 本身就是 UserMessage
        // （{ role, content, source }），不存在 data.message 字段。
        if (data.source?.kind === "user") {
          this.hadTurn = true;
          this.thinking = false;
          this.completed = false;
          this._activity();
          // 用户发话：展示态回到运行
          this._openGate("user/message");
          this.mode = "running";
          // 气泡第一行黑体 = 会话标题（侧边栏显示的那个，如
          // "审查codex桌宠代码准备移植"）；标题未生成时回退消息文本。
          const promptText = firstText(data.content);
          this.onEvent("UserPromptSubmit", clampDetail(this.taskTitle || promptText));
          // 新指令：动作行"收到指令"并重置 AI 总结锁定（原版语义）
          this.onAction("收到指令", "ok", "action");
        }
        break;
      }
      case "tool/call": {
        this.thinking = false;
        this._activity();
        this.completed = false;
        this._defensiveRunning();
        this.onEvent("PreToolUse", `调用工具 ${data.name}`);
        this.onAction(`调用 ${data.name}`, "ok", "action");
        break;
      }
      case "tool/result": {
        this.thinking = false;
        this._activity();
        this.completed = false;
        if (data.error) {
          this._defensiveRunning();
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
          this._defensiveRunning();
          // ToolResultMessage.content 是 [ToolResultBlock]（无 name 字段），
          // 工具名已在 tool/call 显示过，这里统一用通用文案。
          this.onEvent("PostToolUse", "工具执行完成");
          this.onAction("工具执行完成", "ok", "action");
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
        // completed / blocked / max-tokens / interrupted → 等待态
        this.hadTurn = true;
        // 仅刷新活动时间戳；不取消 goal 完成挂起的完成信号
        // （goal complete 通常先于收尾 turn/end 到达）
        this._touch();
        this.completed = false;
        this.mode = "waiting";
        const detail =
          kind === "blocked" ? "等待处理" : kind === "max-tokens" ? "已达输出上限" : "等待你的输入";
        this.onEvent("AgentStop", detail);
        // 普通任务完成：无 active goal 时，回合正常结束（completed）且没有
        // 已挂起的完成信号 → 8s 静默后触发完成展示（原版语义：任务完成后
        // 气泡第二行 AI 总结 + 对勾圆圈）。有 active goal 时只认 goal complete
        // （goal 是多轮任务，每轮都庆祝会变成"任务中途庆祝"）。
        if (kind === "completed" && !this.hasActiveGoal && !this.pendingComplete) {
          this._armComplete("任务完成");
        }
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
          this._defensiveRunning();
          this.onEvent("agent_message", "已授权，继续执行");
          this.onAction("已授权，继续执行", "ok", "action");
        } else if (outcome === "rejected") {
          this.completed = false;
          this.mode = "idle";
          this._closeGate("approval");
          this.onEvent("deny", "已拒绝授权");
        } else if (outcome === "cancelled") {
          this.completed = false;
          this.mode = "idle";
          this._closeGate("approval");
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
          this.hasActiveGoal = false; // 目标完成：后续回合完成可正常庆祝
          this.hadTurn = true;
          this._activity();
          this._armComplete(goal?.objective ?? "目标完成");
        } else if (operation === "block" || goal?.phase === "blocked") {
          this.hasActiveGoal = false;
          this.onFailure(goal?.blockedReason ?? "目标受阻");
        } else if (operation === "create") {
          this.hasActiveGoal = true;
          this._activity();
          this.completed = false;
          this._defensiveRunning();
          this.onEvent("agent_message", "目标已创建，开始执行");
          this.onAction(clampDetail(goal?.objective, 40), "ok", "action");
        } else if (operation === "edit") {
          this._activity();
          this.completed = false;
          this._defensiveRunning();
          this.onEvent("agent_message", "目标已更新");
        } else if (operation === "pause") {
          this.mode = "waiting";
          this.onEvent("AgentStop", "目标已暂停");
        } else if (operation === "resume") {
          this._activity();
          this.completed = false;
          this._defensiveRunning();
          this.onEvent("agent_message", "目标已恢复");
        } else if (operation === "clear") {
          this.hasActiveGoal = false;
        }
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

  /** 周期心跳（每 5 秒）：空闲兜底 + 状态快照输出。 */
  onTick() {
    if (this.mode === "running" || this.mode === "review") {
      if (this.now() - this.lastActivityAt > this.idleMs) {
        this.mode = "idle";
        // 极端防御：正常运行中 agent/status 与 turn/end 都会把状态收走，
        // 走到这里说明事件流有洞（快照 history 可回溯）。显式记录，不静默兜底。
        this.onLog(
          `空闲兜底触发(事件流异常): gate=${this.gateRunning}(src=${this.gateSource}), 距上次活动 ${Math.round((this.now() - this.lastActivityAt) / 1000)}s (>${this.idleMs / 1000}s), runningAgents=[${[...this.runningAgents].join(",")}]`,
        );
        this.onEvent("idle", "长时间无活动");
      }
    }
    // 诊断快照：每次 tick 都输出当前内部状态（含最近事件历史），
    // 由 index.js 写入 ~/.dsh/dsh-pet-state.debug.json。
    this.onSnapshot(this.snapshot());
  }

  /** 当前内部状态快照（诊断用）。 */
  snapshot() {
    const now = this.now();
    return {
      ts: now,
      mode: this.mode,
      gateRunning: this.gateRunning,
      gateSource: this.gateSource,
      hadTurn: this.hadTurn,
      completed: this.completed,
      thinking: this.thinking,
      anyRunning: this.anyRunning,
      runningAgents: [...this.runningAgents],
      rootAgentIds: [...this.rootAgentIds],
      taskTitle: this.taskTitle,
      lastActivityAgoMs: now - this.lastActivityAt,
      pendingComplete: Boolean(this.pendingComplete),
      history: this.history.slice(-20),
    };
  }

  /** 插件卸载：清理定时器。 */
  dispose() {
    this._cancelPendingComplete();
  }
}
