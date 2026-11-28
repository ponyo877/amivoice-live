// 技術用語の辞書（src/shared/tech-dictionary.json）を使う条件の辞書ファイルを作る。アプリと同じ withTechTerms で重ねる。
//
//   node eval/tech-dictionary.ts
//
// - <音声>.tech.dict.json: 技術用語の辞書だけ（スライドが手元にない登壇を想定）
// - <音声>.slidestech.dict.json: スライドから作った辞書に技術用語の辞書を重ねたもの（アプリの既定）
// 模擬 LT（eval/data/<id>.slides.dict.json）と、実際の登壇（eval/data/real/*.wav）の両方に作る。

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DictionaryTerm } from "../src/shared/amivoice.ts";
import { TECH_DICTIONARY, withTechTerms } from "../src/shared/tech-dictionary.ts";

const DATA = join(import.meta.dirname, "data");

function write(path: string, terms: DictionaryTerm[]): void {
  writeFileSync(path, JSON.stringify({ terms }, null, 1));
  console.log(`${path}: ${terms.length} 語`);
}

console.log(`技術用語の辞書: ${TECH_DICTIONARY.terms.length} 語（${TECH_DICTIONARY.source}）`);
for (const id of ["workers", "rust", "rag"]) {
  const slides = (JSON.parse(readFileSync(join(DATA, `${id}.slides.dict.json`), "utf8")) as { terms: DictionaryTerm[] }).terms;
  write(join(DATA, `${id}.tech.dict.json`), withTechTerms([]));
  write(join(DATA, `${id}.slidestech.dict.json`), withTechTerms(slides));
}
const real = join(DATA, "real");
if (existsSync(real)) {
  for (const wav of readdirSync(real).filter((f) => f.endsWith(".wav"))) write(join(real, wav.replace(/\.wav$/, ".tech.dict.json")), withTechTerms([]));
}
