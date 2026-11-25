// 登壇スライド（PDF）や概要テキストから、AmiVoice のユーザー辞書に登録する語を Claude で抽出する。

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { isRegistrableWritten, isValidReading, normalizeReading, type DictionaryTerm } from "../shared/amivoice.ts";

const MODEL = "claude-opus-5-5";
const MAX_TERMS = 150;

const TermsSchema = z.object({
  terms: z.array(
    z.object({
      written: z.string().describe("字幕に表示したい表記。スライドに書かれている綴りをそのまま使う"),
      readings: z.array(z.string()).describe("登壇者が実際に発音しそうな読み。ひらがなと長音記号「ー」だけで書く"),
      source: z.string().describe("出現箇所。PDF ならページ番号（例: p.3）"),
    }),
  ),
});

const SYSTEM_PROMPT = `あなたは日本語の音声認識エンジン（AmiVoice API）向けのユーザー辞書を作る担当です。
入力は技術勉強会・LT 会の登壇資料です。登壇者が口頭で言いそうな語のうち、汎用の音声認識では誤認識されやすい語を選んでください。

選ぶ語:
- 製品名・サービス名・ライブラリ名・フレームワーク名・API 名・コマンド名（例: Durable Objects, Hono, kubectl）
- 英字の略語（例: CI/CD, LLM, WAF）
- 分野固有の技術用語（例: 冪等性, ダイアライゼーション）
- 人名・組織名・コミュニティ名・イベント名

選ばない語:
- 一般的な日本語の語（例: 開発, データ, 実装）や、誰でも正しく認識される語
- 1 回しか出てこず、口頭で言う可能性が低い語（URL、コード片、脚注の文献名など）

各語の書き方:
- written: 字幕に表示したい表記を、資料に書かれている綴りのまま書く。
- readings: 日本語話者が実際に発音しそうな読みを、ひらがなと長音記号「ー」だけで書く。読み方が複数ありうる語は、ありうるものをすべて入れる。
  - 英字略語は 1 文字ずつ読む形を入れ、単語として読む慣用があればそれも入れる（例: AWS →「えーだぶりゅーえす」、SQL →「えすきゅーえる」「しーくぇる」）。
  - 英単語は日本語の発音に寄せたカタカナ読みをひらがなにする（例: Durable Objects →「でゅらぶるおぶじぇくつ」）。
  - 数字や記号は読み上げる形にする（例: Next.js →「ねくすとじぇいえす」「ねくすとどっとじぇいえす」）。
- source: 出現箇所（PDF ならページ番号）。

最大 ${MAX_TERMS} 語。口頭で言われる可能性が高く、誤認識されやすい語から順に並べてください。`;

export type ExtractInput = { kind: "pdf"; data: Uint8Array } | { kind: "text"; text: string };

export async function extractTerms(apiKey: string, input: ExtractInput): Promise<DictionaryTerm[]> {
  const client = new Anthropic({ apiKey });

  const content: Anthropic.Beta.BetaContentBlockParam[] =
    input.kind === "pdf"
      ? [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: toBase64(input.data) },
          },
          { type: "text", text: "この登壇資料から辞書に登録する語を抽出してください。" },
        ]
      : [{ type: "text", text: `次の資料から辞書に登録する語を抽出してください。\n\n<document>\n${input.text}\n</document>` }];

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // 拒否されたときはサーバ側で自動的に別モデルにフォールバックする
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    output_config: { format: betaZodOutputFormat(TermsSchema), effort: "medium" },
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude が抽出を断りました");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("抽出結果が長すぎて途中で切れました");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("抽出結果を解釈できませんでした");
  return normalizeTerms(parsed.terms);
}

const SuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      written: z.string().describe("字幕に出るべきだった正しい表記"),
      readings: z.array(z.string()).describe("登壇者の発音に近い読み。ひらがなと長音記号「ー」だけで書く"),
      heard: z.string().describe("書き起こしで実際にどう誤認識されていたか（書き起こしの文字列をそのまま）"),
      reason: z.string().describe("そう判断した理由を 1 文で"),
    }),
  ),
});

