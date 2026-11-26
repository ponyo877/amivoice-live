// 正解の書き起こしがない音声（実際の登壇の録音など）で、辞書なしと辞書ありのライブ字幕を比べる。
// CER は出せないので、辞書の語が字幕に出た回数と、同じ時刻の字幕で違いのある箇所を並べる。
//
//   node eval/compare.ts talk.zenn.dict.json out/talk.a-general.nodict.jsonl out/talk.a-general.zenn.jsonl
//
// 回数は、辞書の語を長いものから順に、ほかの語と重ならない出現だけを数える（Vitest の中の Vite は数えない）。
// 辞書の語が出たことは、正しく認識できたことを意味しない（同じ読みの別の語に置き換わった場合も数える）ので、
// 最後は違いのある箇所を読んで確かめる。

import { readFileSync } from "node:fs";
import { parseServerEvent, stripFillers, type DictionaryTerm } from "../src/shared/amivoice.ts";

interface Utterance {
  start: number;
  end: number;
  text: string;
}

/** ライブの結果（stream.ts の出力）から、確定した発話を取り出す */
function utterances(path: string): Utterance[] {
  const out: Utterance[] = [];
  for (const line of readFileSync(path, "utf8").trim().split("\n").slice(1)) {
    const ev = parseServerEvent((JSON.parse(line) as { raw: string }).raw);
    if (ev.kind !== "A") continue;
    const text = stripFillers((ev.result.text ?? "").replace(/_/g, " ")).trim();
    if (!text) continue;
    const first = ev.result.results?.[0];
    const tokens = first?.tokens ?? [];
    const start = first?.starttime ?? tokens[0]?.starttime ?? 0;
    out.push({ start, end: first?.endtime ?? tokens.at(-1)?.endtime ?? start, text });
  }
  return out;
}

function countTerms(text: string, terms: DictionaryTerm[]): Map<string, number> {
  const hay = text.toLowerCase();
  const taken = new Uint8Array(hay.length);
  const counts = new Map<string, number>();
  for (const t of [...terms].sort((a, b) => b.written.length - a.written.length)) {
    const w = t.written.toLowerCase();
    if (!w) continue;
    for (let i = hay.indexOf(w); i >= 0; i = hay.indexOf(w, i + 1)) {
      if (taken.subarray(i, i + w.length).some((v) => v)) continue;
      taken.fill(1, i, i + w.length);
      counts.set(t.written, (counts.get(t.written) ?? 0) + 1);
    }
  }
  return counts;
}

/** 時刻の重なる発話を束ねて、2 つの結果で文字列の違う組を返す */
function differences(a: Utterance[], b: Utterance[]): { at: number; a: string; b: string }[] {
  const diffs: { at: number; a: string; b: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ga = [a[i++]!];
    const gb = [b[j++]!];
    let end = Math.max(ga[0]!.end, gb[0]!.end);
    for (;;) {
      if (i < a.length && a[i]!.start < end) {
        end = Math.max(end, a[i]!.end);
        ga.push(a[i++]!);
      } else if (j < b.length && b[j]!.start < end) {
        end = Math.max(end, b[j]!.end);
        gb.push(b[j++]!);
      } else break;
    }
    const ta = ga.map((u) => u.text).join("");
    const tb = gb.map((u) => u.text).join("");
    if (ta !== tb) diffs.push({ at: ga[0]!.start, a: ta, b: tb });
  }
  return diffs;
}

function main(): void {
  const [dictPath, before, after] = process.argv.slice(2);
  if (!dictPath || !before || !after) throw new Error("使い方: node eval/compare.ts <辞書>.dict.json <辞書なしの結果>.jsonl <辞書ありの結果>.jsonl");
  const terms = (JSON.parse(readFileSync(dictPath, "utf8")) as { terms: DictionaryTerm[] }).terms;
  const a = utterances(before);
  const b = utterances(after);
  const ca = countTerms(a.map((u) => u.text).join(""), terms);
  const cb = countTerms(b.map((u) => u.text).join(""), terms);

  console.log(`確定した発話: 辞書なし ${a.length} / 辞書あり ${b.length}\n`);
  console.log("| 辞書の語 | 辞書なし | 辞書あり |\n|---|---:|---:|");
  const rows = terms
    .map((t) => ({ written: t.written, a: ca.get(t.written) ?? 0, b: cb.get(t.written) ?? 0 }))
    .filter((r) => r.a || r.b)
    .sort((x, y) => y.b - y.a - (x.b - x.a));
  for (const r of rows) console.log(`| ${r.written} | ${r.a} | ${r.b} |`);

  console.log("\n違いのある箇所（- 辞書なし / + 辞書あり）");
  for (const d of differences(a, b)) console.log(`[${Math.round(d.at / 1000)} 秒]\n- ${d.a}\n+ ${d.b}`);
}

if (import.meta.main) main();
