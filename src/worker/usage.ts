// AmiVoice API の月ごとの使用量を、全部の勉強会をまたいで数える Durable Object（"global" の 1 つだけ）。
// 無料枠やクーポン（例: 月 10 時間）の範囲で運用するため、上限に達したら配信を始めさせず、終了後のジョブも出さない。
//
// - 実際の課金は発話区間だけだが、ここでは送った音声の長さ全体を数える（多めに見積もる）。
// - 月は日本時間で区切る（クーポンや無料枠の区切りに合わせる）。
// - 上限は AMIVOICE_MONTHLY_LIMIT_HOURS（空なら上限なし）。感情分析は別に課金されるので AMIVOICE_SENTIMENT_LIMIT_MINUTES で別に抑える。

import { DurableObject } from "cloudflare:workers";
import type { UsageStatus } from "../shared/protocol.ts";

export type UsageApi = "websocket" | "async";

export function monthJst(now = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 7);
}

function limitSeconds(value: string | undefined, unit: number): number | null {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n * unit : null;
}

export class UsageMeter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS usage (
        month TEXT NOT NULL,
        api TEXT NOT NULL,
        engine TEXT NOT NULL,
        sentiment INTEGER NOT NULL DEFAULT 0,
        seconds REAL NOT NULL,
        at INTEGER NOT NULL
      )`);
    });
  }

  status(): UsageStatus {
    const month = monthJst();
    const row = this.ctx.storage.sql
      .exec<{ seconds: number | null; sentiment: number | null }>(
        "SELECT SUM(seconds) AS seconds, SUM(CASE WHEN sentiment = 1 THEN seconds ELSE 0 END) AS sentiment FROM usage WHERE month = ?",
        month,
      )
      .one();
    const limit = limitSeconds(this.env.AMIVOICE_MONTHLY_LIMIT_HOURS, 3600);
    const sentimentLimit = limitSeconds(this.env.AMIVOICE_SENTIMENT_LIMIT_MINUTES, 60);
    const seconds = row.seconds ?? 0;
    const sentimentSeconds = row.sentiment ?? 0;
    return {
      month,
      seconds,
      limitSeconds: limit,
      remainingSeconds: limit === null ? null : limit - seconds,
      sentimentSeconds,
      sentimentLimitSeconds: sentimentLimit,
    };
  }

  /** 送り終えた音声を数える（配信中の音声は送ったあとに数える）。 */
  add(api: UsageApi, engine: string, seconds: number, sentiment = false): UsageStatus {
    if (seconds > 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO usage (month, api, engine, sentiment, seconds, at) VALUES (?, ?, ?, ?, ?, ?)",
        monthJst(),
        api,
        engine,
        sentiment ? 1 : 0,
        seconds,
        Date.now(),
      );
    }
    return this.status();
  }

  /** これから送る音声を、上限に収まるなら数えて ok を返す。収まらなければ数えずに理由を返す。 */
  reserve(api: UsageApi, engine: string, seconds: number, sentiment = false): { ok: true; status: UsageStatus } | { ok: false; reason: "total" | "sentiment"; status: UsageStatus } {
    const s = this.status();
    if (s.limitSeconds !== null && s.seconds + seconds > s.limitSeconds) return { ok: false, reason: "total", status: s };
    if (sentiment && s.sentimentLimitSeconds !== null && s.sentimentSeconds + seconds > s.sentimentLimitSeconds) {
      return { ok: false, reason: "sentiment", status: s };
    }
    return { ok: true, status: this.add(api, engine, seconds, sentiment) };
  }
}
