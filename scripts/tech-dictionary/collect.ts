// Zenn の技術記事を集めて、技術用語の辞書の材料にする。
//
//   node scripts/tech-dictionary/collect.ts [トピック数=400]
//
// 1. 記事数の多いトピック（Zenn のタグ）を上から 1,000 個読む。トピックの表示名そのものも辞書の候補になる。
// 2. 上位のトピックごとに、これまでに人気の記事（alltime）と今週人気の記事（weekly）を数本ずつ選ぶ。
//    古い定番の記事だけだと新しい製品名（例: Claude Code）が拾えないので、両方を混ぜる。
// 3. 選んだ記事の本文を読む。
//
// zenn.dev/api は公式に案内されている API ではない（robots.txt では /search 以外を許可）。
// 負荷をかけないよう 0.5 秒に 1 回だけ読み、読んだものは .cache/zenn/ に残して二度読まない。
// 記事の本文は他人の著作物なのでリポジトリには入れない（.cache/ は .gitignore 済み）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE = join(import.meta.dirname, "../../.cache/zenn");
const ARTICLES = join(CACHE, "articles");
const INTERVAL_MS = 500;
const UA = "Mozilla/5.0 (compatible; tech-term-dictionary-builder)";

export interface Topic {
  name: string;
  display_name: string;
  taggings_count: number;
}
interface ListedArticle {
  slug: string;
  title: string;
  article_type: string;
  liked_count: number;
  published_at: string;
  path: string;
}

let last = 0;
async function getJson<T>(url: string): Promise<T> {
  const wait = last + INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (res.ok) return (await res.json()) as T;
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    throw new Error(`${res.status} ${url}`);
  }
}

async function main(): Promise<void> {
  const topicCount = Number(process.argv[2] ?? 400);
  mkdirSync(ARTICLES, { recursive: true });

  const topicsFile = join(CACHE, "topics.json");
  let topics: Topic[];
  if (existsSync(topicsFile)) {
    topics = JSON.parse(readFileSync(topicsFile, "utf8")) as Topic[];
  } else {
    topics = [];
    for (let page = 1; page <= 10; page++) {
      const { topics: got } = await getJson<{ topics: Topic[] }>(`https://zenn.dev/api/topics?order=count&count=100&page=${page}`);
      topics.push(...got.map(({ name, display_name, taggings_count }) => ({ name, display_name, taggings_count })));
      if (got.length < 100) break;
    }
    writeFileSync(topicsFile, JSON.stringify(topics, null, 1));
  }
  console.log(`トピック ${topics.length} 個`);

  const listFile = join(CACHE, "list.json");
  const listed = new Map<string, ListedArticle & { topics: string[] }>(
    existsSync(listFile) ? (JSON.parse(readFileSync(listFile, "utf8")) as (ListedArticle & { topics: string[] })[]).map((a) => [a.slug, a]) : [],
  );
  const doneTopics = new Set([...listed.values()].flatMap((a) => a.topics));
  for (const topic of topics.slice(0, topicCount)) {
    if (doneTopics.has(topic.name)) continue;
    for (const [order, count] of [["alltime", 5], ["weekly", 3]] as const) {
      const { articles } = await getJson<{ articles: ListedArticle[] }>(
        `https://zenn.dev/api/articles?topicname=${encodeURIComponent(topic.name)}&order=${order}&count=${count}`,
      );
      for (const a of articles) {
        if (a.article_type !== "tech") continue;
        const prev = listed.get(a.slug);
        if (prev) prev.topics = [...new Set([...prev.topics, topic.name])];
        else listed.set(a.slug, { slug: a.slug, title: a.title, article_type: a.article_type, liked_count: a.liked_count, published_at: a.published_at, path: a.path, topics: [topic.name] });
      }
    }
    writeFileSync(listFile, JSON.stringify([...listed.values()], null, 1));
  }
  console.log(`記事 ${listed.size} 本`);

  let fetched = 0;
  for (const a of listed.values()) {
    const file = join(ARTICLES, `${a.slug}.json`);
    if (existsSync(file)) continue;
    try {
      const { article } = await getJson<{ article: { title: string; body_html: string } }>(`https://zenn.dev/api/articles/${a.slug}`);
      writeFileSync(file, JSON.stringify({ title: article.title, body_html: article.body_html }));
    } catch (err) {
      console.warn(`読めなかった: ${a.path} (${err instanceof Error ? err.message : err})`);
    }
    if (++fetched % 100 === 0) console.log(`本文 ${fetched} 本`);
  }
  console.log("完了");
}

if (import.meta.main) await main();
