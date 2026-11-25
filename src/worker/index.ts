// HTTP の入口。静的ファイル（index.html など）は Workers Static Assets が返し、/api/* だけをここで扱う。

import { normalizeTerms, extractTerms, suggestTerms } from "./terms.ts";
import type { DictionaryTerm } from "../shared/amivoice.ts";
import type { CaptionLine } from "../shared/protocol.ts";
import { wavHeader } from "../shared/async-request.ts";

export { Room } from "./room.ts";

const MAX_PDF_BYTES = 30 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/rooms" && request.method === "POST") return await createRoom(request, env, url);

      const m = url.pathname.match(/^\/api\/rooms\/([a-z0-9]{6,32})(\/.*)?$/);
      if (m) return await roomRoute(request, env, m[1]!, m[2] ?? "", url);

      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err instanceof Error ? err.message : "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env, url: URL): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { title?: string; passphrase?: string };
  // 公開環境では誰でもルームを作れると API 利用料がかかるので、合言葉を必須にする。
  // ADMIN_PASSPHRASE が未設定なら、ローカル開発（localhost）からだけ作れる。
  if (env.ADMIN_PASSPHRASE) {
    if (body.passphrase !== env.ADMIN_PASSPHRASE) return json({ error: "合言葉が違います" }, 403);
  } else if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
    return json({ error: "ADMIN_PASSPHRASE が設定されていません" }, 403);
  }
  const title = (body.title ?? "").trim().slice(0, 100) || "無題の勉強会";
  const roomId = randomId(10);
  const token = randomHex(32);
  await env.ROOM.getByName(roomId).init(roomId, title, await sha256(token));
  return json({ roomId, token });
}

