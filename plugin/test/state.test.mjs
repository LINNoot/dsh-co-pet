// dsh-pet-bridge 状态机单测：node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { PetBridgeState } from "../state.js";

/** 可控假时钟 + 假定时器队列。 */
function makeHarness() {
  let now = 1_000_000;
  let timers = [];
  const schedule = (fn, ms) => {
    const entry = { at: now + ms, fn, cancelled: false };
    timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    get now() {
      return now;
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => !t.cancelled && t.at <= now).sort((a, b) => a.at - b.at);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    },
    flush() {
      while (timers.some((t) => !t.cancelled && t.at <= now)) this.advance(0);
    },
    makeState(overrides = {}) {
      const events = [];
      const actions = [];
      const state = new PetBridgeState({
        now: () => now,
        schedule,
        onEvent: (event, detail) => events.push({ event, detail }),
        onAction: (text, status, kind) => actions.push({ text, status, kind }),
        ...overrides,
      });
      return { state, events, actions };
    },
  };
}

// 注意：必须与 DSH 真实结构一致——user/message 的 data 就是 UserMessage
// 本身（{ role, content, source }），没有 data.message 包装层。
const userMessage = (text) => ({
  type: "user/message",
  data: {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  },
});
const turnEnd = (kind, extra = {}) => ({
  type: "turn/end",
  data: { reason: { kind, ...extra } },
});
const goalChange = (operation, goal = {}) => ({
  type: "goal/change",
  data: { operation, goal },
});

test("启动时发送 SessionStart", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onBoot();
  assert.deepEqual(events, [{ event: "SessionStart", detail: "DSH 已启动" }]);
});

test("用户消息 → UserPromptSubmit（running）", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(userMessage("帮我重构这个模块"));
  assert.deepEqual(events.at(-1), { event: "UserPromptSubmit", detail: "帮我重构这个模块" });
});

test("会话标题：UserPromptSubmit 气泡第一行用标题（侧边栏标题）", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionTitle("审查codex桌宠代码准备移植");
  state.onSessionEvent(userMessage("帮我重构这个模块"));
  assert.deepEqual(events.at(-1), { event: "UserPromptSubmit", detail: "审查codex桌宠代码准备移植" });
});

test("会话标题：标题变化时更新", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionTitle("旧标题");
  state.onSessionEvent(userMessage("第一问"));
  state.onSessionTitle("新标题：优化桌宠");
  state.onSessionEvent(userMessage("第二问"));
  assert.deepEqual(events.at(-1), { event: "UserPromptSubmit", detail: "新标题：优化桌宠" });
  assert.equal(state.snapshot().taskTitle, "新标题：优化桌宠");
});

test("工具调用与 diff → PreToolUse / patch_apply（review）", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent({ type: "tool/call", data: { name: "edit" } });
  assert.equal(events.at(-1).event, "PreToolUse");
  state.onSessionEvent({
    type: "tool/result",
    data: { meta: { diffs: [{ path: "a.py" }, { path: "b.py" }] } },
  });
  assert.equal(events.at(-1).event, "patch_apply");
  assert.equal(events.at(-1).detail, "已修改 2 个文件");
});

test("轮次结束（completed）→ 等待态；无 goal 时 8s 静默后触发完成展示", () => {
  // 原版语义：普通任务（无 active goal）完成后要有完成气泡/对勾圆圈。
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(turnEnd("completed"));
  assert.equal(events.at(-1).event, "AgentStop");
  assert.ok(!events.some((e) => e.event === "done"), "静默窗口内不触发完成");
  h.advance(8000);
  assert.deepEqual(events.at(-1), { event: "done", detail: "任务完成" });
});

test("有 active goal 时回合完成不庆祝（等 goal complete，避免每轮庆祝）", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("create", { objective: "长期目标" }));
  state.onSessionEvent(turnEnd("completed"));
  h.advance(8000);
  assert.ok(!events.some((e) => e.event === "done"), "goal 进行中回合完成不应触发完成");
  // goal 完成后收尾回合 → 完成
  state.onSessionEvent(goalChange("complete", { objective: "长期目标" }));
  h.advance(8000);
  assert.deepEqual(events.at(-1), { event: "done", detail: "长期目标" });
});

