// 端到端冒烟：用插件真实输出通道（PetChannel）向桌宠推送完整事件序列。
// 用法：node scripts/e2e_feed.mjs
import { PetChannel } from "../plugin/channel.js";

const channel = new PetChannel({ port: 47993, stateFile: process.env.TEMP + "\\dsh-pet-e2e-state.json" });

const sequence = [
  ["SessionStart", "DSH 已启动"],
  ["UserPromptSubmit", "帮我移植桌宠到 DSH"],
  ["action", "正在分析代码结构"],
  ["PreToolUse", "调用工具 read"],
  ["PostToolUse", "工具 read 完成"],
  ["PreToolUse", "调用工具 edit"],
  ["patch_apply", "已修改 2 个文件"],
  ["AgentStop", "等待你的输入"],
  ["UserPromptSubmit", "继续完成剩余部分"],
  ["PermissionRequest", "pwsh"],
  ["agent_message", "已授权，继续执行"],
  ["PreToolUse", "调用工具 pwsh"],
  ["PostToolUse", "工具 pwsh 完成"],
  ["done", "移植桌宠"],
  ["AgentStop", "等待你的输入"],
];

let i = 0;
const timer = setInterval(() => {
  if (i >= sequence.length) {
    clearInterval(timer);
    channel.close();
    console.log("E2E 事件序列发送完毕");
    return;
  }
  const [event, detail] = sequence[i++];
  channel.send(event, detail);
}, 250);
