// 記事のグラフを eval/results/summary.json から作る（SVG を HTML に入れ、Chrome で PNG にする）。
//
//   node docs/zenn/charts/build.ts
//
// 色は、色覚の多様性の検証（dataviz の validate_palette.js）を通した並びの先頭 3 色を、辞書の種類に順に割り当てる。
// 文字は系列の色ではなく文字用の色で書き、系列は凡例と直接のラベルで区別する（色だけに頼らない）。

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const OUT = resolve(HERE, "..", "images");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const SERIES = ["#257de0", "#f47230", "#00b894"];
const INK = "#1d2433";
const MUTED = "#5b6475";
const GRID = "#e3e7ee";
const FONT = `"Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif`;

interface Row {
  mode: string;
  engine: string;
  dictionary: string;
  variant: string;
  postTime: number | null;
  emphasis: number | null;
  diarization: boolean;
  options: string;
  cer: number;
  termRecall: number | null;
  lagP50: number | null;
  finalizeP50: number | null;
  utterances: number;
  talks: string[];
}

const ENGINE_LABEL: Record<string, string> = {
  "-a-general": "会話_汎用（ハイブリッド）",
  "-a-general-input": "音声入力_汎用（ハイブリッド）",
  "-a2-ja-general": "日本語 E2E_汎用",
  "-a2-multi-general": "多言語 E2E_汎用",
  "-a2b-ja-general": "日本語 E2E_汎用バッチ",
};
const DICTS = [
  { key: "nodict", label: "辞書なし" },
  { key: "slides", label: "スライドから作った辞書" },
  { key: "oracle", label: "理想の辞書" },
];

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

/** 横向きのドットプロット。行ごとに辞書の種類の 3 点を置き、最小から最大を細い線でつなぐ。 */
function dotPanel(opts: {
  title: string;
  note: string;
  rows: { label: string; values: (number | null)[] }[];
  max: number;
  ticks: number[];
  x0: number;
  width: number;
  better: "high" | "low";
}): string {
  const { rows, max, ticks, x0, width } = opts;
  const labelW = 0;
  const plotL = x0 + labelW + 8;
  const plotR = x0 + width - 16;
  const top = 64;
  const rowH = 52;
  const x = (v: number) => plotL + (Math.min(v, max) / max) * (plotR - plotL);
  const parts: string[] = [];
  parts.push(`<text x="${x0}" y="22" font-size="17" font-weight="700" fill="${INK}">${esc(opts.title)}</text>`);
  parts.push(`<text x="${x0}" y="44" font-size="13" fill="${MUTED}">${esc(opts.note)}</text>`);
  for (const t of ticks) {
    parts.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${top + rows.length * rowH}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${x(t)}" y="${top + rows.length * rowH + 18}" font-size="12" fill="${MUTED}" text-anchor="middle">${t * 100}%</text>`);
  }
  rows.forEach((r, i) => {
    const cy = top + i * rowH + rowH / 2;
    const vals = r.values.filter((v): v is number => v !== null);
    if (vals.length >= 2) {
      parts.push(`<line x1="${x(Math.min(...vals))}" x2="${x(Math.max(...vals))}" y1="${cy}" y2="${cy}" stroke="#b8c0cc" stroke-width="2"/>`);
    }
    r.values.forEach((v, j) => {
      if (v === null) return;
      // 重なったときに見分けられるよう、背景色の 2px の輪を付ける
      parts.push(`<circle cx="${x(v)}" cy="${cy}" r="7" fill="${SERIES[j]}" stroke="#fff" stroke-width="2"/>`);
    });
    // 値のラベルは「辞書なし」と「スライドから」の点の真上にだけ付ける（全部の点には付けない。理想の辞書の値は表に載せる）
    r.values.slice(0, 2).forEach((v) => {
      if (v === null || v === undefined) return;
      parts.push(`<text x="${x(v)}" y="${cy - 13}" font-size="12" fill="${INK}" text-anchor="middle">${pct(v)}</text>`);
    });
  });
  return parts.join("\n");
}

