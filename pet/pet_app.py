# -*- coding: utf-8 -*-
"""DSH 桌宠 — 主程序（DeepSeek Harness 版）。

透明置顶小窗口，按 Codex 宠物规则播放 ``pets/<name>/`` 精灵图动画，
通过本地 UDP / 状态文件接收 DSH 插件 ``dsh-pet-bridge`` 推送的事件，
自动切换动画状态。不依赖任何 Codex 组件。

用法：
    pythonw pet_app.py [--pet <name>] [--scale 1.0] [--port 47890]

与 Codex 版的差异：
- 移除“随 Codex 启动”watcher（由 DSH 插件在启动时拉起桌宠）；
- 状态词汇表修正（agentstop 等），未知事件不再重置为 idle；
- review（审阅）状态可真正触发；
- 气泡文案面向 DeepSeek Harness。
"""
from __future__ import annotations

import argparse
import html
import json
import os
import sys
import time
from pathlib import Path
from typing import ClassVar

from pet_loader import STANDARD_STATES, Pet, pil_to_qimage, scan_pets
from pet_style import apply_codex_style
from PySide6.QtCore import QPoint, QRect, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QColor, QFontMetrics, QIcon, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QGraphicsDropShadowEffect,
    QLabel,
    QMenu,
    QSystemTrayIcon,
    QWidget,
)
from state_listener import DEFAULT_PORT, STATE_FILE, StateListener, _log

if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
else:
    APP_DIR = Path(__file__).resolve().parent

CONFIG_FILE = APP_DIR / "pet_config.json"
USER_PETS_ROOT = Path(os.path.expanduser("~")) / ".dsh"
APP_PETS_ROOT = APP_DIR

DEFAULT_CONFIG: dict = {
    "pet": None,
    "scale": 1,
    "fps": 10,
    "port": 47890,
    "always_on_top": True,
    "show_status_text": False,
    "show_bubble": True,
    "x": None,
    "y": None,
}

BUBBLE_MAX_WIDTH = 480
BUBBLE_PAD_X = 12
BUBBLE_PAD_TOP = 5
BUBBLE_PAD_BOTTOM = 5
BUBBLE_TITLE_H = 19
BUBBLE_GAP = 3
BUBBLE_LINE_H = 17
BUBBLE_SHADOW_M = 12
BUBBLE_SHADOW_EXTRA = 4
BUBBLE_CIRCLE_D = 28
BUBBLE_CIRCLE_GAP = 8


class StatusCircle(QLabel):
    """气泡右侧的状态圆圈：完成绿勾 / 失败红叹号。"""

    clicked = Signal()

    MODE_HIDDEN = "hidden"
    MODE_DONE = "done"
    MODE_ERROR = "error"

    COLORS: ClassVar[dict[str, tuple[QColor, QColor]]] = {
        MODE_DONE: (QColor("#C7F0D4"), QColor("#22C55E")),
        MODE_ERROR: (QColor("#FDE2E2"), QColor("#F04438")),
    }

    def __init__(self, parent=None):
        super().__init__(parent)
        self._mode = self.MODE_HIDDEN
        self.setFixedSize(BUBBLE_CIRCLE_D, BUBBLE_CIRCLE_D)

    def enterEvent(self, event):
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        super().enterEvent(event)

    def leaveEvent(self, event):
        self.unsetCursor()
        super().leaveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.rect().contains(event.position().toPoint()):
            self.clicked.emit()
        super().mouseReleaseEvent(event)

    def set_mode(self, mode: str):
        if mode != self._mode:
            self._mode = mode
            self.update()

    def mode(self) -> str:
        return self._mode

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect = self.rect()
        if self._mode == self.MODE_HIDDEN:
            painter.end()
            return
        bg, fg = self.COLORS.get(self._mode, (QColor("#E9E9E9"), QColor("#666666")))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(bg)
        painter.drawEllipse(rect)
        painter.setBrush(fg)
        if self._mode == self.MODE_DONE:
            # 绿勾
            path = QPainterPath()
            path.moveTo(rect.left() + rect.width() * 0.28, rect.top() + rect.height() * 0.52)
            path.lineTo(rect.left() + rect.width() * 0.44, rect.top() + rect.height() * 0.68)
            path.lineTo(rect.left() + rect.width() * 0.74, rect.top() + rect.height() * 0.32)
            pen = QPen(fg, 2.4, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin)
            painter.setPen(pen)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawPath(path)
        elif self._mode == self.MODE_ERROR:
            # 红叹号
            pen = QPen(fg, 2.6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap)
            painter.setPen(pen)
            cx = rect.center().x()
            painter.drawLine(QPoint(cx, rect.top() + rect.height() * 0.30), QPoint(cx, rect.top() + rect.height() * 0.62))
            painter.setBrush(fg)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawEllipse(QPoint(cx, rect.top() + rect.height() * 0.78), 2.0, 2.0)
        painter.end()


