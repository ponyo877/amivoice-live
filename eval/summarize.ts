// 模擬 LT（eval/corpus）の結果を条件ごとにまとめ、記事に載せる表と JSON を作る。
//
//   node eval/summarize.ts [--out eval/out] [--per-talk] [--json eval/results/summary.json]
//
// eval/out/ にある stream.ts（*.jsonl）と async.ts（*.async.json）の出力のうち、eval/data/<id>.truth.json がある音声のものを読む。
// 同じ条件（方式・エンジン・辞書・音声・postTime・強調度・話者分離）の結果を LT をまたいで足し合わせる。
// CER は「編集距離の合計 ÷ 正解の文字数の合計」、用語の再現率は「認識できた回数の合計 ÷ 正解に出てくる回数の合計」。
// 用語は辞書の中身ではなく、台本で {表記|読み} と書いた正解の用語で数える。辞書が違っても同じ物差しで比べるため。

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { isFillerToken, parseServerEvent, resultEndTime, resultTokens, stripFillers, type Token } from "../src/shared/amivoice.ts";
import { asyncUtterances, type AsyncJobResult } from "../src/shared/async-result.ts";
import { cer, normalize } from "../src/shared/metrics.ts";
import { quantile, termRecall } from "./lib.ts";

interface Truth {
  id: string;
  durationMs: number;
  turns: { speaker: string; startMs: number; endMs: number; text: string }[];
  fillers: { total: number };
  terms: string[];
}

interface Condition {
  mode: "ライブ" | "非同期";
  engine: string;
  dictionary: string;
  variant: "静か" | "会場";
  postTime: number | null;
  emphasis: number | null;
  diarization: boolean;
  options: string;
}

interface FileScore extends Condition {
  talk: string;
  file: string;
  errors: number;
  length: number;
  termHits: number;
  termTotal: number;
  finalize: number[];
  lag: number[];
  firstPartial: number[];
  utterances: number;
  speaker: { correct: number; total: number; bHits: number; bTotal: number; labels: number } | null;
  fillers: { detected: number; truth: number } | null;
  elapsedMs: number | null;
  terms: { term: string; inReference: number; inHypothesis: number }[];
}

const DICT_NAMES: Record<string, string> = { nodict: "なし", slides: "スライドから", oracle: "理想", tech: "Zenn の技術用語", slidestech: "スライド＋技術用語" };

function talkOf(audio: string): { talk: string; variant: "静か" | "会場" } {
  const stem = basename(audio).replace(/\.[^.]+$/, "");
  return stem.endsWith(".venue") ? { talk: stem.slice(0, -".venue".length), variant: "会場" } : { talk: stem, variant: "静か" };
}

/** 時刻からその時に話していた正解の話者を引く。話者の切り替えの間の無音なら近い方。 */
function speakerAt(truth: Truth, ms: number): string {
  let best = truth.turns[0]!;
  let bestDist = Infinity;
  for (const t of truth.turns) {
    const d = ms < t.startMs ? t.startMs - ms : ms > t.endMs ? ms - t.endMs : 0;
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best.speaker;
}

/**
 * 話者の割り当ての正しさ。ラベルごとに、そのラベルの文字が最も多く属する正解の話者を対応させ、正しく対応した文字の割合を出す。
 * あわせて、質問者（B）の文字のうち、B に対応したラベルが付いた割合（質問者を分けられたか）を出す。
 */
function scoreSpeakers(truth: Truth, tokens: Token[]): FileScore["speaker"] {
  const labeled = tokens.filter((t) => t.label && typeof t.starttime === "number" && t.written && !isFillerToken(t.written));
  if (labeled.length === 0) return null;
  const counts = new Map<string, Map<string, number>>();
  const items = labeled.map((t) => {
    const mid = ((t.starttime ?? 0) + (t.endtime ?? t.starttime ?? 0)) / 2;
    const truthSpeaker = speakerAt(truth, mid);
    const chars = [...normalize(t.written)].length;
    const m = counts.get(t.label!) ?? new Map<string, number>();
    m.set(truthSpeaker, (m.get(truthSpeaker) ?? 0) + chars);
    counts.set(t.label!, m);
    return { label: t.label!, truthSpeaker, chars };
  });
  const mapping = new Map([...counts].map(([label, m]) => [label, [...m].sort((a, b) => b[1] - a[1])[0]![0]]));
  let correct = 0;
  let total = 0;
  let bHits = 0;
  let bTotal = 0;
  for (const it of items) {
    total += it.chars;
    if (mapping.get(it.label) === it.truthSpeaker) correct += it.chars;
    if (it.truthSpeaker === "B") {
      bTotal += it.chars;
      if (mapping.get(it.label) === "B") bHits += it.chars;
    }
  }
  return { correct, total, bHits, bTotal, labels: counts.size };
}

function scoreLive(path: string, truths: Map<string, Truth>): FileScore | null {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = JSON.parse(lines[0]!) as {
    engine: string;
    dictionary: string | boolean | null;
    audio: string;
    speed: number;
    postTime?: number | null;
    emphasis?: number | null;
    diarization?: boolean;
  };
  const { talk, variant } = talkOf(header.audio);
  const truth = truths.get(talk);
  if (!truth) return null;
  const texts: string[] = [];
  const tokens: Token[] = [];
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
      tokens.push(...resultTokens(ev.result));
      if (lastE !== null) finalize.push(rec.t - lastE);
      lastE = null;
      const end = resultEndTime(ev.result);
      if (end !== undefined) lag.push(rec.audioMs - end);
    }
  }
  const hypothesis = stripFillers(texts.join(""));
  const reference = truth.turns.map((t) => t.text).join("");
  const c = cer(reference, hypothesis);
  const tr = termRecall(reference, hypothesis, truth.terms);
  const dictionary = typeof header.dictionary === "string" ? header.dictionary : header.dictionary ? "dict" : "nodict";
  return {
    talk,
    file: basename(path),
    mode: "ライブ",
    engine: header.engine,
    dictionary,
    variant,
    postTime: header.postTime ?? null,
    emphasis: header.emphasis ?? null,
    diarization: !!header.diarization,
    options: "",
    errors: c.errors,
    length: c.length,
    termHits: tr.hits,
    termTotal: tr.total,
    finalize,
    lag: header.speed === 1 ? lag : [],
    firstPartial,
    utterances: texts.length,
    speaker: header.diarization ? scoreSpeakers(truth, tokens) : null,
    fillers: null,
    elapsedMs: null,
    terms: tr.perTerm,
  };
}

