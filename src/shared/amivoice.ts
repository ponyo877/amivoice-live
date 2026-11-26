// AmiVoice API WebSocket プロトコルの共通処理。
// Worker（Durable Object）、ブラウザ、評価スクリプト（Node）のどこからでも使えるよう、
// 実行環境に依存する API は使わない。
// 仕様: https://docs.amivoice.com/amivoice-api/manual/websocket-interface

/** 辞書の 1 語。ハイブリッドエンジンは読み（ひらがな）を、E2E エンジンは表記だけを使う。 */
export interface DictionaryTerm {
  /** 字幕に表示したい表記（例: "Durable Objects"） */
  written: string;
  /** ひらがなの読み。1 つの表記に複数の読みを登録できる（例: ["でゅらぶるおぶじぇくつ"]） */
  readings: string[];
  /** 抽出元（スライドのページ番号など）。辞書の説明表示用 */
  source?: string;
}

export type EngineKind = "hybrid" | "e2e";

export interface EngineInfo {
  id: string;
  label: string;
  kind: EngineKind;
}

/** UI と評価で扱うエンジン。https://docs.amivoice.com/amivoice-api/manual/engines */
export const ENGINES: EngineInfo[] = [
  { id: "-a-general", label: "会話_汎用（ハイブリッド）", kind: "hybrid" },
  { id: "-a-general-input", label: "音声入力_汎用（ハイブリッド）", kind: "hybrid" },
  { id: "-a2-ja-general", label: "日本語E2E_汎用", kind: "e2e" },
  { id: "-a2-multi-general", label: "多言語E2E_汎用（日英中）", kind: "e2e" },
];

export function engineKind(engineId: string): EngineKind {
  return engineId.startsWith("-a2") ? "e2e" : "hybrid";
}

/**
 * profileWords の表記には半角スペースを入れられない（スペースが区切り文字のため）。
 * 表記の "_" は認識結果で半角スペースとして出力される仕様なので、スペースは "_" に置き換えて登録する。
 * https://docs.amivoice.com/amivoice-api/manual/user-dictionary-basics
 */
const SPACE_PLACEHOLDER = "_";

export function encodeWritten(written: string): string {
  return written.trim().replace(/\s+/g, SPACE_PLACEHOLDER);
}

/** 認識結果に "_" が残っていた場合の保険として、登録時に置き換えたスペースを戻す。 */
export function decodeWritten(text: string, terms: DictionaryTerm[]): string {
  let out = text;
  for (const t of terms) {
    if (!/\s/.test(t.written)) continue;
    const encoded = encodeWritten(t.written);
    if (out.includes(encoded)) out = out.split(encoded).join(t.written.trim());
  }
  return out;
}

const HIRAGANA_READING = /^[ぁ-ゖー]+$/u;

/** ハイブリッドエンジンの読みとして使える文字列か（ひらがなと長音記号のみ）。 */
export function isValidReading(reading: string): boolean {
  return HIRAGANA_READING.test(reading);
}

/**
 * 人が入れた読みを、登録できる形にそろえる。
 * 半角カナ・カタカナはひらがなに直す（「ラングラー」→「らんぐらー」）。それ以外の文字はそのまま残し、isValidReading で弾く。
 */
export function normalizeReading(reading: string): string {
  return reading
    .normalize("NFKC")
    .trim()
    .replace(/[ァ-ヶ]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・]/gu, "");
}

/**
 * 読みが同じで表記の違う語の組。ハイブリッドエンジンは読みで音を照合するので、同じ読みの語が 2 つあると、
 * どちらの表記が字幕に出るかはエンジン次第になる（例: 記事のコードから拾った McpServer と、本文の MCP サーバー）。
 * 大文字と小文字、空白だけが違う表記は同じ語とみなす。
 */
