# -*- coding: utf-8 -*-
"""DSH 桌宠 — 界面风格（Codex 风格 QSS + SF Pro 字体）。

字体查找顺序：应用目录 `fonts/` → 系统 "SF Pro Text" → "Microsoft YaHei UI" →
"Microsoft YaHei"。字体目录缺失时自动回退系统字体。
"""
from __future__ import annotations

from pathlib import Path

FONT_FAMILIES = ["SF Pro Text", "Microsoft YaHei UI", "Microsoft YaHei"]

CODEX_QSS = """
QMenu {
    background-color: #FFFFFF;
    border: 1px solid #E3E3E3;
    border-radius: 8px;
    padding: 6px;
}
QMenu::item {
    background-color: transparent;
    color: #1F2328;
    padding: 7px 28px 7px 14px;
    border-radius: 5px;
    font-size: 13px;
}
QMenu::item:selected {
    background-color: #E9F7F2;
    color: #0F766E;
}
QMenu::item:disabled {
    color: #9DA3AE;
}
QMenu::separator {
    height: 1px;
    background-color: #EDEDED;
    margin: 4px 10px;
}
QMenu::indicator {
    width: 14px;
    height: 14px;
    border-radius: 3px;
}
QMenu::indicator:checked {
    background-color: #10A37F;
    image: __CHECK_IMAGE__;
}
QMenu::indicator:unchecked {
    background-color: transparent;
}

QPushButton {
    background-color: #FFFFFF;
    border: 1px solid #D9D9D9;
    border-radius: 6px;
    padding: 7px 18px;
    color: #1F2328;
    font-size: 13px;
}
QPushButton:hover {
    border-color: #10A37F;
    color: #0F766E;
}
QPushButton:pressed {
    background-color: #F2F2F2;
}
QPushButton:default {
    background-color: #10A37F;
    border-color: #10A37F;
    color: #FFFFFF;
}
QPushButton:default:hover {
    background-color: #0E8F6F;
    border-color: #0E8F6F;
}
QPushButton:default:pressed {
    background-color: #0C7A5E;
}

QCheckBox {
    color: #1F2328;
    font-size: 13px;
    spacing: 8px;
}
QCheckBox::indicator {
    width: 16px;
    height: 16px;
    border: 1px solid #C9CDD4;
    border-radius: 4px;
    background-color: #FFFFFF;
}
QCheckBox::indicator:hover {
    border-color: #10A37F;
}
QCheckBox::indicator:checked {
    background-color: #10A37F;
    border-color: #10A37F;
    image: __CHECK_IMAGE__;
}

QLabel {
    color: #1F2328;
    font-size: 13px;
}

QMessageBox {
    background-color: #FFFFFF;
}
QMessageBox QLabel {
    font-size: 13px;
}

QToolTip {
    background-color: #FFFFFF;
    color: #1F2328;
    border: 1px solid #E3E3E3;
    border-radius: 6px;
    padding: 5px 8px;
}

QDialog {
    background-color: #FFFFFF;
}
#CodexDialog {
    background-color: #FBFBFC;
}
"""


def load_apple_fonts(fonts_roots) -> bool:
    """从给定根目录加载 fonts/SF-Pro-Text-*.otf；成功加载返回 True。"""
    from PySide6.QtGui import QFontDatabase

    loaded = False
    for root in fonts_roots:
        fonts_dir = Path(root) / "fonts"
        if not fonts_dir.is_dir():
            continue
        for name in ("SF-Pro-Text-Regular.otf", "SF-Pro-Text-Bold.otf"):
            path = fonts_dir / name
            if path.is_file():
                try:
                    if QFontDatabase.addApplicationFont(str(path)) >= 0:
                        loaded = True
                except Exception:
                    pass
    return loaded


def _find_asset_path(name: str) -> Path | None:
    """在任意根目录下查找资源文件，返回真实路径。"""
    for root in _assets_roots:
        p = Path(root) / name
        if p.is_file():
            return p
    return None


def _find_asset_data_uri(name: str) -> str | None:
    """在任意根目录下查找资源文件，返回 base64 data URI（QSS 兜底用）。"""
    import base64

    for root in _assets_roots:
        p = Path(root) / name
        if p.is_file():
            try:
                data = p.read_bytes()
            except OSError:
                continue
            return "data:image/png;base64," + base64.b64encode(data).decode("ascii")
    return None


def _resolve_check_image() -> str:
    """返回 QSS ``image:`` 可用的 check.png 引用。

    Qt 样式表对 base64 data URI 支持不可靠（绿框有、对勾不渲染），
    因此优先真实文件路径：应用目录 ``assets/check.png``（绿色使用模式
    exe/脚本旁必须带 assets/），其次 PyInstaller 内嵌资源，最后 data URI
    兜底（总比什么都没有好）。
    """
    import sys

    # 1) 各根目录下的 check.png / assets/check.png（exe 旁或脚本旁）
    for name in ("check.png", "assets/check.png"):
        p = _find_asset_path(name)
        if p is not None:
            return f'url("{p.resolve().as_posix()}")'

    # 2) PyInstaller onefile 内嵌资源（--add-data "assets;assets"）
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        p = Path(meipass) / "assets" / "check.png"
        if p.is_file():
            return f'url("{p.resolve().as_posix()}")'

    # 3) data URI 兜底
    uri = _find_asset_data_uri("check.png") or _find_asset_data_uri("assets/check.png")
    if uri:
        return f"url({uri})"

    return "none"


_assets_roots: list = []


def apply_codex_style(app, roots=()) -> None:
    """应用 Codex 风格 QSS，并注册字体（roots 为字体/资源查找根目录）。"""
    global _assets_roots
    _assets_roots = list(roots)

    load_apple_fonts(roots)

    qss = CODEX_QSS.replace("__CHECK_IMAGE__", _resolve_check_image())
    app.setStyleSheet(qss)
