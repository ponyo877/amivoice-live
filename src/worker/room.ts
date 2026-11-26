// 1 つの勉強会（ルーム）を担当する Durable Object。
//
// 配信中（WebSocket API）
// - 登壇者のブラウザから PCM 音声を受け取り、AmiVoice API に中継する（API キーはこの DO の中だけで使う）
// - 途中結果・確定結果を参加者全員に配る。話者ダイアライゼーションの話者と、トークンの信頼度も付ける
// - 同じ音声を R2 に録音する
// 終了後（非同期 HTTP API、アラームで進める）
// - アーカイブ用: バッチエンジン＋話者ダイアライゼーションで認識し直し、精度の高い字幕を作る
// - 振り返り用: ハイブリッドエンジン＋感情分析＋フィラーを残す設定で認識し、レポートを作る

import { DurableObject } from "cloudflare:workers";
import {
  buildAudioPacket,
  buildProfileWords,
  buildStartCommand,
  decodeWritten,
  engineKind,
  ENGINES,
  majorityLabel,
  parseServerEvent,
  pcmBytesToMs,
  resultEndTime,
  resultTokens,
  type DictionaryTerm,
  type RecognitionResult,
} from "../shared/amivoice.ts";
import { asyncUtterances, buildReport, speakerIndexes, type AsyncJobResult, type TalkReport } from "../shared/async-result.ts";
import type {
  CaptionLine,
  LiveStats,
  RoomInfo,
  ServerMessage,
  SpeakerMessage,
  TalkDetail,
  TalkStatus,
  TalkSummary,
  UsageStatus,
} from "../shared/protocol.ts";
import { buildDParam } from "../shared/async-request.ts";
import { getJob, getSentimentParameters, submitRecording } from "./async-api.ts";
import { PART_SIZE, Recording } from "./recording.ts";

const SNAPSHOT_LINES = 50;
/** AmiVoice 接続待ちの間に溜めておく音声の上限（16kHz 16bit で約 15 秒） */
const MAX_PENDING_AUDIO_BYTES = 16000 * 2 * 15;
const MAX_RECONNECTS_PER_MINUTE = 5;
/** 非同期ジョブの状態を見に行く間隔（公式サンプルも 10 秒） */
const POLL_MS = 10_000;
const MAX_ATTEMPTS = 5;
/** アーカイブ用: 非同期 HTTP ではバッチ用エンジンが推奨されている */
const ARCHIVE_ENGINE = "-a2b-ja-general";
/** 振り返り用: フィラーを残せる（keepFillerToken）のはハイブリッドエンジンだけ */
const REPORT_ENGINE = "-a-general";
/** 配信中の使用量は、送った音声がこの長さ（60 秒）たまるごとに数える */
const USAGE_REPORT_BYTES = 16000 * 2 * 60;
const PCM_BYTES_PER_SECOND = 16000 * 2;

interface LiveConfig {
  engine: string;
  useDictionary: boolean;
  diarization: boolean;
  archive: boolean;
}

type JobState = "pending" | "done" | "error";

type TalkRow = {
  id: number;
  started_at: number;
  ended_at: number | null;
  status: TalkStatus;
  archive: number;
  dictionary: number;
  audio_bytes: number;
  r2_key: string | null;
  upload_id: string | null;
  parts: string;
  archive_job: string | null;
  archive_state: JobState | null;
  report_job: string | null;
  report_state: JobState | null;
  attempts: number;
  error: string | null;
};

type CaptionRow = {
  id: number;
  talk_id: number;
  text: string;
  start_ms: number;
  end_ms: number;
  received_at: number;
  speaker: number | null;
  tokens: string | null;
};

