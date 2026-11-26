#!/bin/sh
# 記事に載せた実験をまとめて実行する。
# AmiVoice の使用量は、送る音声の長さ全体で数えて約 6.2 時間（実際の課金は発話区間だけなので、これより少ない）。
# 台帳（eval/usage.jsonl）で月 9 時間を超える実行は始めないので、途中で止まったら翌月に続きを流す。
#
#   AMIVOICE_API_KEY=... ANTHROPIC_API_KEY=... sh eval/run-experiments.sh [段階...]
#
# 段階: corpus dict live posttime emphasis diarization async summary（省略するとすべて）
# アプリを通した確認（ライブ → 録音 → アーカイブと振り返り）は、npm run dev のあとで scripts/smoke.ts を使う。
set -eu
cd "$(dirname "$0")/.."
IDS="workers rust rag"
STEPS="${*:-corpus dict live posttime emphasis diarization async summary}"
has() { case " $STEPS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# 0. 素材: 模擬 LT の音声・正解・スライド（AmiVoice は使わない）
has corpus && node eval/corpus/build.ts

# 1. スライドから Claude で辞書を作る（AmiVoice は使わない）
has dict && node eval/dictionary.ts

# 2. ライブ（WebSocket）: 4 エンジン × 辞書 3 種（なし・スライドから・理想）× 音声 2 種（静か・会場）
#    3 本 × 約 172 秒 × 12 通り × 2 = 約 206 分
if has live; then
  for id in $IDS; do
    for v in "" ".venue"; do
      node eval/stream.ts --audio "eval/data/$id$v.wav" --matrix \
        --dictionary "eval/data/$id.slides.dict.json" --dictionary "eval/data/$id.oracle.dict.json" --parallel 9
    done
  done
fi

# 3. 発話区間検出の postTime: 字幕が確定する速さと、文が途中で切れる回数の兼ね合い（約 52 分）
if has posttime; then
  for id in $IDS; do
    node eval/stream.ts --audio "eval/data/$id.wav" --engine=-a-general --engine=-a2-ja-general \
      --dictionary "eval/data/$id.slides.dict.json" --post-time 300,800,1200 --parallel 6
  done
fi

# 4. E2E エンジンの単語強調の強調度（約 26 分）
if has emphasis; then
  for id in $IDS; do
    node eval/stream.ts --audio "eval/data/$id.wav" --engine=-a2-ja-general \
      --dictionary "eval/data/$id.slides.dict.json" --emphasis 0.3,0.8,1 --parallel 3
  done
fi

# 5. ライブの話者ダイアライゼーション（約 17 分）
if has diarization; then
  for id in $IDS; do
    node eval/stream.ts --audio "eval/data/$id.wav" --engine=-a-general --engine=-a2-ja-general \
      --dictionary "eval/data/$id.slides.dict.json" --diarization --parallel 2
  done
fi

# 6. 非同期 HTTP API（終了後のアーカイブと同じ方式）: 2 エンジン × 辞書 2 種 × 音声 2 種、話者分離あり（約 69 分）
if has async; then
  for id in $IDS; do
    for v in "" ".venue"; do
      node eval/async.ts --audio "eval/data/$id$v.wav" --matrix --dictionary "eval/data/$id.slides.dict.json" --diarization --parallel 4
    done
  done
fi

# 7. まとめ
if has summary; then
  mkdir -p eval/results/dictionaries
  # Claude の出力は実行のたびに少し変わるので、実験に使った辞書を残す
  cp eval/data/*.slides.dict.json eval/data/*.oracle.dict.json eval/results/dictionaries/
  node eval/summarize.ts --json eval/results/summary.json | tee eval/results/summary.md
  node eval/dictionary.ts --compare-only | tee eval/results/dictionary.md
  node eval/budget.ts | tee eval/results/usage.md
fi
