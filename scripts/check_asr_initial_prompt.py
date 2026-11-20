"""ASR 简体偏置只读校验（决策 2026-10-22：auto 恒带简体文案）。

不起真实模型：给 ASRModel 注入桩 WhisperModel，记录 transcribe() 实参，
断言 initial_prompt 的注入规则：
    language=auto / None（产品恒 auto）-> 注入简体中文 prompt
    language=zh / zh-CN                -> 注入（显式中文同样偏置）
    language=en                        -> 不注入（显式英文不干扰）
    ASR_ZH_SIMPLIFIED_BIAS=false 或 prompt 置空 -> 不注入
英文音频在 auto + prompt 下的输出无漂移已由 2026-10-22 真实音频 A/B 实测
（逐字一致）；中文音频出不出简体需真实中文素材复测（开发机无样本）。

运行（asr venv，无第三方测试框架依赖）：
    C:/Users/lagom/.workbuddy/binaries/python/envs/shutree-asr/Scripts/python.exe \
        scripts/check_asr_initial_prompt.py
"""

from __future__ import annotations

import dataclasses
import os
import sys
from dataclasses import dataclass
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[1] / "server" / "asr_service"
sys.path.insert(0, str(SERVER_ROOT))

from asr_core.config import DEFAULT_ZH_SIMPLIFIED_PROMPT, load_settings  # noqa: E402
from asr_core.model import ASRModel  # noqa: E402

failed = 0


def check(cond: bool, msg: str) -> None:
    global failed
    if cond:
        print("  OK", msg)
    else:
        print("  FAIL", msg)
        failed += 1


@dataclass
class FakeSeg:
    start: float
    end: float
    text: str


@dataclass
class FakeInfo:
    language: str
    duration: float


class StubWhisper:
    """记录 kwargs 并返回一个假结果；迭代一次即结束。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def transcribe(self, audio_path: str, **kwargs):
        self.calls.append(dict(audio_path=audio_path, **kwargs))
        segs = iter([FakeSeg(0.0, 1.0, " stub ")])
        return segs, FakeInfo(language="zh", duration=1.0)


def run_once(env: dict[str, str], language: str | None) -> str | None:
    for key in ("ASR_ZH_SIMPLIFIED_BIAS", "ASR_ZH_SIMPLIFIED_PROMPT"):
        os.environ.pop(key, None)
    os.environ.update(env)
    settings = load_settings()
    model = ASRModel(settings)
    stub = StubWhisper()
    model._model = stub  # 跳过 load()：桩直接上岗
    model.transcribe("whatever.wav", language=language)
    assert len(stub.calls) == 1
    value = stub.calls[0].get("initial_prompt")
    return value if isinstance(value, str) else None


def main() -> int:
    print("initial_prompt 注入规则（桩模型，不起真实推理）")

    got = run_once({}, None)
    check(got == DEFAULT_ZH_SIMPLIFIED_PROMPT, f"language=None（auto）注入默认简体文案（{DEFAULT_ZH_SIMPLIFIED_PROMPT!r}）")

    got = run_once({}, "auto")
    check(got == DEFAULT_ZH_SIMPLIFIED_PROMPT, "language=auto 注入（产品链路恒走这条）")

    got = run_once({}, "zh")
    check(got == DEFAULT_ZH_SIMPLIFIED_PROMPT, "language=zh 注入")

    got = run_once({}, "zh-CN")
    check(got == DEFAULT_ZH_SIMPLIFIED_PROMPT, "language=zh-CN 同样注入（startswith zh）")

    got = run_once({}, "en")
    check(got is None, "language=en 不注入（显式英文不干扰）")

    got = run_once({"ASR_ZH_SIMPLIFIED_BIAS": "false"}, None)
    check(got is None, "ASR_ZH_SIMPLIFIED_BIAS=false 关闭注入")

    # 直达 settings 的空串守卫（env 层面空白=未设置，这里验证模型层防御）
    settings = load_settings()
    empty_settings = dataclasses.replace(settings, zh_simplified_prompt="")
    model = ASRModel(empty_settings)
    stub = StubWhisper()
    model._model = stub
    model.transcribe("whatever.wav", language=None)
    check(stub.calls[0].get("initial_prompt") is None, "settings 级空 prompt：模型层不注入")

    got = run_once({"ASR_ZH_SIMPLIFIED_PROMPT": "請用繁體中文。"}, None)
    check(got == "請用繁體中文。", "ASR_ZH_SIMPLIFIED_PROMPT 可覆盖文案（用户自担效果）")

    print("")
    if failed > 0:
        print(f"{failed} 项失败")
        return 1
    print("ASR 简体偏置校验全部通过 OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
