// 模擬 LT の台本（script.txt）とスライド（slides.txt）から、評価に使う素材を作る。
// 正解（書き起こし・話者・フィラー・用語）が分かっている音声を、ローカルで動くモデルだけで誰でも作り直せるようにするためのもの。
//
//   node eval/corpus/build.ts                 # eval/corpus/ の下の全部
//   node eval/corpus/build.ts workers         # 1 本だけ
//   node eval/corpus/build.ts --tts say       # Irodori-TTS の代わりに macOS の say で読み上げる（手早く試すとき）
//
// 読み上げ: Irodori-TTS（Aratako/Irodori-TTS-v4.1-Small）。話者ごとに、台本の「# voice A: …」の説明（VoiceDesign）から
//   参照音声を 1 本作り、以後の文はその参照音声と説明の両方を条件にして合成する（話者の声を通しでそろえるため）。
//   1 文ずつ合成し、文の間・段落の間・話者の交代の間を決まった長さの無音でつなぐ。
// 会場の音: Sony AI の Woosh（Woosh-Flow）で、空調と客席の気配の環境音、拍手、咳、椅子のきしみを作って重ねる。
// 合成した音は eval/data/.cache/ に（文・声の説明・seed のハッシュで）残すので、台本を直したときは変わった文だけを作り直す。
//
// 出力（eval/data/）:
//   <id>.wav              静かな部屋で、口元のマイクで録った想定の音声（16kHz・16bit・モノラル）
//   <id>.venue.wav        会場の想定。帯域を狭めて残響を足し、環境音（音声全体の RMS から 15dB 下）・拍手・咳などを重ねる
//   <id>.ref.txt          正解の書き起こし（フィラーなし、表記はスライドと同じ綴り）
//   <id>.truth.json       話者の区間、フィラーの数、用語、話す速さ
//   <id>.oracle.dict.json 台本の読みをそのまま入れた辞書（スライドから作った辞書と比べる上限の目安）
//   <id>.slides.pdf       スライド（Claude が辞書を作るときの入力）
//
// 必要なもの: sox、Google Chrome（スライドの PDF 化）、uv、
//   Irodori-TTS（環境変数 IRODORI_TTS_DIR に clone して uv sync した場所）、Woosh（WOOSH_DIR に clone し、重みを checkpoints/ に置いた場所）

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { normalizeReading, type DictionaryTerm } from "../../src/shared/amivoice.ts";
import { normalize } from "../../src/shared/metrics.ts";

const CORPUS = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(CORPUS, "..", "data");
const CACHE = join(OUT, ".cache");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const IRODORI_CHECKPOINT = "Aratako/Irodori-TTS-v4.1-Small";
/** 合成の方式が変わったらキャッシュを作り直すための印（lc: Irodori-TTS の length check を使う） */
const IRODORI_MODE = "lc";
const LEAD_S = 0.8;
const SENTENCE_PAUSE_S = 0.3;
const PARAGRAPH_PAUSE_S = 0.8;
const TURN_GAP_S = 1.0;
/** 登壇が終わってから質疑に移るまでと、最後の拍手の長さ（静かな版では無音、会場の版では拍手） */
const APPLAUSE_S = 4.0;
const SAY_PARAGRAPH_PAUSE_MS = 500;
const VENUE_SNR_DB = 15;
/** 参照音声に読ませる文（話者の声を決めるためだけに使い、LT の音声には入れない） */
const REFERENCE_TEXT = "こんにちは。今日は、最近の開発で分かったことを、短くお話しします。よろしくお願いします。";

interface Turn {
  speaker: string;
  paragraphs: string[];
}

interface Script {
  title: string;
  /** macOS の say の声と速さ（--tts say） */
  voices: Record<string, { voice: string; rate: number }>;
  /** Irodori-TTS の声の説明（VoiceDesign のキャプション） */
  captions: Record<string, string>;
  turns: Turn[];
}

const TERM = /\{([^|}]+)\|([^}]+)\}/g;
const FILLER = /\(([^)]+)\)/g;

