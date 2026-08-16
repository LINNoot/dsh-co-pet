// dsh-pet-bridge 可见性控制单测：node test/visibility.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PetVisibility } from "../visibility.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, ".tmp_test", `run_${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

function makeVis({ file, initial } = {}) {
  const sent = [];
  const logs = [];
  const vis = new PetVisibility({
    file: file ?? path.join(TMP, "visibility.json"),
    channel: { send: (event, detail) => sent.push({ event, detail }) },
    onLog: (m) => logs.push(m),
  });
  if (initial !== undefined) vis.visible = initial;
  return { vis, sent, logs };
}

test("默认可见；load 时文件缺失保持可见", () => {
  const { vis } = makeVis({ file: path.join(TMP, "missing.json") });
  assert.equal(vis.load(), true);
  assert.equal(vis.current(), true);
});

test("setVisible(true) → 持久化 + 发送 show", () => {
  const file = path.join(TMP, "a.json");
  const { vis, sent } = makeVis({ file });
  vis.load();
  vis.setVisible(true);
  assert.deepEqual(sent.at(-1), { event: "pet/visibility", detail: "show" });
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.visible, true);
});

test("toggle 切换并发送 hide；再次 load 恢复持久化状态", () => {
  const file = path.join(TMP, "b.json");
  const { vis, sent } = makeVis({ file });
  vis.load();
  const after = vis.toggle();
  assert.equal(after, false);
  assert.deepEqual(sent.at(-1), { event: "pet/visibility", detail: "hide" });
  // 新实例读同一文件：恢复隐藏
  const vis2 = new PetVisibility({
    file,
    channel: { send: () => {} },
  });
  assert.equal(vis2.load(), false);
});

test("toggle 往返：false → true", () => {
  const { vis } = makeVis({ initial: false });
  assert.equal(vis.toggle(), true);
  assert.equal(vis.current(), true);
});

test("损坏文件 → 默认可见", () => {
  const file = path.join(TMP, "bad.json");
  fs.writeFileSync(file, "{not json", "utf8");
  const { vis } = makeVis({ file });
  assert.equal(vis.load(), true);
});
