#!/usr/bin/env python3
"""模擬 LT の音声を Irodori-TTS でまとめて合成する（eval/corpus/build.ts から呼ぶ）。

モデルの読み込みに時間がかかるので、1 つのプロセスで全部の文を合成する。

    uv run --no-sync --project $IRODORI_TTS_DIR python eval/corpus/tts_irodori.py jobs.json

jobs.json:
    {
      "checkpoint": "Aratako/Irodori-TTS-v4.1-Small",
      "jobs": [
        {"text": "読み上げる文", "caption": "声の説明", "ref_wav": null, "seed": 1, "out": "out.wav"},
        ...
      ]
    }

ref_wav を省くと、caption だけで声を作る（VoiceDesign）。同じ話者の声をそろえるには、
最初に caption だけで作った参照音声を ref_wav に渡す（build.ts がそうしている）。
出力が既にあるジョブは飛ばす（途中で止めても続きから作れる）。

合成には Irodori-TTS の length check（2 パス合成）を使う。長さの予測が長すぎると、短い文の後ろに
台本にない音（言い直しや余計な語）が付くので、読み終わりの位置から長さを決め直して合成し直す。
出力の横に <out>.json を書き、話し始めと話し終わりの時刻、文の中の最も長い無音の長さを残す（確かめる用。
build.ts は音声から同じものを求め直し、話し終わりの後の余計な音も見分ける）。
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path


def analyze(torch, audio, sample_rate: int, frame_s: float = 0.05, threshold_db: float = -45.0) -> dict:
    """50ms ごとの音量から、話し始め・話し終わりと、その間の最も長い無音の長さ（秒）を求める。"""
    x = audio.detach().float().cpu()
    if x.dim() > 1:
        x = x.mean(dim=0)
    n = max(1, int(sample_rate * frame_s))
    frames = x[: (len(x) // n) * n].reshape(-1, n)
    peak = float(x.abs().max()) or 1.0
    db = 20 * torch.log10(frames.pow(2).mean(dim=1).sqrt() / peak + 1e-9)
    active = (db > threshold_db).tolist()
    if True not in active:
        return {"duration": len(x) / sample_rate, "speech_start": 0.0, "speech_end": 0.0, "longest_gap": 0.0}
    first = active.index(True)
    last = len(active) - 1 - active[::-1].index(True)
    longest = run = 0
    for a in active[first : last + 1]:
        run = 0 if a else run + 1
        longest = max(longest, run)
    return {
        "duration": len(x) / sample_rate,
        "speech_start": first * frame_s,
        "speech_end": (last + 1) * frame_s,
        "longest_gap": longest * frame_s,
    }


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    irodori_dir = os.environ.get("IRODORI_TTS_DIR")
    if irodori_dir:
        sys.path.insert(0, irodori_dir)

    import torch  # noqa: E402
    from irodori_tts import length_check  # noqa: E402
    from irodori_tts.inference_runtime import (  # noqa: E402
        InferenceRuntime,
        RuntimeKey,
        SamplingRequest,
        default_runtime_device,
        download_hf_checkpoint,
        resolve_cfg_scales,
        save_wav,
    )

    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    jobs = [j for j in spec["jobs"] if not Path(j["out"]).exists()]
    if not jobs:
        print("[irodori] 合成済み", flush=True)
        return

    device = default_runtime_device()
    checkpoint = download_hf_checkpoint(spec.get("checkpoint", "Aratako/Irodori-TTS-v4.1-Small"))
    runtime = InferenceRuntime.from_key(
        RuntimeKey(
            checkpoint=str(checkpoint),
            model_device=device,
            codec_repo="Aratako/Semantic-DACVAE-Japanese-32dim",
            model_precision="fp32",
            codec_device=device,
            codec_precision="fp32",
            codec_deterministic_encode=True,
            codec_deterministic_decode=True,
            compile_model=False,
            compile_dynamic=False,
            split_rare_tokens=True,
        )
    )
    print(f"[irodori] {len(jobs)} 文を {device} で合成します", flush=True)

    started = time.perf_counter()
    for i, job in enumerate(jobs, 1):
        caption = job.get("caption") or None
        ref_wav = job.get("ref_wav") or None
        text_scale, caption_scale, speaker_scale, _ = resolve_cfg_scales(
            cfg_guidance_mode="independent",
            cfg_scale_text=3.0,
            cfg_scale_caption=3.0,
            cfg_scale_speaker=5.0,
            cfg_scale=None,
            use_caption_condition=caption is not None,
            use_speaker_condition=ref_wav is not None,
        )
        result, info = length_check.synthesize(
            runtime,
            SamplingRequest(
                text=job["text"],
                caption=caption,
                ref_wav=ref_wav,
                no_ref=ref_wav is None,
                seed=int(job["seed"]),
                duration_scale=float(job.get("duration_scale", 1.0)),
                cfg_scale_text=text_scale,
                cfg_scale_caption=caption_scale,
                cfg_scale_speaker=speaker_scale,
            ),
            log_fn=None,
        )
        Path(job["out"]).parent.mkdir(parents=True, exist_ok=True)
        save_wav(job["out"], result.audio, result.sample_rate)
        Path(job["out"] + ".json").write_text(json.dumps({**analyze(torch, result.audio, result.sample_rate), "length_check": str(info)}))
        elapsed = time.perf_counter() - started
        print(f"[irodori] {i}/{len(jobs)} {elapsed:.0f}s {job['text'][:24]}", flush=True)


if __name__ == "__main__":
    main()
