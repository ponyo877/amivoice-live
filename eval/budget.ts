// AmiVoice API に送った音声の長さを記録し、無料クーポンの範囲（月 10 時間）を超える実行を始める前に止める。
//
//   node eval/budget.ts          # 月ごとの使用量と残り
//
// - 実際の課金は「発話区間」だけ（無音は含まない）だが、ここでは送った音声の長さ全体を数える。多めに見積もるためで、実際の請求はこれより少なくなる。
// - 上限は既定で月 9 時間（クーポンの 10 時間から 1 時間の余裕を引いた値）。環境変数 AMIVOICE_BUDGET_HOURS で変えられる。
// - 感情分析は音声認識とは別に課金され、クーポンの対象かどうかがはっきりしないので、無料枠（月 60 分）から余裕を引いた月 55 分を上限にする。
// - 記録は eval/usage.jsonl（リポジトリに入れて、記事の「実験にかかった時間」の根拠にする）。月はクーポンの区切りに合わせて日本時間で数える。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LEDGER = join(dirname(fileURLToPath(import.meta.url)), "usage.jsonl");
const LIMIT_SECONDS = Number(process.env.AMIVOICE_BUDGET_HOURS ?? 9) * 3600;
const SENTIMENT_LIMIT_SECONDS = 55 * 60;

export interface UsageEntry {
  at: string;
  /** 日本時間の年月（例: 2026-11） */
  month: string;
  api: "websocket" | "async";
  engine: string;
  seconds: number;
  sentiment?: boolean;
  /** 何の実行か（スクリプト名と条件） */
  label: string;
}

export function monthJst(date = new Date()): string {
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 7);
}

export function readLedger(): UsageEntry[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as UsageEntry);
}

export function monthlyUsage(month = monthJst()): { seconds: number; sentimentSeconds: number; byEngine: Map<string, number> } {
  const byEngine = new Map<string, number>();
  let seconds = 0;
  let sentimentSeconds = 0;
  for (const e of readLedger()) {
    if (e.month !== month) continue;
    seconds += e.seconds;
    if (e.sentiment) sentimentSeconds += e.seconds;
    byEngine.set(`${e.engine}（${e.api === "async" ? "非同期" : "WebSocket"}）`, (byEngine.get(`${e.engine}（${e.api === "async" ? "非同期" : "WebSocket"}）`) ?? 0) + e.seconds);
  }
  return { seconds, sentimentSeconds, byEngine };
}

/** モック（localhost）に送るときは数えない。 */
export function isMockUrl(url: string | undefined): boolean {
  return !!url && /^(wss?|https?):\/\/(localhost|127\.0\.0\.1)/.test(url);
}

/**
 * これから送る音声を台帳に記録する。上限を超えるなら記録せずに例外を投げる。
 * 失敗した実行でも送った分は課金されうるので、送る前に記録する。
 */
export function reserve(entry: Omit<UsageEntry, "at" | "month">): void {
  const month = monthJst();
  const used = monthlyUsage(month);
  if (used.seconds + entry.seconds > LIMIT_SECONDS) {
    throw new Error(
      `クーポンの範囲を超えるので実行しません（${month} の使用 ${fmt(used.seconds)} + 今回 ${fmt(entry.seconds)} > 上限 ${fmt(LIMIT_SECONDS)}）`,
    );
  }
  if (entry.sentiment && used.sentimentSeconds + entry.seconds > SENTIMENT_LIMIT_SECONDS) {
    throw new Error(`感情分析の無料枠を超えるので実行しません（${month} の使用 ${fmt(used.sentimentSeconds)} + 今回 ${fmt(entry.seconds)}）`);
  }
  appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), month, ...entry, seconds: Math.round(entry.seconds * 10) / 10 }) + "\n");
}

export function fmt(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 時間 ${m % 60} 分` : `${m} 分`;
}

function main(): void {
  const months = [...new Set(readLedger().map((e) => e.month))].sort();
  if (months.length === 0) {
    console.log("まだ記録がありません");
    return;
  }
  for (const month of months) {
    const u = monthlyUsage(month);
    console.log(`## ${month}: ${fmt(u.seconds)} / 上限 ${fmt(LIMIT_SECONDS)}（残り ${fmt(LIMIT_SECONDS - u.seconds)}）、うち感情分析 ${fmt(u.sentimentSeconds)}`);
    for (const [engine, s] of [...u.byEngine].sort((a, b) => b[1] - a[1])) console.log(`- ${engine}: ${fmt(s)}`);
  }
}

if (import.meta.main) main();