export class Room extends DurableObject<Env> {
  // ---- 配信中だけ使うメモリ上の状態（DO が休止すると消えるが、休止するのは配信していないときだけ） ----
  private upstream: WebSocket | null = null;
  private upstreamReady = false;
  private wantLive = false;
  private config: LiveConfig = { engine: "-a-general", useDictionary: true, diarization: false, archive: true };
  private terms: DictionaryTerm[] = [];
  private pendingAudio: Uint8Array[] = [];
  private pendingBytes = 0;
  private talkId: number | null = null;
  /** 今の AmiVoice セッションがどの登壇のものか。停止後に届く最後の確定結果も、その登壇に記録する */
  private upstreamTalkId: number | null = null;
  private recording: Recording | null = null;
  /** 今の AmiVoice セッションより前に送った音声の長さ。セッションごとに 0 から始まる時刻を、登壇の通し時刻に直す */
  private sessionOffsetMs = 0;
  private sessionAudioBytes = 0;
  /** 話者ラベル（speaker0 など）→ 表示用の番号。ラベルはセッションごとに独立なので、張り直したら作り直す */
  private speakerMap = new Map<string, number>();
  private lastEnd: { audioMs: number; at: number } | null = null;
  private partial = "";
  private finalizeSamples: number[] = [];
  private lagSamples: number[] = [];
  private reconnectTimes: number[] = [];
  /** AmiVoice に送ったが、まだ使用量に数えていない音声のバイト数 */
  private unreportedBytes = 0;
  /** 最後に見た今月の使用量。配信を始めるときの判定に使う（同期的に判定したいので手元に持つ） */
  private usageStatus: UsageStatus | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS talks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          status TEXT NOT NULL,
          archive INTEGER NOT NULL,
          engine TEXT NOT NULL,
          dictionary INTEGER NOT NULL,
          diarization INTEGER NOT NULL,
          audio_bytes INTEGER NOT NULL DEFAULT 0,
          r2_key TEXT,
          upload_id TEXT,
          parts TEXT NOT NULL DEFAULT '[]',
          archive_job TEXT,
          archive_state TEXT,
          report_job TEXT,
          report_state TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS captions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          talk_id INTEGER NOT NULL,
          text TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          finalize_ms INTEGER,
          lag_ms INTEGER,
          engine TEXT NOT NULL,
          dictionary INTEGER NOT NULL,
          speaker INTEGER,
          tokens TEXT
        );
        CREATE TABLE IF NOT EXISTS archive_captions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          talk_id INTEGER NOT NULL,
          text TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER NOT NULL,
          speaker INTEGER
        );
        CREATE TABLE IF NOT EXISTS reports (talk_id INTEGER PRIMARY KEY, json TEXT NOT NULL);
      `);
      // 配信中に DO が再起動した登壇は、そこまでの録音を回収する
      const stale = ctx.storage.sql.exec("UPDATE talks SET status = 'interrupted' WHERE status = 'live' RETURNING id").toArray();
      if (stale.length > 0) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }

  // ------------------------------------------------------------------
  // RPC（Worker から呼ぶ）
  // ------------------------------------------------------------------

  async init(roomId: string, title: string, tokenHash: string): Promise<void> {
    if (this.getMeta("token_hash")) throw new Error("room already exists");
    this.setMeta("room_id", roomId);
    this.setMeta("title", title);
    this.setMeta("token_hash", tokenHash);
    this.setMeta("created_at", String(Date.now()));
  }

  async exists(): Promise<boolean> {
    return this.getMeta("token_hash") !== null;
  }

  async verifyToken(tokenHash: string): Promise<boolean> {
    const stored = this.getMeta("token_hash");
    return stored !== null && timingSafeEqual(stored, tokenHash);
  }

  async getDictionary(): Promise<DictionaryTerm[]> {
    return this.loadTerms();
  }

  async setDictionary(terms: DictionaryTerm[]): Promise<void> {
    this.setMeta("dictionary", JSON.stringify(terms));
    this.terms = terms;
    this.broadcast({ type: "terms", terms: this.visibleTerms() });
    // profileWords は s コマンドでしか渡せないので、配信中ならセッションを張り直して新しい辞書を効かせる
    if (this.wantLive && this.config.useDictionary) this.restartUpstream();
  }

  /** ルーム全体の確定字幕（talkId を渡すとその登壇だけ）。 */
  async getLines(talkId?: number): Promise<{ title: string; lines: CaptionLine[] }> {
    const rows =
      talkId === undefined
        ? this.ctx.storage.sql.exec<CaptionRow>("SELECT * FROM captions ORDER BY id").toArray()
        : this.ctx.storage.sql.exec<CaptionRow>("SELECT * FROM captions WHERE talk_id = ? ORDER BY id", talkId).toArray();
    return { title: this.getMeta("title") ?? "", lines: rows.map(toCaptionLine) };
  }

  async getArchiveLines(talkId: number): Promise<{ title: string; lines: CaptionLine[] }> {
    return { title: this.getMeta("title") ?? "", lines: this.archiveLines(talkId) };
  }

  async listTalks(): Promise<TalkSummary[]> {
    return this.talkSummaries();
  }

  async getTalk(talkId: number): Promise<TalkDetail | null> {
    const row = this.talkRow(talkId);
    if (!row) return null;
    const report = this.ctx.storage.sql.exec<{ json: string }>("SELECT json FROM reports WHERE talk_id = ?", talkId).toArray()[0];
    return {
      talk: toTalkSummary(row, this.hasReport(talkId)),
      live: this.ctx.storage.sql.exec<CaptionRow>("SELECT * FROM captions WHERE talk_id = ? ORDER BY id", talkId).toArray().map(toCaptionLine),
      archive: this.archiveLines(talkId),
      report: report ? (JSON.parse(report.json) as TalkReport) : null,
      sentimentParameters: JSON.parse(this.getMeta("sentiment_params") ?? "null"),
    };
  }

  /**
   * 辞書の候補づくりに渡す材料。信頼度の低い語を ⟦表記|読み|信頼度⟧ で印を付けた書き起こしと、今の辞書。
   * 振り返り用の結果（ハイブリッドエンジン）があればそちらを、無ければライブ字幕を使う。
   */
  async suggestionInput(talkId: number): Promise<{ transcript: string; dictionary: DictionaryTerm[] } | null> {
    const report = this.ctx.storage.sql.exec<{ json: string }>("SELECT json FROM reports WHERE talk_id = ?", talkId).toArray()[0];
    let transcript = "";
    if (report) {
      const r = JSON.parse(report.json) as TalkReport;
      transcript = r.lowConfidence.map((l) => `${l.context}\n  → 自信のない語: ⟦${l.written}|${l.spoken ?? ""}|${l.confidence.toFixed(2)}⟧`).join("\n");
    }
    if (!transcript) {
      const rows = this.ctx.storage.sql.exec<CaptionRow>("SELECT * FROM captions WHERE talk_id = ? ORDER BY id", talkId).toArray();
      transcript = rows
        .map((r) => {
          const tokens = r.tokens ? (JSON.parse(r.tokens) as [string, number, string?][]) : [];
          return tokens.length > 0 ? tokens.map(([w, c, s]) => (c < 0.5 ? `⟦${w}|${s ?? ""}|${c.toFixed(2)}⟧` : w)).join("") : r.text;
        })
        .join("\n");
    }
    if (!transcript.trim()) return null;
    return { transcript, dictionary: this.loadTerms() };
  }

  /** 録音の R2 のキー（録音が無ければ null）。 */
  async recordingKey(talkId: number): Promise<string | null> {
    const row = this.talkRow(talkId);
    if (!row?.r2_key || !["recorded", "archiving", "done", "error"].includes(row.status)) return null;
    return row.r2_key;
  }

  /** アーカイブと振り返りを作り直す。 */
  async retryArchive(talkId: number): Promise<void> {
    const row = this.talkRow(talkId);
    if (!row || !row.r2_key || row.audio_bytes === 0) throw new Error("録音が残っていません");
    this.ctx.storage.sql.exec(
      `UPDATE talks SET status = 'recorded', archive = 1, archive_job = NULL, archive_state = NULL, report_job = NULL, report_state = NULL, attempts = 0, error = NULL WHERE id = ?`,
      talkId,
    );
    await this.ctx.storage.setAlarm(Date.now() + 500);
    this.sendToSpeaker({ type: "talks", talks: this.talkSummaries() });
  }

  /** 録音と AmiVoice の生の結果を消す（字幕とレポートは残す）。 */
  async deleteRecording(talkId: number): Promise<void> {
    const row = this.talkRow(talkId);
    if (!row?.r2_key) return;
    const base = row.r2_key.replace(/audio\.pcm$/, "");
    await this.env.RECORDINGS.delete([row.r2_key, `${base}archive.json`, `${base}report.json`]);
    this.ctx.storage.sql.exec("UPDATE talks SET r2_key = NULL WHERE id = ?", talkId);
    this.sendToSpeaker({ type: "talks", talks: this.talkSummaries() });
  }

  // ------------------------------------------------------------------
  // WebSocket（登壇者・参加者）
  // ------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "speaker" ? "speaker" : "viewer";
    // 登壇者のトークンは Worker 側で検証済み（x-speaker-verified は Worker だけが付ける）
    if (role === "speaker" && request.headers.get("x-speaker-verified") !== "1") {
      return new Response("forbidden", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (role === "speaker") {
      // 登壇者は 1 人だけ。新しく接続したら古い接続を閉じる
      for (const old of this.ctx.getWebSockets("speaker")) {
        old.close(4000, "replaced by another speaker connection");
      }
    }
    this.ctx.acceptWebSocket(server, [role]);
    this.terms = this.loadTerms();

    const snapshot: ServerMessage = {
      type: "snapshot",
      room: this.roomInfo(),
      lines: this.recentLines(SNAPSHOT_LINES),
      partial: this.partial,
      terms: this.visibleTerms(),
      viewers: this.ctx.getWebSockets("viewer").length,
    };
    server.send(JSON.stringify(snapshot));
    if (role === "speaker") {
      server.send(JSON.stringify({ type: "stats", stats: this.stats() } satisfies ServerMessage));
      server.send(JSON.stringify({ type: "talks", talks: this.talkSummaries() } satisfies ServerMessage));
      this.ctx.waitUntil(this.refreshUsage());
    }
    this.broadcast({ type: "viewers", count: this.ctx.getWebSockets("viewer").length });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (!this.ctx.getTags(ws).includes("speaker")) return; // 参加者からの入力は使わない

    if (typeof message !== "string") {
      this.forwardAudio(new Uint8Array(message));
      return;
    }
    let msg: SpeakerMessage;
    try {
      msg = JSON.parse(message) as SpeakerMessage;
    } catch {
      return;
    }
    if (msg.type === "start") {
      const engine = ENGINES.some((e) => e.id === msg.engine) ? msg.engine : "-a-general";
      const next: LiveConfig = {
        engine,
        useDictionary: msg.useDictionary,
        diarization: msg.diarization === true,
        archive: msg.archive !== false,
      };
      const changed =
        next.engine !== this.config.engine ||
        next.useDictionary !== this.config.useDictionary ||
        next.diarization !== this.config.diarization;
      // 録音するかどうかは登壇の途中では変えない
      this.config = this.wantLive ? { ...next, archive: this.config.archive } : next;
      this.setMeta("engine", engine);
      this.setMeta("use_dictionary", next.useDictionary ? "1" : "0");
      this.setMeta("diarization", next.diarization ? "1" : "0");
      // 配信中にエンジンや辞書・話者分離の有無を切り替えたら、新しい設定でセッションを張り直す
      if (this.wantLive && this.upstream && changed) {
        this.broadcast({ type: "room", room: this.roomInfo() });
        this.broadcast({ type: "terms", terms: this.visibleTerms() });
        this.restartUpstream();
        return;
      }
      await this.startLive();
    } else if (msg.type === "stop") {
      this.stopLive();
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const isSpeaker = this.ctx.getTags(ws).includes("speaker");
    try {
      ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason);
    } catch {
      // すでに閉じている
    }
    // 登壇者の接続が切れたら認識も止める（音声が来なくなるため）
    if (isSpeaker && this.ctx.getWebSockets("speaker").length === 0) this.stopLive();
    this.broadcast({ type: "viewers", count: this.ctx.getWebSockets("viewer").length });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error");
  }

  // ------------------------------------------------------------------
  // 登壇の開始と終了
  // ------------------------------------------------------------------

  private async startLive(): Promise<void> {
    if (!this.wantLive && this.usageStatus?.remainingSeconds != null && this.usageStatus.remainingSeconds <= 0) {
      this.sendToSpeaker({ type: "upstream", state: "error", message: usageLimitMessage(this.usageStatus, "配信を始められません") });
      return;
    }
    if (!this.wantLive) {
      // 新しい登壇。音声が届き始める前に、同期的に状態を作っておく
      this.wantLive = true;
      this.sessionOffsetMs = 0;
      this.sessionAudioBytes = 0;
      this.finalizeSamples = [];
      this.lagSamples = [];
      const talkId = this.ctx.storage.sql
        .exec<{ id: number }>(
          `INSERT INTO talks (started_at, status, archive, engine, dictionary, diarization)
           VALUES (?, 'live', ?, ?, ?, ?) RETURNING id`,
          Date.now(),
          this.config.archive ? 1 : 0,
          this.config.engine,
          this.config.useDictionary ? 1 : 0,
          this.config.diarization ? 1 : 0,
        )
        .one().id;
      this.talkId = talkId;
      if (this.config.archive) {
        const key = `rooms/${this.getMeta("room_id")}/talks/${talkId}/audio.pcm`;
        this.ctx.storage.sql.exec("UPDATE talks SET r2_key = ? WHERE id = ?", key, talkId);
        this.recording = new Recording(this.env.RECORDINGS, key, (uploadId, parts) => {
          this.ctx.storage.sql.exec("UPDATE talks SET upload_id = ?, parts = ? WHERE id = ?", uploadId, JSON.stringify(parts), talkId);
        });
      }
      this.sendToSpeaker({ type: "talks", talks: this.talkSummaries() });
    }
    this.terms = this.loadTerms();
    this.broadcast({ type: "room", room: this.roomInfo() });
    this.broadcast({ type: "terms", terms: this.visibleTerms() });
    if (!this.upstream) await this.connectUpstream();
  }

  private stopLive(): void {
    if (!this.wantLive) return;
    this.flushUsage();
    this.wantLive = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    const ws = this.upstream;
    if (ws) {
      if (this.upstreamReady) {
        // e を送ると、残りの確定結果のあとに e が返ってくるので、そこで閉じる。
        // 以降の音声（すぐ次の登壇を始めた場合）は、このセッションには送らない
        this.upstreamReady = false;
        try {
          ws.send("e");
        } catch {
          this.closeUpstream();
        }
      } else {
        this.closeUpstream();
      }
    }
    const talkId = this.talkId;
    const recording = this.recording;
    this.talkId = null;
    this.recording = null;
    if (talkId !== null) this.ctx.waitUntil(this.finishTalk(talkId, recording));
    this.broadcast({ type: "room", room: this.roomInfo() });
  }

  private async finishTalk(talkId: number, recording: Recording | null): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE talks SET ended_at = ? WHERE id = ?", Date.now(), talkId);
    if (!recording) {
      this.setTalkStatus(talkId, "done");
    } else {
      try {
        const result = await recording.finish();
        if (result) {
          this.ctx.storage.sql.exec("UPDATE talks SET audio_bytes = ?, status = 'recorded' WHERE id = ?", result.bytes, talkId);
          await this.ctx.storage.setAlarm(Date.now() + 500);
        } else {
          this.setTalkStatus(talkId, "no-audio");
        }
      } catch (err) {
        this.ctx.storage.sql.exec("UPDATE talks SET status = 'error', error = ? WHERE id = ?", errorMessage(err), talkId);
      }
    }
    this.sendToSpeaker({ type: "talks", talks: this.talkSummaries() });
  }

  // ------------------------------------------------------------------
  // 終了後の処理（非同期 HTTP API）。アラームで少しずつ進める
  // ------------------------------------------------------------------

  async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<TalkRow>("SELECT * FROM talks WHERE status IN ('interrupted', 'recorded', 'archiving') ORDER BY id")
      .toArray();
    let again = false;
    for (const row of rows) {
      try {
        again = (await this.advanceTalk(row)) || again;
      } catch (err) {
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          this.ctx.storage.sql.exec("UPDATE talks SET status = 'error', attempts = ?, error = ? WHERE id = ?", attempts, errorMessage(err), row.id);
        } else {
          this.ctx.storage.sql.exec("UPDATE talks SET attempts = ?, error = ? WHERE id = ?", attempts, errorMessage(err), row.id);
          again = true;
        }
      }
    }
    this.sendToSpeaker({ type: "talks", talks: this.talkSummaries() });
    if (again) await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
  }

  /** 登壇を 1 段階進める。まだ続きがあれば true。 */
  private async advanceTalk(row: TalkRow): Promise<boolean> {
    if (row.status === "interrupted") {
      await this.recoverRecording(row);
      return true;
    }
    if (row.status === "recorded") {
      if (!row.archive || !row.r2_key) {
        this.setTalkStatus(row.id, "done");
        return false;
      }
      await this.submitJobs(row);
      return true;
    }
    // archiving
    let archiveState = row.archive_state;
    let reportState = row.report_state;
    if (archiveState === "pending" && row.archive_job) archiveState = await this.pollJob(row, "archive", row.archive_job);
    if (reportState === "pending" && row.report_job) reportState = await this.pollJob(row, "report", row.report_job);
    if (archiveState === "pending" || reportState === "pending") return true;

    if (reportState === "done") await this.saveReport(row, archiveState === "done");
    const status: TalkStatus = archiveState === "error" && reportState === "error" ? "error" : "done";
    this.ctx.storage.sql.exec("UPDATE talks SET status = ?, attempts = 0 WHERE id = ?", status, row.id);
    return false;
  }

  /** 配信中に DO が再起動した登壇の録音を、アップロード済みのパートまでで完成させる。 */
  private async recoverRecording(row: TalkRow): Promise<void> {
    const parts = JSON.parse(row.parts) as R2UploadedPart[];
    this.ctx.storage.sql.exec("UPDATE talks SET ended_at = COALESCE(ended_at, ?) WHERE id = ?", Date.now(), row.id);
    if (!row.r2_key || !row.upload_id || parts.length === 0) {
      if (row.r2_key && row.upload_id) await this.env.RECORDINGS.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch(() => {});
      this.setTalkStatus(row.id, row.archive ? "no-audio" : "done");
      return;
    }
    await this.env.RECORDINGS.resumeMultipartUpload(row.r2_key, row.upload_id).complete(parts);
    this.ctx.storage.sql.exec("UPDATE talks SET status = 'recorded', audio_bytes = ? WHERE id = ?", parts.length * PART_SIZE, row.id);
  }

  private async submitJobs(row: TalkRow): Promise<void> {
    // 辞書を使うかどうかはその登壇の設定に合わせる。語は今の辞書を使うので、振り返りで足した語は作り直しに効く
    const terms = this.loadTerms();
    const useDictionary = row.dictionary === 1;
    const usage = this.env.USAGE.getByName("global");
    const seconds = row.audio_bytes / PCM_BYTES_PER_SECOND;
    if (!row.archive_job) {
      const r = await usage.reserve("async", ARCHIVE_ENGINE, seconds);
      if (!r.ok) {
        // アーカイブを作れないなら振り返りも作らない（使用量の上限に達している）
        this.ctx.storage.sql.exec("UPDATE talks SET status = 'error', error = ? WHERE id = ?", usageLimitMessage(r.status, "アーカイブと振り返りを作りませんでした"), row.id);
        this.sendToSpeaker({ type: "talks", talks: this.talkSummaries() });
        return;
      }
      this.reportUsage(r.status);
      const recording = await this.env.RECORDINGS.get(row.r2_key!);
      if (!recording) throw new Error("録音が見つかりません");
      const d = buildDParam({
        grammarFileNames: ARCHIVE_ENGINE,
        speakerDiarization: "True",
        loggingOptOut: "True",
        profileWords: useDictionary ? buildProfileWords(terms, "e2e") : undefined,
      });
      const job = await submitRecording(this.env, recording, d);
      this.ctx.storage.sql.exec("UPDATE talks SET archive_job = ?, archive_state = 'pending' WHERE id = ?", job, row.id);
    }
    if (!row.report_job) {
      // 感情分析の枠が足りなければ、感情分析なしで振り返りを作る
      let sentiment = true;
      let r = await usage.reserve("async", REPORT_ENGINE, seconds, true);
      if (!r.ok && r.reason === "sentiment") {
        sentiment = false;
        r = await usage.reserve("async", REPORT_ENGINE, seconds, false);
      }
      if (!r.ok) {
        this.ctx.storage.sql.exec(
          "UPDATE talks SET report_state = 'error', error = ?, status = 'archiving', attempts = 0 WHERE id = ?",
          usageLimitMessage(r.status, "振り返りを作りませんでした"),
          row.id,
        );
        return;
      }
      this.reportUsage(r.status);
      const recording = await this.env.RECORDINGS.get(row.r2_key!);
      if (!recording) throw new Error("録音が見つかりません");
      const d = buildDParam({
        grammarFileNames: REPORT_ENGINE,
        sentimentAnalysis: sentiment ? "True" : undefined,
        keepFillerToken: "1",
        loggingOptOut: "True",
        profileWords: useDictionary ? buildProfileWords(terms, "hybrid") : undefined,
      });
      const job = await submitRecording(this.env, recording, d);
      this.ctx.storage.sql.exec("UPDATE talks SET report_job = ?, report_state = 'pending' WHERE id = ?", job, row.id);
    }
    this.ctx.storage.sql.exec("UPDATE talks SET status = 'archiving', attempts = 0, error = NULL WHERE id = ?", row.id);
  }

  private async pollJob(row: TalkRow, kind: "archive" | "report", sessionId: string): Promise<JobState> {
    const { job, raw } = await getJob(this.env, sessionId);
    if (job.status === "error") {
      const message = `${kind === "archive" ? "アーカイブ" : "振り返り"}の認識に失敗しました: ${job.error_message ?? "不明なエラー"}`;
      this.ctx.storage.sql.exec(`UPDATE talks SET ${kind}_state = 'error', error = ? WHERE id = ?`, message, row.id);
      return "error";
    }
    if (job.status !== "completed") return "pending";

    // 生の結果は R2 に置く（大きくなりうるので SQLite には入れない）
    await this.env.RECORDINGS.put(row.r2_key!.replace(/audio\.pcm$/, `${kind}.json`), raw, {
      httpMetadata: { contentType: "application/json" },
    });
    if (kind === "archive") this.saveArchiveCaptions(row.id, job);
    this.ctx.storage.sql.exec(`UPDATE talks SET ${kind}_state = 'done' WHERE id = ?`, row.id);
    return "done";
  }

  private saveArchiveCaptions(talkId: number, job: AsyncJobResult): void {
    const utterances = asyncUtterances(job);
    const indexes = speakerIndexes(utterances);
    this.ctx.storage.sql.exec("DELETE FROM archive_captions WHERE talk_id = ?", talkId);
    for (const u of utterances) {
      this.ctx.storage.sql.exec(
        "INSERT INTO archive_captions (talk_id, text, start_ms, end_ms, speaker) VALUES (?, ?, ?, ?, ?)",
        talkId,
        decodeWritten(u.text, this.terms),
        Math.round(u.startMs),
        Math.round(u.endMs),
        u.label !== undefined ? (indexes.get(u.label) ?? null) : null,
      );
    }
  }

  private async saveReport(row: TalkRow, archiveDone: boolean): Promise<void> {
    const base = row.r2_key!.replace(/audio\.pcm$/, "");
    const reportObj = await this.env.RECORDINGS.get(`${base}report.json`);
    if (!reportObj) throw new Error("振り返り用の結果が見つかりません");
    const reportJob = (await reportObj.json()) as AsyncJobResult;
    const archiveObj = archiveDone ? await this.env.RECORDINGS.get(`${base}archive.json`) : null;
    const archiveJob = archiveObj ? ((await archiveObj.json()) as AsyncJobResult) : null;
    const liveText = this.ctx.storage.sql
      .exec<{ text: string }>("SELECT text FROM captions WHERE talk_id = ? ORDER BY id", row.id)
      .toArray()
      .map((r) => r.text)
      .join("");
    const report = buildReport(reportJob, archiveJob, liveText);
    this.ctx.storage.sql.exec(
      "INSERT INTO reports (talk_id, json) VALUES (?, ?) ON CONFLICT(talk_id) DO UPDATE SET json = excluded.json",
      row.id,
      JSON.stringify(report),
    );
    // 感情分析パラメータの名前一覧は一度取れば十分
    if (report.sentiment && !this.getMeta("sentiment_params")) {
      const params = await getSentimentParameters(this.env).catch(() => null);
      if (params) this.setMeta("sentiment_params", JSON.stringify(params));
    }
  }

  // ------------------------------------------------------------------
  // AmiVoice への中継（WebSocket API）
  // ------------------------------------------------------------------

  /**
   * 今のセッションを e で締めくくり、閉じたら新しい設定でつなぎ直す（wantLive のままなので onUpstreamClosed が再接続する）。
   * 締めくくりの間に届いた音声は pendingAudio に溜まり、次のセッションで送られる。
   */
  private restartUpstream(): void {
    const ws = this.upstream;
    if (!ws) return;
    if (!this.upstreamReady) {
      this.closeUpstream();
      return;
    }
    this.upstreamReady = false; // 以降の音声は次のセッション用に溜める
    try {
      ws.send("e");
    } catch {
      this.closeUpstream();
    }
  }

  private async connectUpstream(): Promise<void> {
    const apiKey = this.env.AMIVOICE_API_KEY;
    if (!apiKey) {
      this.sendToSpeaker({ type: "upstream", state: "error", message: "AMIVOICE_API_KEY が設定されていません" });
      this.stopLive();
      return;
    }
    this.sendToSpeaker({ type: "upstream", state: "connecting" });

    const kind = engineKind(this.config.engine);
    const profileWords = this.config.useDictionary ? buildProfileWords(this.terms, kind) : "";
    const command = buildStartCommand({
      engine: this.config.engine,
      authorization: apiKey,
      profileWords: profileWords || undefined,
      resultUpdatedInterval: 200,
      segmenter: this.config.diarization ? { useDiarizer: 1 } : undefined,
    });

    let ws: WebSocket | null;
    try {
      const resp = await fetch(this.env.AMIVOICE_WS_URL, { headers: { Upgrade: "websocket" } });
      ws = resp.webSocket;
      if (!ws) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      this.sendToSpeaker({ type: "upstream", state: "error", message: `AmiVoice に接続できませんでした: ${errorMessage(err)}` });
      this.scheduleReconnect();
      return;
    }
    ws.accept();
    this.upstream = ws;
    this.upstreamTalkId = this.talkId;
    this.upstreamReady = false;
    this.sessionAudioBytes = 0;
    this.lastEnd = null;
    this.speakerMap = new Map();
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") this.onUpstreamMessage(ws, ev.data);
    });
    ws.addEventListener("close", () => this.onUpstreamClosed(ws));
    ws.addEventListener("error", () => this.onUpstreamClosed(ws));
    // command には API キーが入っているので、ログに出さないこと
    ws.send(command);
  }

  private onUpstreamMessage(ws: WebSocket, raw: string): void {
    if (ws !== this.upstream) return;
    const ev = parseServerEvent(raw);
    switch (ev.kind) {
      case "s":
        if (ev.error) {
          this.sendToSpeaker({ type: "upstream", state: "error", message: `認識を開始できませんでした: ${ev.error}` });
          this.closeUpstream();
          this.stopLive();
          return;
        }
        this.upstreamReady = true;
        this.sendToSpeaker({ type: "upstream", state: "open" });
        for (const chunk of this.pendingAudio) this.sendAudio(chunk);
        this.pendingAudio = [];
        this.pendingBytes = 0;
        return;
      case "p":
        // 長時間無音などで AmiVoice 側がセッションを終えた。閉じたあとに再接続する
        this.sendToSpeaker({ type: "upstream", state: "error", message: ev.error });
        this.closeUpstream();
        return;
      case "E":
        this.lastEnd = { audioMs: ev.time, at: Date.now() };
        return;
      case "U": {
        const text = decodeWritten(ev.result.text ?? "", this.terms);
        if (text === this.partial) return;
        this.partial = text;
        this.broadcast({ type: "partial", text });
        return;
      }
      case "A":
        this.onFinal(ev.result);
        return;
      case "e":
        if (ev.error) this.sendToSpeaker({ type: "upstream", state: "error", message: ev.error });
        this.closeUpstream();
        return;
      default:
        return;
    }
  }

  private onFinal(result: RecognitionResult): void {
    const text = decodeWritten(result.text ?? "", this.terms).trim();
    const talkId = this.upstreamTalkId;
    this.partial = "";
    if (!text || talkId === null) {
      // 雑音などで中身のない確定結果。途中結果の表示だけ消す
      this.broadcast({ type: "partial", text: "" });
      return;
    }
    const now = Date.now();
    const sessionEnd = resultEndTime(result) ?? this.lastEnd?.audioMs ?? pcmBytesToMs(this.sessionAudioBytes);
    const sessionStart = result.results?.[0]?.starttime ?? sessionEnd;
    const finalizeMs = this.lastEnd ? now - this.lastEnd.at : null;
    const lagMs = Math.round(pcmBytesToMs(this.sessionAudioBytes) - sessionEnd);
    this.lastEnd = null;

    // 話者: トークンの多数決で決めたラベルを、このセッションで出てきた順の番号にする
    const tokens = resultTokens(result).filter((t) => t.written);
    let speaker: number | undefined;
    const label = this.config.diarization ? majorityLabel(tokens) : undefined;
    if (label !== undefined) {
      if (!this.speakerMap.has(label)) this.speakerMap.set(label, this.speakerMap.size);
      speaker = this.speakerMap.get(label);
    }
    // 信頼度（ハイブリッドエンジンでは読みも残し、辞書の候補づくりに使う）
    const stored = tokens.map((t) => {
      const entry: [string, number, string?] = [decodeWritten(t.written, this.terms), round2(t.confidence ?? 1)];
      if (t.spoken && t.spoken !== "_") entry.push(t.spoken);
      return entry;
    });

    const startMs = Math.round(this.sessionOffsetMs + sessionStart);
    const endMs = Math.round(this.sessionOffsetMs + sessionEnd);
    const row = this.ctx.storage.sql
      .exec<{ id: number }>(
        `INSERT INTO captions (talk_id, text, start_ms, end_ms, received_at, finalize_ms, lag_ms, engine, dictionary, speaker, tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        talkId,
        text,
        startMs,
        endMs,
        now,
        finalizeMs,
        lagMs,
        this.config.engine,
        this.config.useDictionary ? 1 : 0,
        speaker ?? null,
        stored.length > 0 ? JSON.stringify(stored) : null,
      )
      .one();

    if (finalizeMs !== null) this.finalizeSamples.push(finalizeMs);
    this.lagSamples.push(lagMs);
    const line: CaptionLine = {
      id: row.id,
      talkId,
      text,
      startMs,
      endMs,
      receivedAt: now,
      speaker,
      tokens: stored.length > 0 ? stored.map(([w, c]) => [w, c]) : undefined,
    };
    this.broadcast({ type: "final", line });
    this.sendToSpeaker({ type: "stats", stats: this.stats() });
  }

  private onUpstreamClosed(ws: WebSocket): void {
    if (ws !== this.upstream) return;
    this.upstream = null;
    this.upstreamReady = false;
    // 次の登壇がもう始まっていたら、前の登壇のセッションの長さは足さない（時刻は登壇ごとに 0 から）
    if (this.upstreamTalkId === this.talkId) this.sessionOffsetMs += pcmBytesToMs(this.sessionAudioBytes);
    this.upstreamTalkId = null;
    this.sessionAudioBytes = 0;
    if (this.partial) {
      this.partial = "";
      this.broadcast({ type: "partial", text: "" });
    }
    if (this.wantLive) {
      this.scheduleReconnect();
    } else {
      this.sendToSpeaker({ type: "upstream", state: "closed" });
    }
  }

  private closeUpstream(): void {
    const ws = this.upstream;
    if (!ws) return;
    try {
      ws.close(1000, "done");
    } catch {
      // すでに閉じている
    }
    this.onUpstreamClosed(ws);
  }

  /** 配信中に AmiVoice との接続が切れたら、短い間隔で張り直す（1 分あたりの回数に上限あり）。 */
  private scheduleReconnect(): void {
    if (!this.wantLive) return;
    const now = Date.now();
    this.reconnectTimes = this.reconnectTimes.filter((t) => now - t < 60_000);
    if (this.reconnectTimes.length >= MAX_RECONNECTS_PER_MINUTE) {
      this.sendToSpeaker({ type: "upstream", state: "error", message: "AmiVoice への再接続が続けて失敗したため停止しました" });
      this.stopLive();
      return;
    }
    this.reconnectTimes.push(now);
    setTimeout(() => {
      if (this.wantLive && !this.upstream) void this.connectUpstream();
    }, 500);
  }

  private forwardAudio(chunk: Uint8Array): void {
    if (!this.wantLive) return;
    // AmiVoice に送るのと同じ音声を録音する（接続待ちで溜めた分も含む）
    this.recording?.append(chunk);
    if (this.upstream && this.upstreamReady) {
      this.sendAudio(chunk);
      return;
    }
    // 接続待ち・再接続中は溜めておき、つながったら送る
    this.pendingAudio.push(chunk);
    this.pendingBytes += chunk.byteLength;
    while (this.pendingBytes > MAX_PENDING_AUDIO_BYTES && this.pendingAudio.length > 0) {
      this.pendingBytes -= this.pendingAudio.shift()!.byteLength;
    }
  }

  private sendAudio(chunk: Uint8Array): void {
    try {
      this.upstream?.send(buildAudioPacket(chunk));
      this.sessionAudioBytes += chunk.byteLength;
      this.unreportedBytes += chunk.byteLength;
      if (this.unreportedBytes >= USAGE_REPORT_BYTES) this.flushUsage();
    } catch {
      this.closeUpstream();
    }
  }

  // ------------------------------------------------------------------
  // 補助
  // ------------------------------------------------------------------

  private stats(): LiveStats {
    return {
      utterances: this.lagSamples.length,
      finalizeMedianMs: median(this.finalizeSamples),
      lagMedianMs: median(this.lagSamples),
      audioSentMs: Math.round(this.sessionOffsetMs + pcmBytesToMs(this.sessionAudioBytes)),
    };
  }

  private roomInfo(): RoomInfo {
    return {
      roomId: this.getMeta("room_id") ?? "",
      title: this.getMeta("title") ?? "",
      live: this.wantLive,
      engine: this.getMeta("engine") ?? this.config.engine,
      useDictionary: (this.getMeta("use_dictionary") ?? "1") === "1",
      diarization: this.getMeta("diarization") === "1",
      recording: this.wantLive && this.config.archive,
    };
  }

  /** 字幕で強調表示する語（辞書を使っているときだけ）。 */
  private visibleTerms(): string[] {
    const useDictionary = (this.getMeta("use_dictionary") ?? "1") === "1";
    return useDictionary ? [...new Set(this.terms.map((t) => t.written.trim()).filter(Boolean))] : [];
  }

  private recentLines(limit: number): CaptionLine[] {
    return this.ctx.storage.sql
      .exec<CaptionRow>("SELECT * FROM captions ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .reverse()
      .map((r) => {
        const line = toCaptionLine(r);
        if (line.tokens) line.tokens = line.tokens.map(([w, c]) => [w, c]);
        return line;
      });
  }

  private archiveLines(talkId: number): CaptionLine[] {
    return this.ctx.storage.sql
      .exec<{ id: number; talk_id: number; text: string; start_ms: number; end_ms: number; speaker: number | null }>(
        "SELECT * FROM archive_captions WHERE talk_id = ? ORDER BY start_ms, id",
        talkId,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        talkId: r.talk_id,
        text: r.text,
        startMs: r.start_ms,
        endMs: r.end_ms,
        receivedAt: 0,
        speaker: r.speaker ?? undefined,
      }));
  }

  private talkRow(talkId: number): TalkRow | undefined {
    return this.ctx.storage.sql.exec<TalkRow>("SELECT * FROM talks WHERE id = ?", talkId).toArray()[0];
  }

  private hasReport(talkId: number): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM reports WHERE talk_id = ?", talkId).toArray().length > 0;
  }

  private talkSummaries(): TalkSummary[] {
    const reported = new Set(this.ctx.storage.sql.exec<{ talk_id: number }>("SELECT talk_id FROM reports").toArray().map((r) => r.talk_id));
    return this.ctx.storage.sql
      .exec<TalkRow>("SELECT * FROM talks ORDER BY id DESC LIMIT 50")
      .toArray()
      .map((r) => toTalkSummary(r, reported.has(r.id)));
  }

  /** 送った音声を使用量に数え、上限に達していたら配信を止める。 */
  private flushUsage(): void {
    const bytes = this.unreportedBytes;
    if (bytes === 0) return;
    this.unreportedBytes = 0;
    const engine = this.config.engine;
    this.ctx.waitUntil(
      (async () => {
        const status = await this.env.USAGE.getByName("global").add("websocket", engine, bytes / PCM_BYTES_PER_SECOND);
        this.usageStatus = status;
        this.sendToSpeaker({ type: "usage", usage: status });
        if (this.wantLive && status.remainingSeconds !== null && status.remainingSeconds <= 0) {
          this.sendToSpeaker({ type: "upstream", state: "error", message: usageLimitMessage(status, "配信を止めました") });
          this.stopLive();
        }
      })().catch((err) => console.error("使用量を記録できませんでした", errorMessage(err))),
    );
  }

  /** 使用量が変わったら、登壇者の画面の表示を更新する */
  private reportUsage(status: UsageStatus): void {
    this.usageStatus = status;
    this.sendToSpeaker({ type: "usage", usage: status });
  }

  private async refreshUsage(): Promise<void> {
    try {
      this.usageStatus = await this.env.USAGE.getByName("global").status();
      this.sendToSpeaker({ type: "usage", usage: this.usageStatus });
    } catch (err) {
      console.error("使用量を読めませんでした", errorMessage(err));
    }
  }

  private setTalkStatus(talkId: number, status: TalkStatus): void {
    this.ctx.storage.sql.exec("UPDATE talks SET status = ? WHERE id = ?", status, talkId);
  }

  private loadTerms(): DictionaryTerm[] {
    const raw = this.getMeta("dictionary");
    if (!raw) return [];
    try {
      return JSON.parse(raw) as DictionaryTerm[];
    } catch {
      return [];
    }
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // 切断済みの接続は webSocketClose で片付く
      }
    }
  }

  private sendToSpeaker(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets("speaker")) {
      try {
        ws.send(data);
      } catch {
        // 同上
      }
    }
  }

  private getMeta(key: string): string | null {
    const rows = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}

function toCaptionLine(r: CaptionRow): CaptionLine {
  return {
    id: r.id,
    talkId: r.talk_id,
    text: r.text,
    startMs: r.start_ms,
    endMs: r.end_ms,
    receivedAt: r.received_at,
    speaker: r.speaker ?? undefined,
    tokens: r.tokens ? (JSON.parse(r.tokens) as [string, number][]) : undefined,
  };
}

function toTalkSummary(r: TalkRow, reportReady: boolean): TalkSummary {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    audioMs: Math.round(pcmBytesToMs(r.audio_bytes)),
    archive: r.archive === 1,
    archiveReady: r.archive_state === "done",
    reportReady,
    error: r.error,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usageLimitMessage(status: UsageStatus, what: string): string {
  const hours = status.limitSeconds === null ? "" : `（${Math.round((status.limitSeconds / 3600) * 10) / 10} 時間）`;
  return `今月の AmiVoice の使用量が上限${hours}に達したため、${what}。上限は AMIVOICE_MONTHLY_LIMIT_HOURS で変えられます`;
}