export function parseScript(text: string): Script {
  let title = "";
  const voices: Script["voices"] = {};
  const captions: Script["captions"] = {};
  const turns: Turn[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length && turns.length) turns.at(-1)!.paragraphs.push(paragraph.join(""));
    paragraph = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      const caption = /^#\s*voice\s+([A-Z]):\s*(.+)$/.exec(line);
      const m = /^#\s*(title|[A-Z]):\s*(.+)$/.exec(line);
      if (caption) captions[caption[1]!] = caption[2]!.trim();
      else if (m?.[1] === "title") title = m[2]!.trim();
      else if (m) {
        const [voice, rate] = m[2]!.trim().split(/\s+/);
        voices[m[1]!] = { voice: voice!, rate: Number(rate ?? 200) };
      }
      continue;
    }
    const speaker = /^\[([A-Z])\]$/.exec(line);
    if (speaker) {
      flush();
      turns.push({ speaker: speaker[1]!, paragraphs: [] });
      continue;
    }
    if (line === "") flush();
    else paragraph.push(line);
  }
  flush();
  return { title, voices, captions, turns };
}

/** 読み上げに渡す文。{表記|読み} は読みに、(えー) はフィラーとして読む。 */
export const spoken = (p: string) => p.replace(TERM, "$2").replace(FILLER, "$1");
/** 正解の書き起こし。{表記|読み} は表記に、フィラーは後ろの読点ごと取り除く。 */
export const written = (p: string) => p.replace(TERM, "$1").replace(/\([^)]+\)、?/g, "");
/** 段落を文に分ける（。！？ の後ろで切る。{表記|読み} の中には句点がない前提） */
export const sentences = (p: string) => (p.match(/[^。！？]+[。！？]?/g) ?? []).map((x) => x.trim()).filter(Boolean);

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; inherit?: boolean } = {}): string {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: opts.env ?? process.env,
    stdio: opts.inherit ? ["ignore", "inherit", "pipe"] : "pipe",
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} … に失敗しました: ${r.stderr?.slice(-2000)}`);
  return (r.stdout ?? "") + (r.stderr ?? "");
}

const duration = (path: string) => Number(run("soxi", ["-D", path]).trim());
const rms = (path: string) => Number(/RMS\s+amplitude:\s+([\d.]+)/.exec(run("sox", [path, "-n", "stat"]))![1]);
const silence = (path: string, seconds: number) => run("sox", ["-n", "-r", "16000", "-c", "1", "-b", "16", path, "trim", "0", String(seconds)]);
const hash = (...parts: (string | number)[]) => createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
const seedOf = (...parts: (string | number)[]) => parseInt(hash(...parts).slice(0, 7), 16);
/** 読み上げた 1 区切り（Irodori は 1 文、say は 1 ターン）。pauseAfter は次の区切りまでの無音の長さ */
interface Segment {
  speaker: string;
  turn: number;
  file: string;
  pauseAfter: number;
}

// ---- 読み上げ（Irodori-TTS） ----

function uvPython(projectDir: string, script: string, jobsPath: string, env: NodeJS.ProcessEnv): void {
  run("uv", ["run", "--no-sync", "--project", projectDir, "python", join(CORPUS, script), jobsPath], { env, inherit: true });
}

/**
 * 読み上げた文の速さが極端なときや、文の中に長い無音があるときは、読み飛ばし・繰り返し・余計な音を疑って seed を変えて作り直す。
 * 速さは話し始めから話し終わりまでで測る。
 */
const RATE_RANGE = [3.5, 12] as const; // 1 秒あたりの文字数（句読点を除く）
const MAX_INNER_GAP_S = 1.3; // 読点の後の間は 1 秒を少し超えることがある
const speakableChars = (text: string) => text.replace(/[、。！？「」…・\s]/g, "").length;

interface SpeechBounds {
  start: number;
  end: number;
  longestGap: number;
}

/**
 * 50ms ごとの音量から、声のある区間を求める。
 * 長い無音のあとに 0.35 秒以下の短い音が 1 つだけ付いているのは、長さの予測が長すぎたときに出る余計な音なので、
 * その手前で話し終わったものとする（その音は組み立てのときに切り落とされる）。
 */
function speechBounds(wav: string): SpeechBounds {
  const r = spawnSync("sox", [wav, "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`sox ${wav} の読み込みに失敗しました`);
  const pcm = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 2);
  const FRAME = 800; // 50ms
  const frames: number[] = [];
  let peak = 1;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
    let sum = 0;
    for (let k = i; k < i + FRAME; k++) sum += pcm[k]! * pcm[k]!;
    frames.push(20 * Math.log10(Math.sqrt(sum / FRAME) / peak + 1e-9));
  }
  const runs: [number, number][] = [];
  frames.forEach((db, i) => {
    if (db <= -45) return;
    const last = runs.at(-1);
    if (last && i - last[1] <= 3) last[1] = i + 1; // 0.15 秒までの切れ目はつなぐ
    else runs.push([i, i + 1]);
  });
  if (!runs.length) return { start: 0, end: 0, longestGap: 0 };
  const tail = runs.at(-1)!;
  const beforeTail = runs.at(-2);
  if (beforeTail && (tail[1] - tail[0]) * 0.05 <= 0.35 && (tail[0] - beforeTail[1]) * 0.05 >= 0.6) runs.pop();
  let longestGap = 0;
  for (let i = 1; i < runs.length; i++) longestGap = Math.max(longestGap, (runs[i]![0] - runs[i - 1]![1]) * 0.05);
  return { start: runs[0]![0] * 0.05, end: runs.at(-1)![1] * 0.05, longestGap };
}

function problem(text: string, wav: string): string | null {
  const b = speechBounds(wav);
  const rate = speakableChars(text) / Math.max(0.1, b.end - b.start);
  if (rate < RATE_RANGE[0] || rate > RATE_RANGE[1]) return `速さが ${rate.toFixed(1)} 文字/秒`;
  if (b.longestGap > MAX_INNER_GAP_S) return `文の中に ${b.longestGap.toFixed(2)} 秒の無音`;
  return null;
}

function synthesizeIrodori(id: string, script: Script, tmp: string): Segment[] {
  const dir = process.env.IRODORI_TTS_DIR;
  if (!dir || !existsSync(join(dir, "irodori_tts"))) {
    throw new Error("環境変数 IRODORI_TTS_DIR に、Irodori-TTS を clone して uv sync --extra cpu（または cu128）した場所を指定してください");
  }
  const cacheDir = join(CACHE, "irodori");
  mkdirSync(cacheDir, { recursive: true });
  const env = { ...process.env, IRODORI_TTS_DIR: dir };
  const caption = (speaker: string) => {
    const c = script.captions[speaker];
    if (!c) throw new Error(`${id}: 話者 ${speaker} の声の説明（# voice ${speaker}: …）がありません`);
    return c;
  };

  // 1. 話者ごとの参照音声（声の説明だけから作る）
  const speakers = [...new Set(script.turns.map((t) => t.speaker))];
  const refs = Object.fromEntries(
    speakers.map((s) => [s, join(cacheDir, `ref-${hash(IRODORI_CHECKPOINT, IRODORI_MODE, caption(s), REFERENCE_TEXT, seedOf(id, s))}.wav`)]),
  );
  const refJobs = speakers.map((s) => ({ text: REFERENCE_TEXT, caption: caption(s), seed: seedOf(id, s), out: refs[s] }));
  writeFileSync(join(tmp, "irodori-refs.json"), JSON.stringify({ checkpoint: IRODORI_CHECKPOINT, jobs: refJobs }));
  uvPython(dir, "tts_irodori.py", join(tmp, "irodori-refs.json"), env);

  // 2. 1 文ずつ、参照音声と声の説明を条件にして読み上げる
  interface Line {
    speaker: string;
    turn: number;
    text: string;
    pauseAfter: number;
    attempt: number;
  }
  const lines: Line[] = [];
  script.turns.forEach((turn, ti) => {
    turn.paragraphs.forEach((p, pi) => {
      const ss = sentences(spoken(p));
      ss.forEach((text, si) => {
        const lastOfParagraph = si === ss.length - 1;
        const lastOfTurn = lastOfParagraph && pi === turn.paragraphs.length - 1;
        lines.push({ speaker: turn.speaker, turn: ti, text, pauseAfter: lastOfTurn ? 0 : lastOfParagraph ? PARAGRAPH_PAUSE_S : SENTENCE_PAUSE_S, attempt: 0 });
      });
    });
  });
  const outOf = (l: Line) =>
    join(cacheDir, `${hash(IRODORI_CHECKPOINT, IRODORI_MODE, caption(l.speaker), refs[l.speaker]!, l.text, seedOf(id, l.speaker, l.text, l.attempt))}.wav`);
  const MAX_ATTEMPTS = 4;
  for (let round = 1; ; round++) {
    const jobs = lines.map((l) => ({ text: l.text, caption: caption(l.speaker), ref_wav: refs[l.speaker], seed: seedOf(id, l.speaker, l.text, l.attempt), out: outOf(l) }));
    writeFileSync(join(tmp, "irodori-lines.json"), JSON.stringify({ checkpoint: IRODORI_CHECKPOINT, jobs }));
    uvPython(dir, "tts_irodori.py", join(tmp, "irodori-lines.json"), env);
    const bad = lines.map((l) => ({ l, why: problem(l.text, outOf(l)) })).filter((x) => x.why !== null);
    if (!bad.length) break;
    if (round === MAX_ATTEMPTS) {
      // 作り直しても直らなければ、最後に作ったものを使い、どの文かを知らせる
      for (const { l, why } of bad) console.warn(`  ${id}: 「${l.text.slice(0, 20)}…」は ${MAX_ATTEMPTS} 回作っても ${why} のままです`);
      break;
    }
    for (const { l, why } of bad) {
      console.warn(`  ${id}: 「${l.text.slice(0, 20)}…」が ${why} なので、seed を変えて作り直します（${round} 回目）`);
      l.attempt++;
    }
  }
  return lines.map((l, i) => {
    const file = join(tmp, `line${i}.wav`);
    // 前後の無音（と、話し終わりの後の余計な音）を切る。前後 50ms を残す
    const b = speechBounds(outOf(l));
    const start = Math.max(0, b.start - 0.05);
    const end = Math.min(duration(outOf(l)), b.end + 0.05);
    run("sox", [outOf(l), "-r", "16000", "-c", "1", "-b", "16", file, "trim", start.toFixed(3), (end - start).toFixed(3)]);
    return { speaker: l.speaker, turn: l.turn, file, pauseAfter: l.pauseAfter };
  });
}

