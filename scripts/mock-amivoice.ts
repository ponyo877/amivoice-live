// AmiVoice API を真似るモックサーバ。API キーなしで画面や中継、終了後の処理の動きを確かめるために使う。
//
//   npm run mock            # http://localhost:9900/ で待ち受け
//   .dev.vars に次を書いて npm run dev
//     AMIVOICE_WS_URL=http://localhost:9900/
//     AMIVOICE_ASYNC_URL=http://localhost:9900/v2/recognitions
//     AMIVOICE_SENTIMENT_PARAMS_URL=http://localhost:9900/v2/sentiment-analysis/ja/result-parameters.json
//
// WebSocket API: 音量で発話区間を判定し、S → U（途中結果）→ E → A（確定結果）を返す。
// 非同期 HTTP API: 送られた WAV を同じ方法で区切り、数秒後に completed の結果を返す。
//
// 文面は決まった例文を順に返す。辞書（profileWords）に登録された語は正しい表記に、
// 登録されていない語はカタカナの誤認識（信頼度を低く）にして、辞書と信頼度の表示を画面で確かめられるようにしている。
// 話者ダイアライゼーション・フィラー・感情分析は、それらしい値を作って返すだけで、音声の中身は見ていない。
// 感情分析の結果のキー名と、パラメータ一覧の JSON の形は公開マニュアルに無いため、仮のもの。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { parseStartParam } from "../src/shared/amivoice.ts";

const PORT = Number(process.env.PORT ?? 9900);
const SAMPLE_RATE = 16000;
const SPEECH_RMS = 0.015; // これより大きい音量を発話とみなす
const POST_TIME_MS = 550; // 無音がこれだけ続いたら発話終了
const PARTIAL_EVERY_MS = 400;
const FINALIZE_DELAY_MS = 350;
const ASYNC_PROCESSING_MS = 4000;

/** [表記, 辞書に無いときの誤認識] */
const TERMS: [string, string][] = [
  ["Durable Objects", "デュラブルオブジェクト"],
  ["WebSocket", "ウェブソケット"],
  ["Hibernation", "ハイバネーション"],
  ["AmiVoice", "アミボイス"],
  ["profileWords", "プロファイルワーズ"],
  ["Workers", "ワーカーズ"],
];

const SENTENCES = [
  "今日は {0} を使ってリアルタイム字幕を作った話をします",
  "部屋ごとに {0} を一つ用意して {1} をつないでいます",
  "参加者の接続は {2} できるので待機中のコストがほとんどかかりません",
  "質問です {3} の料金はどれくらいかかりますか",
  "音声認識には {3} を使っていて {4} で専門用語を登録しています",
  "{5} からは外向きの {1} で認識サーバにつないでいます",
];

/** 質問役の話者が話す例文（話者ダイアライゼーションの確認用）。ラベルは欠番を含めて speaker2 にする */
const QUESTION_SENTENCE = 3;

interface MockToken {
  written: string;
  spoken?: string;
  confidence: number;
  starttime?: number;
  endtime?: number;
  label?: string;
}

/** 例文をトークンに分ける。辞書の語は 1 トークン、それ以外は 2〜3 文字ずつ。 */
function renderTokens(index: number, profileWords: string, opts: { fillers: boolean; live: boolean }): MockToken[] {
  const template = SENTENCES[index % SENTENCES.length]!;
  const registered = new Set(profileWords.split("|").map((e) => e.trim().split(/\s+/)[0]));
  const tokens: MockToken[] = [];
  if (opts.fillers && index % 3 === 0) tokens.push({ written: "%えー%", spoken: "えー", confidence: 0.8 });
  const parts = template.split(/(\{\d\})/);
  for (const part of parts) {
    const m = part.match(/^\{(\d)\}$/);
    if (m) {
      const [written, wrong] = TERMS[Number(m[1])]!;
      const encoded = written.replace(/\s+/g, "_");
      // 本物の API は表記の "_" を半角スペースにして返す
      tokens.push(registered.has(encoded) ? { written, confidence: 0.93 } : { written: wrong, confidence: 0.31 });
      continue;
    }
    // ライブでは 1 箇所だけ誤認識させ、アーカイブとの食い違いが出るようにする
    const text = (opts.live ? part.replace("待機中", "大気中") : part).trim();
    for (let i = 0; i < text.length; i += 3) {
      const written = text.slice(i, i + 3);
      tokens.push({ written, confidence: written === "大気中" ? 0.42 : 0.88 + ((i * 7) % 10) / 100 });
    }
    if (opts.fillers && index % 5 === 1 && part.includes("を")) tokens.push({ written: "%あのー%", spoken: "あのー", confidence: 0.7 });
  }
  tokens.push({ written: "。", confidence: 0.99 });
  return tokens;
}

