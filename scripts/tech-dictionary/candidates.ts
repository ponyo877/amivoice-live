// 集めた Zenn の記事から、辞書の候補にする「英字を含む語」を数える（Claude は使わない）。
//
//   node scripts/tech-dictionary/candidates.ts
//
// 字幕で英字のまま出したい語（製品名・ライブラリ名・略語など）は、辞書が無いとカタカナや別の語になりやすい。
// 実験でも、辞書なしで正しく出た用語は 4 分の 1 ほどだった。漢字やカタカナの技術用語は辞書なしでもおおむね正しく出るので、ここでは数えない。
//
// - コードブロック、数式、埋め込み、URL は除く（読み上げられない綴りが大量に混ざるため）。本文中のインラインコードは残し、その割合を記録する。
// - 1 語だけでなく、「GitHub Actions」「Claude Code」のように空白で続く 2〜3 語も数える。
// - 何本の記事に出たか（DF）で数え、表記の大文字・小文字の揺れは最も多い綴りにまとめる。
// - Zenn のトピックの表示名（英字を含むもの）は、DF が少なくても候補に入れる。
// 出力: .cache/zenn/candidates.json（Claude に渡す前段の材料。記事の文脈の抜粋を含むのでリポジトリには入れない）

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Topic } from "./collect.ts";

const CACHE = join(import.meta.dirname, "../../.cache/zenn");

export interface Candidate {
  written: string;
  /** 出てきた記事の数 */
  df: number;
  /** 出てきた回数（全記事の合計） */
  count: number;
  /** インラインコードの中に出てきた割合 */
  codeShare: number;
  variants: string[];
  topic: boolean;
  /** 文脈の抜粋（Claude が意味と読みを判断するため） */
  context: string;
}

function cleanHtml(html: string): string {
  return html
    .replace(/<(pre|script|style|svg|iframe|embed-katex|math)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<span class="embed-block[\s\S]*?<\/span>/g, " ")
    .replace(/<code>([\s\S]*?)<\/code>/g, (_, inner: string) => ` ⁠${inner}⁠ `)
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(p|h\d|li|tr|div|blockquote|td|th|figcaption)>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/https?:\/\/[^\s⁠]+/g, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, " ");
}

// 英字で始まる語。Next.js、C++、C#、gpt-4o、Node.js のような綴りも 1 語として取る
const WORD = /[A-Za-z][A-Za-z0-9]*(?:[.\-+'][A-Za-z0-9]+)*(?:\+\+|#)?/g;
// 空白 1 つで続く英字の語の並び（日本語の文中に埋まった「GitHub Actions」など）
const RUN = /[A-Za-z][A-Za-z0-9.\-+#']*(?: [A-Za-z][A-Za-z0-9.\-+#']*)*/g;

function isCapitalized(word: string): boolean {
  return /[A-Z0-9]/.test(word);
}

function main(): void {
  const topics = JSON.parse(readFileSync(join(CACHE, "topics.json"), "utf8")) as Topic[];
  const files = readdirSync(join(CACHE, "articles")).filter((f) => f.endsWith(".json"));
  const stats = new Map<string, { df: number; count: number; code: number; forms: Map<string, number>; context: string }>();

  for (const file of files) {
    const { title, body_html } = JSON.parse(readFileSync(join(CACHE, "articles", file), "utf8")) as { title: string; body_html: string };
    const text = `${title}\n${cleanHtml(body_html)}`;
    const seen = new Set<string>();
    const add = (form: string, inCode: boolean, at: number) => {
      const key = form.toLowerCase();
      let s = stats.get(key);
      if (!s) {
        s = { df: 0, count: 0, code: 0, forms: new Map(), context: "" };
        stats.set(key, s);
      }
      s.count++;
      if (inCode) s.code++;
      s.forms.set(form, (s.forms.get(form) ?? 0) + 1);
      if (!seen.has(key)) {
        seen.add(key);
        s.df++;
      }
      // 日本語の文中に出てきた箇所を文脈として残す（コードの中より意味が取りやすい）
      if (!s.context && !inCode) {
        const snippet = text.slice(Math.max(0, at - 30), at + form.length + 30).replace(/\s+/g, " ").replace(/⁠/g, "");
        if (/[ぁ-んァ-ン一-龠]/.test(snippet)) s.context = snippet;
      }
    };
    // インラインコードの範囲
    const codeRanges: [number, number][] = [];
    for (const m of text.matchAll(/⁠[^⁠]*⁠/g)) codeRanges.push([m.index, m.index + m[0].length]);
    const inCode = (i: number) => codeRanges.some(([a, b]) => i >= a && i < b);

    for (const m of text.matchAll(RUN)) {
      const run = m[0].replace(/[.\-+']+$/, "");
      const words = [...run.matchAll(WORD)].map((w) => ({ w: w[0], i: m.index + w.index }));
      for (const { w, i } of words) add(w, inCode(i), i);
      // 2〜3 語の並び。固有名詞らしいもの（どの語にも大文字か数字がある）だけ数える
      for (let n = 2; n <= 3; n++) {
        for (let k = 0; k + n <= words.length; k++) {
          const part = words.slice(k, k + n);
          if (!part.every((p) => isCapitalized(p.w))) continue;
          const phrase = part.map((p) => p.w).join(" ");
          if (!run.includes(phrase)) continue;
          add(phrase, inCode(part[0]!.i), part[0]!.i);
        }
      }
    }
  }

  const topicNames = new Map(topics.filter((t) => /[A-Za-z]/.test(t.display_name)).map((t) => [t.display_name.toLowerCase(), t.display_name]));
  const out: Candidate[] = [];
  for (const [key, s] of stats) {
    const isTopic = topicNames.has(key);
    const multi = key.includes(" ");
    if (!isTopic && s.df < (multi ? 3 : 4)) continue;
    if (/^[a-z]$/i.test(key) || /^[0-9.\-]+$/.test(key)) continue;
    const forms = [...s.forms].sort((a, b) => b[1] - a[1]);
    out.push({
      written: isTopic ? topicNames.get(key)! : forms[0]![0],
      df: s.df,
      count: s.count,
      codeShare: Math.round((s.code / s.count) * 100) / 100,
      variants: forms.slice(1, 4).map(([f]) => f),
      topic: isTopic,
      context: s.context,
    });
    topicNames.delete(key);
  }
  // 記事に出てこなかったトピック
  for (const name of topicNames.values()) out.push({ written: name, df: 0, count: 0, codeShare: 0, variants: [], topic: true, context: "" });

  // 2〜3 語の並びが、それを含む 1 語とほぼ同じ記事にしか出ないなら残し、逆に 1 語の一部分でしかない並びは Claude に判断させる
  out.sort((a, b) => b.df - a.df || b.count - a.count);
  writeFileSync(join(CACHE, "candidates.json"), JSON.stringify(out, null, 1));
  const single = out.filter((c) => !c.written.includes(" ")).length;
  console.log(`記事 ${files.length} 本から候補 ${out.length} 語（1 語 ${single}、2〜3 語 ${out.length - single}、トピック ${out.filter((c) => c.topic).length}）`);
}

main();
