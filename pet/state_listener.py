# -*- coding: utf-8 -*-
"""DSH 桌宠 — 状态监听器（DSH 版）。

接收 DSH 插件（dsh-pet-bridge）推送的状态事件，双通道：

1. UDP：插件向 ``127.0.0.1:<port>`` 发送 JSON ``{"event": ..., "detail": ...}``；
2. 状态文件：插件原子写入 ``<state_file>``（默认 ``~/.dsh/dsh-pet-state.json``），
   本模块按 ``(mtime_ns, size)`` 签名轮询（300ms）。

事件名不区分大小写。状态机将事件映射为动画状态并发出
``state_changed(state, detail, source)`` / ``action_changed(text, status)`` 信号。

与 Codex 版相比的修复：
- ``agentstop`` 进入等待态而非被当作未知事件打回 idle；
- 未知事件不再重置为 idle（忽略并记录），避免误伤；
- 移除 Codex rollout JSONL 监听通道（DSH 会话日志为 zstd 压缩，且插件在
  进程内订阅事件，不再需要文件轮询兜底）；
- ``patch_apply`` 真正触发 review 状态。
"""
from __future__ import annotations

import json
import os
import socket
import time
from pathlib import Path

from PySide6.QtCore import QObject, QTimer, Signal

DEFAULT_PORT = 47890
STATE_FILE = Path(os.path.expanduser("~")) / ".dsh" / "dsh-pet-state.json"
# 空闲兜底：插件每 30s 发送活动心跳刷新本计时器，此处留足余量
# （原版靠 rollout 高频事件保活；DSH 插件的心跳是其等价物）
IDLE_TIMEOUT_SECONDS = 120.0


def _log(message: str):
    """无控制台环境（pythonw）下安全地输出日志。"""
    import sys

    stream = sys.stderr or sys.stdout
    if stream is None:
        return
    try:
        print(f"[dsh-pet] {message}", file=stream)
    except Exception:
        pass


class StateListener(QObject):
    """监听 DSH 插件推送的事件，转换为桌宠状态。"""

    state_changed = Signal(str, str, str)  # (state, detail, source)
    action_changed = Signal(str, str)  # (text, status)

    def __init__(
        self,
        port: int = DEFAULT_PORT,
        state_file=STATE_FILE,
        parent=None,
    ):
        super().__init__(parent)
        self._port = port
        self._state_file = Path(state_file)
        self._mode = "idle"
        self._last_file_signature = None
        self._last_activity = time.monotonic()

        self._udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._udp.bind(("127.0.0.1", port))
        self._udp.setblocking(False)

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._poll)
        self._timer.start(300)

        self._idle_timer = QTimer(self)
        self._idle_timer.timeout.connect(self._check_idle)
        self._idle_timer.start(5000)

    # ------------------------------------------------------------------ 轮询

    def _poll(self):
        self._poll_udp()
        self._poll_file()

    def _poll_udp(self):
        while True:
            try:
                data, _addr = self._udp.recvfrom(65535)
            except (BlockingIOError, OSError):
                return
            try:
                message = json.loads(data.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            event = str(message.get("event", "unknown"))
            detail = str(message.get("detail") or message.get("payload") or "")[:200]
            if event.strip().lower() == "action":
                self.action_changed.emit(detail, str(message.get("status", "ok")))
                continue
            self._handle(event, detail)

    def _poll_file(self):
        path = self._state_file
        try:
            stat = path.stat()
        except OSError:
            self._last_file_signature = None
            return
        signature = (stat.st_mtime_ns, stat.st_size)
        if signature == self._last_file_signature:
            return
        self._last_file_signature = signature
        try:
            message = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        event = str(message.get("event", "unknown"))
        detail = str(message.get("detail") or message.get("payload") or "")[:200]
        if event.strip().lower() == "action":
            self.action_changed.emit(detail, str(message.get("status", "ok")))
            return
        self._handle(event, detail)

    # ------------------------------------------------------------------ 状态机

    def _handle(self, event: str, detail: str):
        key = event.strip().lower()

        if key in ("sessionstart",):
            self._mode = "idle"
            self.state_changed.emit("idle", detail, "session")
            return

        if key in ("userpromptsubmit", "prompt"):
            self._mode = "running"
            self._last_activity = time.monotonic()
            self.state_changed.emit("running", detail, "user")
            return

        if key in ("patch_apply",):
            self._mode = "review"
            self._last_activity = time.monotonic()
            self.state_changed.emit("review", detail, "review")
            return

        if key in (
            "agentstart",
            "pretooluse",
            "posttooluse",
            "subagentstart",
            "subagentstop",
            "agent_message",
            "tooluse",
        ):
            self._mode = "running"
            self._last_activity = time.monotonic()
            self.state_changed.emit("running", detail, "activity")
            return

        if key in ("agentstop",):
            # 轮次结束：进入等待态（等待你的输入），但绝不触发“完成”动画；
            # 真正的完成由插件在目标完成 + 静默去抖后发送 done/stop。
            self._mode = "waiting"
            self._last_activity = time.monotonic()
            self.state_changed.emit("waiting", detail, "activity")
            return

        if key in ("permissionrequest", "approval", "waiting"):
            self._mode = "waiting"
            self.state_changed.emit("jumping", "once:waiting", "activity")
            return

        if key in ("deny", "rejected", "denied"):
            self._mode = "idle"
            self.state_changed.emit("idle", detail, "system")
            return

        if key in ("failed", "error"):
            self._mode = "idle"
            self.state_changed.emit("failed", "once:idle", "error")
            return

        if key in ("stop", "sessionend", "done"):
            self._mode = "waiting"
            self.state_changed.emit("waving", "once:waiting", "complete")
            return

        if key in ("idle",):
            self._mode = "idle"
            self.state_changed.emit("idle", detail, "system")
            return

        # 未知事件：忽略（不再重置为 idle）
        _log(f"忽略未知事件: {event!r}")

    def _check_idle(self):
        if self._mode in ("running", "review"):
            if time.monotonic() - self._last_activity > IDLE_TIMEOUT_SECONDS:
                self._mode = "idle"
                _log(f"空闲兜底触发: mode={self._mode}, 距上次事件 {time.monotonic() - self._last_activity:.0f}s")
                self.state_changed.emit("idle", "idle-timeout", "system")

    # ------------------------------------------------------------------ 外部

    def manual_state(self, state: str):
        self.state_changed.emit(state, "manual", "manual")

    def close(self):
        self._timer.stop()
        self._idle_timer.stop()
        try:
            self._udp.close()
        except OSError:
            pass