test("goal complete 挂起中，收尾 turn/end 不重置完成计时", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  h.advance(3000);
  state.onSessionEvent(turnEnd("completed")); // 收尾回合（无重复 arm）
  h.advance(6000);
  assert.deepEqual(events.at(-1), { event: "done", detail: "X" });
});

test("轮次出错 → failed", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(turnEnd("error", { error: { message: "LLM 超时" } }));
  assert.deepEqual(events.at(-1), { event: "failed", detail: "LLM 超时" });
});

test("授权：asked → PermissionRequest；批准 → 继续；拒绝 → deny", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent({ type: "approval/asked", data: { toolName: "pwsh" } });
  assert.deepEqual(events.at(-1), { event: "PermissionRequest", detail: "pwsh" });
  state.onSessionEvent({ type: "approval/decided", data: { outcome: "allowed-once" } });
  assert.equal(events.at(-1).event, "agent_message");
  state.onSessionEvent({ type: "approval/asked", data: { toolName: "edit" } });
  state.onSessionEvent({ type: "approval/decided", data: { outcome: "rejected" } });
  assert.deepEqual(events.at(-1), { event: "deny", detail: "已拒绝授权" });
});

test("目标完成 + 静默去抖 → 触发 done（任务完成动画）", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("complete", { objective: "移植桌宠" }));
  assert.ok(!events.some((e) => e.event === "done"), "去抖窗口内不应触发完成");
  h.advance(8000);
  assert.deepEqual(events.at(-1), { event: "done", detail: "移植桌宠" });
});

test("目标完成后的收尾 turn/end 不取消完成信号", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  state.onSessionEvent(turnEnd("completed")); // goal 完成后的回合收尾
  state.onAgentStatus("agent-1", "idle");
  h.advance(8000);
  assert.deepEqual(events.at(-1), { event: "done", detail: "X" });
});

test("目标完成时 agent 仍在收尾 → 空闲后才确认完成", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onAgentStatus("agent-1", "running"); // 回合进行中
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  h.advance(8000);
  assert.ok(!events.some((e) => e.event === "done"), "agent 未空闲不应触发完成");
  state.onAgentStatus("agent-1", "idle"); // 收尾结束
  h.advance(8000);
  assert.deepEqual(events.at(-1), { event: "done", detail: "X" });
});

test("目标完成后轮次失败 → 取消完成并报错", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  state.onSessionEvent(turnEnd("error", { error: { message: "构建失败" } }));
  h.advance(8000);
  assert.ok(!events.some((e) => e.event === "done"));
  assert.equal(events.at(-1).event, "failed");
});

test("目标完成但窗口内出现新活动 → 取消完成", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  h.advance(3000);
  state.onSessionEvent(userMessage("等等，还有补充"));
  h.advance(8000);
  assert.ok(!events.some((e) => e.event === "done"), "新活动必须取消挂起的完成");
});

test("目标完成但子代理仍在运行 → 不触发完成", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  state.onAgentStatus("agent-1", "running"); // 子代理活动
  h.advance(8000);
  assert.ok(!events.some((e) => e.event === "done"));
});

test("目标受阻 → failed", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("block", { blockedReason: "同一阻塞持续 3 轮" }));
  assert.equal(events.at(-1).event, "failed");
});

test("agent/status idle（无 turn/end）→ 立即 AgentStop，不再等 90s 兜底", () => {
  // 新架构核心：运行门闩由 agent/status 直接开合——agent 一空闲，
  // 展示态立即收为等待输入，而不是靠 90s 空闲兜底（旧行为：永久 running）。
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "running");
  state.onAgentStatus("agent-1", "idle");
  assert.equal(events.at(-1).event, "AgentStop");
  h.advance(95_000);
  state.onTick();
  assert.ok(!events.some((e) => e.event === "idle"), "agent 已空闲，不应触发兜底");
});

