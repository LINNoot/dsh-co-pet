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
        onAction: (text, status) => actions.push({ text, status }),
        ...overrides,
      });
      return { state, events, actions };
    },
  };
}

const userMessage = (text) => ({
  type: "user/message",
  data: { message: { source: { kind: "user" }, content: [{ type: "text", text }] } },
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

test("轮次结束（completed）→ 只进等待态，绝不触发完成", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(turnEnd("completed"));
  assert.equal(events.at(-1).event, "AgentStop");
  assert.ok(!events.some((e) => e.event === "done" || e.event === "waving"));
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

test("长时间无活动 → idle 兜底", () => {
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "idle");
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

test("子代理长时间运行期间不触发空闲兜底", () => {
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "running");
  state.onAgentStatus("agent-1", "idle"); // 主 agent 等待子代理
  state.onAgentStatus("agent-2", "running"); // 子代理在跑
  h.advance(95_000);
  state.onTick();
  assert.ok(!events.some((e) => e.event === "idle"), "子代理运行中不应回 idle");
  state.onAgentStatus("agent-2", "idle");
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

test("状态残留 running 且长时间无任何活动 → idle 兜底", () => {
  const h = makeHarness();
  const { state, events } = h.makeState({ idleMs: 90000 });
  state.onSessionEvent(userMessage("开始"));
  state.onAgentStatus("agent-1", "running");
  state.onAgentStatus("agent-1", "idle"); // 事件流中断，mode 残留 running
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
  assert.deepEqual(actions.at(-1), { text: "实现桥接插件", status: "ok" });
});

test("dispose 清理挂起完成信号", () => {
  const h = makeHarness();
  const { state, events } = h.makeState();
  state.onSessionEvent(goalChange("complete", { objective: "X" }));
  state.dispose();
  h.advance(8000);
  assert.ok(!events.some((e) => e.event === "done"));
});