function joinTokens(tokens: MockToken[]): string {
  return tokens.map((t) => t.written).join("");
}

/** トークンに発話区間の時刻を割り振る（文字数で按分）。 */
function spreadTimes(tokens: MockToken[], startMs: number, endMs: number): void {
  const total = tokens.reduce((s, t) => s + t.written.length, 0) || 1;
  let cursor = startMs;
  for (const t of tokens) {
    const len = ((endMs - startMs) * t.written.length) / total;
    t.starttime = Math.round(cursor);
    t.endtime = Math.round(cursor + len);
    cursor += len;
  }
}

function speakerLabel(index: number): string {
  return index % SENTENCES.length === QUESTION_SENTENCE ? "speaker2" : "speaker0";
}

// ---------------------------------------------------------------------------
// WebSocket API
// ---------------------------------------------------------------------------

interface Session {
  started: boolean;
  engine: string;
  profileWords: string;
  diarization: boolean;
  fillers: boolean;
  /** segmenterProperties の postTime（無音がこれだけ続いたら発話終了） */
  postTimeMs: number;
  audioMs: number;
  inSpeech: boolean;
  speechStartMs: number;
  silenceMs: number;
  lastPartialMs: number;
  utterance: number;
}

function onConnection(ws: WebSocket): void {
  const s: Session = {
    started: false,
    engine: "",
    profileWords: "",
    diarization: false,
    fillers: false,
    postTimeMs: POST_TIME_MS,
    audioMs: 0,
    inSpeech: false,
    speechStartMs: 0,
    silenceMs: 0,
    lastPartialMs: 0,
    utterance: 0,
  };

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString();
      if (text.startsWith("s ")) {
        s.engine = text.split(" ")[2] ?? "";
        s.profileWords = parseStartParam(text, "profileWords") ?? "";
        const segmenter = parseStartParam(text, "segmenterProperties") ?? "";
        s.diarization = /useDiarizer=1/.test(segmenter);
        s.postTimeMs = Number(segmenter.match(/postTime=(\d+)/)?.[1] ?? POST_TIME_MS);
        s.fillers = parseStartParam(text, "keepFillerToken") === "1" && !s.engine.startsWith("-a2");
        s.started = true;
        console.log(
          `[mock] ws start engine=${s.engine} profileWords=${s.profileWords.split("|").filter(Boolean).length}語 diarizer=${s.diarization}`,
        );
        ws.send("s");
      } else if (text === "e") {
        if (s.inSpeech) endUtterance(ws, s);
        setTimeout(() => ws.send("e"), FINALIZE_DELAY_MS + 50);
      }
      return;
    }
    const buf = data as Buffer;
    if (!s.started || buf[0] !== 0x70) {
      ws.send("p can't feed audio data to recognizer server");
      return;
    }
    onAudio(ws, s, buf.subarray(1));
  });
}

function rmsOf(pcm: Buffer, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = from; i + 1 < to; i += 2) {
    const v = pcm.readInt16LE(i) / 32768;
    sum += v * v;
    n++;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
}

function onAudio(ws: WebSocket, s: Session, pcm: Buffer): void {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return;
  const rms = rmsOf(pcm, 0, samples * 2);
  const chunkMs = (samples / SAMPLE_RATE) * 1000;
  s.audioMs += chunkMs;

  if (rms >= SPEECH_RMS) {
    s.silenceMs = 0;
    if (!s.inSpeech) {
      s.inSpeech = true;
      s.speechStartMs = s.audioMs - chunkMs;
      s.lastPartialMs = s.audioMs;
      ws.send(`S ${Math.round(s.speechStartMs)}`);
      ws.send("C");
    }
  } else if (s.inSpeech) {
    s.silenceMs += chunkMs;
  }

  if (s.inSpeech && s.audioMs - s.lastPartialMs >= PARTIAL_EVERY_MS) {
    s.lastPartialMs = s.audioMs;
    const full = joinTokens(renderTokens(s.utterance, s.profileWords, { fillers: s.fillers, live: true }));
    // 発話が進むほど長い途中結果を返す（1 秒あたり 6 文字）。途中結果のトークンには信頼度が無い
    const shown = Math.min(full.length, Math.ceil(((s.audioMs - s.speechStartMs) / 1000) * 6));
    const text = full.slice(0, shown);
    ws.send(`U ${JSON.stringify({ results: [{ tokens: [{ written: text }], text }], text })}`);
  }

  if (s.inSpeech && s.silenceMs >= s.postTimeMs) endUtterance(ws, s);
}