test("门闩开着但事件流完全中断 → 90s 兜底回 idle", () => {
  // 兜底只负责极端防御：gate 开着（turn/start/user 信号兜底打开）且
  // 90s 无任何活动（agent/status 与 turn/end 都没到）→ 显式回 idle。
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始")); // 开 gate，但 agent/status 从未到达
  h.advance(95_000);
  state.onTick();
  assert.deepEqual(events.at(-1), { event: "idle", detail: "长时间无活动" });
});

test("多轮任务：轮次间不庆祝，新消息直接继续", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(userMessage("第一轮"));
  state.onAgentStatus("agent-1", "running");
  state.onSessionEvent(turnEnd("completed"));
  state.onAgentStatus("agent-1", "idle");
  assert.equal(events.at(-1).event, "AgentStop");
  state.onSessionEvent(userMessage("第二轮"));
  assert.equal(events.at(-1).event, "UserPromptSubmit");
  h.advance(20_000);
  assert.ok(!events.some((e) => e.event === "done"), "多轮任务中途绝不能出现完成动画");
});

test("多 agent：一个空闲不影响其他 agent 的运行状态", () => {
  const h = makeHarness();
  const { state } = h.makeState();
  state.onAgentStatus("agent-1", "running"); // 主 agent
  state.onAgentStatus("agent-2", "running"); // 子代理
  state.onAgentStatus("agent-1", "idle"); // 主 agent 空闲（等待子代理）
  assert.ok(state.anyRunning, "子代理仍在运行，anyRunning 必须为 true");
  state.onAgentStatus("agent-2", "idle");
  assert.ok(!state.anyRunning, "全部空闲后 anyRunning 为 false");
});

test("子代理长时间运行期间不触发空闲兜底（有活动事件）", () => {
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "running");
  state.onAgentStatus("agent-1", "idle"); // 主 agent 等待子代理
  state.onAgentStatus("agent-2", "running"); // 子代理在跑 → 门闩重开，展示回 running
  assert.equal(state.mode, "running", "子代理运行中展示态应回 running");
  for (let i = 0; i < 5; i++) {
    h.advance(20_000);
    state.onActivity("assistant/chunk"); // 子代理会话活动事件
    state.onTick();
  }
  assert.ok(!events.some((e) => e.event === "idle"), "子代理活动期间不应回 idle");
  // 子代理静默（事件流中断）且门闩仍开 → 兜底最终触发
  h.advance(95_000);
  state.onTick();
  assert.deepEqual(events.at(-1), { event: "idle", detail: "长时间无活动" });
});

test("长推理（assistant/chunk）持续刷新活动时间，不触发兜底", () => {
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onAgentStatus("agent-1", "running");
  state.onSessionEvent(userMessage("开始"));
  for (let i = 0; i < 5; i++) {
    h.advance(40_000);
    state.onSessionEvent({ type: "assistant/chunk", data: { chunk: {} } });
    state.onTick();
  }
  assert.ok(!events.some((e) => e.event === "idle"), "持续推理不应回 idle");
});

test("等待输入（waiting）不触发空闲兜底", () => {
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "running");
  state.onSessionEvent(turnEnd("completed")); // → waiting
  state.onAgentStatus("agent-1", "idle");
  h.advance(95_000);
  state.onTick();
  assert.ok(!events.some((e) => e.event === "idle"), "等待输入不应回 idle");
});

test("状态残留 running（无 idle 信号）且长时间无活动 → idle 兜底", () => {
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "running");
  // agent/status idle 事件丢失：门闩仍开、mode 仍 running，且无任何活动
  h.advance(95_000);
  state.onTick();
  assert.deepEqual(events.at(-1), { event: "idle", detail: "长时间无活动" });
});

