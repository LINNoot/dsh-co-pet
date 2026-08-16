# -*- coding: utf-8 -*-
"""“刷新宠物列表”功能测试（offscreen，无 GUI 显示）。

用法：
    .venv\\Scripts\\python.exe pet\\test_refresh.py
"""
import os
import shutil
import sys
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

    # 沙箱环境下 tempfile.TemporaryDirectory 的权限重置逻辑会被拒，
    # 手动建目录（直接 mkdir 已验证可行）
    tmp = HERE / ".tmp_test" / f"run_{os.getpid()}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        _run_case(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项: {FAILURES}")
        return 1
    print("全部通过")
    return 0


def _run_case(tmp):
    pets_root = tmp / "pets"
    pets_root.mkdir()
    # 初始只有 yuexinmiao
    shutil.copytree(SRC_PETS / "yuexinmiao", pets_root / "yuexinmiao")

    # monkeypatch 扫描根（frozen 判定下 APP_PETS_ROOT 是模块级常量）
    pet_app.APP_PETS_ROOT = tmp
    pet_app.USER_PETS_ROOT = tmp / "user"  # 指向不存在的目录，避免干扰

    pets = scan_pets([pet_app.APP_PETS_ROOT, pet_app.USER_PETS_ROOT])
    check("初始扫描到 1 个宠物", len(pets) == 1, f"({[p.name for p in pets]})")

    widget = pet_app.PetWidget(pets[0], dict(pet_app.DEFAULT_CONFIG), pets)
    pets_menu = widget._menu.actions()[0].menu()
    check("菜单宠物项 = 1", len(widget._pet_actions) == 1)

    # waiting 态保留气泡（turn/end → 完成展示之间不闪断）
    widget._task_text = "审查codex桌宠代码准备移植"
    widget.set_state("waiting", "等待你的输入")
    check("waiting 保留气泡", widget._bubble.isVisible())
    check("waiting 气泡标题", "审查codex桌宠代码准备移植" in widget._bubble._title_label.text())
    check("waiting 气泡短语", "等待你的输入" in widget._bubble._title_label.text())
    # running 态气泡正常（回归）
    widget.set_state("running", "任务进行中")
    check("running 显示气泡", widget._bubble.isVisible())

    # 暂停圆圈：hover 显示灰方块、暂停后显示恢复三角、非 hover 隐藏
    widget._bubble._hovered = False
    widget._refresh_circle_business()
    check("非 hover 圆圈隐藏", widget._circle.mode() == pet_app.StatusCircle.MODE_HIDDEN)
    widget._bubble._hovered = True
    widget._refresh_circle_business()
    check("hover 显示暂停圆圈", widget._circle.mode() == pet_app.StatusCircle.MODE_PAUSE)
    widget._paused = True
    widget._refresh_circle_business()
    check("暂停后 hover 显示恢复圆圈", widget._circle.mode() == pet_app.StatusCircle.MODE_RESUME)
    widget._paused = False
    widget._bubble._hovered = False
    widget._refresh_circle_business()
    check("恢复后非 hover 再隐藏", widget._circle.mode() == pet_app.StatusCircle.MODE_HIDDEN)

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


if __name__ == "__main__":
    sys.exit(main())