async function roomRoute(request: Request, env: Env, roomId: string, sub: string, url: URL): Promise<Response> {
  const stub = env.ROOM.getByName(roomId);
  if (!(await stub.exists())) return json({ error: "ルームが見つかりません" }, 404);

  if (sub === "/ws") {
    const role = url.searchParams.get("role") === "speaker" ? "speaker" : "viewer";
    const headers = new Headers(request.headers);
    headers.delete("x-speaker-verified");
    if (role === "speaker") {
      // ブラウザの WebSocket はヘッダを付けられないので、登壇者トークンはクエリで受け取る
      const token = url.searchParams.get("token") ?? "";
      if (!(await stub.verifyToken(await sha256(token)))) return json({ error: "forbidden" }, 403);
      headers.set("x-speaker-verified", "1");
    }
    return stub.fetch(new Request(request.url, { method: request.method, headers }));
  }

  if (sub === "/transcript" && request.method === "GET") {
    // ?talk=<id> でその登壇だけ、&source=archive で終了後に作った高精度の字幕を返す
    const talkParam = url.searchParams.get("talk");
    const talkId = talkParam && /^\d+$/.test(talkParam) ? Number(talkParam) : undefined;
    const archive = url.searchParams.get("source") === "archive";
    if (archive && talkId === undefined) return json({ error: "talk を指定してください" }, 400);
    const { title, lines } = archive ? await stub.getArchiveLines(talkId!) : await stub.getLines(talkId);
    // RPC を通すとタプル型が配列型になるので、元の型に戻す
    return transcriptResponse(title, lines as CaptionLine[], url.searchParams.get("format") ?? "md");
  }

  // ここから先は登壇者だけが使える操作
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await stub.verifyToken(await sha256(token)))) return json({ error: "forbidden" }, 403);

  if (sub === "/dictionary" && request.method === "GET") {
    return json({ terms: await stub.getDictionary() });
  }
  if (sub === "/dictionary" && request.method === "PUT") {
    const body = (await request.json()) as { terms?: DictionaryTerm[] };
    const terms = normalizeTerms(Array.isArray(body.terms) ? body.terms : []);
    await stub.setDictionary(terms);
    return json({ terms });
  }
  if (sub === "/dictionary/extract" && request.method === "POST") {
    if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY が設定されていません" }, 500);
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("application/pdf")) {
      const data = new Uint8Array(await request.arrayBuffer());
      if (data.byteLength > MAX_PDF_BYTES) return json({ error: "PDF は 30MB までです" }, 413);
      return json({ terms: await extractTerms(env.ANTHROPIC_API_KEY, { kind: "pdf", data }) });
    }
    const text = (await request.text()).slice(0, 200_000);
    if (!text.trim()) return json({ error: "資料が空です" }, 400);
    return json({ terms: await extractTerms(env.ANTHROPIC_API_KEY, { kind: "text", text }) });
  }

  // 登壇（配信の開始から停止まで）ごとのアーカイブと振り返り
  if (sub === "/talks" && request.method === "GET") {
    return json({ talks: await stub.listTalks() });
  }
  const t = sub.match(/^\/talks\/(\d+)(\/[a-z]+)?$/);
  if (t) {
    const talkId = Number(t[1]);
    const action = t[2] ?? "";
    if (action === "" && request.method === "GET") {
      const detail = await stub.getTalk(talkId);
      return detail ? json(detail) : json({ error: "登壇が見つかりません" }, 404);
    }
    if (action === "/audio" && request.method === "GET") {
      // 振り返りの画面で聞き返せるよう、録音（ヘッダなし PCM）に WAV ヘッダを付けて返す
      const key = await stub.recordingKey(talkId);
      const obj = key ? await env.RECORDINGS.get(key) : null;
      if (!obj) return json({ error: "録音がありません" }, 404);
      const header = wavHeader(obj.size);
      const { readable, writable } = new FixedLengthStream(header.byteLength + obj.size);
      void (async () => {
        const w = writable.getWriter();
        await w.write(header);
        w.releaseLock();
        await obj.body.pipeTo(writable);
      })();
      return new Response(readable, { headers: { "content-type": "audio/wav", "cache-control": "private, no-store" } });
    }
    if (action === "/retry" && request.method === "POST") {
      await stub.retryArchive(talkId);
      return json({ ok: true });
    }
    if (action === "/recording" && request.method === "DELETE") {
      await stub.deleteRecording(talkId);
      return json({ ok: true });
    }
    if (action === "/suggestions" && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY が設定されていません" }, 500);
      const input = await stub.suggestionInput(talkId);
      if (!input) return json({ error: "この登壇には字幕がありません" }, 400);
      return json({ suggestions: await suggestTerms(env.ANTHROPIC_API_KEY, input.transcript, input.dictionary) });
    }
  }

  return json({ error: "not found" }, 404);
}

/** 話者の番号を表示名にする（0 → 話者1）。 */
function speakerName(speaker: number): string {
  return `話者${speaker + 1}`;
}

function transcriptResponse(title: string, lines: CaptionLine[], format: string): Response {
  if (format === "json") return json({ title, lines });
  if (format === "vtt") {
    // 話者は WebVTT の voice タグ（<v 名前>）で表す
    const cues = lines.map((l, i) => {
      const text = l.speaker === undefined ? escapeVtt(l.text) : `<v ${speakerName(l.speaker)}>${escapeVtt(l.text)}`;
      return `${i + 1}\n${vttTime(l.startMs)} --> ${vttTime(Math.max(l.endMs, l.startMs + 1))}\n${text}\n`;
    });
    return new Response(["WEBVTT", "", ...cues].join("\n"), { headers: { "content-type": "text/vtt; charset=utf-8" } });
  }
  // Markdown は話者が替わったところにだけ名前を出す
  const body: string[] = [`# ${title}`, ""];
  let prev: number | undefined;
  for (const l of lines) {
    const who = l.speaker !== undefined && l.speaker !== prev ? `**${speakerName(l.speaker)}** ` : "";
    body.push(`- [${clock(l.startMs)}] ${who}${l.text}`);
    prev = l.speaker;
  }
  body.push("");
  return new Response(body.join("\n"), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}

function escapeVtt(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "--&gt;");
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function randomId(length: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // 読み間違えやすい文字を除いた 32 文字
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function vttTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = Math.floor(ms % 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(milli).padStart(3, "0")}`;
}

function clock(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(m)}:${pad(s)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
