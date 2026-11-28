// Zenn の技術記事から作った、どのルームでも最初から使える技術用語の辞書。
// 作り方は scripts/tech-dictionary/ を参照（記事を集める → 英字を含む語を数える → Claude が選んで読みを付ける → 読みのぶつかりを除く）。

import data from "./tech-dictionary.json" with { type: "json" };
import { normalizeReading, type DictionaryTerm } from "./amivoice.ts";

export interface TechTerm {
  written: string;
  readings: string[];
  /** 出てきた記事の数 */
  df: number;
  kind: string;
}

export interface TechDictionary {
  source: string;
  builtAt: string;
  articles: number;
  terms: TechTerm[];
  /** 登録しなかった語と理由（話し言葉で別の語として使われる読み、辞書のほかの語と同じ読み、記事の少ない語の短い読み） */
  excluded: { written: string; readings: string[]; reason: string }[];
}

export const TECH_DICTIONARY = data as TechDictionary;

export const TECH_SOURCE = "Zenn の技術用語";

const sameWord = (w: string) => w.normalize("NFKC").toLowerCase().replace(/[\s_]/g, "");

/**
 * ルームの辞書（スライドから作った語など）に、技術用語の辞書を重ねる。ルームの辞書を優先する。
 * - ルームの辞書と同じ表記の語は入れない。
 * - ルームの辞書の語と同じ読みは入れない（同じ読みに表記が 2 つあると、どちらが字幕に出るかはエンジン次第になる）。
 *   スライドに「MCP サーバー」とあれば、技術用語の辞書の「MCP Server」の同じ読みは使わない。
 */
export function withTechTerms(roomTerms: DictionaryTerm[], tech: TechTerm[] = TECH_DICTIONARY.terms): DictionaryTerm[] {
  const words = new Set(roomTerms.map((t) => sameWord(t.written)));
  const readings = new Set(roomTerms.flatMap((t) => t.readings.map(normalizeReading)));
  const added: DictionaryTerm[] = [];
  for (const t of tech) {
    if (words.has(sameWord(t.written))) continue;
    const free = t.readings.filter((r) => !readings.has(r));
    if (free.length === 0) continue;
    added.push({ written: t.written, readings: free, source: TECH_SOURCE });
  }
  return [...roomTerms, ...added];
}
