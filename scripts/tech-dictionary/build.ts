// curate.ts の結果から、アプリに組み込む技術用語の辞書（src/shared/tech-dictionary.json）を作る。
//
//   node scripts/tech-dictionary/build.ts
//
// 辞書の語は読みが一致すると優先されるので、共通の辞書は「入れても困らない語」に絞る。
// - 話し言葉で別の語として使われる読み（Claude が collision を付けたもの。例: Deno「での」）は登録しない。読みが 1 つも残らない語は落とし、excluded に理由を残す。
// - 短い読みほど、ほかの語の一部と一致しやすい。1 文字の読みは登録せず、2 文字の読み（Hono「ほの」など）は 10 本以上の記事に出た語に限る。
// - 同じ表記（大文字・小文字と空白の違いを除く）は 1 語にまとめる。
// - 違う表記の語どうしで読みが同じなら、多くの記事に出てくる語に読みを譲る（同じ読みに表記が 2 つあると、どちらが出るかはエンジン次第になる）。

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRegistrableWritten, isValidReading, normalizeReading } from "../../src/shared/amivoice.ts";
import type { TechDictionary, TechTerm } from "../../src/shared/tech-dictionary.ts";
import type { Curated } from "./curate.ts";

const CACHE = join(import.meta.dirname, "../../.cache/zenn");
const OUT = join(import.meta.dirname, "../../src/shared/tech-dictionary.json");
const MAX_READINGS = 4;
const SHORT_READING_MIN_DF = 10;

const sameWord = (w: string) => w.normalize("NFKC").toLowerCase().replace(/[\s_]/g, "");

function main(): void {
  const curated = readdirSync(join(CACHE, "curated"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(join(CACHE, "curated", f), "utf8")) as Curated[]);
  const articles = readdirSync(join(CACHE, "articles")).filter((f) => f.endsWith(".json")).length;

  const excluded: TechDictionary["excluded"] = [];
  const byWord = new Map<string, TechTerm>();
  for (const c of curated) {
    const written = c.written.trim();
    if (!isRegistrableWritten(written) || !/[A-Za-z]/.test(written)) continue;
    const readings: string[] = [];
    const collided: string[] = [];
    const shortOnes: string[] = [];
    for (const r of c.readings) {
      const reading = normalizeReading(r.reading);
      if (!isValidReading(reading) || reading.length <= 1) continue;
      if (r.collision) collided.push(reading);
      else if (reading.length === 2 && c.df < SHORT_READING_MIN_DF) shortOnes.push(reading);
      else readings.push(reading);
    }
    const key = sameWord(written);
    const prev = byWord.get(key);
    if (prev) {
      prev.readings = [...new Set([...prev.readings, ...readings])];
      prev.df = Math.max(prev.df, c.df);
      continue;
    }
    if (readings.length === 0) {
      if (collided.length) excluded.push({ written, readings: collided, reason: "別の語と同じ読み" });
      else if (shortOnes.length) excluded.push({ written, readings: shortOnes, reason: "記事の少ない語の短い読み" });
      continue;
    }
    byWord.set(key, { written, readings: [...new Set(readings)], df: c.df, kind: c.kind });
  }

  // 読みの持ち主を、多くの記事に出てくる語から順に決める
  const terms = [...byWord.values()].sort((a, b) => b.df - a.df || a.written.localeCompare(b.written));
  const owner = new Map<string, string>();
  const out: TechTerm[] = [];
  for (const t of terms) {
    const readings = t.readings.filter((r) => !owner.has(r)).slice(0, MAX_READINGS);
    if (readings.length === 0) {
      excluded.push({ written: t.written, readings: t.readings, reason: `${owner.get(t.readings[0]!)} と同じ読み` });
      continue;
    }
    for (const r of readings) owner.set(r, t.written);
    out.push({ ...t, readings });
  }
  // 落とした語でも、別の表記で辞書に入っていれば excluded からは外す
  const kept = new Set(out.map((t) => sameWord(t.written)));
  const seenExcluded = new Set<string>();
  const finalExcluded = excluded.filter((e) => {
    const key = sameWord(e.written);
    if (kept.has(key) || seenExcluded.has(key)) return false;
    seenExcluded.add(key);
    return true;
  });

  const dict: TechDictionary = {
    source: `Zenn の技術記事 ${articles} 本（記事数の多いトピック上位 400 個の、これまでの人気記事と今週の人気記事）`,
    builtAt: new Date().toISOString().slice(0, 10),
    articles,
    terms: out,
    excluded: finalExcluded,
  };
  writeFileSync(OUT, JSON.stringify(dict, null, 0).replace(/\},\{/g, "},\n{") + "\n");
  const byKind = new Map<string, number>();
  for (const t of out) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
  console.log(`記事 ${articles} 本 → ${out.length} 語（読み ${out.reduce((n, t) => n + t.readings.length, 0)} 個）、除外 ${finalExcluded.length} 語`);
  console.log([...byKind].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("、"));
}

main();