function scoreAsync(path: string, truths: Map<string, Truth>): FileScore | null {
  const { header, result } = JSON.parse(readFileSync(path, "utf8")) as {
    header: { engine: string; dictionary: string | boolean | null; audio: string; diarization?: boolean; sentiment?: boolean; filler?: boolean; elapsedMs: number };
    result: AsyncJobResult;
  };
  const { talk, variant } = talkOf(header.audio);
  const truth = truths.get(talk);
  if (!truth) return null;
  const utts = asyncUtterances(result);
  const tokens = utts.flatMap((u) => u.tokens);
  const hypothesis = stripFillers(utts.map((u) => u.text).join(""));
  const reference = truth.turns.map((t) => t.text).join("");
  const c = cer(reference, hypothesis);
  const tr = termRecall(reference, hypothesis, truth.terms);
  const dictionary = typeof header.dictionary === "string" ? header.dictionary : header.dictionary ? "dict" : "nodict";
  return {
    talk,
    file: basename(path),
    mode: "非同期",
    engine: header.engine,
    dictionary,
    variant,
    postTime: null,
    emphasis: null,
    diarization: !!header.diarization,
    options: [header.sentiment ? "感情分析" : "", header.filler ? "フィラー" : ""].filter(Boolean).join("・"),
    errors: c.errors,
    length: c.length,
    termHits: tr.hits,
    termTotal: tr.total,
    finalize: [],
    lag: [],
    firstPartial: [],
    utterances: utts.length,
    speaker: header.diarization ? scoreSpeakers(truth, tokens) : null,
    fillers: header.filler ? { detected: tokens.filter((t) => isFillerToken(t.written)).length, truth: truth.fillers.total } : null,
    elapsedMs: header.elapsedMs,
    terms: tr.perTerm,
  };
}

export interface Summary extends Condition {
  talks: string[];
  cer: number;
  termRecall: number | null;
  termHits: number;
  termTotal: number;
  finalizeP50: number | null;
  finalizeP90: number | null;
  lagP50: number | null;
  lagP90: number | null;
  firstPartialP50: number | null;
  utterances: number;
  speakerAccuracy: number | null;
  questionerRecall: number | null;
  fillerDetected: string | null;
  elapsedP50: number | null;
  missedTerms: string[];
}

