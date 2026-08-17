# -*- coding: utf-8 -*-
"""气泡模型（BubbleModel）纯逻辑单测——不依赖 Qt，秒级运行。

模型承载气泡内容（标题/短语/第二行/颜色/显隐），与动画状态机解耦：
业务事件写模型，渲染层只做机械转换。本测试覆盖事件 → 模型映射的
全部语义，防止"动画状态异常导致气泡文案错/残留"类耦合 bug 回归。

用法：
    .venv\\Scripts\\python.exe pet\\test_bubble_model.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 避免导入 pet_app 时触发 Qt（BubbleModel 只依赖常量，但 pet_app 顶层
# 会 import PySide6）——测试环境有 PySide6，直接导入即可。
from pet_app import BubbleModel  # noqa: E402

FAILURES = []


def check(name, cond, extra=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")
    if not cond:
        FAILURES.append(name)


def main():
    # ---- 用户新指令：新一轮任务开始（复位中断/完成）----
    m = BubbleModel()
    m.set_interrupted()
    m.set_done("总结")
    m.set_user_prompt("帮我审查代码")
    check("新指令更新标题", m.title == "帮我审查代码")
    check("新指令短语=执行任务", m.phrase == BubbleModel.PHRASE_EXECUTING)
    check("新指令清空第二行", m.body == "")
    check("新指令复位完成标记", not m.completed)
    check("新指令气泡可见", m.visible)

    # ---- 活动事件：动作行 → 短句映射（原版语义）----
    m.set_activity("正在思考")
    check("正在思考→思考中", m.phrase == BubbleModel.PHRASE_THINKING)
    check("正在思考→第二行=动作行", m.body == "正在思考")
    m.set_activity("搜索中")
    check("搜索中→分析代码（原版行为）", m.phrase == BubbleModel.PHRASE_ANALYZING)
    m.set_activity("调用工具 read")
    check("未知动作→回复中", m.phrase == BubbleModel.PHRASE_REPLYING)
    check("未知动作→第二行=动作行", m.body == "调用工具 read")
    m.set_activity(" ")
    check("空动作行不改短语（保持上次）", m.phrase == BubbleModel.PHRASE_REPLYING)

    # ---- 等待输入：保留标题，第二行取 AI 总结优先 ----
    m.title = ""
    m.set_waiting("正在执行任务", body="工具进度", summary="总结文本")
    check("等待短语=等待你的输入", m.phrase == BubbleModel.PHRASE_WAITING)
    check("等待标题回退", m.title == "正在执行任务")
    check("等待第二行取总结", m.body == "总结文本")
    check("等待第二行灰色", m.body_color is not None)
    m.set_waiting("任务", body=" ", summary="")
    check("无总结无动作→第二行空", m.body == "")

    # ---- 审阅 / 授权 / 中断 / 错误 ----
    m.set_review()
    check("审阅短语=等待输入", m.phrase == BubbleModel.PHRASE_REVIEW)
    check("审阅第二行", m.body == BubbleModel.PHRASE_REVIEW_BODY)
    m.set_authorization("pwsh")
    check("授权短语=等待授权确认", m.phrase == BubbleModel.PHRASE_WAIT_AUTH)
    check("授权状态=warn", m.status == "warn")
    check("授权第二行含工具名", "pwsh" in m.body)
    m.set_interrupted()
    check("中断短语=已中断", m.phrase == BubbleModel.PHRASE_INTERRUPTED)
    m.set_error("LLM 超时")
    check("错误短语=发生错误", m.phrase == BubbleModel.PHRASE_ERROR)
    check("错误状态=error", m.status == "error")
    check("错误第二行", m.body == "LLM 超时")

    # ---- AI 总结锁定 + 完成展示 ----
    m.set_summary("全部完成，共修改 12 个文件")
    check("总结写入第二行", m.body == "全部完成，共修改 12 个文件")
    check("总结灰色", m.body_color is not None)
    m.set_done("总结文本")
    check("完成标记", m.completed)
    check("完成短语=任务完成", m.phrase == BubbleModel.PHRASE_DONE)
    check("完成气泡可见", m.visible)
    m.clear_completed()
    check("完成结束复位", not m.completed and not m.visible)

    # ---- 与旧 _status_title 映射一致（兼容入口）----
    mapping = {
        "正在思考": "思考中",
        "搜索中": "分析代码",
        "收到指令": "执行任务",
        "分析代码": "执行任务",
        "执行任务": "执行任务",
        "回复中": "回复中",
        "任意其他": "回复中",
    }
    for action, expected in mapping.items():
        got = BubbleModel.ACTION_TO_PHRASE.get(action, BubbleModel.PHRASE_REPLYING)
        check(f"短语映射 {action}→{expected}", got == expected)

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项: {FAILURES}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
