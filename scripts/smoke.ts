// ブラウザを使わずに、ルーム作成 → 辞書保存 → 音声送信 → 参加者への配信 → 字幕の書き出し
// → （録音したとき）終了後のアーカイブと振り返り までを通しで確かめる。
//
//   node scripts/smoke.ts --audio sample.wav [--base http://localhost:5173] [--engine -a-general] [--no-dictionary]
//                         [--dictionary eval/data/rag.slides.dict.json] [--title タイトル]
//                         [--diarization] [--no-archive] [--speed 1] [--mock]
//
// 音声は ffmpeg で 16kHz モノラル PCM に変換してから、実時間（--speed 倍）で流す。
// 本物の AmiVoice につないだアプリに流すときは、eval/budget.ts の台帳に使用量を記録する
// （ライブ + 録音から作り直す 2 本 + 感情分析）。モックにつないだアプリなら --mock を付けて記録しない。

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { reserve } from "../eval/budget.ts";

const { values } = parseArgs({
  options: {
    audio: { type: "string" },
    base: { type: "string", default: "http://localhost:5173" },
    engine: { type: "string", default: "-a-general" },
    "no-dictionary": { type: "boolean", default: false },
    diarization: { type: "boolean", default: false },
    "no-archive": { type: "boolean", default: false },
    speed: { type: "string", default: "1" },
    passphrase: { type: "string", default: "" },
    dictionary: { type: "string" },
    title: { type: "string", default: "スモークテスト" },
    mock: { type: "boolean", default: false },
  },
});

if (!values.audio) {
  console.error("--audio に音声ファイルを指定してください");
  process.exit(1);
}

const base = values.base!.replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");
const speed = Number(values.speed);

function toPcm(path: string): Buffer {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], {
    maxBuffer: 1024 * 1024 * 512,
  });
  if (r.status !== 0) throw new Error(`ffmpeg に失敗しました: ${r.stderr.toString()}`);
  return r.stdout;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(url: string, label: string, onMessage: (msg: { type: string; [k: string]: unknown }) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`${label}: 接続できませんでした`));
    ws.onmessage = (ev) => onMessage(JSON.parse(String(ev.data)));
  });
}

const pcm = toPcm(values.audio);
const audioSeconds = pcm.length / 32000;
console.log(`音声: ${audioSeconds.toFixed(1)} 秒`);
if (!values.mock) {
  const label = `smoke ${basename(values.audio)}`;
  reserve({ api: "websocket", engine: values.engine!, seconds: audioSeconds, label });
  if (!values["no-archive"]) {
    reserve({ api: "async", engine: "-a2b-ja-general", seconds: audioSeconds, label: `${label} アーカイブ` });
    reserve({ api: "async", engine: "-a-general", seconds: audioSeconds, sentiment: true, label: `${label} 振り返り` });
  }
}

// 1. ルームを作る
const created = (await (
  await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: values.title, passphrase: values.passphrase }),
  })
).json()) as { roomId?: string; token?: string; error?: string };
if (!created.roomId || !created.token) throw new Error(`ルームを作れませんでした: ${created.error}`);
const { roomId, token } = created;
console.log(`ルーム: ${roomId}  参加者用: ${base}/view.html?room=${roomId}`);

// 2. 辞書を保存する
const dict = await fetch(`${base}/api/rooms/${roomId}/dictionary`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    terms: values.dictionary ? (JSON.parse(readFileSync(values.dictionary, "utf8")) as { terms: unknown[] }).terms : [
      { written: "Durable Objects", readings: ["でゅらぶるおぶじぇくつ"] },
      { written: "WebSocket", readings: ["うぇぶそけっと"] },
      { written: "Hibernation", readings: ["はいばねーしょん"] },
      { written: "AmiVoice", readings: ["あみぼいす"] },
      { written: "profileWords", readings: ["ぷろふぁいるわーず"] },
    ],
  }),
});
console.log(`辞書: HTTP ${dict.status}`);

// 3. 参加者として接続し、届いたものを数える
let finals = 0;
let partials = 0;
const viewer = await open(`${wsBase}/api/rooms/${roomId}/ws?role=viewer`, "viewer", (msg) => {
  if (msg.type === "final") {
    finals++;
    const line = msg.line as { text: string; speaker?: number; tokens?: [string, number][] };
    const unsure = (line.tokens ?? []).filter(([, c]) => c < 0.5).map(([w]) => w);
    console.log(`  [字幕]${line.speaker !== undefined ? ` 話者${line.speaker + 1}:` : ""} ${line.text}${unsure.length ? `  （自信なし: ${unsure.join("、")}）` : ""}`);
  } else if (msg.type === "partial") {
    partials++;
  }
});

