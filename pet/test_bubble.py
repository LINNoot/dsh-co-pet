# -*- coding: utf-8 -*-
"""气泡排版测试（offscreen）：原版 Codex 布局——胶囊卡片、标题+短语同行、
摘要单行截断、圆圈靠右居中。

用法：
    .venv\\Scripts\\python.exe pet\\test_bubble.py
"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

import pet_app  # noqa: E402

FAILURES = []


def check(name, cond, extra=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")
    if not cond:
        FAILURES.append(name)


def main():
    app = QApplication(sys.argv)
    b = pet_app.Bubble()

    # 1. 短内容：标题+短语同行，宽度贴合、高度=标题行+内边距
    b.set_content("帮我重构模块", "执行任务中", "", "ok")
    w1, h1 = b.width(), b.height()
    inner_w = w1 - 2 * pet_app.BUBBLE_SHADOW_M
    inner_h = h1 - 2 * pet_app.BUBBLE_SHADOW_M - pet_app.BUBBLE_SHADOW_EXTRA
    check("短内容高度 = 标题行 + 上下内边距",
          inner_h == pet_app.BUBBLE_PAD_TOP + pet_app.BUBBLE_TITLE_H + pet_app.BUBBLE_PAD_BOTTOM,
          f"(inner_h={inner_h})")
    check("窗口含投影边距", w1 >= inner_w + 2 * pet_app.BUBBLE_SHADOW_M and h1 >= inner_h + 2 * pet_app.BUBBLE_SHADOW_M)

    # 2. 标题与短语同行（RichText 两个 span，原版分隔符 " · "）
    rich = b._title_label.text()
    check("标题在 RichText 中", "帮我重构模块" in rich)
    check("状态短语同一行（· 分隔）", " · 执行任务中" in rich)

    # 3. 长标题：截断（原版末尾补省略号 "…"）
    b.set_content("这是一个非常非常长的任务标题用来测试省略效果是否正常工作", "等待你的输入", "", "ok")
    check("长标题不超上限", b.width() <= pet_app.BUBBLE_MAX_WIDTH + 2 * pet_app.BUBBLE_SHADOW_M, f"({b.width()})")
    fm_title = b._title_label.fontMetrics()
    title_text = b._title_label.text()
    # RichText 文本宽度不应超过可用宽度（截断保证）
    check("标题行被截断", "…" in title_text, f"({title_text[:40]})")
    check("截断末尾带省略号", "…" in title_text.split("</span>")[0], f"({title_text[:40]})")

    # 4. 摘要：单行截断、颜色默认跟随状态色
    long_body = "第一行摘要内容比较长需要换行处理。" * 6
    b.set_content("任务", "正在执行任务", long_body, "ok")
    body_text = b._body_label.text()
    check("摘要单行", "\n" not in body_text)
    check("摘要被截断（变短）", len(body_text) < len(long_body), f"({len(body_text)}/{len(long_body)})")
    check("摘要颜色默认跟随状态色(ok=绿)", "#10a37f" in b._body_label.styleSheet().lower())

    # 5. 颜色：warn / error / paused
    for status, color in (("warn", "#ffb000"), ("error", "#f04438"), ("paused", "#8a8f98")):
        b.set_content("任务", "需要你的授权", "等待授权确认", status)
        check(f"状态 {status} 颜色正确", color in b._title_label.text().lower())

    # 6. 文本实际宽度不与圆圈重叠（label 区域本身通栏，原版即如此）
    b.set_content("任务", "需要你的授权", "等待授权确认", "paused")
    circle_left = b.circle.x()
    plain = (b._title + (" " + b._status if b._status else "")).strip()
    text_w = b._title_label.fontMetrics().horizontalAdvance(plain)
    check("文本实际宽度不与圆圈重叠", b._title_label.x() + text_w <= circle_left,
          f"(text_right={b._title_label.x() + text_w}, circle_left={circle_left})")

    # 7. 圆圈靠右、垂直居中（原版公式：x = width - radius - D/2）
    inner_w2 = b.width() - 2 * pet_app.BUBBLE_SHADOW_M
    inner_h2 = b.height() - 2 * pet_app.BUBBLE_SHADOW_M - pet_app.BUBBLE_SHADOW_EXTRA
    expect_x = int(inner_w2 - inner_h2 / 2.0 - pet_app.BUBBLE_CIRCLE_D / 2.0)
    check("圆圈 X 符合原版公式", b.circle.x() == expect_x, f"(x={b.circle.x()}, expect={expect_x})")
    expect_y = int((inner_h2 - pet_app.BUBBLE_CIRCLE_D) / 2.0)
    check("圆圈 Y 垂直居中", b.circle.y() == expect_y, f"(y={b.circle.y()}, expect={expect_y})")

    # 8. 无标题、仅短语
    b.set_content("", "等待你的输入", "", "ok")
    check("无标题时只显示短语", "等待你的输入" in b._title_label.text() and "任务" not in b._title_label.text())

    # 9. 完成态（绿勾 + 灰色摘要）
    b.set_content("移植桌宠", "任务完成", "全部完成，共修改 12 个文件", "ok", body_color=b.COLOR_BODY_GRAY)
    check("完成态正常渲染", "任务完成" in b._title_label.text())
    check("完成态摘要为灰色", "#8a8f98" in b._body_label.styleSheet().lower())

    # 10. 状态圆圈：hover 光晕 + 点击信号（原版复刻）
    from PySide6.QtCore import Qt, QEvent, QPointF
    from PySide6.QtGui import QEnterEvent, QMouseEvent

    c = b.circle
    c.set_mode(c.MODE_DONE)
    clicks = []
    c.clicked.connect(lambda: clicks.append(1))
    # hover：进入后 _hovered=True 且光标为手型
    c.enterEvent(QEnterEvent(QPointF(0, 0), QPointF(0, 0), QPointF(0, 0)))
    check("hover 置位", c._hovered)
    check("hover 手型光标", c.cursor().shape() == Qt.CursorShape.PointingHandCursor)
    c.leaveEvent(QEvent(QEvent.Type.Leave))
    check("leave 复位 hover", not c._hovered)
    # 点击（非隐藏态）发出 clicked
    release = QMouseEvent(
        QEvent.Type.MouseButtonRelease, QPointF(14, 14), Qt.LeftButton, Qt.LeftButton, Qt.KeyboardModifier.NoModifier
    )
    c.mouseReleaseEvent(release)
    check("点击非隐藏态发出 clicked", len(clicks) == 1)
    # 隐藏态点击不响应
    c.set_mode(c.MODE_HIDDEN)
    c.mouseReleaseEvent(release)
    check("隐藏态点击不响应", len(clicks) == 1)

    # 11. visibility 指令 → set_visible 布尔转换（回归：直接连接信号会把
    # "hide"（truthy 字符串）当显示执行，导致"关闭无效"）
    class FakeWidget:
        def __init__(self):
            self.visible = True

        def set_visible(self, v):
            self.visible = v

    fw = FakeWidget()
    pet_app.apply_visibility_cmd(fw, "hide")
    check("hide → 隐藏", fw.visible is False)
    pet_app.apply_visibility_cmd(fw, "show")
    check("show → 显示", fw.visible is True)

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项: {FAILURES}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