export function sharedReadings(terms: DictionaryTerm[]): { reading: string; indices: number[] }[] {
  const sameWord = (w: string) => w.normalize("NFKC").toLowerCase().replace(/[\s_]/g, "");
  const byReading = new Map<string, number[]>();
  terms.forEach((t, i) => {
    for (const r of new Set(t.readings.map(normalizeReading).filter(Boolean))) {
      const list = byReading.get(r) ?? [];
      // 同じ語の重複は数えない
      if (!list.some((j) => sameWord(terms[j]!.written) === sameWord(t.written))) list.push(i);
      byReading.set(r, list);
    }
  });
  return [...byReading].filter(([, indices]) => indices.length > 1).map(([reading, indices]) => ({ reading, indices }));
}

/** 表記に使えない文字（| とスペースは区切り、: は予約、" は s コマンドの引用符）。 */
export function isRegistrableWritten(written: string): boolean {
  return written.trim().length > 0 && !/[|:"]/.test(written);
}

/**
 * profileWords の値を組み立てる。
 * - ハイブリッド: `表記 読み|表記 読み|...`（1 表記に複数の読みがあれば複数エントリ）
 * - E2E（単語強調）: `表記|表記|...`。強調度（0〜1、既定 0.5）を指定するときは代替表記を省いて `表記  0.8`
 * https://docs.amivoice.com/amivoice-api/manual/user-dictionary-basics
 * https://docs.amivoice.com/amivoice-api/manual/user-dictionary-basics-e2e
 */
export function buildProfileWords(terms: DictionaryTerm[], kind: EngineKind, opts: { emphasis?: number } = {}): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    if (!isRegistrableWritten(t.written)) continue;
    const written = encodeWritten(t.written);
    if (kind === "e2e") {
      if (seen.has(written)) continue;
      seen.add(written);
      entries.push(opts.emphasis === undefined ? written : `${written}  ${opts.emphasis}`);
      continue;
    }
    for (const r of t.readings) {
      const reading = normalizeReading(r);
      if (!isValidReading(reading)) continue;
      const key = `${written} ${reading}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(key);
    }
  }
  return entries.join("|");
}

export interface StartOptions {
  engine: string;
  /** "LSB16K"（ヘッダなし 16kHz 16bit リトルエンディアン PCM）が既定 */
  audioFormat?: string;
  authorization?: string;
  profileWords?: string;
  /** 途中結果（U イベント）の間隔。ミリ秒、100 の倍数 */
  resultUpdatedInterval?: number;
  keepFillerToken?: boolean;
  /** segmenterProperties にそのまま入れる追加設定（例: { postTime: 400 }） */
  segmenter?: Record<string, string | number>;
}

/** s コマンドの値。空白や " を含む値は "..." で囲み、内部の " は "" にする。 */
function quoteValue(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** s コマンド文字列を組み立てる。 */
export function buildStartCommand(opts: StartOptions): string {
  const parts = ["s", opts.audioFormat ?? "LSB16K", opts.engine];
  const params: [string, string][] = [];
  if (opts.authorization) params.push(["authorization", opts.authorization]);
  if (opts.profileWords) params.push(["profileWords", opts.profileWords]);
  if (opts.resultUpdatedInterval !== undefined)
    params.push(["resultUpdatedInterval", String(opts.resultUpdatedInterval)]);
  if (opts.keepFillerToken) params.push(["keepFillerToken", "1"]);
  if (opts.segmenter && Object.keys(opts.segmenter).length > 0) {
    const seg = Object.entries(opts.segmenter)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    params.push(["segmenterProperties", seg]);
  }
  for (const [k, v] of params) parts.push(`${k}=${quoteValue(v)}`);
  return parts.join(" ");
}

/** s コマンドから key=value を取り出す（"..." で囲まれた値と "" のエスケープに対応）。モックサーバとテストで使う。 */
export function parseStartParam(command: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${key}=("(?:[^"]|"")*"|\\S+)`);
  const m = command.match(re);
  if (!m) return undefined;
  const raw = m[1]!;
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
}

/** 音声データの p パケット（先頭 1 バイト 'p' + 音声）を作る。 */
export function buildAudioPacket(audio: Uint8Array): Uint8Array {
  const packet = new Uint8Array(audio.byteLength + 1);
  packet[0] = 0x70; // 'p'
  packet.set(audio, 1);
  return packet;
}

