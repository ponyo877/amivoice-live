// 音声ファイルを AmiVoice API の WebSocket に実時間で流し、届いたイベントを時刻付きで記録する。
// 字幕アプリと同じ条件（LSB16K・100ms ごとの送信）で、エンジン × 辞書の有無を比べるためのもの。
//
//   AMIVOICE_API_KEY=... node eval/stream.ts --audio eval/data/talk1.wav \
//     --engine -a-general --dictionary eval/data/talk1.dict.json --out eval/out/talk1.general.dict.jsonl
//
// --matrix を付けると、ENGINES の全エンジン × 辞書あり/なし を順に実行する。
// --post-time 300,550,800 を付けると、発話区間検出の postTime（無音がどれだけ続いたら発話の終わりとみなすか）を変えて順に実行する。
//   短いほど字幕の確定は早くなるが、文の途中の息継ぎで切れやすくなる。その兼ね合いを測るためのもの。
// --emphasis 0.5,0.8,1 を付けると、E2E エンジンの単語強調の強調度を変えて順に実行する（ハイブリッドエンジンでは無視）。
// 出力（JSONL）の 1 行目は設定、以降は {t: 経過ミリ秒, audioMs: 送信済み音声ミリ秒, raw: イベント} 。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  buildAudioPacket,
  buildProfileWords,
  buildStartCommand,
  engineKind,
  ENGINES,
  parseServerEvent,
  type DictionaryTerm,
} from "../src/shared/amivoice.ts";
import { toPcm16k } from "./lib.ts";

const DEFAULT_URL = "wss://acp-api.amivoice.com/v1/nolog/";
const CHUNK_BYTES = 3200; // 100ms

export interface StreamOptions {
  apiKey: string;
  url?: string;
  pcm: Buffer;
  engine: string;
  terms: DictionaryTerm[] | null;
  speed?: number;
  segmenter?: Record<string, string | number>;
  /** E2E エンジンの単語強調の強調度（0〜1） */
  emphasis?: number;
}

export interface StreamRecord {
  t: number;
  audioMs: number;
  raw: string;
}