function endUtterance(ws: WebSocket, s: Session): void {
  const endMs = Math.round(s.audioMs - s.silenceMs);
  const startMs = Math.round(s.speechStartMs);
  s.inSpeech = false;
  s.silenceMs = 0;
  ws.send(`E ${endMs}`);
  const index = s.utterance++;
  const tokens = renderTokens(index, s.profileWords, { fillers: s.fillers, live: true });
  spreadTimes(tokens, startMs, endMs);
  if (s.diarization) for (const t of tokens) t.label = speakerLabel(index);
  const text = joinTokens(tokens);
  setTimeout(() => {
    const result = {
      results: [{ tokens, confidence: 0.9, starttime: startMs, endtime: endMs, tags: [], rulename: "", text }],
      utteranceid: `mock-${index}`,
      text,
      code: "",
      message: "",
    };
    if (ws.readyState === ws.OPEN) ws.send(`A ${JSON.stringify(result)}`);
  }, FINALIZE_DELAY_MS);
}

// ---------------------------------------------------------------------------
// 非同期 HTTP API
// ---------------------------------------------------------------------------

interface Job {
  createdAt: number;
  result: Record<string, unknown>;
}

const jobs = new Map<string, Job>();

/** 仮の感情パラメータ（キー名は仮。日本語名はマニュアルの一覧のとおり） */
const SENTIMENT_PARAMS: [string, string, number, number][] = [
  ["energy", "エネルギー", 0, 100],
  ["stress", "ストレス", 0, 100],
  ["emo_cog", "感情バランス論理", 1, 500],
  ["concentration", "集中", 0, 100],
  ["anticipation", "期待", 0, 100],
  ["excitement", "興奮", 0, 30],
  ["hesitation", "躊躇", 0, 30],
  ["uncertainty", "不確実", 0, 30],
  ["intensive_thinking", "思考", 0, 100],
  ["imagination_activity", "想像力", 0, 30],
  ["embarrassment", "困惑", 0, 30],
  ["passionate", "情熱", 0, 30],
  ["brain_power", "脳活動", 0, 100],
  ["confidence", "自信", 0, 30],
  ["aggression", "攻撃性憤り", 0, 30],
  ["call_priority", "雰囲気会話傾向", -100, 100],
  ["atmosphere", "動揺", 0, 30],
  ["upset", "喜び", 0, 30],
  ["content", "不満", 0, 30],
  ["dissatisfaction", "極端な起伏", 0, 30],
];

function parseD(d: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of d.split(" ")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
  }
  return out;
}

/** WAV から PCM（16bit モノラル）を取り出す。 */
function wavPcm(buf: Buffer): Buffer {
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size;
  }
  throw new Error("data chunk not found");
}

/** 100ms ごとの音量で発話区間を求める。 */
function segment(pcm: Buffer): { startMs: number; endMs: number }[] {
  const frameBytes = (SAMPLE_RATE / 10) * 2;
  const out: { startMs: number; endMs: number }[] = [];
  let start: number | null = null;
  let silence = 0;
  for (let i = 0; i * frameBytes < pcm.length; i++) {
    const t = i * 100;
    const loud = rmsOf(pcm, i * frameBytes, Math.min(pcm.length, (i + 1) * frameBytes)) >= SPEECH_RMS;
    if (loud) {
      silence = 0;
      start ??= t;
    } else if (start !== null) {
      silence += 100;
      if (silence >= POST_TIME_MS) {
        out.push({ startMs: start, endMs: t - silence + 100 });
        start = null;
        silence = 0;
      }
    }
  }
  if (start !== null) out.push({ startMs: start, endMs: (pcm.length / 2 / SAMPLE_RATE) * 1000 });
  return out;
}

