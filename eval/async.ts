// 音声ファイルを AmiVoice の非同期 HTTP API（v2）で認識し、結果を保存する。
// 終了後に作るアーカイブ字幕と同じ条件で、ライブ（WebSocket）とどれだけ精度が違うかを score.ts で比べるためのもの。
//
//   AMIVOICE_API_KEY=... node eval/async.ts --audio eval/data/rag.wav \
//     --engine=-a2b-ja-general --dictionary eval/data/rag.slides.dict.json --baseline --diarization
//
// --engine と --dictionary は何度でも指定できる（stream.ts と同じ）。--matrix はバッチ用 E2E とハイブリッド × （辞書なし＋指定した辞書）。
// --sentiment で感情分析、--filler でフィラーを残す（ハイブリッドエンジンのみ）。
// 実行のたびに eval/budget.ts の台帳に使用量を記録し、クーポンの範囲を超えるなら始めない。
// 出力は eval/out/<音声>.<エンジン>.<辞書>[.spk][.sa][.filler].async.json（{ header, result }）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { buildProfileWords, engineKind, type DictionaryTerm } from "../src/shared/amivoice.ts";
import { buildDParam, wavHeader } from "../src/shared/async-request.ts";
import type { AsyncJobResult } from "../src/shared/async-result.ts";
import { fmt, isMockUrl, monthlyUsage, reserve } from "./budget.ts";
import { toPcm16k } from "./lib.ts";
import { dictionaryLabel } from "./stream.ts";

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
      engine: { type: "string", multiple: true },
      dictionary: { type: "string", multiple: true },
      baseline: { type: "boolean", default: false },
      diarization: { type: "boolean", default: false },
      sentiment: { type: "boolean", default: false },
      filler: { type: "boolean", default: false },
      matrix: { type: "boolean", default: false },
      parallel: { type: "string", default: "4" },
      url: { type: "string" },
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
  const stem = basename(values.audio).replace(/\.[^.]+$/, "");
  const outDir = join(dirname(values.audio), "..", "out");
  const engines = values.engine?.length ? values.engine : values.matrix ? ["-a2b-ja-general", "-a-general"] : ["-a2b-ja-general"];
  const dictRuns = values.matrix || values.baseline || dictionaries.length === 0 ? [null, ...dictionaries] : dictionaries;
  const extra: Record<string, string> = {};
  if (values.sentiment) extra.sentimentAnalysis = "True";
  if (values.filler) extra.keepFillerToken = "1";
  const suffix = [values.diarization ? "spk" : "", values.sentiment ? "sa" : "", values.filler ? "filler" : ""].filter(Boolean).join(".");
  const outPath = (engine: string, dict: { label: string } | null) =>
    join(outDir, `${stem}.${engine.replace(/^-/, "")}.${dict?.label ?? "nodict"}${suffix ? `.${suffix}` : ""}.async.json`);
  const runs = engines
    .flatMap((engine) => dictRuns.map((dict) => ({ engine, dict, out: outPath(engine, dict) })))
    // --skip-existing: 結果がすでにある組み合わせは飛ばす（途中で止まったバッチの続きを流すとき）
    .filter((run) => !(values["skip-existing"] && existsSync(run.out)));

  const counted = !isMockUrl(values.url);
  console.log(
    `音声: ${values.audio}（${audioSeconds.toFixed(1)} 秒）× ${runs.length} 通り（非同期 HTTP API）` +
      (counted ? `。AmiVoice の使用量 ${fmt(audioSeconds * runs.length)}（この月の使用済み ${fmt(monthlyUsage().seconds)}）` : "（モックなので使用量に数えない）"),
  );
  if (values["dry-run"]) return;

  const queue = [...runs];
  const failures: string[] = [];
  const worker = async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      const label = `${run.engine} ${run.dict ? `辞書=${run.dict.label}` : "辞書なし"}${suffix ? ` ${suffix}` : ""}`;
      if (counted) reserve({ api: "async", engine: run.engine, seconds: audioSeconds, sentiment: values.sentiment, label: `async ${stem} ${label}` });
      let done: Awaited<ReturnType<typeof recognizeAsync>>;
      try {
        done = await recognizeAsync({
          apiKey: apiKey!,
          url: values.url,
          pcm,
          engine: run.engine,
          terms: run.dict?.terms ?? null,
          diarization: values.diarization,
          extra,
        });
      } catch (err) {
        // 1 つ失敗しても残りは流す（台帳には記録済みなので、やり直すときは --skip-existing で続きから）
        console.error(`- ${label}: ${err instanceof Error ? err.message : err}`);
        failures.push(label);
        continue;
      }
      const { result, elapsedMs } = done;
      const out = run.out;
      mkdirSync(dirname(out), { recursive: true });
      const header = {
        kind: "async",
        engine: run.engine,
        dictionary: run.dict?.label ?? null,
        diarization: values.diarization,
        sentiment: values.sentiment,
        filler: values.filler,
        audio: values.audio,
        audioMs: audioSeconds * 1000,
        elapsedMs,
        at: new Date().toISOString(),
      };
      writeFileSync(out, JSON.stringify({ header, result }, null, 1));
      console.log(`- ${label}: ${(elapsedMs / 1000).toFixed(0)} 秒で完了 → ${out}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, worker));
  if (failures.length) throw new Error(`${failures.length} 通りが失敗しました: ${failures.join("、")}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