export interface TermSuggestion extends DictionaryTerm {
  heard: string;
  reason: string;
}

const SUGGEST_PROMPT = `あなたは日本語の音声認識エンジン（AmiVoice API）のユーザー辞書を育てる担当です。
入力は、技術勉強会・LT 会の登壇を音声認識した書き起こしと、そのとき使っていた辞書です。
書き起こしの ⟦表記|読み|信頼度⟧ は、認識エンジンが自信を持てなかった語です（読みや信頼度が空のこともあります）。

やること: 誤認識されたと思われる技術用語・製品名・人名などを見つけ、次回の登壇で正しく認識されるよう辞書に追加すべき語を提案する。

判断のしかた:
- 前後の文脈から、本来は何という語だったかを推測する。カタカナ語やひらがなの連なりが、英字の製品名や略語の誤認識であることが多い（例: 「デュラブルオブジェクト」→ Durable Objects）。
- 自信のない語の印が無くても、明らかな誤認識は対象にする。逆に、印があっても一般的な語が正しく認識されているだけなら提案しない。
- すでに辞書にある語は提案しない。ただし辞書にあるのに誤認識されている語は、別の読みを足す提案をしてよい（written は辞書と同じ表記にし、readings に足すべき読みを入れる）。
- 確信の持てない推測はしない。提案は多くても 30 語。

各項目:
- written: 字幕に出るべき正しい表記
- readings: 書き起こしの誤認識や読みから推測した、登壇者の実際の発音に近い読み（ひらがなと「ー」だけ）
- heard: 書き起こしでの誤認識（書き起こしの文字列をそのまま）
- reason: 判断の理由を 1 文で`;

/** 登壇の書き起こし（自信のない語に印付き）から、辞書に追加すべき語を提案する。 */
export async function suggestTerms(apiKey: string, transcript: string, dictionary: DictionaryTerm[]): Promise<TermSuggestion[]> {
  const client = new Anthropic({ apiKey });
  const dictText = dictionary.length > 0 ? dictionary.map((t) => `${t.written}（${t.readings.join("、") || "読みなし"}）`).join("\n") : "（なし）";
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SUGGEST_PROMPT,
    messages: [
      {
        role: "user",
        content: `<dictionary>\n${dictText}\n</dictionary>\n\n<transcript>\n${transcript.slice(0, 150_000)}\n</transcript>`,
      },
    ],
    output_config: { format: betaZodOutputFormat(SuggestionSchema), effort: "medium" },
  });
  if (response.stop_reason === "refusal") throw new Error("Claude が提案を断りました");
  if (response.stop_reason === "max_tokens") throw new Error("提案が長すぎて途中で切れました");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("提案を解釈できませんでした");
  const out: TermSuggestion[] = [];
  for (const s of parsed.suggestions) {
    const [term] = normalizeTerms([{ written: s.written, readings: s.readings, source: "登壇の書き起こし" }]);
    if (term) out.push({ ...term, heard: s.heard, reason: s.reason });
  }
  return out;
}

/** 読みの検証・重複の除去・上限の適用。 */
export function normalizeTerms(raw: { written: string; readings: string[]; source?: string }[]): DictionaryTerm[] {
  const byWritten = new Map<string, DictionaryTerm>();
  for (const t of raw) {
    const written = t.written.trim();
    if (!isRegistrableWritten(written)) continue;
    const readings = [...new Set(t.readings.map(normalizeReading).filter(isValidReading))];
    const existing = byWritten.get(written);
    if (existing) {
      existing.readings = [...new Set([...existing.readings, ...readings])];
      continue;
    }
    byWritten.set(written, { written, readings, source: t.source });
  }
  return [...byWritten.values()].slice(0, MAX_TERMS);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
