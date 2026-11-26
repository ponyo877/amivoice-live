#!/bin/sh
# 記事に載せた実験をまとめて実行する。
# AmiVoice の使用量は、送る音声の長さ全体で数えて約 5.8 時間（1 本約 200 秒として。実際の課金は発話区間だけなので、これより少ない）。
# 台帳（eval/usage.jsonl）で月 9 時間を超える実行は始めないので、途中で止まったら翌月に続きを流す。
# 結果のある組み合わせは飛ばす（--skip-existing）ので、失敗したあとにもう一度実行すると、失敗した組み合わせだけを流し直す。
#
#   AMIVOICE_API_KEY=... ANTHROPIC_API_KEY=... sh eval/run-experiments.sh [段階...]
#
# 段階: corpus dict live posttime emphasis diarization async summary（省略するとすべて）
# アプリを通した確認（ライブ → 録音 → アーカイブと振り返り）は、npm run dev のあとで scripts/smoke.ts を使う。
set -u
cd "$(dirname "$0")/.."
IDS="workers rust rag"
STEPS="${*:-corpus dict live posttime emphasis diarization async summary}"
has() { case " $STEPS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
# 1 つの組み合わせが失敗しても残りは流し、最後に失敗があったことを終了コードで返す
FAILED=0
run() { "$@" || FAILED=1; }

# 0. 素材: 模擬 LT の音声・正解・スライド（AmiVoice は使わない）
if has corpus; then node eval/corpus/build.ts || exit 1; fi

# 1. スライドから Claude で辞書を作る（AmiVoice は使わない）
if has dict; then node eval/dictionary.ts || exit 1; fi

# 2. ライブ（WebSocket）: 4 エンジン × 辞書 3 種（なし・スライドから・理想）を静かな音声で、
#    4 エンジン × 辞書 2 種（なし・スライドから）を会場の音声で（3 本 × 約 200 秒 × 20 通り = 約 200 分）
if has live; then
  for id in $IDS; do
    run node eval/stream.ts --audio "eval/data/$id.wav" --matrix --skip-existing \
      --dictionary "eval/data/$id.slides.dict.json" --dictionary "eval/data/$id.oracle.dict.json" --parallel 6
    run node eval/stream.ts --audio "eval/data/$id.venue.wav" --matrix --skip-existing \
      --dictionary "eval/data/$id.slides.dict.json" --parallel 8
  done
fi

# 3. 発話区間検出の postTime: 字幕が確定する速さと、文が途中で切れる回数の兼ね合い（既定の 550 は 2. にある。約 40 分）
if has posttime; then
  for id in $IDS; do
    run node eval/stream.ts --audio "eval/data/$id.wav" --engine=-a-general --engine=-a2-ja-general --skip-existing \
      --dictionary "eval/data/$id.slides.dict.json" --post-time 300,1200 --parallel 4
  done
fi

# 4. E2E エンジンの単語強調の強調度（既定の 0.5 は 2. にある。約 20 分）
if has emphasis; then
  for id in $IDS; do
    run node eval/stream.ts --audio "eval/data/$id.wav" --engine=-a2-ja-general --skip-existing \
      --dictionary "eval/data/$id.slides.dict.json" --emphasis 0.3,1 --parallel 2
  done
fi

# 5. ライブの話者ダイアライゼーション（約 20 分）
if has diarization; then
  for id in $IDS; do
    run node eval/stream.ts --audio "eval/data/$id.wav" --engine=-a-general --engine=-a2-ja-general --skip-existing \
      --dictionary "eval/data/$id.slides.dict.json" --diarization --parallel 2
  done
fi

# 6. 非同期 HTTP API（終了後のアーカイブと同じ方式）、話者分離あり: 2 エンジン × 辞書 2 種（なし・スライドから）を静かな音声で、
#    2 エンジン × スライドからの辞書を会場の音声で（約 60 分）
if has async; then
  for id in $IDS; do
    run node eval/async.ts --audio "eval/data/$id.wav" --matrix --dictionary "eval/data/$id.slides.dict.json" --diarization --parallel 4 --skip-existing
    run node eval/async.ts --audio "eval/data/$id.venue.wav" --engine=-a2b-ja-general --engine=-a-general \
      --dictionary "eval/data/$id.slides.dict.json" --diarization --parallel 2 --skip-existing
    # 振り返りと同じ指定（ハイブリッド + keepFillerToken=1）で、フィラーの数を正解と比べる（約 10 分）
    run node eval/async.ts --audio "eval/data/$id.wav" --engine=-a-general \
      --dictionary "eval/data/$id.slides.dict.json" --filler --skip-existing
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
  # 台本の用語が、条件ごとに何になったか（記事の例はここから拾う）
  for id in $IDS; do
    node eval/examples.ts "$id" eval/out/$id.a-general.nodict.jsonl eval/out/$id.a-general.slides.jsonl \
      eval/out/$id.a2-ja-general.nodict.jsonl eval/out/$id.a2-ja-general.slides.jsonl \
      eval/out/$id.a-general.slides.spk.async.json eval/out/$id.a2b-ja-general.slides.spk.async.json > "eval/results/examples-$id.md" || FAILED=1
  done
fi
exit "$FAILED"
