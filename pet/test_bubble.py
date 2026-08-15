# -*- coding: utf-8 -*-
"""气泡排版测试（offscreen）：Apple 分层布局——尺寸自适应、省略、无重叠。

用法：
    .venv\\Scripts\\python.exe pet\\test_bubble.py
"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtGui import QFontMetrics  # noqa: E402
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

    # 1. 短内容（标题 + 短语）：宽度贴合文本、高度 = 两行 + 内边距
    b.set_content("帮我重构模块", "执行任务中", "", "ok")
    w1, h1 = b.width(), b.height()
    fm = QFontMetrics(b._title_font)
    content_w = fm.horizontalAdvance("帮我重构模块")
    expect_w = content_w + pet_app.BUBBLE_PAD_X * 2 + pet_app.BUBBLE_CIRCLE_D + pet_app.BUBBLE_CIRCLE_GAP
    check("短内容宽度贴合文本", abs(w1 - expect_w) <= 2, f"(w={w1}, expect≈{expect_w})")
    expect_h = (
        pet_app.BUBBLE_PAD_TOP
        + pet_app.BUBBLE_TITLE_H
        + pet_app.BUBBLE_GAP
        + pet_app.BUBBLE_PHRASE_H
        + pet_app.BUBBLE_PAD_BOTTOM
    )
    check("高度 = 标题+短语两行+内边距", h1 == expect_h, f"({h1})")

    # 2. 分层：标题与短语在不同行
    check("标题独立成行", b._title_label.text() == "帮我重构模块")
    check("短语独立成行", b._phrase_label.text() == "执行任务中")
    check("标题在短语上方", b._title_label.y() < b._phrase_label.y())

    # 3. 长标题：省略、不超上限
    b.set_content("这是一个非常非常长的任务标题用来测试省略效果是否正常工作", "等待你的输入", "", "ok")
    check("长标题不超上限", b.width() <= pet_app.BUBBLE_MAX_WIDTH, f"({b.width()})")
    check("长标题被省略（含 …）", "…" in b._title_label.text(), f"({b._title_label.text()[:26]}…)")

    # 4. 摘要多行：最多两行、末行省略
    long_body = "第一行摘要内容比较长需要换行处理。" * 6
    b.set_content("任务", "正在执行任务", long_body, "ok")
    lines = b._body_label.text().split("\n")
    check("摘要 ≤ 2 行", 1 <= len(lines) <= pet_app.BUBBLE_BODY_MAX_LINES, f"({len(lines)} 行)")
    check("两行时末行有省略号", "…" in lines[-1] if len(lines) == 2 else True)
    check("含摘要时高度增加", b.height() > b._phrase_label.y() + pet_app.BUBBLE_PHRASE_H + pet_app.BUBBLE_PAD_BOTTOM)

    # 5. 无重叠：各文字区右缘 ≤ 圆圈左缘；左缘 = 内边距
    circle_left = b._circle.x()
    for label in (b._title_label, b._phrase_label, b._body_label):
        check(f"文字区({label.objectName() or label is b._title_label})与圆圈无重叠",
              label.x() + label.width() <= circle_left,
              f"(right={label.x() + label.width()}, circle_left={circle_left})")
    check("左内边距正确", b._title_label.x() == pet_app.BUBBLE_PAD_X)

    # 6. 圆圈垂直居中
    cy = b._circle.y() + b._circle.height() // 2
    check("圆圈垂直居中", abs(cy - b.height() // 2) <= 1, f"(cy={cy}, h/2={b.height()//2})")

    # 7. 三种状态色（styleSheet 中，QColor.name() 输出小写）
    for status, color in (("ok", "#10a37f"), ("warn", "#ffb000"), ("error", "#f04438")):
        b.set_content("任务", "需要你的授权", "等待授权确认", status)
        check(f"状态 {status} 颜色正确", color in b._phrase_label.styleSheet().lower())

    # 8. 无标题、仅短语
    b.set_content("", "等待你的输入", "", "ok")
    check("无标题时隐藏标题行", b._title_label.text() == "")
    check("无标题时显示短语", "等待你的输入" in b._phrase_label.text())
    check("无标题高度 = 短语行+内边距",
          b.height() == pet_app.BUBBLE_PAD_TOP + pet_app.BUBBLE_PHRASE_H + pet_app.BUBBLE_PAD_BOTTOM)

    # 9. 完成态（绿勾 + 摘要）
    b.set_content("移植桌宠", "任务完成", "全部完成，共修改 12 个文件", "ok", body_color=b.COLOR_BODY_GRAY)
    check("完成态正常渲染", b.width() <= pet_app.BUBBLE_MAX_WIDTH and "任务完成" in b._phrase_label.text())

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项: {FAILURES}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
