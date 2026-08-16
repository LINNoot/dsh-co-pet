// dsh-pet-bridge 开关控制单测：node test/visibility.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PetVisibility } from "../visibility.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, ".tmp_test", `run_${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

function makeVis({ file, initial, spawn } = {}) {
  const sent = [];
  const logs = [];
  const spawned = [];
  const vis = new PetVisibility({
    file: file ?? path.join(TMP, "visibility.json"),
    channel: { send: (event, detail) => sent.push({ event, detail }) },
    spawn: spawn ?? (() => {
      spawned.push(1);
      return {};
    }),
    onLog: (m) => logs.push(m),
  });
  if (initial !== undefined) vis.enabled = initial;
  return { vis, sent, logs, spawned };
}

test("默认开启；load 时文件缺失保持开启", () => {
  const { vis } = makeVis({ file: path.join(TMP, "missing.json") });
  assert.equal(vis.load(), true);
  assert.equal(vis.current(), true);
});

test("setEnabled(true) → 持久化 + 启动桌宠进程", () => {
  const file = path.join(TMP, "a.json");
  const { vis, spawned } = makeVis({ file });
  vis.load();
  vis.setEnabled(true);
  assert.equal(spawned.length, 1, "开启应调用 spawn 启动桌宠");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.enabled, true);
});

test("setEnabled(false) → 持久化 + 发送 pet/quit（桌宠自行退出）", () => {
  const file = path.join(TMP, "b.json");
  const { vis, sent, spawned } = makeVis({ file, initial: true });
  vis.setEnabled(false);
  assert.deepEqual(sent.at(-1), { event: "pet/quit", detail: "" });
  assert.equal(spawned.length, 0, "关闭不应 spawn");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.enabled, false);
});

test("toggle 切换：true → false（quit）→ true（spawn）", () => {
  const file = path.join(TMP, "c.json");
  const { vis, sent, spawned } = makeVis({ file, initial: true });
  vis.toggle();
  assert.equal(vis.current(), false);
  assert.equal(sent.at(-1).event, "pet/quit");
  // toggle 到关闭后，新实例读同一文件应恢复"关闭"
  const visMid = new PetVisibility({ file, channel: { send: () => {} } });
  assert.equal(visMid.load(), false);
  vis.toggle();
  assert.equal(vis.current(), true);
  assert.equal(spawned.length, 1);
  // 最终状态开启：新实例恢复"开启"
  const vis2 = new PetVisibility({ file, channel: { send: () => {} } });
  assert.equal(vis2.load(), true);
});

test("onPetExited：开启中进程退出（手动退出/崩溃）→ 自动置为关闭", () => {
  const file = path.join(TMP, "d.json");
  const { vis } = makeVis({ file, initial: true });
  vis.onPetExited();
  assert.equal(vis.current(), false);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.enabled, false);
});

test("onPetExited：已关闭时进程退出 → 状态不变（幂等）", () => {
  const file = path.join(TMP, "e.json");
  const { vis } = makeVis({ file, initial: false });
  vis.onPetExited();
  assert.equal(vis.current(), false);
});

test("兼容旧字段 visible=false → 关闭", () => {
  const file = path.join(TMP, "f.json");
  fs.writeFileSync(file, JSON.stringify({ visible: false }), "utf8");
  const { vis } = makeVis({ file });
  assert.equal(vis.load(), false);
});

test("损坏文件 → 默认开启", () => {
  const file = path.join(TMP, "bad.json");
  fs.writeFileSync(file, "{not json", "utf8");
  const { vis } = makeVis({ file });
  assert.equal(vis.load(), true);
});
