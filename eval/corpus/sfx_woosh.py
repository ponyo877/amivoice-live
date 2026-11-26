#!/usr/bin/env python3
"""会場の環境音と効果音を、Sony AI の Woosh（テキストから効果音を作るモデル）でまとめて作る。

eval/corpus/build.ts が、会場の想定の音声（<id>.venue.wav）に重ねる音を作るために呼ぶ。

    uv run --no-sync --project $WOOSH_DIR python eval/corpus/sfx_woosh.py jobs.json

jobs.json:
    {"jobs": [{"prompt": "英語の説明", "negative": "入れたくない音（省略可）", "seed": 1, "out": "out.wav"}, ...]}

Woosh-Flow は 1 回に 5 秒の 48kHz の音を作る。長い環境音は build.ts がつなぐ。
チェックポイントの設定が相対パス（checkpoints/...）なので、WOOSH_DIR に移動してから読み込む。
出力が既にあるジョブは飛ばす。
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    spec_path = Path(sys.argv[1]).resolve()
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    jobs = [j for j in spec["jobs"] if not Path(j["out"]).exists()]
    if not jobs:
        print("[woosh] 生成済み", flush=True)
        return

    woosh_dir = os.environ.get("WOOSH_DIR")
    if not woosh_dir:
        sys.exit("環境変数 WOOSH_DIR に Woosh のリポジトリを指定してください")
    os.chdir(woosh_dir)
    sys.path.insert(0, woosh_dir)

    import torch  # noqa: E402
    import torchaudio  # noqa: E402
    from woosh.components.base import LoadConfig  # noqa: E402
    from woosh.inference.flowmatching_sampler import flowmatching_integrate  # noqa: E402
    from woosh.model.ldm import LatentDiffusionModel  # noqa: E402

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    ldm = LatentDiffusionModel(LoadConfig(path="checkpoints/Woosh-Flow")).eval().to(device)
    print(f"[woosh] {len(jobs)} 本を {device} で作ります", flush=True)

    started = time.perf_counter()
    for i, job in enumerate(jobs, 1):
        generator = torch.Generator().manual_seed(int(job["seed"]))
        noise = torch.randn(1, 128, 501, generator=generator).to(device)
        cond = ldm.get_cond({"audio": None, "description": [job["prompt"]]}, no_dropout=True, device=device)
        # 入れたくない音（環境音に人の話し声が混ざると、認識の評価に紛れ込む）は否定の条件にする
        negative = job.get("negative")
        cond_neg = ldm.get_cond({"audio": None, "description": [negative]}, no_dropout=True, device=device) if negative else None
        with torch.inference_mode():
            latents = flowmatching_integrate(
                ldm,
                noise=noise,
                cond=cond,
                cond_neg=cond_neg,
                cfg=4.5,
                atol=0.001,
                rtol=0.001,
                device=device,
                dtype=torch.float32 if device == "mps" else torch.float64,
            )
            audio = ldm.autoencoder.inverse(latents).cpu()[0]
        peak = torch.max(torch.abs(audio))
        if peak > 1.0:
            audio = audio / peak
        Path(job["out"]).parent.mkdir(parents=True, exist_ok=True)
        torchaudio.save(job["out"], audio, sample_rate=48000)
        print(f"[woosh] {i}/{len(jobs)} {time.perf_counter() - started:.0f}s {job['prompt'][:40]}", flush=True)


if __name__ == "__main__":
    main()
