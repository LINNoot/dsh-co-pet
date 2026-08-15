# -*- coding: utf-8 -*-
"""桌宠监听器 + 加载器冒烟测试（无 GUI，offscreen）。

用法：
    .venv\\Scripts\\python.exe pet\\test_smoke.py
"""
import json
import os
import shutil
import socket
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QCoreApplication, QTimer  # noqa: E402

from pet_loader import scan_pets  # noqa: E402
from state_listener import StateListener  # noqa: E402

HERE = Path(__file__).resolve().parent

FAILURES = []


def check(name, cond, extra=""):
    mark = "PASS" if cond else "FAIL"
    print(f"[{mark}] {name} {extra}")
    if not cond:
        FAILURES.append(name)


def send_udp(port, event, detail="", status=None, kind=None):
    payload = {"src": "dsh-pet-bridge", "event": event, "detail": detail}
    if status is not None:
        payload["status"] = status
    if kind is not None:
        payload["kind"] = kind
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(json.dumps(payload).encode("utf-8"), ("127.0.0.1", port))
    s.close()


def send_udp_legacy(port, event, detail=""):
    """模拟旧 Codex hook_notify 报文（无 src 标记）——必须被忽略。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(json.dumps({"event": event, "detail": detail}).encode("utf-8"), ("127.0.0.1", port))
    s.close()


def main():
    # ---------- pet_loader ----------
    pets = scan_pets([HERE])
    check("scan_pets 找到 yuexinmiao", any(p.name == "yuexinmiao-mix" for p in pets))
    pet = next((p for p in pets if p.name == "yuexinmiao-mix"), None)
    if pet is not None:
        check("精灵图 9 行 v1", pet.cell_h > 0 and len(pet.rows) == 9)
        check("idle 帧数 > 0", len(pet.frames.get("idle", [])) > 0)
        for state in ("running", "review", "waiting", "failed", "jumping", "waving"):
            check(f"状态 {state} 有帧", len(pet.frames.get(state, [])) > 0)

    # ---------- state_listener ----------
    # 沙箱环境下 tempfile.TemporaryDirectory 的权限重置逻辑会被拒，
    # 手动建目录（直接 mkdir 已验证可行）
    tmp = HERE / ".tmp_test" / f"run_{os.getpid()}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        _run_listener(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项: {FAILURES}")
        return 1
    print("全部通过")
    return 0


def _run_listener(tmp):
    app = QCoreApplication(sys.argv)
    port = 47991
    state_file = tmp / "dsh-pet-state.json"
    listener = StateListener(port=port, state_file=state_file)

    events = []

    def on_state(state, detail, source):
        events.append(("state", state, detail, source))

    def on_action(text, status, kind):
        events.append(("action", text, status, kind))

    listener.state_changed.connect(on_state)
    listener.action_changed.connect(on_action)

    def run():
        send_udp(port, "SessionStart")
        send_udp(port, "UserPromptSubmit", "帮我移植桌宠")
        send_udp(port, "PreToolUse", "调用工具 edit")
        send_udp(port, "patch_apply", "已修改 2 个文件")
        send_udp(port, "AgentStop", "等待你的输入")
        send_udp(port, "PermissionRequest", "pwsh")
        send_udp(port, "done", "目标完成")
        # 未知事件必须被忽略（不产生任何状态变更）
        send_udp(port, "TotallyUnknown", "x")
        # 旧 Codex hook_notify 报文（无 src）必须被忽略——防污染
        send_udp_legacy(port, "SessionStart")
        send_udp_legacy(port, "Stop", "旧 Codex 事件")
        # action 事件走 action_changed（动作行）
        send_udp(port, "action", "正在重构模块", status="ok", kind="action")
        # AI 总结（kind=summary）
        send_udp(port, "action", "全部完成，共修改 12 个文件", status="ok", kind="summary")
        # 新指令重置（空 action 行）
        send_udp(port, "action", " ", status="ok", kind="action")
        # 状态文件通道
        state_file.write_text(json.dumps({"event": "failed", "detail": "LLM 超时"}), encoding="utf-8")

    QTimer.singleShot(300, run)
    QTimer.singleShot(2600, app.quit)
    app.exec()
    listener.close()

    states = [e for e in events if e[0] == "state"]
    actions = [e for e in events if e[0] == "action"]

    def has_state(s, detail=None, source=None):
        for e in states:
            if e[1] == s and (detail is None or e[2] == detail) and (source is None or e[3] == source):
                return True
        return False

    check("SessionStart → idle(session)", has_state("idle", source="session"))
    check("UserPromptSubmit → running(user)", has_state("running", "帮我移植桌宠", "user"))
    check("PreToolUse → running(activity)", has_state("running", "调用工具 edit", "activity"))
    check("patch_apply → review(review)", has_state("review", "已修改 2 个文件", "review"))
    check("AgentStop → waiting(activity)", has_state("waiting", "等待你的输入", "activity"))
    check("PermissionRequest → jumping(once:waiting)", has_state("jumping", "once:waiting", "activity"))
    check("done → waving(once:waiting,complete)", has_state("waving", "once:waiting", "complete"))
    check("未知事件被忽略", not has_state("idle", "x"))
    # 精确校验：旧 Codex 报文（无 src）不产生任何状态（状态数仍为 8）
    check("旧 Codex 报文不增加状态", len(states) == 8, f"({len(states)})")
    check("action → action_changed", any(a[1] == "正在重构模块" and a[2] == "ok" and a[3] == "action" for a in actions))
    check("summary → action_changed(kind=summary)", any(a[1] == "全部完成，共修改 12 个文件" and a[3] == "summary" for a in actions))
    check("新指令重置 → 空 action 行", any(a[1] == " " and a[3] == "action" for a in actions))
    check("状态文件通道 → failed", has_state("failed", "once:idle", "error"))


if __name__ == "__main__":
    sys.exit(main())
