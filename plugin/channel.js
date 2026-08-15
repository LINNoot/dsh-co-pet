// dsh-pet-bridge — 输出通道：UDP 报文 + 原子写状态文件（与桌宠协议一致）。
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class PetChannel {
  /**
   * @param {object} opts
   * @param {number} [opts.port=47890] 桌宠 UDP 监听端口（pet_config.json 的 port）
   * @param {string} [opts.stateFile] 状态文件路径（默认 ~/.dsh/dsh-pet-state.json）
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this.port = opts.port ?? 47890;
    this.stateFile = expandHome(
      opts.stateFile ?? path.join(os.homedir(), ".dsh", "dsh-pet-state.json"),
    );
    this.logger = opts.logger ?? console;
    this.socket = dgram.createSocket("udp4");
    // 桌宠未启动时 UDP 发送会触发 ECONNREFUSED（Windows 上为异步错误），忽略
    this.socket.on("error", () => {});
  }

  /**
   * 推送一个事件给桌宠。
   * @param {string} event 事件名（桌宠词汇表内，如 UserPromptSubmit / PreToolUse / done）
   * @param {string} detail 详情文本（气泡标题/短语）
   * @param {string} [status] 可选：action 行的状态（ok/warn/error），仅 event==='action' 使用
   */
  send(event, detail = "", status = "ok") {
    const message = JSON.stringify(
      status === "ok" ? { event, detail } : { event, detail, status },
    );
    const buf = Buffer.from(message, "utf-8");
    try {
      this.socket.send(buf, this.port, "127.0.0.1");
    } catch {
      // 忽略发送失败（桌宠未运行）
    }
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, message, "utf-8");
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      this.logger.warn?.(`[dsh-pet-bridge] 状态文件写入失败: ${err.message}`);
    }
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // 忽略
    }
  }
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
