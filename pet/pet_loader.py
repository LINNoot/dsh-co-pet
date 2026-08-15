# -*- coding: utf-8 -*-
"""DSH 桌宠 — 宠物包加载器。

按 Codex 宠物包规则读取 `pets/<name>/` 下的宠物包：

- `pet.json`（可选）：`id` / `displayName` / `description` / `spriteVersionNumber`
- `spritesheet.webp|png|gif`：8 列 × 9 行（v1）或 × 11 行（v2，多 look-0/look-1 两行）

每格按可见像素（alpha>0 的像素数）过滤，少于 ``MIN_VISIBLE_PIXELS``
的空帧会被剔除；缺帧状态用 idle（或第一个非空状态）回退填充。

状态行顺序与 Codex 一致：idle / running-right / running-left / waving /
jumping / failed / waiting / running / review（v2 追加 look-0 / look-1）。
"""
from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

#: 标准动画状态（9 行 = v1；v2 在其后追加 look 行）
STANDARD_STATES: list[str] = [
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
]

#: v2 精灵图追加的两行（不参与业务状态切换）
LOOK_ROW_NAMES: list[str] = ["look-0", "look-1"]

#: 精灵图固定列数
FRAME_COLUMNS = 8

#: 支持的精灵图文件名（按优先级）
SUPPORTED_SHEET_NAMES = ("spritesheet.webp", "spritesheet.png", "spritesheet.gif")

#: 一帧最少可见像素数，低于此值的帧视为空帧剔除
MIN_VISIBLE_PIXELS = 20


@dataclass
class Pet:
    """一个已加载的宠物包。"""

    name: str
    display_name: str
    description: str
    path: Path
    sheet_path: Path
    meta: dict
    sprite_version_number: int
    cell_w: int
    cell_h: int
    rows: list[str]
    frames: dict[str, list[Image.Image]] = field(default_factory=dict)
    frame_duration_ms: int = 100

    def state_rows(self) -> list[str]:
        return self.rows


def _find_sheet(pet_dir: Path) -> Path | None:
    for name in SUPPORTED_SHEET_NAMES:
        p = pet_dir / name
        if p.is_file():
            return p
    return None


def _load_meta(pet_dir: Path) -> dict:
    meta_file = pet_dir / "pet.json"
    if not meta_file.is_file():
        return {}
    try:
        data = json.loads(meta_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _visible_pixel_count(image: Image.Image) -> int:
    """alpha 直方图中 alpha>0 的像素总数。"""
    hist = image.getchannel("A").histogram()
    return sum(hist[1:])


def load_pet(pet_dir) -> Pet:
    """加载一个宠物包；目录或精灵图无效时抛 ``ValueError``。"""
    pet_dir = Path(pet_dir)
    if not pet_dir.is_dir():
        raise ValueError(f"不是目录: {pet_dir}")

    sheet = _find_sheet(pet_dir)
    if sheet is None:
        raise ValueError(f"缺少 spritesheet: {pet_dir}")

    meta = _load_meta(pet_dir)

    try:
        image = Image.open(sheet).convert("RGBA")
    except OSError as exc:
        raise ValueError(f"无法打开 {sheet}: {exc}") from exc

    width, height = image.size

    if width % FRAME_COLUMNS != 0:
        raise ValueError(f"宽度 {width} 不是 {FRAME_COLUMNS} 的整数倍: {sheet}")
    cell_w = width // FRAME_COLUMNS

    if height % 9 == 0:
        rows = [] + STANDARD_STATES
        cell_h = height // 9
    elif height % 11 == 0:
        rows = [] + STANDARD_STATES + LOOK_ROW_NAMES
        cell_h = height // 11
    else:
        raise ValueError(f"高度 {height} 不是 9 或 11 的整数倍: {sheet}")

    frames: dict[str, list[Image.Image]] = {}
    for row_index, state in enumerate(rows):
        frame_list: list[Image.Image] = []
        for col in range(FRAME_COLUMNS):
            box = (
                col * cell_w,
                row_index * cell_h,
                (col + 1) * cell_w,
                (row_index + 1) * cell_h,
            )
            frame = image.crop(box)
            if _visible_pixel_count(frame) >= MIN_VISIBLE_PIXELS:
                frame_list.append(frame)
        frames[state] = frame_list

    fallback = frames.get("idle") or next(iter(frames.values()), [])
    for state in STANDARD_STATES:
        if not frames.get(state):
            frames[state] = list(fallback)

    name = str(meta.get("id") or meta.get("name") or pet_dir.name).strip()
    if not name:
        name = pet_dir.name
    display_name = str(meta.get("displayName") or meta.get("name") or pet_dir.name).strip()
    description = str(meta.get("description", "")).strip()
    version = meta.get("spriteVersionNumber")
    try:
        version = int(version)
    except (TypeError, ValueError):
        version = 0

    return Pet(
        name=name,
        display_name=display_name,
        description=description,
        path=pet_dir,
        sheet_path=sheet,
        meta=meta,
        sprite_version_number=version,
        cell_w=cell_w,
        cell_h=cell_h,
        rows=rows,
        frames=frames,
    )


def scan_pets(roots: Iterable[Path]) -> list[Pet]:
    """按顺序扫描多个根目录，同名宠物以先出现的根（应用目录）优先。"""
    pets: list[Pet] = []
    seen: set[str] = set()
    for root in roots:
        root = Path(root)
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            if not child.is_dir():
                continue
            try:
                pet = load_pet(child)
            except ValueError:
                continue
            if pet.name in seen:
                continue
            seen.add(pet.name)
            pets.append(pet)
    return pets


def pil_to_qimage(image: Image.Image):
    """PIL RGBA 图片 → QImage（拷贝像素，不持有 PIL 引用）。"""
    from PySide6.QtGui import QImage

    rgba = image.convert("RGBA")
    w, h = rgba.size
    data = rgba.tobytes("raw", "RGBA")
    qimage = QImage(data, w, h, w * 4, QImage.Format.Format_RGBA8888)
    return qimage.copy()
