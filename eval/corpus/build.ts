// 模擬 LT の台本（script.txt）とスライド（slides.txt）から、評価に使う素材を作る。
// 正解（書き起こし・話者・フィラー・用語）が分かっている音声を、macOS の読み上げ（say）で誰でも作り直せるようにするためのもの。
//
//   node eval/corpus/build.ts            # eval/corpus/ の下の全部
//   node eval/corpus/build.ts workers    # 1 本だけ
//
// 出力（eval/data/）:
//   <id>.wav              静かな部屋で、口元のマイクで録った想定の音声（16kHz・16bit・モノラル）
//   <id>.venue.wav        会場の想定。残響を足し、帯域を狭め、ピンクノイズを音声全体の RMS から 15dB 下で重ねる
//   <id>.ref.txt          正解の書き起こし（フィラーなし、表記はスライドと同じ綴り）
//   <id>.truth.json       話者の区間、フィラーの数、用語、話す速さ
//   <id>.oracle.dict.json 台本の読みをそのまま入れた辞書（スライドから作った辞書と比べる上限の目安）
//   <id>.slides.pdf       スライド（Claude が辞書を作るときの入力）
//
// 必要なもの: macOS の say、sox、Google Chrome（スライドの PDF 化）

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeReading, type DictionaryTerm } from "../../src/shared/amivoice.ts";
import { normalize } from "../../src/shared/metrics.ts";

const CORPUS = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(CORPUS, "..", "data");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LEAD_S = 0.6;
const TURN_GAP_S = 0.9;
const TAIL_S = 1.0;
const PARAGRAPH_PAUSE_MS = 500;
const VENUE_SNR_DB = 15;

interface Turn {
  speaker: string;
  paragraphs: string[];
}

interface Script {
  title: string;
  voices: Record<string, { voice: string; rate: number }>;
  turns: Turn[];
}

const TERM = /\{([^|}]+)\|([^}]+)\}/g;
const FILLER = /\(([^)]+)\)/g;

export function parseScript(text: string): Script {
  let title = "";
  const voices: Script["voices"] = {};
  const turns: Turn[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length && turns.length) turns.at(-1)!.paragraphs.push(paragraph.join(""));
    paragraph = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      const m = /^#\s*(title|[A-Z]):\s*(.+)$/.exec(line);
      if (m?.[1] === "title") title = m[2]!.trim();
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
  return { title, voices, turns };
}

/** 読み上げに渡す文。{表記|読み} は読みに、(えー) はフィラーとして読む。 */
export const spoken = (p: string) => p.replace(TERM, "$2").replace(FILLER, "$1");
/** 正解の書き起こし。{表記|読み} は表記に、フィラーは後ろの読点ごと取り除く。 */
export const written = (p: string) => p.replace(TERM, "$1").replace(/\([^)]+\)、?/g, "");

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} … に失敗しました: ${r.stderr}`);
  return r.stdout + r.stderr;
}

const duration = (path: string) => Number(run("soxi", ["-D", path]).trim());
const rms = (path: string) => Number(/RMS\s+amplitude:\s+([\d.]+)/.exec(run("sox", [path, "-n", "stat"]))![1]);
const silence = (path: string, seconds: number) => run("sox", ["-n", "-r", "16000", "-c", "1", "-b", "16", path, "trim", "0", String(seconds)]);

function buildAudio(id: string, script: Script, tmp: string): { turns: { speaker: string; startMs: number; endMs: number; text: string }[]; durationMs: number } {
  const parts: string[] = [];
  const turns: { speaker: string; startMs: number; endMs: number; text: string }[] = [];
  silence(join(tmp, "lead.wav"), LEAD_S);
  silence(join(tmp, "gap.wav"), TURN_GAP_S);
  silence(join(tmp, "tail.wav"), TAIL_S);
  parts.push(join(tmp, "lead.wav"));
  let t = LEAD_S;
  script.turns.forEach((turn, i) => {
    const v = script.voices[turn.speaker];
    if (!v) throw new Error(`${id}: 話者 ${turn.speaker} の声が決まっていません`);
    const text = turn.paragraphs.map(spoken).join(` [[slnc ${PARAGRAPH_PAUSE_MS}]] `);
    const raw = join(tmp, `turn${i}.raw.wav`);
    const out = join(tmp, `turn${i}.wav`);
    run("say", ["-v", v.voice, "-r", String(v.rate), "--file-format=WAVE", "--data-format=LEI16@16000", "-o", raw, text]);
    run("sox", [raw, "-r", "16000", "-c", "1", "-b", "16", out]);
    if (i > 0) {
      parts.push(join(tmp, "gap.wav"));
      t += TURN_GAP_S;
    }
    const d = duration(out);
    turns.push({ speaker: turn.speaker, startMs: Math.round(t * 1000), endMs: Math.round((t + d) * 1000), text: turn.paragraphs.map(written).join("") });
    parts.push(out);
    t += d;
  });
  parts.push(join(tmp, "tail.wav"));
  const clean = join(OUT, `${id}.wav`);
  run("sox", [...parts, clean]);

  // 会場の想定: 帯域を狭め（安いマイクと PA）、残響を足し、ピンクノイズ（空調・ざわめきの代わり）を重ねる。
  // sox -R で乱数を固定し、何度作っても同じ音声になるようにする。
  const reverbed = join(tmp, "reverbed.wav");
  run("sox", ["-R", clean, reverbed, "highpass", "120", "lowpass", "6500", "reverb", "45", "50", "80", "100", "10", "0"]);
  const total = duration(reverbed);
  const noise = join(tmp, "noise.wav");
  run("sox", ["-R", "-n", "-r", "16000", "-c", "1", "-b", "16", noise, "synth", String(total), "pinknoise"]);
  const gain = (rms(reverbed) / Math.pow(10, VENUE_SNR_DB / 20)) / rms(noise);
  run("sox", ["-R", "-m", "-v", "1", reverbed, "-v", gain.toFixed(6), noise, join(OUT, `${id}.venue.wav`), "gain", "-n", "-1"]);

  return { turns, durationMs: Math.round(duration(clean) * 1000) };
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

function buildTruth(id: string, script: Script, audio: ReturnType<typeof buildAudio>) {
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
    voices: script.voices,
    turns: audio.turns,
    speakers: Object.fromEntries(Object.keys(script.voices).map((s) => [s, { speechMs: speakerMs(s) }])),
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
  const ids = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(CORPUS, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(CORPUS, d.name, "script.txt"))).map((d) => d.name);
  mkdirSync(OUT, { recursive: true });
  for (const id of ids) {
    const tmp = join(OUT, `.tmp-${id}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const script = parseScript(readFileSync(join(CORPUS, id, "script.txt"), "utf8"));
    const audio = buildAudio(id, script, tmp);
    buildSlides(id, readFileSync(join(CORPUS, id, "slides.txt"), "utf8"), tmp);
    const truth = buildTruth(id, script, audio);
    rmSync(tmp, { recursive: true, force: true });
    console.log(
      `${id}: ${(truth.durationMs / 1000).toFixed(1)} 秒、正解 ${truth.referenceChars} 文字、${truth.charsPerMinute} 文字/分、フィラー ${truth.fillers.total}、用語 ${truth.terms.length} 種 ${truth.termOccurrences} 回、話者の切り替え ${truth.turns.length - 1} 回`,
    );
  }
}

if (import.meta.main) main();