class BubbleCard(QLabel):
    """白色胶囊气泡卡片：两端半圆，无边框。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect = self.rect().adjusted(BUBBLE_SHADOW_M, BUBBLE_SHADOW_M, -BUBBLE_SHADOW_M, -BUBBLE_SHADOW_M)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(255, 255, 255, 245))
        painter.drawRoundedRect(rect, rect.height() / 2, rect.height() / 2)
        painter.end()


class Bubble(QWidget):
    """任务提示气泡：独立透明置顶窗口，跟随宠物同步移动。

    内容结构：
    - 第一行：标题（任务对话标题），粗体大字号近黑色；
    - 第二行：状态提示短句（思考中/执行任务/等待你的输入等），按状态着色：
      ok=DSH 绿 #10A37F，warn=警告黄 #FFB000，error=失败红 #F04438；
    - 第三行（可选）：简短摘要/错误描述。

    自动换行、限行截断（末尾加 …），气泡宽高跟随文本自动缩放。
    """

    COLOR_OK = QColor("#10A37F")
    COLOR_WARN = QColor("#FFB000")
    COLOR_ERROR = QColor("#F04438")
    COLOR_BODY_GRAY = QColor("#8A8F98")
    COLOR_TITLE = QColor("#1F2328")

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)

        self._card = BubbleCard(self)
        self._circle = StatusCircle(self)
        self._body_label = QLabel(self)
        self._body_label.setWordWrap(True)
        self._body_label.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)

    def set_content(
        self,
        title: str,
        status_phrase: str,
        body: str,
        status: str,
        body_color: QColor | None = None,
    ):
        """设置气泡内容；status: ok / warn / error。"""
        self._card.setToolTip("")
        colors = {
            "ok": self.COLOR_OK,
            "warn": self.COLOR_WARN,
            "error": self.COLOR_ERROR,
        }
        phrase_color = colors.get(status, self.COLOR_OK)
        body_color = body_color or self.COLOR_BODY_GRAY

        title_html = f'<span style="color:{self.COLOR_TITLE.name()}; font-size:13px; font-weight:bold;">{html.escape(title)}</span>'
        phrase_html = f'<span style="color:{phrase_color.name()}; font-size:13px; font-weight:bold;">{html.escape(status_phrase)}</span>'
        if title:
            html_text = title_html + ' · ' + phrase_html
        else:
            html_text = phrase_html
        if body:
            html_text += f'<br><span style="color:{body_color.name()}; background: transparent;">{html.escape(body)}</span>'

        metrics = QFontMetrics(self.font())
        max_w = BUBBLE_MAX_WIDTH - BUBBLE_PAD_X * 2 - BUBBLE_CIRCLE_D - BUBBLE_CIRCLE_GAP - BUBBLE_SHADOW_M * 2
        text_w = metrics.horizontalAdvance(html.unescape(title + status_phrase))
        w = min(BUBBLE_MAX_WIDTH, max(BUBBLE_PAD_X * 2 + BUBBLE_SHADOW_M * 2 + BUBBLE_CIRCLE_D + BUBBLE_CIRCLE_GAP + text_w, BUBBLE_PAD_X * 2 + 80))

        self._body_label.setText(html_text)
        self._body_label.setStyleSheet("background: transparent;")
        self._body_label.adjustSize()
        self._body_label.setMaximumWidth(max_w)
        self._body_label.adjustSize()

        body_h = self._body_label.heightForWidth(max_w)
        if body_h > BUBBLE_LINE_H * 2:
            body_h = BUBBLE_LINE_H * 2
        h = BUBBLE_PAD_TOP + BUBBLE_TITLE_H + BUBBLE_GAP + body_h + BUBBLE_PAD_BOTTOM + BUBBLE_SHADOW_M * 2
        self.setFixedSize(w, h)
        self._card.setGeometry(0, 0, w, h)
        self._body_label.setGeometry(
            BUBBLE_PAD_X + BUBBLE_SHADOW_M,
            BUBBLE_PAD_TOP + BUBBLE_SHADOW_M,
            max_w,
            body_h,
        )
        self._circle.move(w - BUBBLE_CIRCLE_D - BUBBLE_CIRCLE_GAP - BUBBLE_SHADOW_M, BUBBLE_PAD_TOP + BUBBLE_SHADOW_M)

    def _elide_line(self, text: str, max_w: int) -> str:
        """单行截断，超长末尾加 …。"""
        if not text:
            return ""
        metrics = QFontMetrics(self.font())
        if metrics.horizontalAdvance(text) <= max_w:
            return text
        return metrics.elidedText(text, Qt.TextElideMode.ElideRight, max_w)


def load_config(path) -> dict:
    config = dict(DEFAULT_CONFIG)
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return config
    if isinstance(data, dict):
        config.update(data)
    return config


def save_config(path, config) -> None:
    try:
        Path(path).write_text(
            json.dumps(config, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass


class PetWidget(QWidget):
    """桌宠窗口：动画播放、拖拽、气泡、托盘菜单。"""

    pet_changed = Signal()

    KNOWN_ACTION_WORDS = ("收到指令", "正在思考", "搜索中", "分析代码", "执行任务", "回复中")

    def __init__(self, pet: Pet | None, config: dict, pets: list[Pet], parent=None):
        super().__init__(parent)
        self._config = config
        self._pets = pets
        self._pet = pet
        self._state = "idle"
        self._frame_index = 0
        self._pixmaps: dict[str, list[QPixmap]] = {}
        self._drag_offset = None
        self._dragging = False
        self._last_drag_x = 0.0
        self._last_drag_y = 0.0
        self._dir_intent = 0.0
        self._vert_intent = 0.0
        self._once_next = None
        self._base_state = None
        self._hover_prev_state = None
        self._drag_was_up = False
        self._business_state = "idle"
        self._pending_business = None
        self._task_text = ""
        self._action_text = ""
        self._action_status = "ok"
        self._has_ai_summary = False
        self._ai_summary_text = ""
        self._from_business = False
        self._hover_cooldown_until = 0.0

        self._bubble = Bubble()
        self._circle = self._bubble._circle
        self._circle.clicked.connect(self._on_circle_clicked)
        self._completed = False
        self._circle_business = StatusCircle.MODE_HIDDEN
        self._show_status_text = bool(config.get("show_status_text", True))
        self._show_bubble = bool(config.get("show_bubble", True))

        self._pet_actions: list[tuple[Pet, QAction]] = []
        self._scale_actions: list[tuple[float, QAction]] = []

        self._apply_window_flags()
        self._build_pixmaps()
        self._resize_to_pet()

        fps = max(1, int(config.get("fps", 10)))
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._next_frame)
        self._timer.start(max(30, 1000 // fps))

        self._completed_timer = QTimer(self)
        self._completed_timer.setSingleShot(True)
        self._completed_timer.timeout.connect(self._on_completed_timeout)

        self._waiting_timer = QTimer(self)
        self._waiting_timer.setSingleShot(True)
        self._waiting_timer.timeout.connect(self._on_waiting_timeout)

        self._menu = self._build_menu()

        # 初始位置：优先配置文件，否则屏幕右下角
        pos = (config.get("x"), config.get("y"))
        if isinstance(pos[0], (int, float)) and isinstance(pos[1], (int, float)):
            self.move(int(pos[0]), int(pos[1]))
        else:
            screen = QApplication.primaryScreen()
            if screen is not None:
                geo = screen.availableGeometry()
                self.move(geo.right() - self.width() - 40, geo.bottom() - self.height() - 40)

    # ------------------------------------------------------------- 窗口基础

    def _apply_window_flags(self):
        flags = Qt.WindowType.FramelessWindowHint | Qt.WindowType.Tool
        if self._config.get("always_on_top", True):
            flags |= Qt.WindowType.WindowStaysOnTopHint
        self.setWindowFlags(flags)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)

    def _resize_to_pet(self):
        if self._pet is None:
            self.resize(192, 208)
            return
        scale = float(self._config.get("scale", 1.0))
        self.resize(
            max(1, int(self._pet.cell_w * scale)),
            max(1, int(self._pet.cell_h * scale)),
        )

    def _build_pixmaps(self):
        self._pixmaps = {}
        if self._pet is None:
            return
        for state, frames in self._pet.frames.items():
            if state not in STANDARD_STATES:
                continue
            self._pixmaps[state] = [
                QPixmap.fromImage(pil_to_qimage(frame)) for frame in frames
            ]

    # ------------------------------------------------------------- 动画

    def _next_frame(self):
        frames = self._pixmaps.get(self._state)
        if not frames:
            return
        self._frame_index += 1
        if self._once_next is not None and self._frame_index >= len(frames):
            # 一次性动画播完：应用暂存的业务事件或回到 once 目标
            nxt = self._pending_business if self._pending_business is not None else self._once_next
            self._once_next = None
            self._pending_business = None
            if nxt in self._pixmaps:
                self._state = nxt
                if nxt in ("idle", "running", "waiting", "review"):
                    self._business_state = nxt
                self._frame_index = 0
                self._update_bubble()
                self.update()
                return
            self._state = "idle"
            self._business_state = "idle"
            self._frame_index = 0
            self._update_bubble()
            self.update()
            return
        self._frame_index %= len(frames)
        self.update()

    def set_state(self, state, detail=""):
        if state not in self._pixmaps:
            return
        # 一次性动画播放期间，业务事件先暂存（手动状态除外）
        if self._once_next is not None:
            if state not in ("running-left", "running-right", "jumping") and detail != "manual":
                if state in ("idle", "running", "waiting", "review"):
                    self._pending_business = state
                return
        # 拖拽期间忽略业务状态
        if self._dragging and state not in ("running-left", "running-right", "jumping"):
            return

        once_next = None
        if isinstance(detail, str) and detail.startswith("once:"):
            once_next = detail[5:]
            detail = detail[5:]

        if state != self._state or once_next is not None:
            self._state = state
            self._once_next = once_next
            self._frame_index = 0
            self._update_bubble()
            self.update()

        if once_next is None and not self._dragging and detail != "drag-end":
            if state in ("idle", "running", "waiting", "review"):
                self._business_state = state

    def apply_business(self, state, detail="", source="activity"):
        """业务状态入口（来自状态监听器）：更新任务文本并切换状态。

        DSH 版：插件是唯一事件源，任何新业务事件都取消“完成”展示
        （目标自动续跑、新轮次等都不会卡在完成态）。
        """
        if state == "waving" and detail == "once:waiting":
            self._mark_completed()
            return
        self._completed = False
        self._completed_timer.stop()
        self._waiting_timer.stop()
        if self._once_next is not None:
            self._once_next = None
            self._pending_business = None

        if detail and not detail.startswith("once:") and detail not in ("rollout", "manual", "drag-end"):
            self._task_text = detail[:200]

        self._from_business = True
        self.set_state(state, detail)
        self._update_bubble()
        self._from_business = False

    # ------------------------------------------------------------- 气泡

    def _update_bubble(self):
        """按状态与来源决定气泡显隐与内容（标题 + 状态短句 + 摘要/错误）。"""
        self._refresh_circle_business()
        if not self._show_bubble:
            self._bubble.hide()
            self._circle.set_mode(StatusCircle.MODE_HIDDEN)
            return
        if self._dragging:
            self._bubble.hide()
            return

        if self._completed:
            title = self._task_text or ""
            phrase = "任务完成"
            status = "ok"
            body = self._ai_summary_text
            body_color = Bubble.COLOR_BODY_GRAY
            self._bubble.set_content(title, phrase, body, status, body_color=body_color)
            self._bubble.show()
            self._sync_bubble_pos()
            return

        title, phrase, body, status, body_color = "", "", "", "ok", None

        if self._state == "failed":
            title = self._task_text or "出错"
            phrase = "发生错误"
            body = self._action_text or ""
            status = "error"
        elif self._state == "running":
            title = self._task_text or ""
            phrase = self._status_title()
            status = self._action_status
            if self._has_ai_summary:
                body = self._ai_summary_text
            elif self._action_text == " ":
                body = " "
            elif self._action_text == " ":
                body = " "
            else:
                body = ""
            if body:
                body_color = Bubble.COLOR_BODY_GRAY
        elif self._state == "review":
            title = self._task_text or ""
            phrase = "等待审阅代码变更"
            body = ""
        elif self._state == "jumping" and self._from_business:
            title = self._task_text or "需要你的授权"
            phrase = "等待授权确认"
            body = self._action_text or ""
            status = "warn"
        else:
            self._bubble.hide()
            return

        if title or phrase or body:
            self._bubble.set_content(title, phrase, body, status, body_color=body_color)
            self._bubble.show()
            self._sync_bubble_pos()

    def set_action(self, text=" ", status="ok"):
        """更新最新进度行（来自状态监听器）。"""
        self._action_text = text
        if status in ("ok", "warn", "error"):
            self._action_status = status
        else:
            self._action_status = "ok"
        if status == "ok":
            if text == " ":
                self._has_ai_summary = False
                self._ai_summary_text = ""
            elif text not in self.KNOWN_ACTION_WORDS:
                self._has_ai_summary = True
                self._ai_summary_text = text
        if self._show_bubble:
            self._update_bubble()

    def _status_title(self) -> str:
        """running 状态的第一行状态短句（· 后内容）。"""
        action = self._action_text
        if action == "正在思考":
            return "思考中"
        if action == "搜索中":
            return "搜索中"
        if action in self.KNOWN_ACTION_WORDS:
            return "执行任务中"
        return "回复中"

    def _mark_completed(self):
        self._completed = True
        self._completed_timer.start(10000)
        self._waiting_timer.start(20000)
        self._update_bubble()

    def _on_completed_timeout(self):
        self._completed = False
        self._update_bubble()

    def _on_waiting_timeout(self):
        if self._business_state == "waiting":
            self.set_state("idle", "manual")

    def _on_circle_clicked(self):
        if self._completed:
            self._close_completed()

    def _close_completed(self):
        self._completed = False
        self._completed_timer.stop()
        if self._once_next is not None:
            self._once_next = None
            self._pending_business = None
            base = self._business_state or "waiting"
            if base in self._pixmaps:
                self._state = base
                self._frame_index = 0
        self._bubble.hide()
        self._circle.set_mode(StatusCircle.MODE_HIDDEN)

    def _refresh_circle_business(self):
        if self._completed:
            self._circle_business = StatusCircle.MODE_DONE
        elif self._state == "failed":
            self._circle_business = StatusCircle.MODE_ERROR
        else:
            self._circle_business = StatusCircle.MODE_HIDDEN
        self._circle.set_mode(self._circle_business)

    def _sync_bubble_pos(self):
        visual_w = self._bubble.width() - 2 * BUBBLE_SHADOW_M
        visual_h = self._bubble.height() - 2 * BUBBLE_SHADOW_M - BUBBLE_SHADOW_EXTRA
        x = self.x() + self.width() - int(visual_w * 0.7) - BUBBLE_SHADOW_M
        y = self.y() - visual_h + 8 - BUBBLE_SHADOW_M
        self._bubble.move(x, y)

    def moveEvent(self, event):
        super().moveEvent(event)
        self._sync_bubble_pos()

    # ------------------------------------------------------------- 手动/切换

    def manual_state(self, state: str):
        if state != "waving":
            self._completed = False
            self._completed_timer.stop()
            self._waiting_timer.stop()
        self.set_state(state, "manual")

    def switch_pet(self, pet: Pet):
        self._pet = pet
        self._build_pixmaps()
        self._state = "idle"
        self._frame_index = 0
        self._config["pet"] = pet.name
        self._resize_to_pet()
        self.refresh_checks()
        save_config(CONFIG_FILE, self._config)
        self.pet_changed.emit()
        self.update()

    def set_scale(self, scale: float):
        self._config["scale"] = scale
        self._resize_to_pet()
        self.refresh_checks()
        save_config(CONFIG_FILE, self._config)
        self.update()

    def set_always_on_top(self, enabled: bool):
        self._config["always_on_top"] = enabled
        save_config(CONFIG_FILE, self._config)
        self.hide()
        self._apply_window_flags()
        self.show()

    def set_show_status_text(self, enabled: bool):
        self._show_status_text = enabled
        self._config["show_status_text"] = enabled
        save_config(CONFIG_FILE, self._config)
        self.update()

    def set_show_bubble(self, enabled: bool):
        self._show_bubble = enabled
        self._config["show_bubble"] = enabled
        save_config(CONFIG_FILE, self._config)
        self._update_bubble()

    # ------------------------------------------------------------- 托盘菜单

    def current_icon(self) -> QIcon:
        frames = self._pixmaps.get("idle")
        if not frames:
            return QIcon()
        return QIcon(frames[0])

    def _build_menu(self) -> QMenu:
        menu = QMenu(self)

        pets_menu = menu.addMenu("宠物")
        if self._pets:
            for pet in self._pets:
                action = pets_menu.addAction(pet.display_name)
                action.setCheckable(True)
                action.setChecked(self._pet is not None and pet.name == self._pet.name)
                self._pet_actions.append((pet, action))
                action.triggered.connect(lambda checked=False, p=pet: self.switch_pet(p))
        else:
            action = pets_menu.addAction("（未找到宠物包）")
            action.setEnabled(False)

        state_menu = menu.addMenu("状态（手动）")
        for state in STANDARD_STATES:
            action = state_menu.addAction(state)
            action.triggered.connect(lambda checked=False, s=state: self.manual_state(s))

        scale_menu = menu.addMenu("大小")
        for scale in (0.5, 0.75, 1.0, 1.5, 2.0):
            action = scale_menu.addAction(f"{scale:.2g}x")
            action.setCheckable(True)
            action.setChecked(abs(float(self._config.get("scale", 1.0)) - scale) < 0.01)
            self._scale_actions.append((scale, action))
            action.triggered.connect(lambda checked=False, s=scale: self.set_scale(s))

        top_action = menu.addAction("窗口置顶")
        top_action.setCheckable(True)
        top_action.setChecked(bool(self._config.get("always_on_top", True)))
        top_action.triggered.connect(self.set_always_on_top)

        text_action = menu.addAction("显示状态文字")
        text_action.setCheckable(True)
        text_action.setChecked(self._show_status_text)
        text_action.triggered.connect(self.set_show_status_text)

        bubble_action = menu.addAction("显示气泡框")
        bubble_action.setCheckable(True)
        bubble_action.setChecked(self._show_bubble)
        bubble_action.triggered.connect(self.set_show_bubble)

        menu.addSeparator()
        menu.addAction("退出", QApplication.quit)
        return menu

    def refresh_checks(self):
        for pet, action in self._pet_actions:
            action.setChecked(self._pet is not None and pet.name == self._pet.name)
        current_scale = float(self._config.get("scale", 1.0))
        for scale, action in self._scale_actions:
            action.setChecked(abs(current_scale - scale) < 0.01)

    def contextMenuEvent(self, event):
        self._menu.exec(event.globalPos())

    # ------------------------------------------------------------- 交互

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            self._last_drag_x = event.globalPosition().x()
            self._last_drag_y = event.globalPosition().y()
            self._dir_intent = 0.0
            self._vert_intent = 0.0
            self._dragging = True
            if self._pending_business is not None:
                self._business_state = self._pending_business
                self._pending_business = None
            self._base_state = self._business_state
            self._drag_was_up = False
            self._bubble.hide()
            self.set_state("jumping")
            event.accept()

    def mouseMoveEvent(self, event):
        if self._drag_offset is None or not (event.buttons() & Qt.MouseButton.LeftButton):
            return
        self.move(event.globalPosition().toPoint() - self._drag_offset)
        x = event.globalPosition().x()
        y = event.globalPosition().y()
        dx = x - self._last_drag_x
        dy = y - self._last_drag_y
        self._last_drag_x = x
        self._last_drag_y = y

        self._dir_intent = max(-12.0, min(12.0, self._dir_intent + dx))
        self._vert_intent = max(-12.0, min(12.0, self._vert_intent + dy))

        if self._vert_intent <= -5 and abs(self._vert_intent) >= abs(self._dir_intent):
            self.set_state("jumping")
            self._drag_was_up = True
            self._vert_intent = 0.0
            self._dir_intent = 0.0
        elif self._state == "running-left" and self._dir_intent >= 3:
            self.set_state("running-right")
            self._drag_was_up = False
            self._dir_intent = 0.0
        elif self._state == "running-right" and self._dir_intent <= -3:
            self.set_state("running-left")
            self._drag_was_up = False
            self._dir_intent = 0.0
        elif self._state not in ("running-left", "running-right"):
            if self._dir_intent >= 10:
                self.set_state("running-right")
                self._drag_was_up = False
                self._dir_intent = 0.0
            elif self._dir_intent <= -10:
                self.set_state("running-left")
                self._drag_was_up = False
                self._dir_intent = 0.0
        event.accept()

    def mouseReleaseEvent(self, event):
        if event.button() != Qt.MouseButton.LeftButton or self._drag_offset is None:
            return
        self._drag_offset = None
        self._dragging = False
        base = self._base_state or "idle"
        if self._drag_was_up:
            self.set_state("jumping", "once:" + base)
        else:
            self.set_state(base, "drag-end")
        self._base_state = None
        self._config["x"] = self.x()
        self._config["y"] = self.y()
        save_config(CONFIG_FILE, self._config)
        event.accept()

    def enterEvent(self, event):
        if not self._dragging:
            now = time.monotonic()
            if now >= self._hover_cooldown_until:
                self._hover_cooldown_until = now + 2.0
                self._hover_prev_state = self._business_state
                self.set_state("waving", "once:" + (self._hover_prev_state or "idle"))
        super().enterEvent(event)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        frames = self._pixmaps.get(self._state)
        if frames:
            frame = frames[self._frame_index % len(frames)]
            painter.drawPixmap(self.rect(), frame)
        elif self._pet is None:
            painter.fillRect(self.rect(), QColor(30, 30, 30, 180))
            painter.setPen(QColor(255, 255, 255, 230))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "未找到宠物包")

        if self._show_status_text and frames:
            painter.setPen(QPen(QColor(255, 255, 255, 220)))
            painter.drawText(2, self.height() - 1, self._state)
            painter.setPen(QPen(QColor(138, 143, 152, 255)))
            painter.drawText(1, self.height() - 2, self._state)
        painter.end()

    def closeEvent(self, event):
        self._config["x"] = self.x()
        self._config["y"] = self.y()
        save_config(CONFIG_FILE, self._config)
        self._bubble.close()
        super().closeEvent(event)


def pick_pet(pets: list[Pet], requested: str | None) -> Pet | None:
    if requested:
        wanted = requested.strip().lower()
        for pet in pets:
            if (
                pet.name.lower() == wanted
                or pet.path.name.lower() == wanted
                or pet.display_name.lower() == wanted
            ):
                return pet
    if pets:
        return pets[0]
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="DSH 桌宠")
    parser.add_argument("--pet", default=None, help="宠物包名（pets 目录下的文件夹名）")
    parser.add_argument("--scale", type=float, default=None, help="显示缩放倍率")
    parser.add_argument("--port", type=int, default=None, help="本地 UDP 端口")
    parser.add_argument("--config", type=Path, default=CONFIG_FILE, help="配置文件路径")
    parser.add_argument("--no-tray", action="store_true", help="不创建系统托盘图标")
    args = parser.parse_args()

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    apply_codex_style(app, [APP_DIR, APP_DIR / "assets"])

    config = load_config(args.config)
    if args.pet is not None:
        config["pet"] = args.pet
    if args.scale is not None:
        config["scale"] = args.scale
    if args.port is not None:
        config["port"] = args.port

    pets = scan_pets([APP_PETS_ROOT, USER_PETS_ROOT / "pets"])
    pet = pick_pet(pets, config.get("pet"))
    if pet is not None:
        config["pet"] = pet.name
    save_config(args.config, config)

    widget = PetWidget(pet, config, pets)

    port = int(config.get("port", DEFAULT_PORT))
    state_file = Path(config.get("state_file")) if config.get("state_file") else STATE_FILE
    listener = None
    try:
        listener = StateListener(port=port, state_file=state_file)
    except OSError as exc:
        _log(f"警告：状态监听不可用（{exc}），仅保留手动状态切换。")
    if listener is not None:
        listener.state_changed.connect(widget.apply_business)
        listener.action_changed.connect(widget.set_action)

    tray = None
    if not args.no_tray:
        tray = QSystemTrayIcon(widget.current_icon(), app)
        tray.setToolTip("DSH 桌宠")
        tray.setContextMenu(widget._menu)
        widget.pet_changed.connect(lambda: tray.setIcon(widget.current_icon()))
        tray.activated.connect(lambda reason: widget.setVisible(not widget.isVisible()))
        tray.show()

    widget.show()
    rc = app.exec()
    if listener is not None:
        listener.close()
    return rc


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