test("todo 更新 → action 行", () => {
  const h = makeHarness();
  const { state, actions } = h.makeState();
  state.onSessionEvent({
    type: "todo/write",
    data: { todos: [{ content: "实现桥接插件", status: "in_progress" }] },
  });
  assert.deepEqual(actions.at(-1), { text: "实现桥接插件", status: "ok", kind: "action" });
});

test("活动心跳：running 期间发空事件保活桌宠端", () => {
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("长任务"));
  state.onAgentStatus("agent-1", "running");
  h.advance(30_000);
  state.heartbeat();
  assert.ok(events.some((e) => e.event === "agent_message" && e.detail === ""),
    "心跳应为空 detail 的 agent_message（不污染任务文本）");
});

test("心跳不刷新插件端计时器：卡 running + 心跳持续 → 90s 兜底仍触发", () => {
  // 核心回归：agent/status idle 事件丢失、anyRunning 卡 true 时，
  // 心跳只保活桌宠端，插件端 90s 兜底必须仍能触发，否则任务结束后永久 running。
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "running");
  // agent/status idle 事件丢失（anyRunning 卡 true），无任何会话活动，只有心跳
  for (let i = 0; i < 6; i++) {
    h.advance(20_000);
    state.heartbeat();
    state.onTick();
  }
  assert.ok(events.some((e) => e.event === "idle"), "卡 running 时必须能兜底回 idle");
});

test("agent 状态卡 running 但 30s 无任何活动 → 完成确认（done）", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onAgentStatus("agent-1", "running"); // 回合进行中（goal 前已在跑）
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  // agent/status idle 事件丢失，状态卡 running，且无任何会话活动
  h.advance(35_000);
  assert.deepEqual(events.at(-1), { event: "done", detail: "X" });
});

test("思考态：assistant/chunk 每段推理流只提示一次'正在思考'", () => {
  const h = makeHarness();
  const { state, actions } = h.makeState();
  state.onSessionEvent({ type: "assistant/chunk", data: { chunk: {} } });
  state.onSessionEvent({ type: "assistant/chunk", data: { chunk: {} } });
  state.onSessionEvent({ type: "assistant/chunk", data: { chunk: {} } });
  const thinking = actions.filter((a) => a.text === "正在思考");
  assert.equal(thinking.length, 1, "同段推理流只提示一次");
  // 工具调用后重新进入推理 → 再次提示
  state.onSessionEvent({ type: "tool/call", data: { name: "edit" } });
  state.onSessionEvent({ type: "assistant/chunk", data: { chunk: {} } });
  const thinking2 = actions.filter((a) => a.text === "正在思考");
  assert.equal(thinking2.length, 2, "工具后新推理流再次提示");
});

test("子代理活动事件（onActivity）保持运行且不产生桌宠事件", () => {
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "running");
  state.onAgentStatus("agent-1", "idle"); // 主 agent 等待子代理
  // 子代理会话活动事件（index.js 路由到 onActivity）
  for (let i = 0; i < 5; i++) {
    h.advance(20_000);
    state.onActivity("assistant/chunk");
    state.onTick();
  }
  assert.ok(!events.some((e) => e.event === "idle"), "子代理活动期间不应回 idle");
  const before = events.length;
  state.onActivity("turn/start");
  assert.equal(events.length, before, "onActivity 不产生桌宠事件");
});

test("回合开始/推理事件把 mode 置为 running（防残留导致兜底误判）", () => {
  const h = makeHarness();
  const { state } = h.makeState();
  state.onSessionEvent({ type: "turn/start", data: { turn: 1 } });
  assert.equal(state.mode, "running");
  state.onSessionEvent({ type: "assistant/chunk", data: { chunk: {} } });
  assert.equal(state.mode, "running");
  state.onSessionEvent(turnEnd("completed"));
  assert.equal(state.mode, "waiting");
  // 收尾残留推理事件不应把 waiting 拉回 running（否则空闲兜底会误伤等待中的桌宠）
  state.onSessionEvent({ type: "assistant/chunk", data: { chunk: {} } });
  assert.equal(state.mode, "waiting");
  // 新一轮开始 → running
  state.onSessionEvent(userMessage("继续"));
  assert.equal(state.mode, "running");
});

