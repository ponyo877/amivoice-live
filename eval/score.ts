// stream.ts の記録（ライブ）と async.ts の結果（非同期）を正解の書き起こしと比べ、文字誤り率・辞書語の再現率・遅延を表にする。
//
//   node eval/score.ts --reference eval/data/talk1.ref.txt --dictionary eval/data/talk1.dict.json eval/out/talk1.*.jsonl eval/out/talk1.*.async.json
//
// 遅延の定義:
// - 確定までの時間: 発話終了イベント（E）が届いてから確定結果（A）が届くまで（実時間）
// - 確定の遅れ: A が届いた時点で送り終えていた音声の位置 − その発話の終了位置。話し終わってから字幕が確定するまでの体感に近い
// - 最初の途中結果まで: 発話開始イベント（S）から最初の途中結果（U）まで（実時間）

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { parseServerEvent, resultEndTime, stripFillers, type DictionaryTerm } from "../src/shared/amivoice.ts";
import { asyncUtterances, type AsyncJobResult } from "../src/shared/async-result.ts";
import { cer, quantile, termRecall } from "./lib.ts";

interface Header {
  engine: string;
  dictionary: boolean;
  profileWordsCount: number;
  speed: number;
  postTime?: number | null;
  emphasis?: number | null;
}

interface Row {
  file: string;
  mode: "ライブ" | "非同期";
  engine: string;
  dictionary: boolean;
  condition: string;
  cer: number;
  termRecall: number | null;
  termHits: string;
  finalizeP50: number | null;
  finalizeP90: number | null;
  lagP50: number | null;
  firstPartialP50: number | null;
  hypothesis: string;
}

/** async.ts の結果（非同期 HTTP API）。遅延は測れないので文字の正確さだけを出す。 */
function scoreAsyncFile(path: string, reference: string, terms: string[]): Row {
  const { header, result } = JSON.parse(readFileSync(path, "utf8")) as {
    header: { engine: string; dictionary: boolean; diarization?: boolean; elapsedMs: number; audioMs: number };
    result: AsyncJobResult;
  };
  const hypothesis = stripFillers(asyncUtterances(result).map((u) => u.text).join(""));
  const c = cer(reference, hypothesis);
  const tr = termRecall(reference, hypothesis, terms);
  return {
    file: basename(path),
    mode: "非同期",
    engine: header.engine,
    dictionary: header.dictionary,
    condition: `処理 ${(header.elapsedMs / 1000).toFixed(0)} 秒${header.diarization ? "・話者分離" : ""}`,
    cer: c.cer,
    termRecall: tr.recall,
    termHits: `${tr.hits}/${tr.total}`,
    finalizeP50: null,
    finalizeP90: null,
    lagP50: null,
    firstPartialP50: null,
    hypothesis,
  };
}

function scoreFile(path: string, reference: string, terms: string[]): Row {
  if (path.endsWith(".async.json")) return scoreAsyncFile(path, reference, terms);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = JSON.parse(lines[0]!) as Header;
  const texts: string[] = [];
  const finalize: number[] = [];
  const lag: number[] = [];
  const firstPartial: number[] = [];
  let lastE: number | null = null;
  let lastS: number | null = null;

  for (const line of lines.slice(1)) {
    const rec = JSON.parse(line) as { t: number; audioMs: number; raw: string };
    const ev = parseServerEvent(rec.raw);
    if (ev.kind === "S") lastS = rec.t;
    if (ev.kind === "U" && lastS !== null) {
      firstPartial.push(rec.t - lastS);
      lastS = null;
    }
    if (ev.kind === "E") lastE = rec.t;
    if (ev.kind === "A") {
      const text = (ev.result.text ?? "").replace(/_/g, " ");
      if (text.trim()) texts.push(text);
      if (lastE !== null) finalize.push(rec.t - lastE);
      lastE = null;
      const end = resultEndTime(ev.result);
      if (end !== undefined) lag.push(rec.audioMs - end);
    }
  }

  const hypothesis = texts.join("");
  const c = cer(reference, hypothesis);
  const tr = termRecall(reference, hypothesis, terms);
  const condition = [
    header.postTime != null ? `postTime=${header.postTime}` : "",
    header.emphasis != null ? `強調度=${header.emphasis}` : "",
  ]
    .filter(Boolean)
    .join("・");
  return {
    file: basename(path),
    mode: "ライブ",
    engine: header.engine,
    dictionary: header.dictionary,
    condition: condition || "既定",
    cer: c.cer,
    termRecall: tr.recall,
    termHits: `${tr.hits}/${tr.total}`,
    finalizeP50: quantile(finalize, 0.5),
    finalizeP90: quantile(finalize, 0.9),
    lagP50: header.speed === 1 ? quantile(lag, 0.5) : null,
    firstPartialP50: quantile(firstPartial, 0.5),
    hypothesis,
  };
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      reference: { type: "string" },
      dictionary: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.reference || positionals.length === 0) {
    throw new Error("使い方: node eval/score.ts --reference ref.txt [--dictionary dict.json] out/*.jsonl");
  }
  const reference = readFileSync(values.reference, "utf8");
  const terms = values.dictionary
    ? (JSON.parse(readFileSync(values.dictionary, "utf8")) as { terms: DictionaryTerm[] }).terms.map((t) => t.written)
    : [];
  const rows = positionals.map((p) => scoreFile(p, reference, terms));

  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const ms = (v: number | null) => (v === null ? "–" : `${v}`);
  const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);
  console.log("| 方式 | エンジン | 辞書 | 条件 | CER | 辞書語の再現率 | 確定まで p50/p90 (ms) | 確定の遅れ p50 (ms) | 最初の途中結果 p50 (ms) |");
  console.log("|---|---|---|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    console.log(
      `| ${r.mode} | ${r.engine} | ${r.dictionary ? "あり" : "なし"} | ${r.condition} | ${pct(r.cer)} | ${pct(r.termRecall)} (${r.termHits}) | ${ms(r.finalizeP50)} / ${ms(r.finalizeP90)} | ${ms(r.lagP50)} | ${ms(r.firstPartialP50)} |`,
    );
  }
}

main();