// ---- 読み上げ（macOS の say） ----

function synthesizeSay(id: string, script: Script, tmp: string): Segment[] {
  return script.turns.map((turn, i) => {
    const v = script.voices[turn.speaker];
    if (!v) throw new Error(`${id}: 話者 ${turn.speaker} の声（# ${turn.speaker}: Kyoko 210 など）がありません`);
    const text = turn.paragraphs.map(spoken).join(` [[slnc ${SAY_PARAGRAPH_PAUSE_MS}]] `);
    const raw = join(tmp, `turn${i}.raw.wav`);
    const file = join(tmp, `turn${i}.wav`);
    run("say", ["-v", v.voice, "-r", String(v.rate), "--file-format=WAVE", "--data-format=LEI16@16000", "-o", raw, text]);
    run("sox", [raw, "-r", "16000", "-c", "1", "-b", "16", file]);
    return { speaker: turn.speaker, turn: i, file, pauseAfter: 0 };
  });
}

// ---- 会場の音（Woosh） ----

const SFX = {
  room: [
    "quiet conference room tone during a tech talk, soft air conditioning hum, a small attentive audience sitting still",
    "indoor meeting room ambience, gentle ventilation noise, faint rustling of clothes and paper from a seated audience",
  ],
  applause: "warm polite applause from a small audience of about thirty people in a meeting room",
  events: [
    "a single person clears their throat and coughs once in a quiet meeting room",
    "an office chair creaks as someone shifts in their seat in a quiet room",
    "a few soft laptop keyboard clicks in a quiet meeting room",
  ],
  /** 入れたくない音。環境音に人の話し声が混ざると、認識の評価に紛れ込む */
  negative: "speech, talking, voices, singing, music",
};
/** 環境音は 5 秒ずつ作り、この本数をつないで繰り返す（約 40 秒ごとに同じ音に戻る） */
const ROOM_CLIPS = 8;

