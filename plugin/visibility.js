// dsh-pet-bridge — 桌宠可见性控制（纯逻辑 + 文件持久化，可单测）。
//
// 供 Web GUI 开关按钮（plugin/client.js → /pet-bridge/*）与未来其它入口调用：
// 记录桌宠窗口的显示/隐藏状态，持久化到 ~/.dsh/dsh-pet-visibility.json，
// 并通过 PetChannel 发送 pet/visibility 事件（UDP + 状态文件双通道）
// 通知桌宠应用执行 show/hide。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class PetVisibility {
  /**
   * @param {object} opts
   * @param {string} [opts.file] 状态文件路径（默认 ~/.dsh/dsh-pet-visibility.json）
   * @param {object} opts.channel PetChannel（send(event, detail)）
   * @param {(msg: string) => void} [opts.onLog]
   */
  constructor({ file, channel, onLog = () => {} }) {
    this.file = file ?? path.join(os.homedir(), ".dsh", "dsh-pet-visibility.json");
    this.channel = channel;
    this.onLog = onLog;
    this.visible = true; // 默认可见
  }

  /** 启动时读取持久化状态（文件缺失/损坏 → 可见）。 */
  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof data.visible === "boolean") {
        this.visible = data.visible;
      }
    } catch {
      // 首次运行或文件损坏：保持默认可见
    }
    return this.visible;
  }

  /** 当前可见性。 */
  current() {
    return this.visible;
  }

  _persist() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ visible: this.visible, updatedAt: Date.now() }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.onLog(`可见性持久化失败: ${err.message}`);
    }
  }

  /** 设置可见性：持久化 + 通知桌宠。幂等（重复设置仍会重发，保证送达）。 */
  setVisible(visible) {
    this.visible = Boolean(visible);
    this._persist();
    this.channel.send("pet/visibility", this.visible ? "show" : "hide");
    this.onLog(`桌宠可见性 → ${this.visible ? "显示" : "隐藏"}`);
    return this.visible;
  }

  /** 切换可见性，返回新状态。 */
  toggle() {
    return this.setVisible(!this.visible);
  }
}
