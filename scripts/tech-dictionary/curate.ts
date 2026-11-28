// candidates.ts の候補を Claude に渡し、字幕に英字で出したい語を選んで読みを付けてもらう。
//
//   ANTHROPIC_API_KEY=... node scripts/tech-dictionary/curate.ts [候補の上限=4500]
//
// 100 語ずつ渡し、結果は .cache/zenn/curated/ に残す（途中で止まっても、残りから続けられる）。
// 最後に build.ts で、読みのぶつかりを除いてアプリの辞書（src/shared/tech-dictionary.json）にする。

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Candidate } from "./candidates.ts";

const CACHE = join(import.meta.dirname, "../../.cache/zenn");
const OUT = join(CACHE, "curated");
const BATCH = 100;
const PARALLEL = 6;

const KINDS = ["言語", "フレームワーク・ライブラリ", "製品・サービス", "クラウドの機能", "ツール・コマンド", "プロトコル・規格・形式", "略語", "技術概念", "企業・団体・コミュニティ"] as const;

const Schema = z.object({
  terms: z.array(
    z.object({
      candidate: z.string().describe("入力の候補の綴り（そのまま）"),
      written: z.string().describe("字幕に出す正式な綴り"),
      readings: z
        .array(
          z.object({
            reading: z.string().describe("日本の開発者が実際に言う読み。ひらがなと長音記号「ー」だけ"),
            collision: z.boolean().describe("この読みが、話し言葉で別の語（助詞の並びを含む）としてよく使われるなら true"),
          }),
        )
        .describe("最大 4 つ"),
      kind: z.enum(KINDS),
    }),
  ),
});
export type Curated = z.infer<typeof Schema>["terms"][number] & { df: number };

const SYSTEM = `あなたは日本語の音声認識エンジン（AmiVoice API のハイブリッドエンジン）に登録する「技術用語の辞書」を作る担当です。
この辞書は、勉強会・LT 会・社内の技術的な会議のリアルタイム字幕で、スライドが無くても最初から効かせる共通の辞書です。
入力は、Zenn の技術記事によく出る英字を含む語の候補です。各行は「候補 / 出てきた記事の数 / インラインコードの中の割合 / 別の綴り / 文脈」です。

残す語: 日本語の技術の話で口頭で言われ、字幕では英字のまま出したい語。
- 言語、フレームワーク、ライブラリ、製品、サービス、クラウドの機能名、ツール、コマンド、プロトコル、規格、口頭で言うファイル形式（JSON、YAML など）
- 英字の略語（CI/CD、LLM、RAG など）、企業・団体・コミュニティの名前
- 技術概念の英語名（Server Components、Row Level Security など）
- 広く使われ、口頭でも名前で呼ぶ API（useEffect など）

落とす語:
- 普通の英単語で、日本語の会話ではカタカナ語として言い、字幕もカタカナでよいもの（data、file、test、error、user、server など）。ただし技術記事で製品名・言語名として使われている語は残す（Rust、Swift、Go など）。
- 口頭で言わない綴り: 記事固有の変数名・関数名・クラス名、CLI のオプション、ファイル名やパス、バージョン番号だけのもの、HTML タグ、設定のキー、人のアカウント名、記事固有の名前。
- 2〜3 語の並びのうち、固有名詞のまとまりになっていないもの（例: 「Next.js App」）。
- 確信を持って何の語か判断できないもの。

残す語の書き方:
- written: 公式の綴り（大文字・小文字、空白、記号）。候補の綴りが崩れていれば直す（Github → GitHub）。
- readings: 日本の開発者が実際に言う読みを、ひらがなと長音記号「ー」だけで、ありうるものをすべて（最大 4 つ）。
  - 略語は 1 文字ずつ読む形を入れ、単語として読む慣用があればそれも入れる（AWS →「えーだぶりゅーえす」、SQL →「えすきゅーえる」「しーくぇる」）。
  - 数字と記号は読み上げる形にする（Next.js →「ねくすとじぇいえす」「ねくすとどっとじぇいえす」、C# →「しーしゃーぷ」）。
- readings の collision: その読みが、話し言葉で「この語ではない別の語」としてよく使われるなら true。
  辞書の語は読みが一致すると優先されるので、別の語と同じ読みで登録すると、その語まで英字に置き換わってしまう。
  カタカナ語が同じものを指すだけなら false（「グーグル」を Google と書くのは正しい置き換え）。
  - true の例: Deno「での」（助詞の並び）、Bun「ぶん」（文・分）、Go「ごー」（数字の 5）、Rust「らすと」（最後の意味のラスト）、Nuxt「なくすと」（無くすと）、Vite「びーと」（ビート）、Mac「まっく」（マクドナルドの略）
  - false の例: Google「ぐーぐる」、Web「うぇぶ」、OS「おーえす」、PR「ぴーあーる」、JSON「じぇいそん」、Vite「ゔぃーと」、Hono「ほの」、Kubernetes「くーばねてぃす」
  すべての読みが true になる語に、別の語とぶつからない言い方（例: Go →「Go言語」「ごーげんご」）が広く使われているなら、それを別の語として追加してよい（candidate は元の候補にする）。
- kind: 種類。

残す語だけを返してください。`;

function line(c: Candidate): string {
  return [c.written, c.df, c.codeShare, c.variants.join(", ") || "-", c.context || "-"].join(" / ");
}

async function curateBatch(client: Anthropic, batch: Candidate[]): Promise<Curated[]> {
  // 出力が長くなるので、ストリーミングで受けて最後にまとめて検証する
  const stream = client.beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: `<candidates>\n${batch.map(line).join("\n")}\n</candidates>` }],
    output_config: { format: betaZodOutputFormat(Schema), effort: "medium" },
  });
  const response = await stream.finalMessage();
  if (response.stop_reason !== "end_turn") throw new Error(`stop_reason=${response.stop_reason}`);
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = Schema.parse(JSON.parse(text));
  const df = new Map(batch.map((c) => [c.written, c.df]));
  return parsed.terms.map((t) => ({ ...t, df: df.get(t.candidate) ?? 0 }));
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("環境変数 ANTHROPIC_API_KEY を設定してください");
  const limit = Number(process.argv[2] ?? 4500);
  const candidates = (JSON.parse(readFileSync(join(CACHE, "candidates.json"), "utf8")) as Candidate[]).slice(0, limit);
  mkdirSync(OUT, { recursive: true });
  const client = new Anthropic({ apiKey });
  const batches: number[] = [];
  for (let i = 0; i * BATCH < candidates.length; i++) if (!existsSync(join(OUT, `${String(i).padStart(3, "0")}.json`))) batches.push(i);
  console.log(`候補 ${candidates.length} 語、残り ${batches.length} 組`);
  const worker = async () => {
    for (let i = batches.shift(); i !== undefined; i = batches.shift()) {
      const batch = candidates.slice(i * BATCH, (i + 1) * BATCH);
      for (let attempt = 1; ; attempt++) {
        try {
          const terms = await curateBatch(client, batch);
          writeFileSync(join(OUT, `${String(i).padStart(3, "0")}.json`), JSON.stringify(terms, null, 1));
          console.log(`組 ${i}: ${batch.length} 語から ${terms.length} 語`);
          break;
        } catch (err) {
          console.error(`組 ${i}: ${err instanceof Error ? err.message : err}`);
          if (attempt >= 3) break;
          await new Promise((r) => setTimeout(r, 10_000 * attempt));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

if (import.meta.main) await main();