interface VenueSounds {
  room: string[];
  applause: string;
  events: string[];
}

function generateSfx(): VenueSounds {
  const dir = process.env.WOOSH_DIR;
  if (!dir || !existsSync(join(dir, "checkpoints", "Woosh-Flow"))) {
    throw new Error("環境変数 WOOSH_DIR に、Woosh を clone して uv sync し、重み（Woosh-Flow・TextConditionerA・Woosh-AE）を checkpoints/ に置いた場所を指定してください");
  }
  const cacheDir = join(CACHE, "woosh");
  mkdirSync(cacheDir, { recursive: true });
  const job = (prompt: string, seed: number) => ({
    prompt,
    negative: SFX.negative,
    seed,
    out: join(cacheDir, `${hash("Woosh-Flow", prompt, SFX.negative, seed)}.wav`),
  });
  const room = Array.from({ length: ROOM_CLIPS }, (_, i) => job(SFX.room[i % SFX.room.length]!, 1000 + i));
  const applause = job(SFX.applause, 2000);
  const events = SFX.events.map((p, i) => job(p, 3000 + i));
  const jobsPath = join(cacheDir, "jobs.json");
  writeFileSync(jobsPath, JSON.stringify({ jobs: [...room, applause, ...events] }));
  uvPython(dir, "sfx_woosh.py", jobsPath, { ...process.env, WOOSH_DIR: dir });
  return { room: room.map((j) => j.out), applause: applause.out, events: events.map((j) => j.out) };
}