export async function streamOnce(opts: StreamOptions): Promise<{ records: StreamRecord[]; profileWordsCount: number }> {
  const speed = opts.speed ?? 1;
  const profileWords = opts.terms ? buildProfileWords(opts.terms, engineKind(opts.engine), { emphasis: opts.emphasis }) : "";
  const command = buildStartCommand({
    engine: opts.engine,
    authorization: opts.apiKey,
    profileWords: profileWords || undefined,
    resultUpdatedInterval: 200,
    segmenter: opts.segmenter,
  });

  const ws = new WebSocket(opts.url ?? DEFAULT_URL);
  ws.binaryType = "arraybuffer";
  const records: StreamRecord[] = [];
  let t0 = 0;
  let sentBytes = 0;
  let started!: () => void;
  let failed!: (err: Error) => void;
  const startedP = new Promise<void>((res, rej) => {
    started = res;
    failed = rej;
  });
  let finished!: () => void;
  const finishedP = new Promise<void>((res) => (finished = res));

  ws.onmessage = (ev) => {
    const raw = String(ev.data);
    records.push({ t: t0 ? Date.now() - t0 : 0, audioMs: (sentBytes / 32000) * 1000, raw });
    const e = parseServerEvent(raw);
    if (e.kind === "s") e.error ? failed(new Error(`s: ${e.error}`)) : started();
    if (e.kind === "p") console.error(`  p: ${e.error}`);
    if (e.kind === "e") finished();
  };
  ws.onclose = () => {
    failed(new Error("接続が閉じられました"));
    finished();
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("AmiVoice に接続できませんでした"));
  });
  ws.send(command); // API キーを含むので出力しない
  await startedP;

  t0 = Date.now();
  for (let off = 0, i = 0; off < opts.pcm.length; off += CHUNK_BYTES, i++) {
    const chunk = opts.pcm.subarray(off, Math.min(off + CHUNK_BYTES, opts.pcm.length));
    ws.send(buildAudioPacket(chunk));
    sentBytes += chunk.length;
    const due = t0 + ((i + 1) * 100) / speed;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  ws.send("e");
  await Promise.race([finishedP, new Promise((r) => setTimeout(r, 30_000))]);
  ws.close();
  return { records, profileWordsCount: profileWords ? profileWords.split("|").length : 0 };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      audio: { type: "string" },
      engine: { type: "string", default: "-a-general" },
      dictionary: { type: "string" },
      out: { type: "string" },
      matrix: { type: "boolean", default: false },
      speed: { type: "string", default: "1" },
      url: { type: "string" },
      "post-time": { type: "string" },
      emphasis: { type: "string" },
    },
  });
  const apiKey = process.env.AMIVOICE_API_KEY;
  if (!apiKey) throw new Error("環境変数 AMIVOICE_API_KEY を設定してください");
  if (!values.audio) throw new Error("--audio を指定してください");

  const pcm = toPcm16k(values.audio);
  const terms = values.dictionary ? (JSON.parse(readFileSync(values.dictionary, "utf8")) as { terms: DictionaryTerm[] }).terms : null;
  const speed = Number(values.speed);
  const stem = basename(values.audio).replace(/\.[^.]+$/, "");
  const outDir = join(dirname(values.audio), "..", "out");

  const list = (v: string | undefined) => (v ? v.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : [undefined]);
  const postTimes = list(values["post-time"]);
  const emphases = list(values.emphasis);

  interface Run {
    engine: string;
    terms: DictionaryTerm[] | null;
    postTime?: number;
    emphasis?: number;
    out: string;
  }
  const base: Omit<Run, "out" | "postTime" | "emphasis">[] = values.matrix
    ? ENGINES.flatMap((e) => [{ engine: e.id, terms: null }, ...(terms ? [{ engine: e.id, terms }] : [])])
    : [{ engine: values.engine!, terms }];
  const runs: Run[] = [];
  for (const b of base) {
    for (const postTime of postTimes) {
      // 強調度は E2E エンジンで辞書を使うときだけ意味がある
      const ems = b.terms && engineKind(b.engine) === "e2e" ? emphases : [undefined];
      for (const emphasis of ems) {
        const suffix = [postTime !== undefined ? `pt${postTime}` : "", emphasis !== undefined ? `em${emphasis}` : ""].filter(Boolean).join(".");
        const name = `${stem}.${b.engine.replace(/^-/, "")}.${b.terms ? "dict" : "nodict"}${suffix ? `.${suffix}` : ""}.jsonl`;
        runs.push({ ...b, postTime, emphasis, out: !values.matrix && values.out && runs.length === 0 && postTimes.length === 1 && emphases.length === 1 ? values.out : join(outDir, name) });
      }
    }
  }

  console.log(`音声: ${values.audio}（${(pcm.length / 32000).toFixed(1)} 秒）× ${runs.length} 通り、${speed} 倍速`);
  for (const run of runs) {
    const cond = [run.postTime !== undefined ? `postTime=${run.postTime}` : "", run.emphasis !== undefined ? `強調度=${run.emphasis}` : ""].filter(Boolean).join(" ");
    process.stdout.write(`- ${run.engine} 辞書${run.terms ? "あり" : "なし"}${cond ? ` ${cond}` : ""} … `);
    const { records, profileWordsCount } = await streamOnce({
      apiKey,
      url: values.url,
      pcm,
      engine: run.engine,
      terms: run.terms,
      speed,
      segmenter: run.postTime !== undefined ? { postTime: run.postTime } : undefined,
      emphasis: run.emphasis,
    });
    mkdirSync(dirname(run.out), { recursive: true });
    const header = {
      engine: run.engine,
      dictionary: run.terms !== null,
      profileWordsCount,
      postTime: run.postTime ?? null,
      emphasis: run.emphasis ?? null,
      audio: values.audio,
      audioMs: (pcm.length / 32000) * 1000,
      speed,
      at: new Date().toISOString(),
    };
    writeFileSync(run.out, [JSON.stringify(header), ...records.map((r) => JSON.stringify(r))].join("\n") + "\n");
    const finals = records.filter((r) => r.raw.startsWith("A ")).length;
    console.log(`確定 ${finals} 件 → ${run.out}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
