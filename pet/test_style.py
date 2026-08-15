# -*- coding: utf-8 -*-
"""菜单勾选图标（check.png）样式测试：QSS 引用必须可加载。

用法：
    .venv\\Scripts\\python.exe pet\\test_style.py
"""
import os
import re
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtGui import QPixmap  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

import pet_style  # noqa: E402

HERE = Path(__file__).resolve().parent
FAILURES = []


def check(name, cond, extra=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")
    if not cond:
        FAILURES.append(name)


def main():
    app = QApplication(sys.argv)

    # 1. 正常路径：应用目录 assets/check.png → QSS 用文件路径且可加载
    pet_style.apply_codex_style(app, [HERE, HERE / "assets"])
    qss = app.styleSheet()
    check("占位符已替换", "__CHECK_IMAGE__" not in qss)
    m = re.search(r"image:\s*url\(\"([^\"]+)\"\)", qss)
    check("QSS 使用文件路径引用", m is not None, f"({qss[qss.find('indicator:checked'):qss.find('indicator:checked')+120] if 'indicator:checked' in qss else ''})")
    if m:
        pix = QPixmap(m.group(1))
        check("check.png 可加载（QPixmap 非空）", not pix.isNull(), f"({m.group(1)})")
        check("引用的是真实文件", Path(m.group(1)).is_file())

    # 2. 兜底场景：roots 全为空目录 → 不崩溃、无占位符残留
    with tempfile.TemporaryDirectory() as tmp:
        pet_style.apply_codex_style(app, [Path(tmp)])
        qss2 = app.styleSheet()
        check("无资源时不崩溃", "__CHECK_IMAGE__" not in qss2)

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项: {FAILURES}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