/** 環境音のクリップを 16kHz モノラルにして、少しずつ重ねながら total 秒までつなぐ */
function roomBed(sounds: VenueSounds, total: number, tmp: string): string {
  const clips = sounds.room.map((src, i) => {
    const out = join(tmp, `room${i}.wav`);
    // 前後 0.5 秒をフェードし、つなぎ目で音が途切れたり跳ねたりしないようにする
    run("sox", [src, "-r", "16000", "-c", "1", "-b", "16", out, "trim", "0.3", "-0.3", "fade", "t", "0.5", "-0", "0.5"]);
    return out;
  });
  const parts: string[] = [];
  let t = 0;
  for (let i = 0; t < total + 1; i++) {
    const clip = clips[i % clips.length]!;
    parts.push(clip);
    t += duration(clip);
  }
  const joined = join(tmp, "room-joined.wav");
  run("sox", [...parts, joined]);
  const bed = join(tmp, "room.wav");
  run("sox", [joined, bed, "trim", "0", String(total)]);
  return bed;
}

/**
 * 効果音を、決めた時刻から最長 maxLen 秒だけ、話し声の RMS に対する相対レベル（dB）で置いた音声にする。
 * 次の発話にかからないよう、maxLen で切って終わりをフェードアウトする。
 */
function placed(src: string, at: number, maxLen: number, total: number, levelDb: number, speechRms: number, tmp: string, name: string): string {
  const mono = join(tmp, `${name}.mono.wav`);
  run("sox", [src, "-r", "16000", "-c", "1", "-b", "16", mono, "silence", "1", "0.02", "-45d"]);
  const len = Math.min(duration(mono), maxLen, total - at);
  const cut = join(tmp, `${name}.cut.wav`);
  run("sox", [mono, cut, "trim", "0", String(len), "fade", "t", "0.03", String(len), String(Math.min(0.8, len / 3))]);
  const gain = (speechRms * Math.pow(10, levelDb / 20)) / Math.max(rms(cut), 1e-6);
  const out = join(tmp, `${name}.wav`);
  run("sox", ["-v", gain.toFixed(6), cut, out, "pad", String(at), String(Math.max(0, total - at - len))]);
  return out;
}