test("兜底触发时输出日志（onLog）", () => {
  const h = makeHarness();
  const logs = [];
  const { state, events } = h.makeState({
    idleMs: 90000,
    onLog: (msg) => logs.push(msg),
  });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "running"); // idle 事件丢失：门闩残留打开
  h.advance(95_000);
  state.onTick();
  assert.equal(events.at(-1).event, "idle");
  assert.ok(logs.some((l) => l.includes("空闲兜底触发")), `日志应有兜底记录: ${logs.join("|")}`);
});

test("模型完整回复 → AI 总结（kind=summary，20 字截断）", () => {
  const h = makeHarness();
  const { state, actions } = h.makeState();
  state.onSessionEvent({
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "这个任务已经全部完成了，共修改了十二个文件并且通过了所有测试。" }] } },
  });
  const last = actions.at(-1);
  assert.equal(last.status, "ok");
  assert.equal(last.kind, "summary");
  assert.ok(last.text.length <= 23, `总结应截断到 20 字左右: ${last.text}`);
  assert.ok(last.text.endsWith("…") || last.text.endsWith("..."));
});

test("assistant/message 无文本（纯工具回合）不发总结", () => {
  const h = makeHarness();
  const { state, actions } = h.makeState();
  const before = actions.length;
  state.onSessionEvent({
    type: "assistant/message",
    data: { message: { content: [{ type: "reasoning", text: "思考..." }] } },
  });
  assert.equal(actions.length, before, "无文本不应发总结");
});

test("新指令：user/message 发'收到指令'动作行（原版语义）", () => {
  const h = makeHarness();
  const { state, actions } = h.makeState();
  state.onSessionEvent(userMessage("开始"));
  assert.deepEqual(actions.at(-1), { text: "收到指令", status: "ok", kind: "action" });
});

test("工具调用动作行为 kind=action（不锁定总结）", () => {
  const h = makeHarness();
  const { state, actions } = h.makeState();
  state.onSessionEvent({ type: "tool/call", data: { name: "edit" } });
  assert.deepEqual(actions.at(-1), { text: "调用 edit", status: "ok", kind: "action" });
});

test("dispose 清理挂起完成信号", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  state.dispose();
  h.advance(8000);
  assert.ok(!events.some((e) => e.event === "done"));
});

test("快照：onTick 输出内部状态（mode/运行集合/历史）", () => {
  const h = makeHarness();
  const snaps = [];
  const { state } = h.makeState({ onSnapshot: (s) => snaps.push(s) });
  // 初始 tick：idle
  state.onTick();
  assert.equal(snaps.at(-1).mode, "idle");
  // 运行一段：工具调用 → running + history 记录
  state.onSessionEvent({ type: "tool/call", data: { name: "edit" } });
  state.onTick();
  const snap = snaps.at(-1);
  assert.equal(snap.mode, "running");
  assert.ok(!snap.anyRunning, "无 agent/status 时 anyRunning 应为 false");
  assert.ok(Array.isArray(snap.runningAgents) && snap.runningAgents.length === 0);
  assert.ok(snap.history.some((e) => e.kind === "event" && e.name === "PreToolUse"));
  assert.ok(snap.history.some((e) => e.kind === "action" && e.text === "调用 edit"));
  assert.equal(snap.pendingComplete, false);
});

