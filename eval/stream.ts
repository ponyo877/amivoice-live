// 音声ファイルを AmiVoice API の WebSocket に実時間で流し、届いたイベントを時刻付きで記録する。
// 字幕アプリと同じ条件（LSB16K・100ms ごとの送信）で、エンジン × 辞書 × 区切り方の設定を比べるためのもの。
//
//   AMIVOICE_API_KEY=... node eval/stream.ts --audio eval/data/rag.wav \
//     --engine=-a-general --dictionary eval/data/rag.slides.dict.json --baseline
//
// --engine と --dictionary は何度でも指定できる。辞書の種類は名前（<音声>.<種類>.dict.json）から取る。
// --baseline を付けると辞書なしも一緒に実行する。--matrix は ENGINES の全エンジン × （辞書なし＋指定した辞書）。
// --post-time 300,800,1200 を付けると、発話区間検出の postTime（無音がどれだけ続いたら発話の終わりとみなすか）を変えて実行する。
//   短いほど字幕の確定は早くなるが、文の途中の息継ぎで切れやすくなる。その兼ね合いを測るためのもの。
// --emphasis 0.3,0.8,1 を付けると、E2E エンジンの単語強調の強調度を変えて実行する（ハイブリッドエンジンでは無視）。
// --diarization で話者ダイアライゼーション（useDiarizer=1）を有効にする。
// --parallel 3 で 3 本ずつ同時に流す（結果は実時間で流したときと同じになる前提。遅延の比較には 1 を使う）。
// --dry-run で、実行する組み合わせと AmiVoice の使用量の見積もりだけを出す。
// --skip-existing で、確定結果の入った出力がすでにある組み合わせを飛ばす（途中で止まったバッチの続きを流すとき）。
// 接続に失敗した組み合わせや、途中で接続が切れた組み合わせは、少し待って 2 回までやり直す。それでも失敗したら残りを流してから終了コード 1 で終える。
// 実行のたびに eval/budget.ts の台帳に使用量を記録し、クーポンの範囲を超えるなら始めない。
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
import { fmt, isMockUrl, monthlyUsage, reserve } from "./budget.ts";
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
  /** 認識を始められた（s が成功した）直後、音声を送る前に呼ぶ。例外を投げたら送らずにやめる */
  onStarted?: () => void;
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
  let closed: { code: number; reason: string } | null = null;
  ws.onclose = (ev) => {
    closed = { code: ev.code, reason: ev.reason };
    failed(new Error(`接続が閉じられました（${ev.code}${ev.reason ? ` ${ev.reason}` : ""}）`));
    finished();
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("AmiVoice に接続できませんでした"));
  });
  ws.send(command); // API キーを含むので出力しない
  try {
    await startedP;
    opts.onStarted?.();
  } catch (err) {
    ws.close();
    throw err;
  }

  t0 = Date.now();
  for (let off = 0, i = 0; off < opts.pcm.length; off += CHUNK_BYTES, i++) {
    // 送っている途中で切れたら、残りを送っても届かないので失敗にする（無音のまま最後まで待たない）
    if (closed) throw new Error(`音声を送っている途中で接続が閉じられました（${(closed as { code: number }).code}、${((sentBytes / 32000)).toFixed(0)} 秒まで送信）`);
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

/** eval/data/rag.slides.dict.json → "slides"。名前から辞書の種類が分からなければ "dict"。 */
export function dictionaryLabel(path: string): string {
  return /\.([a-z0-9-]+)\.dict\.json$/i.exec(basename(path))?.[1] ?? "dict";
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      audio: { type: "string" },
      engine: { type: "string", multiple: true },
      dictionary: { type: "string", multiple: true },
      baseline: { type: "boolean", default: false },
      out: { type: "string" },
      matrix: { type: "boolean", default: false },
      speed: { type: "string", default: "1" },
      url: { type: "string" },
      "post-time": { type: "string" },
      emphasis: { type: "string" },
      diarization: { type: "boolean", default: false },
      parallel: { type: "string", default: "1" },
      "dry-run": { type: "boolean", default: false },
      "skip-existing": { type: "boolean", default: false },
    },
  });
  const apiKey = process.env.AMIVOICE_API_KEY;
  if (!apiKey && !values["dry-run"]) throw new Error("環境変数 AMIVOICE_API_KEY を設定してください");
  if (!values.audio) throw new Error("--audio を指定してください");

  const pcm = toPcm16k(values.audio);
  const audioSeconds = pcm.length / 32000;
  const dictionaries = (values.dictionary ?? []).map((path) => ({
    label: dictionaryLabel(path),
    terms: (JSON.parse(readFileSync(path, "utf8")) as { terms: DictionaryTerm[] }).terms,
  }));
  const speed = Number(values.speed);
  const stem = basename(values.audio).replace(/\.[^.]+$/, "");
  const outDir = join(dirname(values.audio), "..", "out");

  const list = (v: string | undefined) => (v ? v.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : [undefined]);
  const postTimes = list(values["post-time"]);
  const emphases = list(values.emphasis);
  const engines = values.engine?.length ? values.engine : values.matrix ? ENGINES.map((e) => e.id) : ["-a-general"];
  const dictRuns: ({ label: string; terms: DictionaryTerm[] } | null)[] =
    values.matrix || values.baseline || dictionaries.length === 0 ? [null, ...dictionaries] : dictionaries;

  interface Run {
    engine: string;
    dict: { label: string; terms: DictionaryTerm[] } | null;
    postTime?: number;
    emphasis?: number;
    out: string;
  }
  const runs: Run[] = [];
  for (const engine of engines) {
    for (const dict of dictRuns) {
      for (const postTime of postTimes) {
        // 強調度は E2E エンジンで辞書を使うときだけ意味がある
        const ems = dict && engineKind(engine) === "e2e" ? emphases : [undefined];
        for (const emphasis of ems) {
          const suffix = [postTime !== undefined ? `pt${postTime}` : "", emphasis !== undefined ? `em${emphasis}` : "", values.diarization ? "spk" : ""]
            .filter(Boolean)
            .join(".");
          const name = `${stem}.${engine.replace(/^-/, "")}.${dict?.label ?? "nodict"}${suffix ? `.${suffix}` : ""}.jsonl`;
          runs.push({ engine, dict, postTime, emphasis, out: join(outDir, name) });
        }
      }
    }
  }
  if (values.out && runs.length === 1) runs[0]!.out = values.out;

  const counted = !isMockUrl(values.url);
  if (values["skip-existing"]) {
    const done = runs.filter((run) => hasFinals(run.out));
    for (const run of done) runs.splice(runs.indexOf(run), 1);
    if (done.length) console.log(`確定結果のある ${done.length} 通りを飛ばします`);
  }
  console.log(
    `音声: ${values.audio}（${audioSeconds.toFixed(1)} 秒）× ${runs.length} 通り、${speed} 倍速、同時に ${values.parallel} 本` +
      (counted ? `。AmiVoice の使用量 ${fmt(audioSeconds * runs.length)}（この月の使用済み ${fmt(monthlyUsage().seconds)}）` : "（モックなので使用量に数えない）"),
  );
  if (values["dry-run"]) {
    for (const run of runs) console.log(`- ${run.out}`);
    return;
  }

  const describe = (run: Run) =>
    [run.engine, run.dict ? `辞書=${run.dict.label}` : "辞書なし", run.postTime !== undefined ? `postTime=${run.postTime}` : "", run.emphasis !== undefined ? `強調度=${run.emphasis}` : "", values.diarization ? "話者分離" : ""]
      .filter(Boolean)
      .join(" ");

  const queue = [...runs];
  const failures: string[] = [];
  const worker = async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      // 認識を始められなければ音声は送らない（課金されない）ので、始められてから記録する
      const onStarted = counted ? () => reserve({ api: "websocket", engine: run.engine, seconds: audioSeconds, label: `stream ${stem} ${describe(run)}` }) : undefined;
      const segmenter: Record<string, string | number> = {};
      if (run.postTime !== undefined) segmenter.postTime = run.postTime;
      if (values.diarization) segmenter.useDiarizer = 1;
      let result: Awaited<ReturnType<typeof streamOnce>> | null = null;
      for (let attempt = 1; attempt <= 3 && !result; attempt++) {
        try {
          result = await streamOnce({
            apiKey: apiKey!,
            url: values.url,
            pcm,
            engine: run.engine,
            terms: run.dict?.terms ?? null,
            speed,
            segmenter: Object.keys(segmenter).length ? segmenter : undefined,
            emphasis: run.emphasis,
            onStarted,
          });
          // 認識は始まったのに確定結果が 1 つも来ないのは、途中で通信が途絶えたとき
          if (!result.records.some((r) => r.raw.startsWith("A "))) {
            result = null;
            throw new Error("確定結果が 1 件も届きませんでした");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // 上限を超える・API キーが違うなどは、やり直しても通らない
          const retryable = attempt < 3 && !/^s: |超える/.test(message);
          console.error(`- ${describe(run)}: ${message}${retryable ? `（${attempt * 10} 秒後にやり直します）` : ""}`);
          if (!retryable) break;
          await new Promise((r) => setTimeout(r, attempt * 10_000));
        }
      }
      if (!result) {
        failures.push(describe(run));
        continue;
      }
      const { records, profileWordsCount } = result;
      mkdirSync(dirname(run.out), { recursive: true });
      const header = {
        engine: run.engine,
        dictionary: run.dict?.label ?? null,
        profileWordsCount,
        postTime: run.postTime ?? null,
        emphasis: run.emphasis ?? null,
        diarization: values.diarization,
        audio: values.audio,
        audioMs: audioSeconds * 1000,
        speed,
        at: new Date().toISOString(),
      };
      writeFileSync(run.out, [JSON.stringify(header), ...records.map((r) => JSON.stringify(r))].join("\n") + "\n");
      const finals = records.filter((r) => r.raw.startsWith("A ")).length;
      console.log(`- ${describe(run)}: 確定 ${finals} 件 → ${run.out}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, worker));
  if (failures.length) throw new Error(`${failures.length} 通りが失敗しました: ${failures.join("、")}`);
}

/** 出力があり、確定結果（A イベント）が 1 つ以上入っているか */
function hasFinals(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes('"raw":"A ');
  } catch {
    return false;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
