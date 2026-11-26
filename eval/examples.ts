// 台本の用語が、条件ごとの認識結果で何になったかを並べる（記事の例を、実測からそのまま拾うためのもの）。
//
//   node eval/examples.ts workers eval/out/workers.a-general.nodict.jsonl eval/out/workers.a-general.slides.jsonl
//   node eval/examples.ts workers --sentences eval/out/...   # 用語を含む文ごとに並べる
//
// 正解と認識結果を正規化（metrics.ts の normalize と同じ）した文字列どうしで対応を取り、
// 正解の用語の範囲に対応する認識結果の部分を、元の表記のまま切り出す。

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { parseServerEvent, stripFillers } from "../src/shared/amivoice.ts";
import { asyncUtterances, type AsyncJobResult } from "../src/shared/async-result.ts";
import { normalize } from "../src/shared/metrics.ts";

interface Truth {
  turns: { text: string }[];
  terms: string[];
}

/** 認識結果の本文（フィラーを除く）。ライブは確定結果をつなぎ、非同期は発話をつなぐ。 */
export function hypothesisOf(path: string): string {
  if (path.endsWith(".async.json")) {
    const { result } = JSON.parse(readFileSync(path, "utf8")) as { result: AsyncJobResult };
    return stripFillers(asyncUtterances(result).map((u) => u.text).join(""));
  }
  const texts: string[] = [];
  for (const line of readFileSync(path, "utf8").trim().split("\n").slice(1)) {
    const ev = parseServerEvent((JSON.parse(line) as { raw: string }).raw);
    if (ev.kind === "A" && ev.result.text?.trim()) texts.push(ev.result.text.replace(/_/g, " "));
  }
  return stripFillers(texts.join(""));
}

/** 正規化した文字の列と、それぞれの文字が元の文字列のどこから来たか */
function normalizedWithMap(text: string): { chars: string[]; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  const raw = [...text];
  raw.forEach((c, i) => {
    for (const n of normalize(c)) {
      chars.push(n);
      map.push(i);
    }
  });
  return { chars, map };
}

/** 正解の各文字に対応する認識結果の文字の位置（対応がなければ -1）。編集距離の表を逆にたどって求める。 */
function align(ref: string[], hyp: string[]): { from: number; to: number }[] {
  const n = ref.length;
  const m = hyp.length;
  const w = m + 1;
  const d = new Uint32Array((n + 1) * w);
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    d[i * w] = i;
    for (let j = 1; j <= m; j++) {
      d[i * w + j] = Math.min(d[(i - 1) * w + j]! + 1, d[i * w + j - 1]! + 1, d[(i - 1) * w + j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
  }
  // 正解の i 文字目の前後に対応する認識結果の範囲 [from, to)
  const span = Array.from({ length: n }, () => ({ from: -1, to: -1 }));
  let i = n;
  let j = m;
  let pendingTo = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * w + j] === d[(i - 1) * w + j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      span[i - 1] = { from: j - 1, to: pendingTo };
      pendingTo = j - 1;
      i--;
      j--;
    } else if (i > 0 && d[i * w + j] === d[(i - 1) * w + j]! + 1) {
      span[i - 1] = { from: j, to: j === pendingTo ? j : pendingTo };
      pendingTo = j;
      i--;
    } else {
      j--;
    }
  }
  return span;
}

function main(): void {
  const { values, positionals } = parseArgs({ options: { data: { type: "string", default: "eval/data" } }, allowPositionals: true });
  const [talk, ...files] = positionals;
  if (!talk || !files.length) throw new Error("使い方: node eval/examples.ts <LT の id> <認識結果のファイル>...");
  const truth = JSON.parse(readFileSync(`${values.data}/${talk}.truth.json`, "utf8")) as Truth;
  const reference = truth.turns.map((t) => t.text).join("");
  const ref = normalizedWithMap(reference);
  const columns = files.map((f) => {
    const text = hypothesisOf(f);
    const hyp = normalizedWithMap(text);
    return { name: basename(f).replace(`${talk}.`, "").replace(/\.(jsonl|async\.json)$/, ""), text: [...text], hyp, span: align(ref.chars, hyp.chars) };
  });
  console.log(`| 用語 | ${columns.map((c) => c.name).join(" | ")} |`);
  console.log(`|---|${columns.map(() => "---").join("|")}|`);
  const seen = new Set<string>();
  for (const term of truth.terms) {
    const t = normalize(term);
    const refText = ref.chars.join("");
    for (let at = refText.indexOf(t); at >= 0; at = refText.indexOf(t, at + t.length)) {
      const cells = columns.map((c) => {
        // 用語の最初の文字の対応から最後の文字の対応まで（その間の挿入も含む）
        const from = c.span[at]!.from;
        const to = c.span[at + t.length - 1]!.to;
        if (from < 0 || to <= from) return "（抜け）";
        const rawFrom = c.hyp.map[from]!;
        const rawTo = c.hyp.map[to - 1]!;
        return c.text.slice(rawFrom, rawTo + 1).join("");
      });
      const key = [term, ...cells].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`| ${term} | ${cells.join(" | ")} |`);
    }
  }
}

if (import.meta.main) main();
