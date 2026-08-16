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
- 气泡文案面向 DeepSeek Harness；
- 单实例锁（防双开）；支持 pet/visibility 窗口显隐、pet/quit 退出；
- 运行日志落盘 ~/.dsh/dsh-pet.log。
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
from pet_style import FONT_FAMILIES, apply_codex_style
from PySide6.QtCore import QRect, QRectF, QSharedMemory, Qt, QTimer, Signal
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

# —— 气泡排版（原版 Codex 样式：白色胶囊 + 柔和投影）——
# 常量值与原版反汇编逐一核对（BUBBLE_SHADOW_M=20 等），复刻原版观感。
BUBBLE_MAX_WIDTH = 480          # 气泡最大宽度（px）
BUBBLE_PAD_X = 12               # 水平内边距
BUBBLE_PAD_TOP = 5              # 上内边距
BUBBLE_PAD_BOTTOM = 6           # 下内边距
BUBBLE_TITLE_H = 19             # 标题行高（13px 粗体）
BUBBLE_LINE_H = 18              # 摘要行高（13px）
BUBBLE_GAP = 0                  # 标题与摘要间距
BUBBLE_SHADOW_M = 20            # 投影外扩边距
BUBBLE_SHADOW_EXTRA = 6         # 底部投影额外边距
BUBBLE_CIRCLE_D = 36            # 状态圆圈直径（略大，与右侧圆弧同心）
BUBBLE_CIRCLE_GAP = 6           # 圆圈与文字间距


class StatusCircle(QLabel):
    """气泡右侧的状态圆圈：完成绿勾 / 失败红叹号 / 暂停灰方块 / 恢复三角。

    原版交互：hover 时出现同色光晕（外扩 4px、alpha 110），
    非 hover 时本体缩小 6px；点击（非隐藏态）发出 clicked 信号。
    """

    clicked = Signal()

    MODE_HIDDEN = "hidden"
    MODE_DONE = "done"
    MODE_ERROR = "error"
    MODE_PAUSE = "pause"
    MODE_RESUME = "resume"

    COLORS: ClassVar[dict[str, tuple[QColor, QColor]]] = {
        MODE_DONE: (QColor("#C7F0D4"), QColor("#22C55E")),
        MODE_ERROR: (QColor("#FDE2E2"), QColor("#F04438")),
        # 暂停/恢复：浅灰底 + 深灰图案（底浅于图案，有辨识度）
        MODE_PAUSE: (QColor("#E9E9E9"), QColor("#5F6672")),
        MODE_RESUME: (QColor("#E9E9E9"), QColor("#5F6672")),
    }

    def __init__(self, parent=None):
        super().__init__(parent)
        self._mode = self.MODE_HIDDEN
        self._hovered = False
        self.setFixedSize(BUBBLE_CIRCLE_D, BUBBLE_CIRCLE_D)

    def set_mode(self, mode: str):
        if mode != self._mode:
            self._mode = mode
            if mode == self.MODE_HIDDEN:
                self._hovered = False
                self.unsetCursor()
            self.update()

    def mode(self) -> str:
        return self._mode

    def enterEvent(self, event):
        if self._mode != self.MODE_HIDDEN:
            self._hovered = True
            self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.update()
        super().enterEvent(event)

    def leaveEvent(self, event):
        self._hovered = False
        self.unsetCursor()
        self.update()
        super().leaveEvent(event)

    def mouseReleaseEvent(self, event):
        # 原版：仅非隐藏态响应点击
        if self._mode != self.MODE_HIDDEN:
            self.clicked.emit()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        if self._mode == self.MODE_HIDDEN:
            painter.end()
            return
        bg, fg = self.COLORS.get(self._mode, (QColor("#E9E9E9"), QColor("#666666")))
        painter.setPen(Qt.PenStyle.NoPen)
        if self._hovered:
            # 光晕：外扩 4px 的底色圆（alpha 110）
            halo = QRect(-2, -2, BUBBLE_CIRCLE_D + 4, BUBBLE_CIRCLE_D + 4)
            halo_color = QColor(bg)
            halo_color.setAlpha(110)
            painter.setBrush(halo_color)
            painter.drawEllipse(halo)
            body_rect = QRect(0, 0, BUBBLE_CIRCLE_D, BUBBLE_CIRCLE_D)
        else:
            body_rect = QRect(3, 3, BUBBLE_CIRCLE_D - 6, BUBBLE_CIRCLE_D - 6)
        painter.setBrush(bg)
        painter.drawEllipse(body_rect)

        # 原版图案坐标按 28px 圆设计：圆圈放大后统一按比例缩放，保持居中美观
        k = BUBBLE_CIRCLE_D / 28.0
        if self._mode == self.MODE_DONE:
            # 绿勾（原版 28px 坐标等比放大）
            pen = QPen(fg, 2.0 * k, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap)
            painter.setPen(pen)
            path = QPainterPath()
            path.moveTo(8.0 * k, 14.0 * k)
            path.lineTo(12.0 * k, 18.0 * k)
            path.lineTo(20.0 * k, 9.5 * k)
            painter.drawPath(path)
        elif self._mode == self.MODE_ERROR:
            # 红叹号（原版 28px 坐标等比放大）
            pen = QPen(fg, 2.4 * k, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap)
            painter.setPen(pen)
            painter.drawLine(14.0 * k, 8.0 * k, 14.0 * k, 16.5 * k)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(fg)
            painter.drawEllipse(QRectF(12.5 * k, 18.5 * k, 3.0 * k, 3.0 * k))
        elif self._mode == self.MODE_PAUSE:
            # 暂停：灰色方块（按圆直径动态居中）
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(fg)
            s = BUBBLE_CIRCLE_D * 0.28  # 方块边长 ≈ 圆直径的 28%
            off = (BUBBLE_CIRCLE_D - s) / 2.0
            painter.drawRoundedRect(QRectF(off, off, s, s), s * 0.18, s * 0.18)
        elif self._mode == self.MODE_RESUME:
            # 恢复：灰色右向三角（按圆直径动态居中）
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(fg)
            d = float(BUBBLE_CIRCLE_D)
            path = QPainterPath()
            path.moveTo(d * 0.34, d * 0.28)
            path.lineTo(d * 0.34, d * 0.72)
            path.lineTo(d * 0.68, d * 0.5)
            path.closeSubpath()
            painter.drawPath(path)
        painter.end()