export interface Token {
  written: string;
  spoken?: string;
  starttime?: number;
  endtime?: number;
  confidence?: number;
  /** 話者ダイアライゼーション有効時の話者ラベル（speaker0 など。欠番がありうる） */
  label?: string;
  /** 多言語エンジンの言語ラベル（ja / en / zh） */
  language?: string;
}

export interface RecognitionResult {
  results?: {
    tokens?: Token[];
    confidence?: number;
    starttime?: number;
    endtime?: number;
    text?: string;
  }[];
  utteranceid?: string;
  text?: string;
  code?: string;
  message?: string;
}

/** サーバから届くイベント。 */
export type ServerEvent =
  | { kind: "s"; error?: string } // s コマンドの応答。error なしなら成功
  | { kind: "p"; error: string } // p コマンドのエラー
  | { kind: "e"; error?: string } // 終了応答
  | { kind: "S"; time: number } // 発話開始（音声先頭からのミリ秒）
  | { kind: "E"; time: number } // 発話終了
  | { kind: "C" } // 認識開始
  | { kind: "U"; result: RecognitionResult } // 途中結果
  | { kind: "A"; result: RecognitionResult } // 確定結果
  | { kind: "G"; raw: string } // サーバ内部情報（無視してよい）
  | { kind: "unknown"; raw: string };

export function parseServerEvent(raw: string): ServerEvent {
  const head = raw.charAt(0);
  const rest = raw.length > 2 ? raw.slice(2) : "";
  switch (head) {
    case "s":
      return rest ? { kind: "s", error: rest } : { kind: "s" };
    case "p":
      return { kind: "p", error: rest };
    case "e":
      return rest ? { kind: "e", error: rest } : { kind: "e" };
    case "S":
      return { kind: "S", time: Number.parseInt(rest, 10) };
    case "E":
      return { kind: "E", time: Number.parseInt(rest, 10) };
    case "C":
      return { kind: "C" };
    case "U":
    case "A":
    case "R": {
      // R はサンプルコードで A と同じに扱われている
      let result: RecognitionResult;
      try {
        result = JSON.parse(rest) as RecognitionResult;
      } catch {
        return { kind: "unknown", raw };
      }
      return head === "U" ? { kind: "U", result } : { kind: "A", result };
    }
    case "G":
      return { kind: "G", raw };
    default:
      return { kind: "unknown", raw };
  }
}

/** 結果の全トークンの終了時刻の最大値（ミリ秒）。時刻が無ければ undefined。 */
export function resultEndTime(result: RecognitionResult): number | undefined {
  let end: number | undefined;
  for (const r of result.results ?? []) {
    if (typeof r.endtime === "number") end = Math.max(end ?? 0, r.endtime);
    for (const t of r.tokens ?? []) {
      if (typeof t.endtime === "number") end = Math.max(end ?? 0, t.endtime);
    }
  }
  return end;
}

/** 16kHz 16bit モノラル PCM のバイト数を再生時間（ミリ秒）に換算する。 */
export function pcmBytesToMs(bytes: number, sampleRate = 16000): number {
  return (bytes / 2 / sampleRate) * 1000;
}

/** keepFillerToken=1 のとき、フィラーは written が %えー% のように % で囲まれて返る（ハイブリッドエンジンのみ）。 */
export function isFillerToken(written: string): boolean {
  return /^%[^%]+%$/.test(written);
}

/** テキスト中の %えー% 形式のフィラーを取り除く。 */
export function stripFillers(text: string): string {
  return text.replace(/%[^%\s]+%/g, "");
}

/** 発話の話者ラベルを、トークンの多数決で決める（ラベルの付かないトークンは数えない）。 */
export function majorityLabel(tokens: Token[]): string | undefined {
  const counts = new Map<string, number>();
  for (const t of tokens) if (t.label) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

/** 結果に含まれる全トークン。 */
export function resultTokens(result: RecognitionResult): Token[] {
  return (result.results ?? []).flatMap((r) => r.tokens ?? []);
}
