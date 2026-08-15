# -*- coding: utf-8 -*-
"""气泡排版测试（offscreen）：尺寸自适应、省略、无重叠。

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

    # 1. 短内容：宽度贴合文本、高度一行
    b.set_content("帮我重构模块", "执行任务中", "", "ok")
    w1, h1 = b.width(), b.height()
    from PySide6.QtGui import QFontMetrics
    head_w = QFontMetrics(b.font()).horizontalAdvance("帮我重构模块 · 执行任务中")
    expect_w = head_w + pet_app.BUBBLE_PAD_X * 2 + pet_app.BUBBLE_CIRCLE_D + pet_app.BUBBLE_CIRCLE_GAP
    check("短内容宽度贴合文本", abs(w1 - expect_w) <= 2, f"(w={w1}, expect≈{expect_w})")
    check("短内容高度 = 标题行 + 内边距", h1 == pet_app.BUBBLE_PAD_TOP + pet_app.BUBBLE_HEAD_H + pet_app.BUBBLE_PAD_BOTTOM, f"({h1})")

    # 2. 长标题：整体省略、不超上限
    b.set_content("这是一个非常非常长的任务标题用来测试省略效果是否正常工作", "等待你的输入", "", "ok")
    check("长标题不超上限", b.width() <= pet_app.BUBBLE_MAX_WIDTH, f"({b.width()})")
    head = b._head_label
    check("长标题被省略（含 …）", "…" in head.text(), f"({head.text()[:30]}…)")

    # 3. 摘要多行：最多两行、有省略
    long_body = "第一行摘要内容比较长需要换行处理。" * 6
    b.set_content("任务", "正在执行任务", long_body, "ok")
    body_text = b._body_label.text()
    lines = body_text.split("\n")
    check("摘要 ≤ 2 行", 1 <= len(lines) <= pet_app.BUBBLE_BODY_MAX_LINES, f"({len(lines)} 行)")
    check("末行有省略号", "…" in lines[-1] if len(lines) == 2 else True)
    check("含摘要时高度增加", b.height() > pet_app.BUBBLE_PAD_TOP + pet_app.BUBBLE_HEAD_H + pet_app.BUBBLE_PAD_BOTTOM)

    # 4. 无重叠：文字区右缘 ≤ 圆圈左缘；文字区左缘 = 内边距
    text_right = b._head_label.x() + b._head_label.width()
    circle_left = b._circle.x()
    check("文字与圆圈无重叠", text_right <= circle_left, f"(text_right={text_right}, circle_left={circle_left})")
    check("左内边距正确", b._head_label.x() == pet_app.BUBBLE_PAD_X)

    # 5. 圆圈垂直居中
    cy = b._circle.y() + b._circle.height() // 2
    check("圆圈垂直居中", abs(cy - b.height() // 2) <= 1, f"(cy={cy}, h/2={b.height()//2})")

    # 6. 三种状态色（QColor.name() 输出小写）
    for status, color in (("ok", "#10a37f"), ("warn", "#ffb000"), ("error", "#f04438")):
        b.set_content("任务", "需要你的授权", "等待授权确认", status)
        check(f"状态 {status} 颜色正确", color in b._head_label.text().lower())

    # 7. 无标题、仅短语
    b.set_content("", "等待你的输入", "", "ok")
    check("无标题时显示短语", "等待你的输入" in b._head_label.text())

    # 8. 完成态（绿勾 + 摘要）
    b.set_content("移植桌宠", "任务完成", "全部完成，共修改 12 个文件", "ok", body_color=b.COLOR_BODY_GRAY)
    check("完成态正常渲染", b.width() <= pet_app.BUBBLE_MAX_WIDTH and "任务完成" in b._head_label.text())

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项: {FAILURES}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
