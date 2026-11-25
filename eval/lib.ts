// 評価スクリプトの共通処理: 音声の変換、文字誤り率（CER）、辞書語の再現率、統計。

import { spawnSync } from "node:child_process";
import { normalize } from "../src/shared/metrics.ts";

export { cer, editDistance, normalize } from "../src/shared/metrics.ts";

/** ffmpeg で任意の音声・動画ファイルを 16kHz・16bit・モノラル PCM に変換する。 */
export function toPcm16k(path: string): Buffer {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ffmpeg に失敗しました: ${r.stderr.toString()}`);
  return r.stdout;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

export interface TermRecall {
  term: string;
  inReference: number;
  inHypothesis: number;
}

/**
 * 辞書語の再現率。正解に出てくる回数のうち、認識結果にも同じ表記で出てきた回数の割合。
 * 認識結果に正解より多く出ても、正解の回数で頭打ちにする。
 */
export function termRecall(reference: string, hypothesis: string, terms: string[]): { recall: number | null; hits: number; total: number; perTerm: TermRecall[] } {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  const perTerm: TermRecall[] = [];
  let hits = 0;
  let total = 0;
  for (const term of new Set(terms)) {
    const t = normalize(term);
    const inReference = countOccurrences(ref, t);
    if (inReference === 0) continue;
    const inHypothesis = countOccurrences(hyp, t);
    perTerm.push({ term, inReference, inHypothesis });
    total += inReference;
    hits += Math.min(inReference, inHypothesis);
  }
  return { recall: total === 0 ? null : hits / total, hits, total, perTerm };
}

export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}
