// dsh-pet-bridge — 桌宠开关控制（纯逻辑 + 文件持久化，可单测）。
//
// 语义：开启 = 桌宠进程运行；关闭 = 桌宠进程退出（发 pet/quit 事件，
// 桌宠应用收到后自行退出）。持久化到 ~/.dsh/dsh-pet-visibility.json
// （字段 enabled；兼容读取旧字段 visible），DSH 重启后恢复上次意图。
//
// 供 Web GUI 开关按钮（plugin/client.js → /pet-bridge/*）调用。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class PetVisibility {
  /**
   * @param {object} opts
   * @param {string} [opts.file] 状态文件路径（默认 ~/.dsh/dsh-pet-visibility.json）
   * @param {object} opts.channel PetChannel（send(event, detail)）
   * @param {() => object | null} [opts.spawn] 启动桌宠进程，返回子进程句柄或 null
   * @param {(msg: string) => void} [opts.onLog]
   */
  constructor({ file, channel, spawn = () => null, onLog = () => {} }) {
    this.file = file ?? path.join(os.homedir(), ".dsh", "dsh-pet-visibility.json");
    this.channel = channel;
    this.spawn = spawn;
    this.onLog = onLog;
    this.enabled = true; // 默认开启
  }

  /** 启动时读取持久化意图（文件缺失/损坏 → 开启）。 */
  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof data.enabled === "boolean") {
        this.enabled = data.enabled;
      } else if (typeof data.visible === "boolean") {
        // 兼容旧版本字段（visible=false 即关闭）
        this.enabled = data.visible;
      }
    } catch {
      // 首次运行或文件损坏：保持默认开启
    }
    return this.enabled;
  }

  /** 当前是否开启（桌宠应运行）。 */
  current() {
    return this.enabled;
  }

  _persist() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ enabled: this.enabled, updatedAt: Date.now() }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.onLog(`开关状态持久化失败: ${err.message}`);
    }
  }

  /**
   * 设置开关状态。
   * @param {boolean} on true=启动桌宠进程；false=通知桌宠退出
   */
  setEnabled(on) {
    this.enabled = Boolean(on);
    this._persist();
    if (this.enabled) {
      this.spawn();
      this.onLog("桌宠 → 开启");
    } else {
      // 桌宠自行退出（pet/quit）；插件 spawn 的实例由 index.js 的
      // exit 监听兜底 kill（若未及时退出）。
      this.channel.send("pet/quit", "");
      // 关键：紧接着用无害事件覆盖状态文件——否则下次启动桌宠时，
      // 第一次文件轮询会读到残留的 pet/quit 而立即退出（"闪一下就
      // 没了"）。注意覆盖事件必须是词汇表里的空闲态事件（SessionStart
      // → idle）；agent_message 在桌宠词汇表里是 running，会让下次
      // 启动的桌宠"莫名其妙进入 running"。
      this.channel.send("SessionStart", "DSH 已启动");
      this.onLog("桌宠 → 关闭");
    }
    return this.enabled;
  }

  /** 切换开关状态，返回新状态。 */
  toggle() {
    return this.setEnabled(!this.enabled);
  }

  /**
   * 桌宠进程退出回调（index.js 挂到 spawn 的子进程 exit 事件）：
   * 若此时开关仍为开（用户手动退出 / 进程崩溃），自动置为关，
   * 保证 GUI 按钮反映真实状态。
   */
  onPetExited() {
    if (this.enabled) {
      this.enabled = false;
      this._persist();
      this.onLog("桌宠进程已退出（非主动关闭），开关状态同步为关闭");
    }
  }
}