// ---- 組み立て ----

interface Timeline {
  turns: { speaker: string; startMs: number; endMs: number; text: string }[];
  durationMs: number;
  /** 拍手を入れる区間（秒） */
  applause: { at: number; length: number }[];
  /** 段落の間の無音（咳などを入れる候補。秒） */
  pauses: { at: number; length: number }[];
}

function assemble(id: string, script: Script, segments: Segment[], tmp: string): Timeline {
  const parts: string[] = [];
  const pad = (seconds: number) => {
    const file = join(tmp, `pad-${seconds.toFixed(2)}.wav`);
    if (!existsSync(file)) silence(file, seconds);
    parts.push(file);
    t += seconds;
  };
  const timeline: Timeline = { turns: [], durationMs: 0, applause: [], pauses: [] };
  let t = 0;
  pad(LEAD_S);
  script.turns.forEach((turn, ti) => {
    if (ti > 0) {
      // 登壇者の話が終わって最初の質問に移るところには、拍手の間を空ける
      const afterTalk = script.turns[ti - 1]!.speaker === "A" && turn.speaker !== "A" && !script.turns.slice(0, ti - 1).some((x) => x.speaker !== "A");
      if (afterTalk) {
        timeline.applause.push({ at: t + 0.3, length: APPLAUSE_S - 0.6 });
        pad(APPLAUSE_S);
      } else pad(TURN_GAP_S);
    }
    const start = t;
    for (const seg of segments.filter((s) => s.turn === ti)) {
      parts.push(seg.file);
      t += duration(seg.file);
      if (seg.pauseAfter > 0) {
        if (seg.pauseAfter >= PARAGRAPH_PAUSE_S) timeline.pauses.push({ at: t, length: seg.pauseAfter });
        pad(seg.pauseAfter);
      }
    }
    timeline.turns.push({ speaker: turn.speaker, startMs: Math.round(start * 1000), endMs: Math.round(t * 1000), text: turn.paragraphs.map(written).join("") });
  });
  timeline.applause.push({ at: t + 0.4, length: APPLAUSE_S - 0.6 });
  pad(APPLAUSE_S);
  const clean = join(OUT, `${id}.wav`);
  run("sox", [...parts, clean, "gain", "-n", "-1"]);
  timeline.durationMs = Math.round(duration(clean) * 1000);
  return timeline;
}

/**
 * 会場の想定: 帯域を狭め（安いマイクと PA）、残響を足し、環境音・拍手・咳などを重ねる。
 * sfx がなければ（--tts say で Woosh を使わないとき）、環境音の代わりにピンクノイズを重ねる。
 */
