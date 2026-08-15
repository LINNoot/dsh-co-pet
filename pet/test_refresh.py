# -*- coding: utf-8 -*-
"""“刷新宠物列表”功能测试（offscreen，无 GUI 显示）。

用法：
    .venv\\Scripts\\python.exe pet\\test_refresh.py
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

import pet_app  # noqa: E402
from pet_loader import scan_pets  # noqa: E402

HERE = Path(__file__).resolve().parent
SRC_PETS = HERE / "pets"

FAILURES = []


def check(name, cond, extra=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")
    if not cond:
        FAILURES.append(name)


def main():
    app = QApplication(sys.argv)

    with tempfile.TemporaryDirectory() as tmp:
        pets_root = Path(tmp) / "pets"
        pets_root.mkdir()
        # 初始只有 yuexinmiao
        shutil.copytree(SRC_PETS / "yuexinmiao", pets_root / "yuexinmiao")

        # monkeypatch 扫描根（frozen 判定下 APP_PETS_ROOT 是模块级常量）
        pet_app.APP_PETS_ROOT = Path(tmp)
        pet_app.USER_PETS_ROOT = Path(tmp) / "user"  # 指向不存在的目录，避免干扰

        pets = scan_pets([pet_app.APP_PETS_ROOT, pet_app.USER_PETS_ROOT])
        check("初始扫描到 1 个宠物", len(pets) == 1, f"({[p.name for p in pets]})")

        widget = pet_app.PetWidget(pets[0], dict(pet_app.DEFAULT_CONFIG), pets)
        pets_menu = widget._menu.actions()[0].menu()
        check("菜单宠物项 = 1", len(widget._pet_actions) == 1)

        # 新宠物加入
        shutil.copytree(SRC_PETS / "yuexin", pets_root / "yuexin")
        widget._refresh_pets()

        check("刷新后 _pets = 2", len(widget._pets) == 2, f"({[p.name for p in widget._pets]})")
        check("刷新后菜单宠物项 = 2", len(widget._pet_actions) == 2)
        check("当前宠物未丢失", widget._pet is not None and widget._pet.name == "yuexinmiao-mix")

        # 删除当前宠物 → 回退到第一个
        shutil.rmtree(pets_root / "yuexinmiao", ignore_errors=True)
        widget._refresh_pets()
        check("删除当前宠物后回退", widget._pet is not None and widget._pet.name != "yuexinmiao-mix")
        check("回退后菜单 = 1", len(widget._pet_actions) == 1)

        # 全部删除 → 无宠物
        shutil.rmtree(pets_root / "yuexin", ignore_errors=True)
        widget._refresh_pets()
        check("全部删除后无宠物", len(widget._pets) == 0 and len(widget._pet_actions) == 0)

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项: {FAILURES}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
