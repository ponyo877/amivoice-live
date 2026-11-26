// スライドの PDF から、アプリと同じ処理（src/worker/terms.ts）で Claude に辞書を作らせ、台本の正解の用語と比べる。
//
//   ANTHROPIC_API_KEY=... node eval/dictionary.ts            # eval/data/*.slides.pdf の全部
//   node eval/dictionary.ts --compare-only                   # 作り直さずに比べるだけ
//
// 出力: eval/data/<id>.slides.dict.json（stream.ts / async.ts の --dictionary に渡す）
// 比べる指標:
// - 用語の網羅率: 台本の正解の用語のうち、辞書に同じ表記（正規化して比較）で入った割合
// - 読みの一致率: 網羅できた用語のうち、台本で読み上げた読みが辞書の読みのどれかと一致した割合（ハイブリッドエンジンは読みで照合するため）

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { normalizeReading, type DictionaryTerm } from "../src/shared/amivoice.ts";
import { normalize } from "../src/shared/metrics.ts";
import { extractTerms } from "../src/worker/terms.ts";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "compare-only": { type: "boolean", default: false } } });
  const ids = positionals.length ? positionals : readdirSync(DATA).filter((f) => f.endsWith(".slides.pdf")).map((f) => f.replace(/\.slides\.pdf$/, ""));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!values["compare-only"] && !apiKey) throw new Error("環境変数 ANTHROPIC_API_KEY を設定してください");

  console.log("| LT | 辞書の語数 | 用語の網羅率 | 読みの一致率 | 辞書に入らなかった用語 | 読みが合わなかった用語（台本の読み → 辞書の読み） |");
  console.log("|---|---:|---:|---:|---|---|");
  for (const id of ids) {
    const out = join(DATA, `${id}.slides.dict.json`);
    if (!values["compare-only"]) {
      const t0 = Date.now();
      const terms = await extractTerms(apiKey!, { kind: "pdf", data: new Uint8Array(readFileSync(join(DATA, `${id}.slides.pdf`))) });
      writeFileSync(out, JSON.stringify({ terms, source: `${id}.slides.pdf`, elapsedMs: Date.now() - t0, at: new Date().toISOString() }, null, 1) + "\n");
    }
    if (!existsSync(out)) continue;
    const dict = (JSON.parse(readFileSync(out, "utf8")) as { terms: DictionaryTerm[] }).terms;
    const oracle = (JSON.parse(readFileSync(join(DATA, `${id}.oracle.dict.json`), "utf8")) as { terms: DictionaryTerm[] }).terms;
    const byWritten = new Map(dict.map((t) => [normalize(t.written), t]));
    const missing: string[] = [];
    const readingMiss: string[] = [];
    let covered = 0;
    let readingHit = 0;
    for (const o of oracle) {
      const d = byWritten.get(normalize(o.written));
      if (!d) {
        missing.push(o.written);
        continue;
      }
      covered++;
      const readings = new Set(d.readings.map(normalizeReading));
      if (o.readings.some((r) => readings.has(normalizeReading(r)))) readingHit++;
      else readingMiss.push(`${o.written}: ${o.readings.join("/")} → ${d.readings.join("/")}`);
    }
    const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}% (${a}/${b})` : "–");
    console.log(`| ${id} | ${dict.length} | ${pct(covered, oracle.length)} | ${pct(readingHit, covered)} | ${missing.join(", ") || "–"} | ${readingMiss.join("<br>") || "–"} |`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
