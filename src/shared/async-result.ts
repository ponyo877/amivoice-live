// 非同期 HTTP API（v2）の結果の解釈と、登壇の振り返りレポートの組み立て。
// https://docs.amivoice.com/amivoice-api/manual/async-http-interface
// https://docs.amivoice.com/amivoice-api/manual/sentiment-analysis

import { isFillerToken, majorityLabel, stripFillers, type RecognitionResult, type Token } from "./amivoice.ts";
import { cer } from "./metrics.ts";

export type AsyncStatus = "queued" | "started" | "processing" | "completed" | "error";

export interface AsyncSegment {
  results?: RecognitionResult["results"];
  text?: string;
}

export interface SentimentSegment {
  starttime: number;
  endtime: number;
  [param: string]: number;
}

export interface AsyncJobResult {
  session_id?: string;
  status?: AsyncStatus;
  error_message?: string;
  text?: string;
  segments?: AsyncSegment[];
  /** ドキュメントの例によっては results の中に segments が入っている */
  results?: { segments?: AsyncSegment[] } | RecognitionResult["results"];
  sentiment_analysis?: {
    segments?: SentimentSegment[];
    code?: number | string;
    error_code?: string;
    error_message?: string;
  };
}

/** 信頼度がこれより低いトークンを「自信のない語」とみなす。 */
export const LOW_CONFIDENCE = 0.5;

export interface Utterance {
  text: string;
  startMs: number;
  endMs: number;
  label?: string;
  tokens: Token[];
}

function jobSegments(job: AsyncJobResult): AsyncSegment[] {
  if (Array.isArray(job.segments)) return job.segments;
  const nested = job.results;
  if (nested && !Array.isArray(nested) && Array.isArray(nested.segments)) return nested.segments;
  // compatibleWithSync=True のときはトップレベルに results がある
  if (Array.isArray(nested)) return [{ results: nested }];
  return [];
}

/** 非同期の結果を発話の列にする。 */
export function asyncUtterances(job: AsyncJobResult): Utterance[] {
  const out: Utterance[] = [];
  for (const seg of jobSegments(job)) {
    for (const r of seg.results ?? []) {
      const tokens = r.tokens ?? [];
      const text = (r.text ?? tokens.map((t) => t.written).join("")).trim();
      if (!text) continue;
      const startMs = r.starttime ?? tokens.find((t) => t.starttime !== undefined)?.starttime ?? 0;
      const endMs = r.endtime ?? [...tokens].reverse().find((t) => t.endtime !== undefined)?.endtime ?? startMs;
      out.push({ text, startMs, endMs, label: majorityLabel(tokens), tokens });
    }
  }
  return out;
}

/**
 * 話者ラベルを表示用の番号にする。いちばん長く話した人を 0（登壇者）とし、ほかは初めて話した順に 1, 2, ...。
 * ラベルは speaker0, speaker1, speaker3 のように欠番がありうるので、番号をそのまま使わない。
 */
