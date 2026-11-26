// スライドの代わりに、テキストや Zenn の記事から、アプリと同じ処理（src/worker/terms.ts）で辞書を作る。
// 登壇者が登壇と同じ内容を Zenn に書いていることは多いので、スライドが手元にないときの代わりになる。
//
//   ANTHROPIC_API_KEY=... node eval/text-dictionary.ts talk.zenn.dict.json https://zenn.dev/<user>/articles/<slug>
//   ANTHROPIC_API_KEY=... node eval/text-dictionary.ts talk.abstract.dict.json abstract.txt
//
// 入力は何個でも渡せる（つないで 1 つの資料として渡す）。Zenn の記事の URL は、記事の本文を JSON で返す
// zenn.dev/api/articles/<slug> から読む（公式に案内されている API ではないので、変わったら本文をテキストで渡す）。
// 出力は stream.ts の --dictionary に渡せる形式。辞書の種類は名前（<音声>.<種類>.dict.json）から取られる。
// Claude に渡したテキストは <出力>.source.txt に残す。

import { readFileSync, writeFileSync } from "node:fs";
import { sharedReadings } from "../src/shared/amivoice.ts";
import { extractTerms } from "../src/worker/terms.ts";

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(p|h\d|li|pre|tr|div)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function readSource(source: string): Promise<string> {
  const zenn = source.match(/^https:\/\/zenn\.dev\/[^/]+\/articles\/([\w-]+)/);
  if (zenn) {
    const res = await fetch(`https://zenn.dev/api/articles/${zenn[1]}`);
    if (!res.ok) throw new Error(`Zenn の記事を読めませんでした（${res.status}）: ${source}`);
    const { article } = (await res.json()) as { article: { title: string; body_html: string } };
    return `# ${article.title}\n${htmlToText(article.body_html)}`;
  }
  const text = readFileSync(source, "utf8");
  return /\.html?$/.test(source) ? htmlToText(text) : text;
}

async function main(): Promise<void> {
  const [out, ...sources] = process.argv.slice(2);
  if (!out?.endsWith(".dict.json") || !sources.length) throw new Error("使い方: node eval/text-dictionary.ts <出力>.dict.json <テキストか Zenn の記事の URL>...");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("環境変数 ANTHROPIC_API_KEY を設定してください");

  const text = (await Promise.all(sources.map(readSource))).join("\n\n");
  writeFileSync(out.replace(/\.dict\.json$/, ".source.txt"), text);
  const terms = await extractTerms(apiKey, { kind: "text", text });
  writeFileSync(out, JSON.stringify({ terms }, null, 1));
  console.log(`${text.length} 文字から ${terms.length} 語 → ${out}`);
  // 同じ読みの語があると、どちらの表記が字幕に出るかはエンジン次第になる（アプリの辞書の表と同じ確認）
  for (const s of sharedReadings(terms)) console.log(`同じ読みの語: ${s.reading}: ${s.indices.map((i) => terms[i]!.written).join(" と ")}`);
}

if (import.meta.main) await main();