// 4. 登壇者として接続し、音声を流す
let ready = false;
const speaker = await open(`${wsBase}/api/rooms/${roomId}/ws?role=speaker&token=${token}`, "speaker", (msg) => {
  if (msg.type === "upstream") {
    console.log(`  [AmiVoice] ${msg.state}${msg.message ? `: ${msg.message}` : ""}`);
    if (msg.state === "open") ready = true;
  }
  if (msg.type === "stats") console.log(`  [計測] ${JSON.stringify(msg.stats)}`);
  if (msg.type === "talks") talks = msg.talks as typeof talks;
  if (msg.type === "usage") {
    const u = msg.usage as { seconds: number; limitSeconds: number | null; sentimentSeconds: number };
    console.log(`  [今月の使用量] ${Math.round(u.seconds)} 秒 / 上限 ${u.limitSeconds === null ? "なし" : `${u.limitSeconds} 秒`}（感情分析 ${Math.round(u.sentimentSeconds)} 秒）`);
  }
});
let talks: { id: number; status: string; error: string | null; reportReady: boolean }[] = [];
speaker.send(
  JSON.stringify({
    type: "start",
    engine: values.engine,
    useDictionary: !values["no-dictionary"],
    diarization: values.diarization,
    archive: !values["no-archive"],
  }),
);

const CHUNK = 3200; // 100ms
const t0 = Date.now();
for (let off = 0, i = 0; off < pcm.length; off += CHUNK, i++) {
  speaker.send(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
  const due = t0 + ((i + 1) * 100) / speed;
  await sleep(Math.max(0, due - Date.now()));
}
// 最後の発話を区切るため、少し無音を送ってから止める
for (let i = 0; i < 10; i++) {
  speaker.send(new Uint8Array(CHUNK));
  await sleep(100 / speed);
}
speaker.send(JSON.stringify({ type: "stop" }));
await sleep(3000);

// 5. 書き出し
const md = await (await fetch(`${base}/api/rooms/${roomId}/transcript?format=md`)).text();
console.log("\n--- Markdown ---\n" + md);
console.log(`AmiVoice 接続: ${ready ? "成功" : "失敗"}  途中結果: ${partials} 件  確定: ${finals} 件`);
viewer.close();

// 6. 終了後のアーカイブと振り返り（非同期 HTTP API）を待つ
let archiveOk = true;
if (!values["no-archive"]) {
  archiveOk = false;
  const deadline = Date.now() + 10 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const talk = talks[0];
    const state = talk ? `${talk.status}${talk.error ? ` (${talk.error})` : ""}` : "（登壇の記録なし）";
    if (state !== last) console.log(`  [アーカイブ] ${state}`);
    last = state;
    if (talk && ["done", "error", "no-audio"].includes(talk.status)) break;
    await sleep(1000);
  }
  const talk = talks[0];
  if (talk?.status === "done") {
    const detail = (await (await fetch(`${base}/api/rooms/${roomId}/talks/${talk.id}`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      archive: { text: string; speaker?: number }[];
      report: { charsPerMinute: number | null; fillers: { total: number; top: unknown[] }; sentiment: { keys: string[]; segments: unknown[] } | null; speakers: unknown[]; lowConfidence: unknown[]; liveVsArchive: { cer: number } | null } | null;
    };
    console.log("\n--- アーカイブ字幕 ---");
    for (const l of detail.archive) console.log(`  ${l.speaker !== undefined ? `話者${l.speaker + 1}: ` : ""}${l.text}`);
    const r = detail.report;
    if (r) {
      console.log("\n--- 振り返り ---");
      console.log(`  話す速さ: ${r.charsPerMinute} 文字/分`);
      console.log(`  フィラー: ${r.fillers.total} 回 ${JSON.stringify(r.fillers.top)}`);
      console.log(`  感情分析: ${r.sentiment ? `${r.sentiment.keys.length} 項目 × ${r.sentiment.segments.length} 区間` : "なし"}`);
      console.log(`  話者: ${JSON.stringify(r.speakers)}`);
      console.log(`  自信のない語: ${r.lowConfidence.length} 件`);
      console.log(`  ライブとアーカイブの食い違い: ${r.liveVsArchive ? `${(r.liveVsArchive.cer * 100).toFixed(1)}%` : "–"}`);
    }
    console.log(`\n振り返り: ${base}/report.html#room=${roomId}&talk=${talk.id}&token=${token}`);
    archiveOk = detail.archive.length > 0 && r !== null;
  }
}
speaker.close();
process.exit(ready && finals > 0 && archiveOk ? 0 : 1);