export function speakerIndexes(utterances: Utterance[]): Map<string, number> {
  const time = new Map<string, number>();
  const order: string[] = [];
  for (const u of utterances) {
    if (!u.label) continue;
    if (!time.has(u.label)) order.push(u.label);
    time.set(u.label, (time.get(u.label) ?? 0) + (u.endMs - u.startMs));
  }
  const main = [...time.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const map = new Map<string, number>();
  if (main) map.set(main, 0);
  for (const label of order) if (!map.has(label)) map.set(label, map.size);
  return map;
}

export interface TalkReport {
  durationMs: number;
  speechMs: number;
  /** 1 分あたりの文字数（フィラー・句読点・空白を除く） */
  charsPerMinute: number | null;
  rateSeries: { t: number; cpm: number }[];
  fillers: { total: number; perMinute: number | null; top: { word: string; count: number }[]; times: number[] };
  sentiment: { keys: string[]; segments: { s: number; e: number; v: number[] }[] } | null;
  sentimentError: string | null;
  speakers: { index: number; ms: number }[];
  lowConfidence: { written: string; spoken?: string; confidence: number; t: number; context: string }[];
  /** ライブ字幕とアーカイブ字幕の食い違い（アーカイブを正解とみなした CER） */
  liveVsArchive: { cer: number; archiveChars: number } | null;
}

const RATE_WINDOW_MS = 30_000;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/gu;

function countChars(text: string): number {
  return [...stripFillers(text).replace(PUNCT_OR_SPACE, "")].length;
}

/**
 * 振り返りレポートを組み立てる。
 * - reportJob: ハイブリッドエンジン（フィラーを残す設定・感情分析あり）の結果
 * - archiveJob: アーカイブ用（バッチエンジン・話者ダイアライゼーションあり）の結果。話者ごとの時間とライブとの比較に使う
 * - liveText: その登壇のライブ字幕をつなげたもの
 */
export function buildReport(reportJob: AsyncJobResult, archiveJob: AsyncJobResult | null, liveText: string): TalkReport {
  const utts = asyncUtterances(reportJob);
  const tokens = utts.flatMap((u) => u.tokens);
  const durationMs = Math.max(0, ...utts.map((u) => u.endMs), ...(reportJob.sentiment_analysis?.segments ?? []).map((s) => s.endtime));
  const speechMs = utts.reduce((sum, u) => sum + Math.max(0, u.endMs - u.startMs), 0);

  // 話す速さ（話している時間あたり）
  const totalChars = utts.reduce((sum, u) => sum + countChars(u.text), 0);
  const charsPerMinute = speechMs > 0 ? Math.round((totalChars / speechMs) * 60_000) : null;
  const windows = new Map<number, { chars: number; ms: number }>();
  for (const u of utts) {
    const w = Math.floor(u.startMs / RATE_WINDOW_MS);
    const cur = windows.get(w) ?? { chars: 0, ms: 0 };
    cur.chars += countChars(u.text);
    cur.ms += Math.max(0, u.endMs - u.startMs);
    windows.set(w, cur);
  }
  const rateSeries = [...windows.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.ms >= 3000)
    .map(([w, v]) => ({ t: w * RATE_WINDOW_MS, cpm: Math.round((v.chars / v.ms) * 60_000) }));

  // フィラー
  const fillerTokens = tokens.filter((t) => isFillerToken(t.written));
  const counts = new Map<string, number>();
  for (const t of fillerTokens) {
    const word = t.written.slice(1, -1);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const fillers = {
    total: fillerTokens.length,
    perMinute: durationMs > 0 ? Math.round((fillerTokens.length / durationMs) * 60_000 * 10) / 10 : null,
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word, count]) => ({ word, count })),
    times: fillerTokens.map((t) => t.starttime ?? 0),
  };

  // 感情分析（キー名はドキュメントに無いので、結果に出てきた数値のキーをそのまま使う）
  const sa = reportJob.sentiment_analysis;
  let sentiment: TalkReport["sentiment"] = null;
  if (sa?.segments && sa.segments.length > 0) {
    const keys = Object.keys(sa.segments[0]!).filter((k) => k !== "starttime" && k !== "endtime" && typeof sa.segments![0]![k] === "number");
    sentiment = {
      keys,
      segments: sa.segments.map((s) => ({ s: s.starttime, e: s.endtime, v: keys.map((k) => s[k] ?? 0) })),
    };
  }
  const sentimentError = sa?.error_message ?? (sa?.error_code ? String(sa.error_code) : null);

  // 話者ごとの時間（アーカイブの話者ダイアライゼーションから）
  const archiveUtts = archiveJob ? asyncUtterances(archiveJob) : [];
  const indexes = speakerIndexes(archiveUtts);
  const speakerMs = new Map<number, number>();
  for (const u of archiveUtts) {
    if (!u.label) continue;
    const i = indexes.get(u.label)!;
    speakerMs.set(i, (speakerMs.get(i) ?? 0) + (u.endMs - u.startMs));
  }
  const speakers = [...speakerMs.entries()].sort((a, b) => a[0] - b[0]).map(([index, ms]) => ({ index, ms }));

  // 自信のない語（句読点・フィラーは除く）
  const lowConfidence: TalkReport["lowConfidence"] = [];
  for (const u of utts) {
    for (const t of u.tokens) {
      if (t.confidence === undefined || t.confidence >= LOW_CONFIDENCE) continue;
      if (isFillerToken(t.written) || !t.written.replace(PUNCT_OR_SPACE, "")) continue;
      lowConfidence.push({ written: t.written, spoken: t.spoken, confidence: t.confidence, t: t.starttime ?? u.startMs, context: stripFillers(u.text) });
    }
  }

  // ライブ字幕とアーカイブの食い違い
  const archiveText = archiveUtts.map((u) => u.text).join("");
  const liveVsArchive = archiveText && liveText ? { cer: cer(archiveText, liveText).cer, archiveChars: countChars(archiveText) } : null;

  return {
    durationMs,
    speechMs,
    charsPerMinute,
    rateSeries,
    fillers,
    sentiment,
    sentimentError,
    speakers,
    lowConfidence: lowConfidence.slice(0, 300),
    liveVsArchive,
  };
}
