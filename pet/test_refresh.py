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


def _force_rmtree(path):
    """删除目录树；Windows 上先清除只读属性（宠物包 说明.txt 自带 ReadOnly，
    copytree 复制后 rmtree 会 PermissionError 导致 .tmp_test 残留）。"""
    import stat

    def _onexc(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass

    shutil.rmtree(path, onexc=_onexc)


def main():
    app = QApplication(sys.argv)

    # 沙箱环境下 tempfile.TemporaryDirectory 的权限重置逻辑会被拒，
    # 手动建目录（直接 mkdir 已验证可行）
    tmp = HERE / ".tmp_test" / f"run_{os.getpid()}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        _run_case(tmp)
    finally:
        _force_rmtree(tmp)
        try:
            tmp.parent.rmdir()  # 清理空壳父目录（.tmp_test）
        except OSError:
            pass  # 非空（并发测试占用）则保留

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

    pets = scan_pets([pet_app.APP_PETS_ROOT])
    check("初始扫描到 1 个宠物", len(pets) == 1, f"({[p.name for p in pets]})")

    widget = pet_app.PetWidget(pets[0], dict(pet_app.DEFAULT_CONFIG), pets)
    # 注意：不要用 widget._menu.actions()[0].menu() 链式取宠物子菜单——
    # 临时 QAction 包装被 GC 时会连带销毁 C++ QMenu 及其子 actions（PySide6 行为），
    # 导致后面 setChecked 报 "already deleted"。widget 持久持有 _pets_menu。
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

    # 中断圆圈：hover 显示灰方块、非 hover 隐藏、中断后不再显示
    widget._bubble._hovered = False
    widget._refresh_circle_business()
    check("非 hover 圆圈隐藏", widget._circle.mode() == pet_app.StatusCircle.MODE_HIDDEN)
    widget._bubble._hovered = True
    widget._refresh_circle_business()
    check("hover 显示中断圆圈", widget._circle.mode() == pet_app.StatusCircle.MODE_INTERRUPT)
    widget._interrupted = True
    widget._refresh_circle_business()
    check("中断后圆圈不再显示", widget._circle.mode() == pet_app.StatusCircle.MODE_HIDDEN)
    widget._interrupted = False
    widget._bubble._hovered = False
    widget._refresh_circle_business()
    check("恢复后非 hover 再隐藏", widget._circle.mode() == pet_app.StatusCircle.MODE_HIDDEN)

    # 完成展示结束：气泡与圆圈彻底隐藏（不再有"等待你的输入"残留气泡）
    widget.set_state("waiting", "等待你的输入")
    widget._mark_completed()
    check("完成展示气泡显示", widget._bubble.isVisible())
    widget._on_completed_timeout()
    check("完成展示结束气泡隐藏", not widget._bubble.isVisible())
    check("完成展示结束圆圈隐藏", widget._circle.mode() == pet_app.StatusCircle.MODE_HIDDEN)

    # 宠物菜单勾选防御：掉勾后 refresh_checks 必须恢复（与实际宠物一致）
    current_pet = widget._pet
    current_action = next(a for p, a in widget._pet_actions if p.name == current_pet.name)
    current_action.setChecked(False)  # 模拟菜单点击 toggle 掉勾
    widget.refresh_checks()  # _enforce_pet_check 调度的是 refresh_checks
    check("点击当前宠物项勾选保持", current_action.isChecked())
    # 未选中的项必须无勾
    for p, a in widget._pet_actions:
        if p.name != current_pet.name:
            check("非当前项无勾", not a.isChecked())

    # 新宠物加入（复制 yuexinmiao 并改 id，模拟另一个宠物包）
    import json as _json

    new_dir = pets_root / "yuexin-copy"
    shutil.copytree(SRC_PETS / "yuexinmiao", new_dir)
    meta = _json.loads((new_dir / "pet.json").read_text(encoding="utf-8"))
    meta["id"] = "yuexin-copy"
    (new_dir / "pet.json").write_text(_json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    widget._refresh_pets()

    check("刷新后 _pets = 2", len(widget._pets) == 2, f"({[p.name for p in widget._pets]})")
    check("刷新后菜单宠物项 = 2", len(widget._pet_actions) == 2)
    check("当前宠物未丢失", widget._pet is not None and widget._pet.name == "yuexinmiao")

    # 删除当前宠物 → 回退到第一个
    _force_rmtree(pets_root / "yuexinmiao")
    widget._refresh_pets()
    check("删除当前宠物后回退", widget._pet is not None and widget._pet.name != "yuexinmiao")
    check("回退后菜单 = 1", len(widget._pet_actions) == 1)

    # 全部删除 → 无宠物
    _force_rmtree(new_dir)
    widget._refresh_pets()
    check("全部删除后无宠物", len(widget._pets) == 0 and len(widget._pet_actions) == 0)


if __name__ == "__main__":
    sys.exit(main())
