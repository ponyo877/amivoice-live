// 登壇の振り返り。/report.html#room=<id>&talk=<n> で開く（登壇者のトークンは登壇者の画面で保存したものを使う）。
// 終了後に非同期 HTTP API で作ったアーカイブ字幕と、話す速さ・フィラー・感情分析・話者の内訳を並べ、
// 自信のない語から次回の辞書の候補を Claude に出してもらう。

import type { DictionaryTerm } from "../shared/amivoice.ts";
import type { TalkReport } from "../shared/async-result.ts";
import type { CaptionLine, TalkDetail } from "../shared/protocol.ts";
import { speakerName } from "./captions.ts";
import { setupThemeToggle } from "./ui.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

setupThemeToggle($<HTMLButtonElement>("app-theme"));

const hash = new URLSearchParams(location.hash.slice(1));
const roomId = hash.get("room") ?? "";
const talkId = Number(hash.get("talk") ?? "0");
const token = hash.get("token") ?? localStorage.getItem(`speaker-token:${roomId}`) ?? "";
if (roomId && token) $<HTMLAnchorElement>("back").href = `/speaker.html#room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
if (!roomId || !talkId || !token) {
  $("title").textContent = "登壇を開けませんでした";
  $("progress").hidden = false;
  $("progress").textContent = "登壇者の画面の「登壇の記録」から開いてください。";
  throw new Error("room, talk or token is missing");
}
const api = (path: string) => `/api/rooms/${encodeURIComponent(roomId)}${path}`;
const authHeaders = { authorization: `Bearer ${token}` };

let detail: TalkDetail | null = null;
let source: "archive" | "live" = "archive";
let pollTimer: number | undefined;

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

async function load(): Promise<void> {
  const [talkRes, transcriptRes] = await Promise.all([
    fetch(api(`/talks/${talkId}`), { headers: authHeaders }),
    fetch(api(`/transcript?format=json&talk=${talkId}`)),
  ]);
  if (!talkRes.ok) {
    const body = (await talkRes.json().catch(() => ({}))) as { error?: string };
    $("title").textContent = "登壇を開けませんでした";
    showProgress(body.error ?? `HTTP ${talkRes.status}`);
    return;
  }
  detail = (await talkRes.json()) as TalkDetail;
  const { title } = (await transcriptRes.json()) as { title: string };
  $("title").textContent = `「${title}」の振り返り`;
  document.title = `「${title}」の振り返り | amivoice-live`;
  render(detail);

  // 認識し直している間は 10 秒ごとに見に行く
  window.clearTimeout(pollTimer);
  if (["interrupted", "recorded", "archiving"].includes(detail.talk.status)) {
    pollTimer = window.setTimeout(() => void load(), 10_000);
  }
}

function render(d: TalkDetail): void {
  const t = d.talk;
  const started = new Date(t.startedAt);
  $("when").textContent = `${started.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}・${formatDuration(t.audioMs)}`;

  const progress: Record<string, string> = {
    live: "まだ配信中です。配信を止めると、録音をもとにアーカイブと振り返りを作り始めます。",
    interrupted: "途中で止まった配信の録音を回収しています…",
    recorded: "録音を AmiVoice の非同期 API に送っています…",
    archiving: "AmiVoice が録音を認識し直しています。登壇の長さによって数分かかります。このページは自動で更新されます。",
    "no-audio": "音声が届かなかったため、アーカイブと振り返りはありません。",
  };
  if (t.status === "error") showProgress(`アーカイブを作れませんでした: ${t.error ?? "不明なエラー"}`, true);
  else if (t.status === "done" && !t.archive) showProgress("この登壇は録音しない設定だったため、ライブ字幕だけがあります。");
  else if (progress[t.status]) showProgress(progress[t.status]!);
  else if (t.error) showProgress(t.error, true);
  else $("progress").hidden = true;

  if (d.report) renderReport(d.report, d);
  if (!d.archive.length) source = "live";
  (document.querySelector(`input[name="source"][value="${source}"]`) as HTMLInputElement).checked = true;
  (document.querySelector('input[name="source"][value="archive"]') as HTMLInputElement).disabled = d.archive.length === 0;
  renderTranscript();

  $<HTMLAnchorElement>("dl-archive-vtt").href = api(`/transcript?talk=${talkId}&source=archive&format=vtt`);
  $<HTMLAnchorElement>("dl-archive-md").href = api(`/transcript?talk=${talkId}&source=archive&format=md`);
  $<HTMLAnchorElement>("dl-live-md").href = api(`/transcript?talk=${talkId}&format=md`);
  for (const id of ["dl-archive-vtt", "dl-archive-md"]) $(id).hidden = d.archive.length === 0;

  const hasRecording = t.archive && t.status !== "no-audio" && t.status !== "live";
  $("retry").hidden = !hasRecording || !["done", "error"].includes(t.status);
  $("delete-recording").hidden = !hasRecording;
  $("load-audio").hidden = !hasRecording;
}

function showProgress(text: string, isError = false): void {
  const el = $("progress");
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("is-error", isError);
}

// ---------------------------------------------------------------------------
// 数字のまとめ
// ---------------------------------------------------------------------------

function renderReport(r: TalkReport, d: TalkDetail): void {
  $("figures").hidden = false;
  $("fig-rate").textContent = r.charsPerMinute === null ? "–" : `${r.charsPerMinute} 文字/分`;
  if (r.fillers.perMinute === null) {
    $("fig-fillers").textContent = "–";
  } else {
    $("fig-fillers").textContent = `${r.fillers.perMinute} 回/分`;
    $("fig-fillers-note").textContent =
      r.fillers.total === 0 ? "1 回も出ませんでした" : `全部で ${r.fillers.total} 回。多い順に ${r.fillers.top.slice(0, 3).map((f) => `「${f.word}」${f.count} 回`).join("、")}`;
  }
  $("fig-cer").textContent = r.liveVsArchive ? `${(r.liveVsArchive.cer * 100).toFixed(1)}%` : "–";

  const totalMs = r.speakers.reduce((s, x) => s + x.ms, 0);
  $("fig-speakers-box").hidden = r.speakers.length < 2;
  if (r.speakers.length >= 2) {
    const bar = $("fig-speakers");
    const legend = $("fig-speakers-legend");
    bar.replaceChildren();
    legend.replaceChildren();
    const described: string[] = [];
    for (const s of r.speakers) {
      const share = s.ms / totalMs;
      const part = document.createElement("span");
      part.className = "share-part";
      part.dataset.speaker = String(s.index % 6);
      part.style.flexGrow = String(share);
      bar.append(part);
      const item = document.createElement("span");
      item.className = "legend-item";
      item.dataset.speaker = String(s.index % 6);
      item.textContent = `${speakerName(s.index)} ${Math.round(share * 100)}%`;
      legend.append(item);
      described.push(`${speakerName(s.index)} ${Math.round(share * 100)}%`);
    }
    bar.setAttribute("aria-label", `話した時間の割合: ${described.join("、")}`);
  }

  renderTimeline(r, d);
  renderUnsure(r);
}

// ---------------------------------------------------------------------------
// 登壇の流れ（時間軸をそろえた小さなグラフを縦に並べる）
// ---------------------------------------------------------------------------

interface TimelineData {
  durationMs: number;
  speakers: { s: number; e: number; speaker: number }[];
  rate: { t: number; cpm: number }[];
  sentiment: {
    keys: string[];
    labels: string[];
    /** パラメータごとの値の範囲（AmiVoice のパラメータ一覧から）。取れなければ null でデータから決める */
    ranges: ({ min: number; max: number } | null)[];
    segments: { s: number; e: number; v: number[] }[];
  } | null;
  fillers: number[];
}

let timeline: TimelineData | null = null;
let sentimentIndex = 0;
let cursorMs: number | null = null;

const RATE_WINDOW_MS = 30_000;
const PAD_L = 8;
const PAD_R = 8;

function renderTimeline(r: TalkReport, d: TalkDetail): void {
  const speakerLines = (d.archive.some((l) => l.speaker !== undefined) ? d.archive : d.live).filter((l) => l.speaker !== undefined);
  const durationMs = Math.max(r.durationMs, d.talk.audioMs, ...d.archive.map((l) => l.endMs));
  timeline = {
    durationMs,
    speakers: speakerLines.map((l) => ({ s: l.startMs, e: l.endMs, speaker: l.speaker! })),
    rate: r.rateSeries,
    sentiment: r.sentiment
      ? { ...r.sentiment, labels: sentimentLabels(r.sentiment.keys, d.sentimentParameters), ranges: sentimentRanges(r.sentiment.keys, d.sentimentParameters) }
      : null,
    fillers: r.fillers.times,
  };
  $("timeline-panel").hidden = false;
  $("track-speakers").hidden = timeline.speakers.length === 0;
  $("track-sentiment").hidden = !timeline.sentiment;

  const note = $("sentiment-note");
  if (r.sentimentError) {
    note.hidden = false;
    note.textContent = `感情分析の結果を取れませんでした: ${r.sentimentError}`;
  } else {
    note.hidden = !timeline.sentiment;
    note.textContent = "感情は AmiVoice の感情解析（ESAS）が声の調子から約 2 秒ごとに推定した値です。話の内容ではなく、声の抑揚や勢いを表します。";
  }

  const select = $<HTMLSelectElement>("sentiment-key");
  if (timeline.sentiment && select.options.length === 0) {
    timeline.sentiment.labels.forEach((label, i) => select.add(new Option(label, String(i))));
    // 既定は「エネルギー」。名前が分からなければ最初のパラメータ
    const energy = timeline.sentiment.labels.findIndex((l) => /エネルギー|energy/i.test(l));
    sentimentIndex = energy >= 0 ? energy : 0;
    select.value = String(sentimentIndex);
    select.addEventListener("change", () => {
      sentimentIndex = Number(select.value);
      drawTimeline();
      renderTimelineTable();
    });
  }
  drawTimeline();
  renderTimelineTable();
}

/**
 * 感情パラメータのキー（結果 JSON のキー）を日本語名にする。
 * 名前一覧（result-parameters.json）の形はマニュアルに無いので、キーと同じ文字列を持つオブジェクトを探し、
 * その中の日本語の文字列を名前とみなす。見つからなければキーをそのまま使う。
 */
function sentimentLabels(keys: string[], params: unknown): string[] {
  const found = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const values = Object.values(node as Record<string, unknown>);
    const strings = values.filter((v): v is string => typeof v === "string");
    const key = strings.find((s) => keys.includes(s));
    const ja = strings.find((s) => /[぀-ヿ一-鿿]/u.test(s));
    if (key && ja && !found.has(key)) found.set(key, ja);
    // { "energy": "エネルギー" } の形にも対応する
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (keys.includes(k) && typeof v === "string" && /[぀-ヿ一-鿿]/u.test(v) && !found.has(k)) found.set(k, v);
    }
    values.forEach(visit);
  };
  visit(params);
  return keys.map((k) => found.get(k) ?? k);
}

/**
 * パラメータ一覧の { name, minimum, maximum } から値の範囲を引く。
 * 範囲が決まっている値（エネルギーは 0〜100、雰囲気は -100〜100）は、その範囲で縦軸を描く。
 * データの最小と最大で描くと、わずかな揺れも大きな山に見えてしまうため。
 */
function sentimentRanges(keys: string[], params: unknown): ({ min: number; max: number } | null)[] {
  const found = new Map<string, { min: number; max: number }>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.name === "string" && keys.includes(o.name) && typeof o.minimum === "number" && typeof o.maximum === "number" && o.maximum > o.minimum) {
      found.set(o.name, { min: o.minimum, max: o.maximum });
    }
    Object.values(o).forEach(visit);
  };
  visit(params);
  return keys.map((k) => found.get(k) ?? null);
}

function trackWidth(svg: SVGSVGElement): number {
  return Math.max(200, svg.clientWidth || svg.parentElement?.clientWidth || 600);
}

function xScale(width: number): (ms: number) => number {
  const span = Math.max(1, timeline?.durationMs ?? 1);
  return (ms) => PAD_L + (Math.min(Math.max(ms, 0), span) / span) * (width - PAD_L - PAD_R);
}

function drawTimeline(): void {
  if (!timeline) return;
  const tl = timeline;

  // 話者（誰がいつ話したか）
  const sp = $("svg-speakers") as unknown as SVGSVGElement;
  if (tl.speakers.length > 0) {
    const w = trackWidth(sp);
    const x = xScale(w);
    sp.setAttribute("viewBox", `0 0 ${w} 20`);
    sp.replaceChildren(
      ...tl.speakers.map((u) =>
        svg("rect", {
          x: x(u.s),
          y: 4,
          width: Math.max(2, x(u.e) - x(u.s) - 2), // 2px の隙間で隣の発話と分ける
          height: 12,
          rx: 2,
          class: "speaker-fill",
          "data-speaker": u.speaker % 6,
        }),
      ),
    );
  }

  // 話す速さ（30 秒ごと）
  drawLine($("svg-rate") as unknown as SVGSVGElement, tl.rate.map((p) => ({ t: p.t + RATE_WINDOW_MS / 2, v: p.cpm })), "文字/分");

  // 感情（選んだパラメータ 1 つ）
  if (tl.sentiment) {
    const i = sentimentIndex;
    drawLine(
      $("svg-sentiment") as unknown as SVGSVGElement,
      tl.sentiment.segments.map((s) => ({ t: (s.s + s.e) / 2, v: s.v[i] ?? 0 })),
      "",
      tl.sentiment.ranges[i] ?? undefined,
    );
  }

  // フィラー（出た時刻に短い縦線）
  const fs = $("svg-fillers") as unknown as SVGSVGElement;
  {
    const w = trackWidth(fs);
    const x = xScale(w);
    fs.setAttribute("viewBox", `0 0 ${w} 20`);
    fs.replaceChildren(...tl.fillers.map((t) => svg("line", { x1: x(t), x2: x(t), y1: 3, y2: 17, class: "filler-tick" })));
  }

  // 時間軸
  const ax = $("svg-axis") as unknown as SVGSVGElement;
  {
    const w = trackWidth(ax);
    const x = xScale(w);
    ax.setAttribute("viewBox", `0 0 ${w} 22`);
    const step = niceStep(tl.durationMs, Math.max(2, Math.floor(w / 90)));
    const ticks: SVGElement[] = [];
    for (let t = 0; t <= tl.durationMs; t += step) {
      const anchor = t === 0 ? "start" : "middle";
      ticks.push(svg("line", { x1: x(t), x2: x(t), y1: 0, y2: 4, class: "axis-tick" }));
      const label = svg("text", { x: x(t), y: 17, "text-anchor": anchor, class: "axis-label" });
      label.textContent = clock(t);
      ticks.push(label);
    }
    ax.replaceChildren(...ticks);
  }
  drawCursor();
}

/** 単一系列の折れ線（2px）。y 軸は 0 から始め、最大値の目盛りを左上に小さく書く。 */
function drawLine(el: SVGSVGElement, points: { t: number; v: number }[], unit: string, range?: { min: number; max: number }): void {
  const w = trackWidth(el);
  const h = 72;
  const x = xScale(w);
  el.setAttribute("viewBox", `0 0 ${w} ${h}`);
  if (points.length === 0) {
    el.replaceChildren();
    return;
  }
  const max = range ? range.max : niceMax(Math.max(...points.map((p) => p.v)));
  const min = range ? range.min : Math.min(0, ...points.map((p) => p.v));
  const y = (v: number) => 6 + (1 - (v - min) / (max - min || 1)) * (h - 12);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const grid = [max, min < 0 && max > 0 ? 0 : (min + max) / 2].map((v) => svg("line", { x1: PAD_L, x2: w - PAD_R, y1: y(v), y2: y(v), class: "grid-line" }));
  const base = svg("line", { x1: PAD_L, x2: w - PAD_R, y1: y(min), y2: y(min), class: "base-line" });
  const top = svg("text", { x: PAD_L + 2, y: y(max) + 11, class: "axis-label" });
  top.textContent = `${max}${unit ? ` ${unit}` : ""}`;
  const path = svg("path", { d, class: "series-line" });
  const children: SVGElement[] = [...grid, base, top, path];
  // 点が少ないときは点も打つ（線だけだと 1 点が見えない）
  if (points.length <= 2) for (const p of points) children.push(svg("circle", { cx: x(p.t), cy: y(p.v), r: 4, class: "series-dot" }));
  el.replaceChildren(...children);
}

function drawCursor(): void {
  for (const id of ["svg-speakers", "svg-rate", "svg-sentiment", "svg-fillers"]) {
    const el = $(id) as unknown as SVGSVGElement;
    el.querySelector(".cursor")?.remove();
    if (cursorMs === null || !timeline) continue;
    const w = trackWidth(el);
    const x = xScale(w)(cursorMs);
    const h = Number(el.getAttribute("viewBox")?.split(" ")[3] ?? 20);
    el.append(svg("line", { x1: x, x2: x, y1: 0, y2: h, class: "cursor" }));
  }
  renderTooltip();
}

function renderTooltip(): void {
  const tip = $("tooltip");
  if (cursorMs === null || !timeline) {
    tip.hidden = true;
    return;
  }
  const t = cursorMs;
  const tl = timeline;
  const rows: [string, string][] = [];
  const who = tl.speakers.find((u) => u.s <= t && t <= u.e);
  if (tl.speakers.length > 0) rows.push([who ? speakerName(who.speaker) : "–", "話者"]);
  const rate = tl.rate.find((p) => p.t <= t && t < p.t + RATE_WINDOW_MS);
  rows.push([rate ? `${rate.cpm} 文字/分` : "–", "話す速さ"]);
  if (tl.sentiment) {
    const seg = nearest(tl.sentiment.segments, t);
    rows.push([seg ? String(seg.v[sentimentIndex]) : "–", tl.sentiment.labels[sentimentIndex] ?? "感情"]);
  }
  const windowStart = Math.floor(t / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const fillers = tl.fillers.filter((f) => f >= windowStart && f < windowStart + RATE_WINDOW_MS).length;
  rows.push([`${fillers} 回`, "この 30 秒のフィラー"]);

  tip.replaceChildren();
  const head = document.createElement("p");
  head.className = "tooltip-time";
  head.textContent = clock(t);
  tip.append(head);
  for (const [value, label] of rows) {
    const row = document.createElement("p");
    const v = document.createElement("strong");
    v.textContent = value;
    const l = document.createElement("span");
    l.textContent = label;
    row.append(v, l);
    tip.append(row);
  }
  tip.hidden = false;
  const box = $("timeline");
  const svgEl = $("svg-rate") as unknown as SVGSVGElement;
  const px = xScale(trackWidth(svgEl))(t) + svgEl.getBoundingClientRect().left - box.getBoundingClientRect().left;
  const left = px + 16 + tip.offsetWidth > box.clientWidth ? px - 16 - tip.offsetWidth : px + 16;
  tip.style.left = `${Math.max(0, left)}px`;
}

function nearest<T extends { s: number; e: number }>(items: T[], t: number): T | undefined {
  let best: T | undefined;
  let bestDist = Infinity;
  for (const it of items) {
    const dist = t < it.s ? it.s - t : t > it.e ? t - it.e : 0;
    if (dist < bestDist) {
      best = it;
      bestDist = dist;
    }
  }
  return bestDist <= 5000 ? best : undefined;
}

function timeAtPointer(ev: PointerEvent | MouseEvent): number | null {
  if (!timeline) return null;
  const svgEl = $("svg-rate") as unknown as SVGSVGElement;
  const rect = svgEl.getBoundingClientRect();
  const w = rect.width;
  const span = timeline.durationMs;
  const ratio = (ev.clientX - rect.left - PAD_L) / (w - PAD_L - PAD_R);
  return Math.min(Math.max(ratio, 0), 1) * span;
}

const timelineEl = $("timeline");
timelineEl.addEventListener("pointermove", (ev) => {
  cursorMs = timeAtPointer(ev);
  drawCursor();
});
timelineEl.addEventListener("pointerleave", () => {
  cursorMs = null;
  drawCursor();
});
timelineEl.addEventListener("click", (ev) => {
  const t = timeAtPointer(ev);
  if (t !== null) jumpTranscript(t);
});
timelineEl.addEventListener("keydown", (ev) => {
  if (!timeline) return;
  if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
    ev.preventDefault();
    const delta = ev.key === "ArrowRight" ? 5000 : -5000;
    cursorMs = Math.min(Math.max((cursorMs ?? 0) + delta, 0), timeline.durationMs);
    drawCursor();
  } else if (ev.key === "Enter" && cursorMs !== null) {
    jumpTranscript(cursorMs);
  }
});
timelineEl.addEventListener("blur", () => {
  cursorMs = null;
  drawCursor();
});
new ResizeObserver(() => drawTimeline()).observe(timelineEl);

function renderTimelineTable(): void {
  if (!timeline) return;
  const table = $("timeline-table");
  table.replaceChildren();
  const head = document.createElement("tr");
  const cols = ["時刻", "話す速さ（文字/分）", ...(timeline.sentiment ? [`${timeline.sentiment.labels[sentimentIndex]}（平均）`] : []), "フィラー（回）"];
  for (const c of cols) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = c;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  const tbody = document.createElement("tbody");
  for (let t = 0; t < timeline.durationMs; t += RATE_WINDOW_MS) {
    const rate = timeline.rate.find((p) => p.t === t);
    const cells = [clock(t), rate ? String(rate.cpm) : "–"];
    if (timeline.sentiment) {
      const segs = timeline.sentiment.segments.filter((s) => s.s >= t && s.s < t + RATE_WINDOW_MS);
      cells.push(segs.length ? (segs.reduce((sum, s) => sum + (s.v[sentimentIndex] ?? 0), 0) / segs.length).toFixed(1) : "–");
    }
    cells.push(String(timeline.fillers.filter((f) => f >= t && f < t + RATE_WINDOW_MS).length));
    const tr = document.createElement("tr");
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
}

// ---------------------------------------------------------------------------
// 書き起こし
// ---------------------------------------------------------------------------

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="source"]')) {
  radio.addEventListener("change", () => {
    source = radio.value as "archive" | "live";
    renderTranscript();
  });
}

function renderTranscript(): void {
  if (!detail) return;
  const lines: CaptionLine[] = source === "archive" ? detail.archive : detail.live;
  const list = $("transcript");
  list.replaceChildren();
  const empty = $("transcript-empty");
  empty.hidden = lines.length > 0;
  empty.textContent = source === "archive" ? "アーカイブ字幕はまだありません。" : "ライブ字幕はありません。";
  let prev: number | undefined;
  for (const l of lines) {
    const li = document.createElement("li");
    li.dataset.start = String(l.startMs);
    if (l.speaker !== undefined) li.dataset.speaker = String(l.speaker % 6);
    const time = document.createElement("button");
    time.type = "button";
    time.className = "transcript-time";
    time.textContent = clock(l.startMs);
    time.setAttribute("aria-label", `${clock(l.startMs)} から再生`);
    time.addEventListener("click", () => playFrom(l.startMs));
    const body = document.createElement("p");
    if (l.speaker !== undefined && l.speaker !== prev) {
      const who = document.createElement("span");
      who.className = "speaker-name";
      who.textContent = speakerName(l.speaker);
      body.append(who);
    }
    prev = l.speaker;
    body.append(l.text);
    li.append(time, body);
    list.append(li);
  }
}

function jumpTranscript(ms: number): void {
  const items = [...$("transcript").children] as HTMLElement[];
  let target: HTMLElement | undefined;
  for (const li of items) {
    if (Number(li.dataset.start) <= ms) target = li;
    else break;
  }
  target ??= items[0];
  if (!target) return;
  for (const li of items) li.classList.remove("is-current");
  target.classList.add("is-current");
  target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  (target.querySelector(".transcript-time") as HTMLButtonElement | null)?.focus({ preventScroll: true });
}

// ---- 録音の再生（認証が要るので、押したときに取りに行く） ----
const audio = $<HTMLAudioElement>("audio");
let audioLoading: Promise<void> | null = null;

async function loadAudio(): Promise<void> {
  audioLoading ??= (async () => {
    const button = $<HTMLButtonElement>("load-audio");
    button.disabled = true;
    button.textContent = "録音を読み込んでいます…";
    const res = await fetch(api(`/talks/${talkId}/audio`), { headers: authHeaders });
    if (!res.ok) {
      button.disabled = false;
      button.textContent = "録音を聞く";
      audioLoading = null;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    audio.src = URL.createObjectURL(await res.blob());
    audio.hidden = false;
    button.hidden = true;
  })();
  return audioLoading;
}

$("load-audio").addEventListener("click", () => {
  loadAudio().catch((err: unknown) => setActionStatus(`録音を読み込めませんでした: ${errorText(err)}`, true));
});

async function playFrom(ms: number): Promise<void> {
  if ($("load-audio").hidden && audio.hidden) return; // 録音が無い
  try {
    await loadAudio();
    audio.currentTime = ms / 1000;
    await audio.play();
  } catch (err) {
    setActionStatus(`再生できませんでした: ${errorText(err)}`, true);
  }
}

// ---------------------------------------------------------------------------
// 次の登壇に向けた辞書
// ---------------------------------------------------------------------------

interface Suggestion extends DictionaryTerm {
  heard: string;
  reason: string;
}

let suggestions: Suggestion[] = [];

function renderUnsure(r: TalkReport): void {
  const list = $("unsure-list");
  list.replaceChildren();
  // 同じ語はまとめ、いちばん低い信頼度を出す
  const byWord = new Map<string, { confidence: number; count: number; spoken?: string }>();
  for (const u of r.lowConfidence) {
    const cur = byWord.get(u.written);
    if (cur) {
      cur.count++;
      cur.confidence = Math.min(cur.confidence, u.confidence);
    } else byWord.set(u.written, { confidence: u.confidence, count: 1, spoken: u.spoken });
  }
  const sorted = [...byWord.entries()].sort((a, b) => a[1].confidence - b[1].confidence);
  for (const [word, info] of sorted.slice(0, 80)) {
    const li = document.createElement("li");
    const w = document.createElement("span");
    w.className = "unsure";
    w.textContent = word;
    li.append(w, ` ${info.spoken ? `（${info.spoken}）` : ""}信頼度 ${info.confidence.toFixed(2)}${info.count > 1 ? `・${info.count} 回` : ""}`);
    list.append(li);
  }
  $("unsure-count").textContent = String(byWord.size);
  $("unsure-details").hidden = byWord.size === 0;
}

$("suggest").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("suggest");
  button.disabled = true;
  setSuggestStatus("Claude が書き起こしを読んでいます。数十秒かかります…");
  try {
    const res = await fetch(api(`/talks/${talkId}/suggestions`), { method: "POST", headers: authHeaders });
    const body = (await res.json()) as { suggestions?: Suggestion[]; error?: string };
    if (!res.ok || !body.suggestions) throw new Error(body.error ?? `HTTP ${res.status}`);
    suggestions = body.suggestions;
    renderSuggestions();
    setSuggestStatus(suggestions.length === 0 ? "辞書に足すべき語は見つかりませんでした。" : `${suggestions.length} 語の候補があります。足したい語を選んでください。`);
  } catch (err) {
    setSuggestStatus(`候補を出せませんでした: ${errorText(err)}`, true);
  } finally {
    button.disabled = false;
  }
});

function renderSuggestions(): void {
  const list = $("suggestions");
  list.replaceChildren();
  suggestions.forEach((s, i) => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.dataset.index = String(i);
    const main = document.createElement("span");
    main.className = "suggestion-main";
    const written = document.createElement("strong");
    written.textContent = s.written;
    const readings = document.createElement("span");
    readings.className = "suggestion-readings";
    readings.textContent = s.readings.join("、") || "読みなし";
    main.append(written, readings);
    const heard = document.createElement("span");
    heard.className = "suggestion-heard";
    heard.textContent = `字幕では「${s.heard}」。${s.reason}`;
    label.append(box, main, heard);
    li.append(label);
    list.append(li);
  });
  $("add-suggestions").hidden = suggestions.length === 0;
}

$("add-suggestions").addEventListener("click", async () => {
  const chosen = [...document.querySelectorAll<HTMLInputElement>("#suggestions input:checked")].map((b) => suggestions[Number(b.dataset.index)]!);
  if (chosen.length === 0) {
    setSuggestStatus("足す語を選んでください。", true);
    return;
  }
  const res = await fetch(api("/dictionary"), { headers: authHeaders });
  if (!res.ok) {
    setSuggestStatus("今の辞書を読み込めませんでした。", true);
    return;
  }
  const { terms } = (await res.json()) as { terms: DictionaryTerm[] };
  // 同じ表記がすでにあれば読みだけ足す
  let added = 0;
  let extended = 0;
  for (const s of chosen) {
    const existing = terms.find((t) => t.written === s.written);
    if (existing) {
      const before = existing.readings.length;
      existing.readings = [...new Set([...existing.readings, ...s.readings])];
      if (existing.readings.length > before) extended++;
    } else {
      terms.push({ written: s.written, readings: s.readings, source: "振り返り" });
      added++;
    }
  }
  const put = await fetch(api("/dictionary"), {
    method: "PUT",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ terms }),
  });
  if (!put.ok) {
    setSuggestStatus("辞書を保存できませんでした。", true);
    return;
  }
  setSuggestStatus(`辞書に ${added} 語を足し、${extended} 語に読みを足しました。次の配信から使われます。`);
});

function setSuggestStatus(text: string, isError = false): void {
  const el = $("suggest-status");
  el.textContent = text;
  el.classList.toggle("is-error", isError);
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

$("retry").addEventListener("click", async () => {
  const res = await fetch(api(`/talks/${talkId}/retry`), { method: "POST", headers: authHeaders });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setActionStatus(`作り直せませんでした: ${body.error ?? res.status}`, true);
    return;
  }
  setActionStatus("作り直しを始めました。");
  void load();
});

// 削除は元に戻せないので、1 回目の押下で確認の文言に変え、2 回目で消す
let deleteArmed = false;
$("delete-recording").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("delete-recording");
  if (!deleteArmed) {
    deleteArmed = true;
    button.textContent = "もう一度押すと録音を削除します（元に戻せません）";
    button.classList.add("is-danger");
    setTimeout(() => {
      deleteArmed = false;
      button.textContent = "録音を削除する";
      button.classList.remove("is-danger");
    }, 5000);
    return;
  }
  deleteArmed = false;
  const res = await fetch(api(`/talks/${talkId}/recording`), { method: "DELETE", headers: authHeaders });
  button.textContent = "録音を削除する";
  button.classList.remove("is-danger");
  if (!res.ok) {
    setActionStatus("録音を削除できませんでした。", true);
    return;
  }
  setActionStatus("録音と AmiVoice の生の結果を削除しました。字幕と振り返りは残っています。");
  void load();
});

function setActionStatus(text: string, isError = false): void {
  const el = $("action-status");
  el.textContent = text;
  el.classList.toggle("is-error", isError);
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * exp) return m * exp;
  return 10 * exp;
}

function niceStep(durationMs: number, maxTicks: number): number {
  const steps = [10, 15, 30, 60, 120, 300, 600, 900, 1800].map((s) => s * 1000);
  return steps.find((s) => durationMs / s <= maxTicks) ?? 3_600_000;
}

function clock(ms: number): string {
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, "0")}秒`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

void load();