function buildVenue(id: string, timeline: Timeline, sfx: VenueSounds | null, tmp: string): void {
  const clean = join(OUT, `${id}.wav`);
  const reverbed = join(tmp, "reverbed.wav");
  run("sox", ["-R", clean, reverbed, "highpass", "120", "lowpass", "6500", "reverb", "45", "50", "80", "100", "10", "0"]);
  const total = duration(reverbed);
  const speechRms = rms(reverbed);
  const layers: string[] = [];
  if (sfx) {
    const bed = roomBed(sfx, total, tmp);
    const gain = speechRms / Math.pow(10, VENUE_SNR_DB / 20) / rms(bed);
    const bedOut = join(tmp, "room-level.wav");
    run("sox", ["-v", gain.toFixed(6), bed, bedOut]);
    layers.push(bedOut);
    timeline.applause.forEach((a, i) => layers.push(placed(sfx.applause, a.at, a.length, total, -4, speechRms, tmp, `applause${i}`)));
    // 咳・椅子・キーボードは、段落の間の無音に 1 回ずつ置く（話し声には重ねない）
    const slots = timeline.pauses.filter((p) => p.length >= PARAGRAPH_PAUSE_S);
    sfx.events.forEach((src, i) => {
      const slot = slots[Math.floor(((i + 1) * slots.length) / (sfx.events.length + 1))];
      if (slot) layers.push(placed(src, slot.at + 0.1, slot.length - 0.2, total, -10, speechRms, tmp, `event${i}`));
    });
  } else {
    const noise = join(tmp, "noise.wav");
    run("sox", ["-R", "-n", "-r", "16000", "-c", "1", "-b", "16", noise, "synth", String(total), "pinknoise"]);
    const gain = speechRms / Math.pow(10, VENUE_SNR_DB / 20) / rms(noise);
    const level = join(tmp, "noise-level.wav");
    run("sox", ["-v", gain.toFixed(6), noise, level]);
    layers.push(level);
  }
  run("sox", ["-R", "-m", reverbed, ...layers, join(OUT, `${id}.venue.wav`), "gain", "-n", "-1"]);
}

