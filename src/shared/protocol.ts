// ブラウザ ⇔ Durable Object 間のメッセージ定義。

import type { DictionaryTerm } from "./amivoice.ts";
import type { TalkReport } from "./async-result.ts";

/** 確定した字幕 1 行。 */
export interface CaptionLine {
  id: number;
  talkId: number;
  text: string;
  /** 登壇の開始からの音声上の時刻（ミリ秒）。字幕ファイル（VTT）の出力に使う */
  startMs: number;
  endMs: number;
  /** 確定結果がサーバに届いた時刻（UNIX ミリ秒） */
  receivedAt: number;
  /** 話者の番号。0 が登壇者、1 以降が質問者など。話者ダイアライゼーションを使っていなければ無い */
  speaker?: number;
  /** トークンごとの [表記, 信頼度]。信頼度の低い語を字幕上で区別するのに使う */
  tokens?: [string, number][];
}

export interface RoomInfo {
  roomId: string;
  title: string;
  live: boolean;
  engine: string;
  useDictionary: boolean;
  /** ルームの辞書に Zenn の技術用語の辞書を重ねる（ハイブリッドエンジンだけ） */
  useTech: boolean;
  diarization: boolean;
  /** 配信中に、それまでの内容のまとめと図解を Claude に作らせる */
  summary: boolean;
  /** 配信中で、音声を録音している（アーカイブを作る）。参加者の画面に録音中であることを示す */
  recording: boolean;
}

/** 図の節の種類。画面では種類ごとに色と小さな見出しを付ける */
export const DIAGRAM_KINDS = ["concept", "tool", "problem", "cause", "solution", "point"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/** まとめの各項目の文字数・個数の目安（Claude への指示と、画面のレイアウトの両方で使う） */
export const SUMMARY_LIMITS = {
  topic: 30,
  now: 50,
  sections: 8,
  sectionTitle: 20,
  points: 3,
  point: 40,
  diagramTitle: 24,
  nodes: 10,
  nodeLabel: 16,
  edges: 11,
  edgeLabel: 10,
  terms: 6,
  termNote: 60,
  qas: 4,
  qa: 60,
} as const;

/** 配信中に Claude が作る「ここまでのまとめ」。字幕が少したまるたびに作り直す */
export interface LiveSummary {
  talkId: number;
  /** どの字幕（CaptionLine.id）までを読んで作ったか */
  upToLineId: number;
  /** 読んだ字幕の最後の時刻（登壇の開始からのミリ秒） */
  upToMs: number;
  updatedAt: number;
  topic: string;
  /** いま話していること */
  now: string;
  sections: { title: string; startMs: number; points: string[] }[];
  diagram: {
    title: string;
    nodes: { id: string; label: string; kind: DiagramKind }[];
    edges: { from: string; to: string; label: string }[];
    /** いま話している内容にあたる節の id（無ければ空文字） */
    focus: string;
  };
  terms: { term: string; note: string }[];
  qa: { question: string; answer: string }[];
}

/** 登壇者の画面に出す計測値。 */
export interface LiveStats {
  utterances: number;
  /** 発話終了（E）から確定結果（A）までの遅延の中央値（ミリ秒） */
  finalizeMedianMs: number | null;
  /** 確定結果が届いた時点での、送信済み音声の位置と発話終了位置の差の中央値（ミリ秒） */
  lagMedianMs: number | null;
  audioSentMs: number;
}

/**
 * 登壇（「配信を始める」から「止める」まで）の状態。
 * live → recorded → archiving → done の順に進む。アーカイブを作らない設定なら live → done。
 */
export type TalkStatus = "live" | "interrupted" | "recorded" | "archiving" | "done" | "error" | "no-audio";

export interface TalkSummary {
  id: number;
  startedAt: number;
  endedAt: number | null;
  status: TalkStatus;
  audioMs: number;
  archive: boolean;
  archiveReady: boolean;
  reportReady: boolean;
  error: string | null;
}

export interface TalkDetail {
  talk: TalkSummary;
  live: CaptionLine[];
  archive: CaptionLine[];
  report: TalkReport | null;
  /** 配信中に作った「ここまでのまとめ」の最後の版 */
  summary: LiveSummary | null;
  /** 感情分析パラメータの名前一覧（AmiVoice の result-parameters.json をそのまま） */
  sentimentParameters: unknown;
}

/** DO → クライアント */
export type ServerMessage =
  | {
      type: "snapshot";
      room: RoomInfo;
      lines: CaptionLine[];
      partial: string;
      terms: string[];
      viewers: number;
      /** いちばん新しい登壇のまとめ（まだ無ければ null） */
      summary: LiveSummary | null;
      summaryState: SummaryState;
    }
  | { type: "partial"; text: string }
  | { type: "final"; line: CaptionLine }
  | { type: "room"; room: RoomInfo }
  | { type: "terms"; terms: string[] }
  | { type: "viewers"; count: number }
  /** まとめが新しくなった。新しい登壇が始まったときは null で消す */
  | { type: "summary"; summary: LiveSummary | null }
  | { type: "summary-state"; state: SummaryState; message?: string }
  | { type: "stats"; stats: LiveStats }
  | { type: "talks"; talks: TalkSummary[] }
  | { type: "usage"; usage: UsageStatus }
  | { type: "upstream"; state: "connecting" | "open" | "closed" | "error"; message?: string };

/** まとめを作っている最中か。error は登壇者の画面にだけ送る */
export type SummaryState = "idle" | "working" | "error";

/** AmiVoice API の今月の使用量（全部の勉強会の合計）。秒。上限なしなら limitSeconds は null */
export interface UsageStatus {
  month: string;
  seconds: number;
  limitSeconds: number | null;
  remainingSeconds: number | null;
  sentimentSeconds: number;
  sentimentLimitSeconds: number | null;
}

/** 登壇者クライアント → DO（音声はバイナリフレームで別送） */
export type SpeakerMessage =
  | { type: "start"; engine: string; useDictionary: boolean; useTech?: boolean; diarization: boolean; archive: boolean; summary?: boolean }
  | { type: "stop" };

export interface DictionaryPayload {
  terms: DictionaryTerm[];
}