test("快照：agent/status 进入 runningAgents；完成挂起可见", () => {
  const h = makeHarness();
  const snaps = [];
  const { state } = h.makeState({ onSnapshot: (s) => snaps.push(s) });
  state.onAgentStatus("agent-1", "running");
  state.onTick();
  const snap = snaps.at(-1);
  assert.ok(snap.anyRunning);
  assert.deepEqual(snap.runningAgents, ["agent-1"]);
  assert.equal(snap.gateRunning, true);
  assert.equal(snap.gateSource, "agent/status");
  state.onAgentStatus("agent-1", "idle");
  state.onTick();
  assert.equal(snaps.at(-1).gateRunning, false);
  assert.equal(snaps.at(-1).gateSource, "agent/status");
  // 完成挂起（agent 重新运行，未空闲）
  state.onAgentStatus("agent-1", "running");
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  state.onTick();
  assert.equal(snaps.at(-1).pendingComplete, true);
  // agent 仍在 running：窗口到点后条件不满足，会重新挂起（不完成）
  h.advance(8000);
  state.onTick();
  assert.equal(snaps.at(-1).pendingComplete, true, "agent 未空闲时继续等待");
  // agent 空闲后窗口到点 → 完成
  state.onAgentStatus("agent-1", "idle");
  h.advance(8000);
  state.onTick(); // 快照只在 tick 输出
  assert.equal(snaps.at(-1).pendingComplete, false);
  assert.equal(snaps.at(-1).mode, "waiting");
});

test("快照：历史环形缓冲上限", () => {
  const h = makeHarness();
  const { state } = h.makeState();
  for (let i = 0; i < 60; i++) {
    state.onSessionEvent({ type: "tool/call", data: { name: `t${i}` } });
  }
  assert.ok(state.history.length <= 40, `history 应 ≤40，实际 ${state.history.length}`);
  assert.equal(state.snapshot().history.length, 20, "快照只带最近 20 条");
});

test("agents 轮询：running 补入（事件丢失兜底）", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  // 事件从未到达，轮询先发现 agent running
  state.onAgentsSnapshot([{ id: "agent-1", status: "running" }]);
  assert.ok(state.anyRunning, "轮询补入 running agent");
  assert.equal(events.at(-1).event, "AgentStart");
  assert.equal(state.gateSource, "poll");
  // 轮询再次运行：幂等（不重复 AgentStart）
  const before = events.length;
  state.onAgentsSnapshot([{ id: "agent-1", status: "running" }]);
  assert.equal(events.length, before, "重复轮询不产生重复事件");
});

test("agents 轮询：idle 校正（卡 running 兜底）", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onAgentStatus("agent-1", "running"); // 事件说 running（idle 事件丢失）
  assert.ok(state.anyRunning);
  // 轮询发现其实已 idle → 校正移除
  state.onAgentsSnapshot([{ id: "agent-1", status: "idle" }]);
  assert.ok(!state.anyRunning, "轮询校正移除卡住的 running agent");
  assert.equal(events.at(-1).event, "AgentStop", "门闩关闭收为等待");
});

test("agents 轮询：消失的 agent 被移除", () => {
  const h = makeHarness();
  const { state } = h.makeState();
  state.onAgentStatus("agent-1", "running");
  state.onAgentsSnapshot([]); // 轮询列表为空
  assert.ok(!state.anyRunning);
});

test("agents 轮询：与事件状态一致时无副作用", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onAgentStatus("agent-1", "running");
  const before = events.length;
  state.onAgentsSnapshot([{ id: "agent-1", status: "running" }]);
  assert.equal(events.length, before);
  assert.ok(state.anyRunning);
});

test("顶层 agent 集合：setRootAgents + isRootSessionId", () => {
  const h = makeHarness();
  const { state } = h.makeState();
  state.setRootAgents(["session-root-1", "session-root-2", null]);
  assert.ok(state.isRootSessionId("session-root-1"));
  assert.ok(state.isRootSessionId("session-root-2"));
  assert.ok(!state.isRootSessionId("session-child-9"), "子代理会话不是顶层");
  assert.ok(!state.isRootSessionId("不存在的"), "未知会话不是顶层");
  // 空列表清空集合
  state.setRootAgents([]);
  assert.ok(!state.isRootSessionId("session-root-1"));
  // 快照可见
  state.setRootAgents(["session-root-1"]);
  assert.deepEqual(state.snapshot().rootAgentIds, ["session-root-1"]);
});
