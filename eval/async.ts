// 音声ファイルを AmiVoice の非同期 HTTP API（v2）で認識し、結果を保存する。
// 終了後に作るアーカイブ字幕と同じ条件で、ライブ（WebSocket）とどれだけ精度が違うかを score.ts で比べるためのもの。
//
//   AMIVOICE_API_KEY=... node eval/async.ts --audio eval/data/talk1.wav \
//     [--engine -a2b-ja-general] [--dictionary eval/data/talk1.dict.json] [--diarization] [--url http://localhost:9900/v2/recognitions]
//
// --matrix を付けると、バッチ用 E2E（-a2b-ja-general）とハイブリッド（-a-general）× 辞書あり/なし を順に実行する。
// 出力は eval/out/<音声>.<エンジン>.<dict|nodict>.async.json（{ header, result }）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { buildProfileWords, engineKind, type DictionaryTerm } from "../src/shared/amivoice.ts";
import { buildDParam, wavHeader } from "../src/shared/async-request.ts";
import type { AsyncJobResult } from "../src/shared/async-result.ts";
import { toPcm16k } from "./lib.ts";

const DEFAULT_URL = "https://acp-api-async.amivoice.com/v2/recognitions";
const POLL_MS = 10_000;

export async function recognizeAsync(opts: {
  apiKey: string;
  url?: string;
  pcm: Buffer;
  engine: string;
  terms: DictionaryTerm[] | null;
  diarization?: boolean;
  extra?: Record<string, string>;
}): Promise<{ result: AsyncJobResult; elapsedMs: number }> {
  const url = opts.url ?? DEFAULT_URL;
  const auth = { authorization: `Bearer ${opts.apiKey}` };
  const d = buildDParam({
    grammarFileNames: opts.engine,
    loggingOptOut: "True",
    profileWords: opts.terms ? buildProfileWords(opts.terms, engineKind(opts.engine)) || undefined : undefined,
    speakerDiarization: opts.diarization ? "True" : undefined,
    ...opts.extra,
  });
  const form = new FormData();
  form.append("d", d);
  const wav = new Uint8Array(44 + opts.pcm.length);
  wav.set(wavHeader(opts.pcm.length), 0);
  wav.set(opts.pcm, 44);
  form.append("a", new Blob([wav], { type: "audio/wav" }), "audio.wav");

  const t0 = Date.now();
  const res = await fetch(url, { method: "POST", headers: auth, body: form });
  const created = (await res.json().catch(() => ({}))) as { sessionid?: string; code?: string; message?: string };
  if (!res.ok || !created.sessionid) throw new Error(`ジョブを作れませんでした（HTTP ${res.status} ${created.code ?? ""} ${created.message ?? ""}）`);

  for (;;) {
    await new Promise((r) => setTimeout(r, url.startsWith("http://localhost") ? 1000 : POLL_MS));
    const job = (await (await fetch(`${url}/${created.sessionid}`, { headers: auth })).json()) as AsyncJobResult;
    if (job.status === "completed") return { result: job, elapsedMs: Date.now() - t0 };
    if (job.status === "error") throw new Error(`認識に失敗しました: ${job.error_message ?? "不明なエラー"}`);
    process.stdout.write(".");
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      audio: { type: "string" },
      engine: { type: "string", default: "-a2b-ja-general" },
      dictionary: { type: "string" },
      diarization: { type: "boolean", default: false },
      matrix: { type: "boolean", default: false },
      url: { type: "string" },
    },
  });
  const apiKey = process.env.AMIVOICE_API_KEY;
  if (!apiKey) throw new Error("環境変数 AMIVOICE_API_KEY を設定してください");
  if (!values.audio) throw new Error("--audio を指定してください");

  const pcm = toPcm16k(values.audio);
  const terms = values.dictionary ? (JSON.parse(readFileSync(values.dictionary, "utf8")) as { terms: DictionaryTerm[] }).terms : null;
  const stem = basename(values.audio).replace(/\.[^.]+$/, "");
  const outDir = join(dirname(values.audio), "..", "out");
  const engines = values.matrix ? ["-a2b-ja-general", "-a-general"] : [values.engine!];
  const runs = engines.flatMap((engine) => (values.matrix && terms ? [null, terms] : [terms]).map((t) => ({ engine, terms: t })));

  console.log(`音声: ${values.audio}（${(pcm.length / 32000).toFixed(1)} 秒）× ${runs.length} 通り（非同期 HTTP API）`);
  for (const run of runs) {
    process.stdout.write(`- ${run.engine} 辞書${run.terms ? "あり" : "なし"} `);
    const { result, elapsedMs } = await recognizeAsync({ apiKey, url: values.url, pcm, engine: run.engine, terms: run.terms, diarization: values.diarization });
    const out = join(outDir, `${stem}.${run.engine.replace(/^-/, "")}.${run.terms ? "dict" : "nodict"}.async.json`);
    mkdirSync(dirname(out), { recursive: true });
    const header = {
      kind: "async",
      engine: run.engine,
      dictionary: run.terms !== null,
      diarization: values.diarization,
      audio: values.audio,
      audioMs: (pcm.length / 32000) * 1000,
      elapsedMs,
      at: new Date().toISOString(),
    };
    writeFileSync(out, JSON.stringify({ header, result }, null, 1));
    console.log(` ${(elapsedMs / 1000).toFixed(0)} 秒で完了 → ${out}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