// ---- スライド ----

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function slidesHtml(source: string): string {
  const slides = source.split(/^---$/m).map((block) => {
    const lines = block.trim().split("\n");
    const title = lines.shift()!.replace(/^#\s*/, "");
    const body: string[] = [];
    let code: string[] | null = null;
    let list: string[] = [];
    const flushList = () => {
      if (list.length) body.push(`<ul>${list.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`);
      list = [];
    };
    for (const line of lines) {
      if (line.startsWith("```")) {
        if (code) {
          body.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
          code = null;
        } else {
          flushList();
          code = [];
        }
      } else if (code) code.push(line);
      else if (line.startsWith("- ")) list.push(line.slice(2));
      else if (line.trim()) {
        flushList();
        body.push(`<p>${escapeHtml(line)}</p>`);
      }
    }
    flushList();
    return { title, body: body.join("") };
  });
  const [cover, ...rest] = slides;
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>
@page { size: 1280px 720px; margin: 0 }
* { box-sizing: border-box }
body { margin: 0; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif; color: #1d2433 }
section { width: 1280px; height: 720px; padding: 72px 96px; page-break-after: always; overflow: hidden; position: relative }
section.cover { display: flex; flex-direction: column; justify-content: center; background: #1d2433; color: #fff }
section.cover h1 { font-size: 56px; line-height: 1.3; margin: 0 0 24px }
section.cover p { font-size: 26px; opacity: .8 }
h2 { font-size: 44px; margin: 0 0 40px; padding-bottom: 16px; border-bottom: 4px solid #2f6fdb }
ul { font-size: 32px; line-height: 1.7; padding-left: 1.2em }
pre { font: 24px/1.5 Menlo, monospace; background: #eef2f8; padding: 20px 24px; border-radius: 8px; white-space: pre-wrap }
.page { position: absolute; right: 48px; bottom: 32px; font-size: 18px; color: #7a8599 }
</style>
<section class="cover"><h1>${escapeHtml(cover!.title)}</h1>${cover!.body}</section>
${rest.map((s, i) => `<section><h2>${escapeHtml(s.title)}</h2>${s.body}<span class="page">${i + 2}</span></section>`).join("\n")}
</html>`;
}

function buildSlides(id: string, source: string, tmp: string): void {
  const html = join(tmp, "slides.html");
  writeFileSync(html, slidesHtml(source));
  if (!existsSync(CHROME)) throw new Error(`Google Chrome が見つかりません: ${CHROME}`);
  run(CHROME, ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${join(OUT, `${id}.slides.pdf`)}`, `file://${html}`]);
}

// ---- 正解 ----

function buildTruth(id: string, script: Script, audio: Timeline, tts: string) {
  const all = script.turns.flatMap((t) => t.paragraphs);
  const fillers = all.flatMap((p) => [...p.matchAll(FILLER)].map((m) => m[1]!));
  const termMap = new Map<string, Set<string>>();
  let termOccurrences = 0;
  for (const p of all) {
    for (const m of p.matchAll(TERM)) {
      termOccurrences++;
      const set = termMap.get(m[1]!) ?? new Set<string>();
      set.add(normalizeReading(m[2]!));
      termMap.set(m[1]!, set);
    }
  }
  const reference = audio.turns.map((t) => t.text).join("\n");
  const speakerMs = (s: string) => audio.turns.filter((t) => t.speaker === s).reduce((sum, t) => sum + t.endMs - t.startMs, 0);
  const mainChars = normalize(audio.turns.filter((t) => t.speaker === "A").map((t) => t.text).join("")).length;
  const truth = {
    id,
    title: script.title,
    durationMs: audio.durationMs,
    tts: tts === "irodori" ? { engine: "Irodori-TTS", checkpoint: IRODORI_CHECKPOINT, voices: script.captions } : { engine: "say", voices: script.voices },
    turns: audio.turns,
    speakers: Object.fromEntries([...new Set(script.turns.map((t) => t.speaker))].map((s) => [s, { speechMs: speakerMs(s) }])),
    fillers: { total: fillers.length, list: fillers },
    terms: [...termMap.keys()],
    termOccurrences,
    referenceChars: normalize(reference).length,
    /** 登壇者（A）の話す速さ。正解の書き起こしの文字数 ÷ A が話していた時間 */
    charsPerMinute: Math.round(mainChars / (speakerMs("A") / 60000)),
  };
  const oracle: { terms: DictionaryTerm[] } = { terms: [...termMap].map(([w, r]) => ({ written: w, readings: [...r] })) };
  writeFileSync(join(OUT, `${id}.ref.txt`), reference + "\n");
  writeFileSync(join(OUT, `${id}.truth.json`), JSON.stringify(truth, null, 1) + "\n");
  writeFileSync(join(OUT, `${id}.oracle.dict.json`), JSON.stringify(oracle, null, 1) + "\n");
  return truth;
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: { tts: { type: "string", default: "irodori" } },
    allowPositionals: true,
  });
  const tts = values.tts!;
  if (tts !== "irodori" && tts !== "say") throw new Error("--tts は irodori か say を指定してください");
  const ids = positionals.length
    ? positionals
    : readdirSync(CORPUS, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(CORPUS, d.name, "script.txt"))).map((d) => d.name);
  mkdirSync(OUT, { recursive: true });
  // 1. 読み上げて、静かな版の音声を作る（読み上げの失敗に先に気付けるよう、会場の音より先に全部作る）
  const built = ids.map((id) => {
    const tmp = join(OUT, `.tmp-${id}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const script = parseScript(readFileSync(join(CORPUS, id, "script.txt"), "utf8"));
    const segments = tts === "irodori" ? synthesizeIrodori(id, script, tmp) : synthesizeSay(id, script, tmp);
    return { id, tmp, script, timeline: assemble(id, script, segments, tmp) };
  });
  // 2. 会場の音は全部の LT で同じものを使う（Irodori で作るときは Woosh、say のときはピンクノイズ）
  const sfx = tts === "irodori" ? generateSfx() : null;
  for (const { id, tmp, script, timeline } of built) {
    buildVenue(id, timeline, sfx, tmp);
    buildSlides(id, readFileSync(join(CORPUS, id, "slides.txt"), "utf8"), tmp);
    const truth = buildTruth(id, script, timeline, tts);
    rmSync(tmp, { recursive: true, force: true });
    console.log(
      `${id}: ${(truth.durationMs / 1000).toFixed(1)} 秒、正解 ${truth.referenceChars} 文字、${truth.charsPerMinute} 文字/分、フィラー ${truth.fillers.total}、用語 ${truth.terms.length} 種 ${truth.termOccurrences} 回、話者の切り替え ${truth.turns.length - 1} 回`,
    );
  }
}

if (import.meta.main) main();