/** 凡例。その図に出てくる辞書の種類だけを並べる（色は種類ごとに固定で、図によって塗り替えない） */
function legend(y: number, x: number, present: Set<string>): string {
  let cx = x;
  return DICTS.map((d, i) => {
    if (!present.has(d.key)) return "";
    const s = `<circle cx="${cx + 7}" cy="${y}" r="7" fill="${SERIES[i]}"/><text x="${cx + 20}" y="${y + 5}" font-size="14" fill="${INK}">${esc(d.label)}</text>`;
    cx += 26 + d.label.length * 14 + 24;
    return s;
  }).join("");
}

function dictionaryFigure(rows: Row[], variant: string, file: string, caption: string): void {
  const live = rows.filter((r) => r.mode === "ライブ" && r.variant === variant && r.postTime === null && r.emphasis === null && !r.diarization);
  const engines = ["-a-general", "-a-general-input", "-a2-ja-general", "-a2-multi-general"].filter((e) => live.some((r) => r.engine === e));
  const get = (engine: string, dict: string, f: (r: Row) => number | null) => {
    const r = live.find((x) => x.engine === engine && x.dictionary === dict);
    return r ? f(r) : null;
  };
  const W = 1200;
  const labelW = 250;
  const panelW = (W - labelW - 40) / 2;
  const H = 64 + engines.length * 52 + 90;
  const labels = engines
    .map((e, i) => `<text x="24" y="${64 + i * 52 + 26 + 5}" font-size="14" fill="${INK}">${esc(ENGINE_LABEL[e] ?? e)}</text>`)
    .join("");
  const recall = dotPanel({
    title: "用語の再現率（高いほどよい）",
    note: "台本の用語が、同じ表記で字幕に出た割合",
    rows: engines.map((e) => ({ label: e, values: DICTS.map((d) => get(e, d.key, (r) => r.termRecall)) })),
    max: 1,
    ticks: [0, 0.25, 0.5, 0.75, 1],
    x0: labelW,
    width: panelW,
    better: "high",
  });
  const cerMax = Math.max(0.2, Math.ceil(Math.max(...live.map((r) => r.cer)) * 10) / 10);
  const cerTicks = Array.from({ length: Math.round(cerMax / 0.05) + 1 }, (_, i) => Math.round(i * 5) / 100).filter((t, i, a) => a.length <= 6 || i % 2 === 0);
  const cer = dotPanel({
    title: "CER（文字誤り率、低いほどよい）",
    note: "正解との編集距離 ÷ 正解の文字数",
    rows: engines.map((e) => ({ label: e, values: DICTS.map((d) => get(e, d.key, (r) => r.cer)) })),
    max: cerMax,
    ticks: cerTicks,
    x0: labelW + panelW + 40,
    width: panelW,
    better: "low",
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 40}" font-family='${FONT}'>
<rect width="100%" height="100%" fill="#fff"/>
<g transform="translate(0,40)">${labels}${recall}${cer}</g>
<g>${legend(20, 24, new Set(live.map((r) => r.dictionary)))}</g>
<text x="24" y="${H + 30}" font-size="12" fill="${MUTED}">${esc(caption)}</text>
</svg>`;
  render(svg, W, H + 40, file);
}

/** postTime を変えたときの、確定の遅れと発話数。2 つの量は単位が違うので、縦軸を共有せず 2 枚に分ける。 */
const POST_TIMES = [300, 550, 1200];
function postTimeFigure(rows: Row[], file: string): void {
  const engines = ["-a-general", "-a2-ja-general"];
  const pts = (engine: string, f: (r: Row) => number | null) =>
    POST_TIMES
      .map((pt) => {
        const r = rows.find(
          (x) => x.mode === "ライブ" && x.variant === "静か" && x.engine === engine && x.dictionary === "slides" && !x.diarization && x.emphasis === null && (x.postTime ?? 550) === pt,
        );
        return r ? { pt, v: f(r) } : null;
      })
      .filter((p): p is { pt: number; v: number | null } => p !== null && p.v !== null) as { pt: number; v: number }[];
  const W = 1200;
  const H = 420;
  const panel = (x0: number, title: string, note: string, f: (r: Row) => number | null, unit: string, directLabels: boolean) => {
    const series = engines.map((e) => pts(e, f));
    const all = series.flat().map((p) => p.v);
    if (all.length === 0) return "";
    const maxV = Math.ceil((Math.max(...all) * 1.15) / 100) * 100 || 1;
    const L = x0 + 56;
    const R = x0 + (directLabels ? 440 : 520);
    const T = 110;
    const B = H - 60;
    const x = (pt: number) => L + ((pt - 300) / 900) * (R - L);
    const y = (v: number) => B - (v / maxV) * (B - T);
    const parts = [`<text x="${x0}" y="24" font-size="17" font-weight="700" fill="${INK}">${esc(title)}</text>`, `<text x="${x0}" y="46" font-size="13" fill="${MUTED}">${esc(note)}</text>`];
    for (let i = 0; i <= 4; i++) {
      const v = (maxV / 4) * i;
      parts.push(`<line x1="${L}" x2="${R}" y1="${y(v)}" y2="${y(v)}" stroke="${i === 0 ? "#b8c0cc" : GRID}"/>`);
      parts.push(`<text x="${L - 8}" y="${y(v) + 4}" font-size="12" fill="${MUTED}" text-anchor="end">${Math.round(v)}</text>`);
    }
    for (const pt of POST_TIMES) {
      parts.push(`<text x="${x(pt)}" y="${B + 20}" font-size="12" fill="${MUTED}" text-anchor="middle">${pt}${pt === 550 ? "（既定）" : ""}</text>`);
    }
    parts.push(`<text x="${(L + R) / 2}" y="${B + 42}" font-size="12" fill="${MUTED}" text-anchor="middle">postTime（ミリ秒）</text>`);
    parts.push(`<text x="${L - 48}" y="${T - 14}" font-size="12" fill="${MUTED}">${esc(unit)}</text>`);
    series.forEach((s, i) => {
      if (s.length === 0) return;
      parts.push(`<path d="${s.map((p, j) => `${j ? "L" : "M"}${x(p.pt)},${y(p.v)}`).join("")}" fill="none" stroke="${SERIES[i]}" stroke-width="2"/>`);
      for (const p of s) parts.push(`<circle cx="${x(p.pt)}" cy="${y(p.v)}" r="5" fill="${SERIES[i]}" stroke="#fff" stroke-width="2"/>`);
      // 線が重ならない左の図にだけ、線の端に名前を付ける（右の図は 2 本がほぼ重なるので凡例に任せる）
      if (!directLabels) return;
      const last = s.at(-1)!;
      parts.push(`<text x="${x(last.pt) + 10}" y="${y(last.v) + (i === 0 ? -8 : 14)}" font-size="12" fill="${INK}">${esc(ENGINE_LABEL[engines[i]!]!.replace(/（.*）/, ""))}</text>`);
    });
    return parts.join("\n");
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family='${FONT}'>
<rect width="100%" height="100%" fill="#fff"/>
${panel(24, "話し終えてから字幕が確定するまで", "確定の遅れの中央値（3 本の LT、スライドから作った辞書）", (r) => r.lagP50, "ミリ秒", true)}
${panel(624, "確定した発話の数", "postTime が短いほど、字幕が細かく区切られる", (r) => r.utterances, "件", false)}
${engines.map((e, i) => `<circle cx="${24 + i * 220 + 7}" cy="68" r="6" fill="${SERIES[i]}"/><text x="${24 + i * 220 + 20}" y="73" font-size="13" fill="${INK}">${esc(ENGINE_LABEL[e]!.replace(/（.*）/, ""))}</text>`).join("")}
</svg>`;
  render(svg, W, H, file);
}

function render(svg: string, width: number, height: number, file: string): void {
  mkdirSync(OUT, { recursive: true });
  const html = join(OUT, `.${file}.html`);
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style>${svg}`);
  const png = join(OUT, `${file}.png`);
  const r = spawnSync(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", `--window-size=${width},${height}`, `--screenshot=${png}`, `file://${html}`], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  console.log(`→ ${png}`);
}

const summary = JSON.parse(readFileSync(join(ROOT, "eval/results/summary.json"), "utf8")) as { rows: Row[] };
dictionaryFigure(summary.rows, "静か", "dictionary-quiet", "模擬 LT 3 本（各約 3 分、Irodori-TTS の合成音声）をライブ（WebSocket）で認識。静かな部屋で口元のマイクを使った想定。");
dictionaryFigure(summary.rows, "会場", "dictionary-venue", "同じ 3 本に、残響・帯域の制限・会場の音（Woosh で作った環境音を音声から 15dB 下、拍手・咳など）を足した想定。");
postTimeFigure(summary.rows, "posttime");