function buildAsyncResult(sessionId: string, pcm: Buffer, d: Map<string, string>): Record<string, unknown> {
  const engine = d.get("grammarFileNames") ?? "";
  const profileWords = d.get("profileWords") ?? "";
  const diarization = d.get("speakerDiarization") === "True";
  const fillers = d.get("keepFillerToken") === "1" && !engine.startsWith("-a2");
  const sentiment = d.get("sentimentAnalysis") === "True";

  const segments = segment(pcm).map((u, index) => {
    const tokens = renderTokens(index, profileWords, { fillers, live: false });
    spreadTimes(tokens, u.startMs, u.endMs);
    if (diarization) for (const t of tokens) t.label = speakerLabel(index);
    // E2E エンジンは単語ごとの読み（spoken）を返さない
    if (engine.startsWith("-a2")) for (const t of tokens) delete t.spoken;
    else for (const t of tokens) t.spoken ??= t.written.startsWith("%") ? t.written.slice(1, -1) : "_";
    const text = joinTokens(tokens);
    return {
      results: [{ tokens, confidence: 0.9, starttime: u.startMs, endtime: u.endMs, tags: [], rulename: "", text }],
      text,
    };
  });

  const result: Record<string, unknown> = {
    audio_md5: "mock",
    audio_size: pcm.length + 44,
    service_id: "mock",
    session_id: sessionId,
    status: "completed",
    segments,
    text: segments.map((s) => s.text).join(""),
    utteranceid: `mock-${sessionId}`,
    code: "",
    message: "",
  };
  if (sentiment) {
    const out: Record<string, number>[] = [];
    for (const u of segment(pcm)) {
      for (let t = u.startMs; t + 1000 < u.endMs; t += 2000) {
        const seg: Record<string, number> = { starttime: Math.round(t), endtime: Math.round(Math.min(u.endMs, t + 2000)) };
        SENTIMENT_PARAMS.forEach(([key, , min, max], i) => {
          // ゆっくり上下する値（登壇の後半ほどエネルギーが上がる）
          const wave = (Math.sin(t / 9000 + i) + 1) / 2;
          const trend = key === "energy" ? Math.min(1, t / 120_000) * 0.4 : 0;
          seg[key] = Math.round(min + (max - min) * Math.min(1, wave * 0.6 + trend));
        });
        out.push(seg);
      }
    }
    result.sentiment_analysis = { segments: out };
  }
  return result;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const auth = req.headers.authorization ?? "";
  if (url.pathname === "/v2/sentiment-analysis/ja/result-parameters.json") {
    if (!auth.startsWith("Bearer ")) return sendJson(res, 401, { message: "unauthorized" });
    // 本物と同じ形（2026-11 に実際の API で確認）
    return sendJson(res, 200, {
      sentiment_analysis: {
        result_parameters: {
          display_language: "ja",
          definitions: SENTIMENT_PARAMS.map(([name, display_name, minimum, maximum]) => ({ name, display_name, minimum, maximum })),
        },
      },
    });
  }
  if (url.pathname === "/v2/recognitions" && req.method === "POST") {
    const body = await readBody(req);
    const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
    const d = parseD(String(form.get("d") ?? ""));
    const audio = form.get("a");
    if (!auth.startsWith("Bearer ") && !form.get("u")) return sendJson(res, 200, { code: "!", message: "authorization failed" });
    if (!(audio instanceof Blob)) return sendJson(res, 200, { code: "-", message: "audio is missing" });
    if (req.headers["content-length"] === undefined) console.warn("[mock] Content-Length がありません（chunked）");
    const pcm = wavPcm(Buffer.from(await audio.arrayBuffer()));
    const sessionId = `mock${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
    jobs.set(sessionId, { createdAt: Date.now(), result: buildAsyncResult(sessionId, pcm, d) });
    console.log(
      `[mock] async job ${sessionId} engine=${d.get("grammarFileNames")} audio=${(pcm.length / 2 / SAMPLE_RATE).toFixed(1)}s diarization=${d.get("speakerDiarization") ?? "-"} sentiment=${d.get("sentimentAnalysis") ?? "-"} filler=${d.get("keepFillerToken") ?? "-"}`,
    );
    return sendJson(res, 200, { sessionid: sessionId, text: "..." });
  }
  const m = url.pathname.match(/^\/v2\/recognitions\/([a-z0-9]+)$/);
  if (m && req.method === "GET") {
    if (!auth.startsWith("Bearer ")) return sendJson(res, 401, { message: "unauthorized" });
    const job = jobs.get(m[1]!);
    if (!job) return sendJson(res, 404, { message: "not found" });
    const elapsed = Date.now() - job.createdAt;
    if (elapsed < ASYNC_PROCESSING_MS / 2) return sendJson(res, 200, { session_id: m[1], status: "queued" });
    if (elapsed < ASYNC_PROCESSING_MS) return sendJson(res, 200, { session_id: m[1], status: "processing", audio_md5: "mock", audio_size: 0, service_id: "mock" });
    return sendJson(res, 200, job.result);
  }
  sendJson(res, 404, { message: "not found" });
}

const server = createServer((req, res) => {
  onHttp(req, res).catch((err: unknown) => {
    console.error(err);
    sendJson(res, 500, { message: String(err) });
  });
});
new WebSocketServer({ server }).on("connection", onConnection);
server.listen(PORT, () => {
  console.log(`[mock] AmiVoice モックサーバ: ws://localhost:${PORT}/ と http://localhost:${PORT}/v2/recognitions`);
});
