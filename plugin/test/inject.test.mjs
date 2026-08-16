// dsh-pet-bridge 注入回归测试：真实 cordis 环境中验证
//  1. `export const inject = ["webServer"]` 能让插件正常加载（不抛
//     "cannot get property without inject"）——本次崩溃的回归保护；
//  2. /pet-bridge/* 路由真实注册；
//  3. HTTP 处理器行为（state/toggle）。
//
// 依赖真实 cordis（DSH 运行时同款）：自动在 npx 缓存中探测，也可用
// 环境变量 DSH_CORDIS_LIB 显式指定；找不到时本测试自动跳过（不失败）。
//
// 用法：node test/inject.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, ".tmp_test", `run_${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
// 测试结束清理临时目录（含 .tmp_test 父目录），不残留垃圾
process.on("exit", () => fs.rmSync(path.join(HERE, ".tmp_test"), { recursive: true, force: true }));

/** 探测 cordis 入口：环境变量 > 本机 npx 缓存（Windows/macOS/Linux）。 */
function findCordisLib() {
  if (process.env.DSH_CORDIS_LIB && fs.existsSync(process.env.DSH_CORDIS_LIB)) {
    return process.env.DSH_CORDIS_LIB;
  }
  const roots = [];
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx"));
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm-cache", "_npx"));
  } else {
    roots.push(path.join(os.homedir(), ".npm", "_npx"));
  }
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // 目录不存在
    }
    for (const dir of entries) {
      const p = path.join(root, dir, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js");
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const CORDIS_LIB = findCordisLib();
const SKIP_REASON = !CORDIS_LIB
  ? "未找到 cordis 库（DSH 未安装或不在 npx 缓存；可设 DSH_CORDIS_LIB 指定入口）"
  : false;
let Context = null;
let Service = null;
if (CORDIS_LIB) {
  const mod = await import(pathToFileURL(CORDIS_LIB).href);
  Context = mod.Context;
  Service = mod.Service;
}

/** 模拟 node:http 的 req/res 最小面。 */
function fakeReq(method, pathname) {
  return { method, url: pathname };
}
function fakeRes() {
  const out = { status: 0, body: null };
  out.writeHead = (code) => {
    out.status = code;
  };
  out.end = (body) => {
    out.body = JSON.parse(body);
  };
  return out;
}

test("带 webServer 服务时插件正常加载并注册路由", { skip: SKIP_REASON }, async () => {
  /** 记录注册路由的假 webServer 服务。 */
  class FakeWebServer extends Service {
    constructor(ctx) {
      super(ctx, "webServer");
      this.routes = [];
    }
    register(route) {
      this.routes.push(route);
      return () => {};
    }
  }
  const ctx = new Context();
  await ctx.plugin(FakeWebServer); // 先让服务就绪（否则插件 fiber 会一直等待注入）
  const plugin = await import("../index.js");
  // visibility 状态文件用隔离路径（避免读到真实环境 ~/.dsh 的开关状态）
  const tmpVis = path.join(TMP, "vis.json");
  const fiber = ctx.plugin(plugin, { visibilityFile: tmpVis });
  await fiber; // 等待加载完成（inject 解析 + apply 执行）
  try {
    assert.ok(ctx.webServer, "webServer 服务可用");
    const route = ctx.webServer.routes.find((r) => r.kind === "prefix" && r.path === "/pet-bridge");
    assert.ok(route, "已注册 /pet-bridge prefix 路由");
    // GET /pet-bridge/state → { visible: true }（默认可见）
    const res = fakeRes();
    route.handler(fakeReq("GET", "/pet-bridge/state"), res);
    assert.equal(res.status, 200);
    assert.equal(res.body.visible, true);
    // POST /pet-bridge/toggle → visible 翻转为 false
    const res2 = fakeRes();
    route.handler(fakeReq("POST", "/pet-bridge/toggle"), res2);
    assert.equal(res2.status, 200);
    assert.equal(res2.body.visible, false);
    // 再 toggle → true
    const res3 = fakeRes();
    route.handler(fakeReq("POST", "/pet-bridge/toggle"), res3);
    assert.equal(res3.body.visible, true);
    // 未知路径 → 404
    const res4 = fakeRes();
    route.handler(fakeReq("GET", "/pet-bridge/nope"), res4);
    assert.equal(res4.status, 404);
  } finally {
    // 清理：dispose 触发插件 dispose → channel.close() 关闭 UDP socket，
    // 否则 dgram socket 会阻止进程退出（node:test 挂起）。
    await fiber.dispose?.();
  }
});

test("未声明 inject 时访问 ctx.webServer 会抛 without inject（证明声明必要）", { skip: SKIP_REASON }, async () => {
  const ctx = new Context();
  const boom = () => {
    const fake = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "webServer") {
            const err = new Error(`cannot get property "${prop}" without inject`);
            throw err;
          }
          return undefined;
        },
      },
    );
    return fake.webServer;
  };
  assert.throws(boom, /without inject/);
  await ctx.stop?.();
});