function summarize(scores: FileScore[]): Summary[] {
  const groups = new Map<string, FileScore[]>();
  for (const s of scores) {
    const key = JSON.stringify([s.mode, s.engine, s.dictionary, s.variant, s.postTime, s.emphasis, s.diarization, s.options]);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.values()].map((g) => {
    const sum = (f: (s: FileScore) => number) => g.reduce((a, s) => a + f(s), 0);
    const termTotal = sum((s) => s.termTotal);
    const spk = g.filter((s) => s.speaker);
    const fil = g.filter((s) => s.fillers);
    const missed = new Map<string, number>();
    for (const s of g) for (const t of s.terms) if (t.inHypothesis < t.inReference) missed.set(t.term, (missed.get(t.term) ?? 0) + t.inReference - Math.min(t.inReference, t.inHypothesis));
    return {
      mode: g[0]!.mode,
      engine: g[0]!.engine,
      dictionary: g[0]!.dictionary,
      variant: g[0]!.variant,
      postTime: g[0]!.postTime,
      emphasis: g[0]!.emphasis,
      diarization: g[0]!.diarization,
      options: g[0]!.options,
      talks: g.map((s) => s.talk).sort(),
      cer: sum((s) => s.errors) / sum((s) => s.length),
      termRecall: termTotal ? sum((s) => s.termHits) / termTotal : null,
      termHits: sum((s) => s.termHits),
      termTotal,
      finalizeP50: quantile(g.flatMap((s) => s.finalize), 0.5),
      finalizeP90: quantile(g.flatMap((s) => s.finalize), 0.9),
      lagP50: quantile(g.flatMap((s) => s.lag), 0.5),
      lagP90: quantile(g.flatMap((s) => s.lag), 0.9),
      firstPartialP50: quantile(g.flatMap((s) => s.firstPartial), 0.5),
      utterances: sum((s) => s.utterances),
      speakerAccuracy: spk.length ? spk.reduce((a, s) => a + s.speaker!.correct, 0) / spk.reduce((a, s) => a + s.speaker!.total, 0) : null,
      questionerRecall: spk.length ? spk.reduce((a, s) => a + s.speaker!.bHits, 0) / Math.max(1, spk.reduce((a, s) => a + s.speaker!.bTotal, 0)) : null,
      fillerDetected: fil.length ? `${fil.reduce((a, s) => a + s.fillers!.detected, 0)}/${fil.reduce((a, s) => a + s.fillers!.truth, 0)}` : null,
      elapsedP50: quantile(g.flatMap((s) => (s.elapsedMs === null ? [] : [s.elapsedMs])), 0.5),
      missedTerms: [...missed].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`),
    };
  });
}

function main(): void {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: join(dirname(new URL(import.meta.url).pathname), "out") },
      data: { type: "string", default: join(dirname(new URL(import.meta.url).pathname), "data") },
      json: { type: "string" },
      "per-talk": { type: "boolean", default: false },
    },
  });
  const truths = new Map<string, Truth>();
  for (const f of readdirSync(values.data!).filter((f) => f.endsWith(".truth.json"))) {
    const t = JSON.parse(readFileSync(join(values.data!, f), "utf8")) as Truth;
    truths.set(t.id, t);
  }
  const scores: FileScore[] = [];
  for (const f of readdirSync(values.out!)) {
    const path = join(values.out!, f);
    const s = f.endsWith(".async.json") ? scoreAsync(path, truths) : f.endsWith(".jsonl") ? scoreLive(path, truths) : null;
    if (s) scores.push(s);
  }
  const rows = summarize(scores).sort(
    (a, b) =>
      a.mode.localeCompare(b.mode) ||
      a.variant.localeCompare(b.variant) ||
      a.engine.localeCompare(b.engine) ||
      a.dictionary.localeCompare(b.dictionary) ||
      (a.postTime ?? 0) - (b.postTime ?? 0) ||
      (a.emphasis ?? 0) - (b.emphasis ?? 0),
  );
  const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);
  const ms = (v: number | null) => (v === null ? "–" : `${v}`);
  console.log(`対象: ${[...truths.keys()].join(", ")}（${scores.length} ファイル）\n`);
  console.log("| 方式 | 音声 | エンジン | 辞書 | 条件 | LT | CER | 用語の再現率 | 確定まで p50/p90 (ms) | 確定の遅れ p50/p90 (ms) | 発話数 | 話者の正しさ | 質問者を分けた割合 | フィラー |");
  console.log("|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const cond = [r.postTime !== null ? `postTime=${r.postTime}` : "", r.emphasis !== null ? `強調度=${r.emphasis}` : "", r.diarization ? "話者分離" : "", r.options].filter(Boolean).join("・") || "既定";
    console.log(
      `| ${r.mode} | ${r.variant} | ${r.engine} | ${DICT_NAMES[r.dictionary] ?? r.dictionary} | ${cond} | ${r.talks.length} | ${pct(r.cer)} | ${pct(r.termRecall)} (${r.termHits}/${r.termTotal}) | ${ms(r.finalizeP50)} / ${ms(r.finalizeP90)} | ${ms(r.lagP50)} / ${ms(r.lagP90)} | ${r.utterances} | ${pct(r.speakerAccuracy)} | ${pct(r.questionerRecall)} | ${r.fillerDetected ?? "–"} |`,
    );
  }
  if (values["per-talk"]) {
    console.log("\n| ファイル | CER | 用語 |\n|---|---:|---:|");
    for (const s of scores.sort((a, b) => a.file.localeCompare(b.file))) console.log(`| ${s.file} | ${pct(s.errors / s.length)} | ${s.termHits}/${s.termTotal} |`);
  }
  if (values.json) {
    if (!existsSync(dirname(values.json))) mkdirSync(dirname(values.json), { recursive: true });
    writeFileSync(values.json, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 1) + "\n");
  }
}

main();