class BubbleCard(QWidget):
    """白色胶囊气泡卡片：两端半圆（radius = 高/2），纯白不透明。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        body = QRect(0, 0, self.width(), self.height())
        radius = body.height() / 2.0
        path = QPainterPath()
        path.addRoundedRect(body, radius, radius)
        painter.fillPath(path, QColor(255, 255, 255, 255))
        painter.end()


class Bubble(QWidget):
    """任务提示气泡：独立透明置顶窗口，跟随宠物同步移动（原版 Codex 样式）。

    - 白色胶囊卡片（两端半圆）+ 柔和投影（blur 16、向下 4px、黑 24%）；
    - 第一行：标题（13px 粗体近黑 #1F2328）+ 状态短语（13px 粗体，按状态着色：
      ok=Codex 绿 #10A37F，warn=警告黄 #FFB000，error=失败红 #F04438，
      paused=灰）同一行（标题与短语间一个空格）；
    - 第二行（可选）：摘要（13px，颜色默认跟随状态色，可传入 body_color），
      单行，超宽逐字截断；
    - 右侧状态圆圈与右侧圆弧同心；宽高随内容自适应（上限 480px）；
    - 鼠标悬停气泡时高亮暂停圆圈（hover 时可见，移开隐藏）。
    """

    clicked = Signal()
    hoverChanged = Signal(bool)  # 鼠标进入/离开气泡（控制暂停圆圈显隐）

    COLOR_OK = QColor("#10A37F")
    COLOR_WARN = QColor("#FFB000")
    COLOR_ERROR = QColor("#F04438")
    COLOR_BODY_GRAY = QColor("#8A8F98")
    TITLE_COLOR = QColor("#1F2328")

    def __init__(self, parent=None):
        super().__init__(None)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)

        self._title = ""
        self._status = ""
        self._summary = ""
        self._status_color = self.COLOR_OK
        self._body_color = self.COLOR_OK
        self._hovered = False

        # 阴影胶囊（底层）
        self._shadow_card = BubbleCard(self)
        self._shadow_card.setGeometry(BUBBLE_SHADOW_M, BUBBLE_SHADOW_M, 100, 40)
        shadow = QGraphicsDropShadowEffect(self._shadow_card)
        shadow.setBlurRadius(16)
        shadow.setOffset(0, 4)
        shadow.setColor(QColor(0, 0, 0, 60))
        self._shadow_card.setGraphicsEffect(shadow)

        # 内容容器（透明，承载圆圈与文字）
        self._card = QWidget(self)
        self._card.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.circle = StatusCircle(self._card)

        self._title_label = QLabel(self._card)
        self._title_label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self._title_label.setAlignment(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft)
        title_font = self._title_label.font()
        title_font.setPixelSize(13)
        title_font.setBold(True)
        title_font.setFamilies(FONT_FAMILIES)
        self._title_label.setFont(title_font)
        self._title_label.setTextFormat(Qt.TextFormat.RichText)

        self._body_label = QLabel(self._card)
        self._body_label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self._body_label.setAlignment(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft)
        body_font = self._body_label.font()
        body_font.setPixelSize(13)
        body_font.setFamilies(FONT_FAMILIES)
        self._body_label.setFont(body_font)
        self._body_label.setWordWrap(False)

    # ------------------------------------------------------------- hover

    def enterEvent(self, event):
        if not self._hovered:
            self._hovered = True
            self.hoverChanged.emit(True)
        super().enterEvent(event)

    def leaveEvent(self, event):
        if self._hovered:
            self._hovered = False
            self.hoverChanged.emit(False)
        super().leaveEvent(event)

    # ------------------------------------------------------------- 排版

    @staticmethod
    def _elide_line(fm: QFontMetrics, text: str, max_w: int) -> str:
        """单行截断（原版复刻）：逐字符累积（用省略号宽做余量），
        超宽截断并在末尾补省略号 "…"。"""
        text = (text or "").strip()
        if not text:
            return ""
        if fm.horizontalAdvance(text) <= max_w:
            return text
        out = ""
        for ch in text:
            if fm.horizontalAdvance(out + ch + "…") > max_w:
                break
            out += ch
        return out + "…" if out else "…"

    def set_content(
        self,
        title: str = "",
        status_phrase: str = "",
        body: str = "",
        status: str = "ok",
        body_color: QColor | None = None,
    ):
        """设置气泡内容；status: ok / warn / error / paused。"""
        self._title = title
        self._status = status_phrase
        self._summary = body

        if status == "warn":
            self._status_color = self.COLOR_WARN
            self._body_color = body_color if body_color is not None else self.COLOR_WARN
        elif status == "error":
            self._status_color = self.COLOR_ERROR
            self._body_color = body_color if body_color is not None else self.COLOR_ERROR
        elif status == "paused":
            self._status_color = self.COLOR_BODY_GRAY
            self._body_color = self.COLOR_BODY_GRAY
        else:  # ok
            self._status_color = self.COLOR_OK
            self._body_color = body_color if body_color is not None else self.COLOR_OK

        total_max_w = BUBBLE_MAX_WIDTH
        circle_space = BUBBLE_CIRCLE_D + BUBBLE_CIRCLE_GAP
        body_max_w = total_max_w - 2 * BUBBLE_PAD_X - circle_space

        title_fm = self._title_label.fontMetrics()
        body_fm = self._body_label.fontMetrics()
        status_font = self._body_label.font()
        status_font.setPixelSize(13)
        status_font.setBold(True)
        status_fm = QFontMetrics(status_font)

        status_seg = " · " + status_phrase if status_phrase else ""
        status_w = status_fm.horizontalAdvance(status_seg) if status_seg else 0

        # 标题：给状态短语预留宽度后单行截断（最小 30px）
        title_max = max(30, body_max_w - status_w)
        title = self._elide_line(title_fm, title, title_max)
        title_w = title_fm.horizontalAdvance(title)

        # 摘要：单行截断
        body = self._elide_line(body_fm, body, body_max_w)
        body_w = body_fm.horizontalAdvance(body)

        width = max(56, min(total_max_w, max(title_w + status_w, body_w) + 2 * BUBBLE_PAD_X + circle_space))

        esc_title = html.escape(title)
        esc_status = html.escape(status_phrase)
        rich = (
            f'<span style="color:{self.TITLE_COLOR.name()}; font-size:13px; font-weight:bold;">{esc_title}</span>'
        )
        if status_phrase:
            rich += (
                f'<span style="color:{self._status_color.name()}; font-size:13px; font-weight:bold;"> · {esc_status}</span>'
            )
        self._title_label.setStyleSheet("background: transparent;")
        self._title_label.setText(rich)

        cursor_y = BUBBLE_PAD_TOP
        self._title_label.setGeometry(BUBBLE_PAD_X, cursor_y, width - 2 * BUBBLE_PAD_X, BUBBLE_TITLE_H)
        cursor_y += BUBBLE_TITLE_H

        body_h = BUBBLE_LINE_H
        if body:
            self._body_label.setStyleSheet(f"color: {self._body_color.name()}; background: transparent;")
            self._body_label.setText(body)
            self._body_label.setGeometry(BUBBLE_PAD_X, cursor_y + BUBBLE_GAP, width - 2 * BUBBLE_PAD_X, body_h)
            cursor_y += BUBBLE_GAP + body_h
        else:
            self._body_label.setText("")

        height = cursor_y + BUBBLE_PAD_BOTTOM
        self.setFixedSize(width + 2 * BUBBLE_SHADOW_M, height + 2 * BUBBLE_SHADOW_M + BUBBLE_SHADOW_EXTRA)
        self._shadow_card.setGeometry(BUBBLE_SHADOW_M, BUBBLE_SHADOW_M, width, height)
        self._card.setGeometry(BUBBLE_SHADOW_M, BUBBLE_SHADOW_M, width, height)

        radius = height / 2.0
        self.circle.move(
            int(width - radius - BUBBLE_CIRCLE_D / 2.0),
            int((height - BUBBLE_CIRCLE_D) / 2.0),
        )
        self.update()


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


COMMAND_FILE = Path(os.path.expanduser("~")) / ".dsh" / "dsh-pet-command.json"


def _write_command(command: dict) -> None:
    """原子写用户命令文件（~/.dsh/dsh-pet-command.json），插件轮询执行。

    命令：{"cmd": "pause"|"resume", "ts": <epoch>}
    """
    try:
        COMMAND_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = str(COMMAND_FILE) + ".tmp"
        Path(tmp).write_text(json.dumps(command), encoding="utf-8")
        Path(tmp).replace(COMMAND_FILE)
    except OSError:
        _log(f"命令写入失败: {COMMAND_FILE}")


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
        self._circle = self._bubble.circle
        self._circle.clicked.connect(self._on_circle_clicked)
        self._bubble.hoverChanged.connect(self._on_bubble_hover)
        self._completed = False
        self._paused = False  # 用户点击暂停圆圈（任务暂停中）
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

        self._visible_action = None  # _build_menu 中创建；show/hide 事件同步文案
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

        # 气泡第一行黑体 = 任务会话标题（插件在 UserPromptSubmit 时携带，
        # source=="user"）；只在用户新指令时更新，防止 AgentStop 等事件
        # 的 detail（"等待你的输入"等）把标题覆盖掉。
        if source == "user" and detail and not detail.startswith("once:"):
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
            # 原版：标题（回退"任务完成"）+ 短语"任务完成" + AI 总结（灰）
            title = self._task_text or "任务完成"
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
            # 原版：标题（回退"出错"）+ 短语"发生错误" + 错误描述（红）
            title = self._task_text or "出错"
            phrase = "发生错误"
            body = self._action_text or "发生错误"
            status = "error"
        elif self._state == "running":
            title = self._task_text or "正在执行任务"
            phrase = "已暂停" if self._paused else self._status_title()
            status = self._action_status
            if self._has_ai_summary:
                body = self._ai_summary_text
            elif self._action_text and self._action_text != " ":
                body = self._action_text
            else:
                body = ""
            if body:
                body_color = Bubble.COLOR_BODY_GRAY
        elif self._state == "review":
            # 原版：第一行"等待你的输入"，第二行"等待审阅代码变更"
            title = self._task_text or "等待审阅代码变更"
            phrase = "等待你的输入"
            body = "等待审阅代码变更"
        elif self._state == "waiting":
            # 回合结束等待输入：保留气泡（标题 + "等待你的输入"），
            # 避免任务完成后气泡闪断（turn/end → 完成展示之间不空白）。
            title = self._task_text or "正在执行任务"
            phrase = "等待你的输入"
            body = self._ai_summary_text or (self._action_text if self._action_text != " " else "")
            status = "ok"
            if body:
                body_color = Bubble.COLOR_BODY_GRAY
        elif self._state == "jumping" and self._from_business:
            # 原版：第一行"需要你的授权/等待授权确认"，第二行授权提示（黄）
            title = self._task_text or "需要你的授权"
            phrase = "等待授权确认"
            body = self._action_text or "等待授权确认"
            status = "warn"
        else:
            self._bubble.hide()
            return

        if title or phrase or body:
            self._bubble.set_content(title, phrase, body, status, body_color=body_color)
            self._bubble.show()
            self._sync_bubble_pos()

    def set_action(self, text=" ", status="ok", kind="action"):
        """更新气泡第二行（来自状态监听器）。

        kind=action：动作行（工具进度等），不锁定；
        kind=summary：AI 总结行，出现后锁定显示（原版语义），
        新指令（空动作行或"收到指令"）时解锁。
        """
        _log(f"动作行: text={text[:30]!r} status={status} kind={kind}")
        self._action_text = text
        if status in ("ok", "warn", "error"):
            self._action_status = status
        else:
            self._action_status = "ok"
        if kind == "summary":
            if text:
                self._has_ai_summary = True
                self._ai_summary_text = text
        else:  # action 行
            if text == " " or text == "收到指令":
                # 新指令：重置 AI 总结锁定
                self._has_ai_summary = False
                self._ai_summary_text = ""
        if self._show_bubble:
            self._update_bubble()

    def _status_title(self) -> str:
        """running 状态的第一行状态短句（· 后内容）。原版语义精确还原。"""
        action = self._action_text
        if action == "正在思考":
            return "思考中"
        if action == "搜索中":
            return "分析代码"  # 原版如此（保留原版行为）
        if action in self.KNOWN_ACTION_WORDS:
            return "执行任务"
        return "回复中"

    def _mark_completed(self):
        _log("完成展示触发（对勾圆圈 + 完成气泡，10 秒）")
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
            return
        # 任务进行中点击暂停/恢复圆圈：写命令文件，插件轮询执行
        if self._circle.mode() == StatusCircle.MODE_PAUSE:
            self._paused = True
            _write_command({"cmd": "pause", "ts": time.time()})
            _log("请求暂停任务")
        elif self._circle.mode() == StatusCircle.MODE_RESUME:
            self._paused = False
            _write_command({"cmd": "resume", "ts": time.time()})
            _log("请求恢复任务")
        self._update_bubble()

    def _on_bubble_hover(self, hovered: bool):
        # 鼠标进出气泡：刷新圆圈显隐（暂停按钮 hover 可见）
        self._refresh_circle_business()

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
        elif self._state in ("running", "review") and self._bubble._hovered:
            # 任务进行中 + 鼠标悬停气泡：显示暂停/恢复圆圈（默认隐藏）
            self._circle_business = (
                StatusCircle.MODE_RESUME if self._paused else StatusCircle.MODE_PAUSE
            )
        else:
            self._circle_business = StatusCircle.MODE_HIDDEN
        self._circle.set_mode(self._circle_business)

    def _sync_bubble_pos(self):
        visual_w = self._bubble.width() - 2 * BUBBLE_SHADOW_M
        visual_h = self._bubble.height() - 2 * BUBBLE_SHADOW_M
        x = self.x() + self.width() - int(visual_w * 0.7) - BUBBLE_SHADOW_M
        y = self.y() - visual_h + 8 - BUBBLE_SHADOW_M
        self._bubble.move(x, y)

    def moveEvent(self, event):
        super().moveEvent(event)
        self._sync_bubble_pos()

    def showEvent(self, event):
        super().showEvent(event)
        if self._visible_action is not None:
            self._visible_action.setText("隐藏桌宠")
            self._visible_action.setChecked(False)

    def hideEvent(self, event):
        super().hideEvent(event)
        self._bubble.hide()
        if self._visible_action is not None:
            self._visible_action.setText("显示桌宠")
            self._visible_action.setChecked(True)

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

    def set_visible(self, visible: bool):
        """Web 开关按钮/托盘：显示或隐藏桌宠窗口（不改变动画状态）。"""
        if visible:
            self.show()
        else:
            self.hide()
            self._bubble.hide()

    # ------------------------------------------------------------- 托盘菜单

    def current_icon(self) -> QIcon:
        frames = self._pixmaps.get("idle")
        if not frames:
            return QIcon()
        return QIcon(frames[0])

    def _build_pets_menu(self, pets_menu: QMenu):
        """构建（或重建）宠物子菜单：宠物列表 + 刷新入口。"""
        pets_menu.clear()
        self._pet_actions.clear()
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
        pets_menu.addSeparator()
        refresh_action = pets_menu.addAction("刷新宠物列表")
        refresh_action.triggered.connect(self._refresh_pets)

    def _refresh_pets(self):
        """重新扫描宠物包并重建宠物子菜单（无需重启桌宠）。"""
        pets = scan_pets([APP_PETS_ROOT, USER_PETS_ROOT])
        self._pets = pets
        if self._pet is not None and not any(p.name == self._pet.name for p in pets):
            # 当前宠物已被移除：回退到第一个可用宠物
            self._pet = pets[0] if pets else None
            if self._pet is not None:
                self._config["pet"] = self._pet.name
                save_config(CONFIG_FILE, self._config)
            self._build_pixmaps()
            self._state = "idle"
            self._frame_index = 0
            self._resize_to_pet()
            self.pet_changed.emit()
            self.update()
        actions = self._menu.actions()
        if actions:
            pets_menu = actions[0].menu()
            if pets_menu is not None:
                self._build_pets_menu(pets_menu)
        self.refresh_checks()

    def _build_menu(self) -> QMenu:
        menu = QMenu(self)

        pets_menu = menu.addMenu("宠物")
        self._build_pets_menu(pets_menu)

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

        self._visible_action = menu.addAction("隐藏桌宠")
        self._visible_action.triggered.connect(lambda: self.set_visible(not self.isVisible()))
        self._visible_action.setCheckable(True)

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


def apply_visibility_cmd(widget: "PetWidget", cmd: str) -> None:
    """把 visibility_changed 信号（"show"/"hide" 字符串）转为窗口显隐。

    注意：set_visible 接受 bool，若直接把信号连到 set_visible，"hide"
    （truthy 字符串）会被当成显示——这是"关闭无效"的经典错误，
    必须在连接处转换。
    """
    widget.set_visible(cmd == "show")


SHARED_MEM_KEY = "dsh-pet-singleton"


def _acquire_singleton() -> QSharedMemory | None:
    """单实例锁：防止双开（第二个实例 UDP 绑定失败会收不到任何事件）。

    返回持有锁的 QSharedMemory（进程退出自动释放）；已有实例时返回 None。
    崩溃残留（无活进程的共享段）会被清理后重试，避免"再也起不来"。
    """
    shared = QSharedMemory(SHARED_MEM_KEY)
    if shared.create(1):
        return shared
    if shared.attach():
        shared.detach()
        if shared.create(1):
            return shared
    return None


def main() -> int:
    # 单实例锁：已有桌宠运行时直接退出（双开会抢 UDP 端口，
    # 第二个实例收不到任何事件，表现为"按钮没用"）。
    singleton = _acquire_singleton()
    if singleton is None:
        _log("已有桌宠实例在运行，本次启动退出（防双开）")
        return 0

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

    pets = scan_pets([APP_PETS_ROOT, USER_PETS_ROOT])
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
        # 信号参数是 "show"/"hide" 字符串：必须转换（直接连接会把
        # "hide" 当 truthy 执行 show()，导致"关闭无效"）。
        listener.visibility_changed.connect(lambda cmd: apply_visibility_cmd(widget, cmd))
        listener.quit_requested.connect(app.quit)

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
