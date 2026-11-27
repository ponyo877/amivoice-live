// 登壇者の画面。/speaker.html#room=<id>&token=<token> で開く（トークンはサーバのログに残らないよう # の後ろに置く）。

import QRCode from "qrcode";
import { ENGINES, isValidReading, normalizeReading, sharedReadings, type DictionaryTerm } from "../shared/amivoice.ts";
import type { LiveStats, ServerMessage, TalkSummary, UsageStatus } from "../shared/protocol.ts";
import { listMicrophones, startCapture, type AudioSourceKind, type Capture } from "./audio.ts";
import { CaptionView } from "./captions.ts";
import { LiveSocket, wsUrl } from "./socket.ts";
import { anchorPopovers, clock, flashLabel, icon, setIcon, setupTabs, setupThemeToggle } from "./ui.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- ルームの特定 ----
const hash = new URLSearchParams(location.hash.slice(1));
const roomId = hash.get("room") ?? localStorage.getItem("speaker-room") ?? "";
const token = hash.get("token") ?? localStorage.getItem(`speaker-token:${roomId}`) ?? "";
if (roomId && token) {
  localStorage.setItem("speaker-room", roomId);
  localStorage.setItem(`speaker-token:${roomId}`, token);
}
if (!roomId || !token) {
  location.replace("/");
  throw new Error("room is not specified");
}
const api = (path: string) => `/api/rooms/${encodeURIComponent(roomId)}${path}`;
const authHeaders = { authorization: `Bearer ${token}` };

// ---- 画面の枠 ----
setupThemeToggle($<HTMLButtonElement>("app-theme"));
anchorPopovers();
setupTabs(document.querySelector<HTMLElement>(".app-nav .tabs")!);
$("room-code").textContent = roomId;

// ---- 要素 ----
const sourceSel = $<HTMLSelectElement>("source");
const micSel = $<HTMLSelectElement>("mic");
const fileInput = $<HTMLInputElement>("audio-file");
const engineSel = $<HTMLSelectElement>("engine");
const useDict = $<HTMLInputElement>("use-dictionary");
const diarization = $<HTMLInputElement>("diarization");
const archive = $<HTMLInputElement>("archive");
const toggle = $<HTMLButtonElement>("toggle");
const statusEl = $("status");
const meter = $("meter");
const tally = $("tally");
const tallyText = $("tally-text");
const empty = $("empty");
const netState = $("net-state");
const micState = $("mic-state");

for (const e of ENGINES) engineSel.add(new Option(e.label, e.id));
engineSel.value = localStorage.getItem("speaker-engine") ?? ENGINES[0]!.id;
engineSel.addEventListener("change", () => {
  localStorage.setItem("speaker-engine", engineSel.value);
  if (capture) sendStart();
});
useDict.addEventListener("change", () => {
  if (capture) sendStart();
});
diarization.checked = localStorage.getItem("speaker-diarization") === "1";
archive.checked = localStorage.getItem("speaker-archive") !== "0";
diarization.addEventListener("change", () => {
  localStorage.setItem("speaker-diarization", diarization.checked ? "1" : "0");
  if (capture) sendStart();
});
archive.addEventListener("change", () => {
  localStorage.setItem("speaker-archive", archive.checked ? "1" : "0");
});

/** 操作の行の「入力」ボタンに、いま選んでいる入力を出す。 */
function renderInputLabel(): void {
  const kind = sourceSel.value as AudioSourceKind;
  $("mic-field").hidden = kind !== "mic";
  $("file-field").hidden = kind !== "file";
  const label =
    kind === "mic"
      ? micSel.selectedOptions[0]?.text ?? "マイク"
      : kind === "tab"
        ? "タブの音声"
        : fileInput.files?.[0]?.name ?? "音声ファイル";
  $("input-label").textContent = kind === "mic" && !micSel.value ? "マイク" : label;
  setIcon($("input-button"), kind === "mic" ? "mic" : kind === "tab" ? "screen" : "file");
}
sourceSel.addEventListener("change", renderInputLabel);
micSel.addEventListener("change", renderInputLabel);
fileInput.addEventListener("change", renderInputLabel);

async function refreshMics(): Promise<void> {
  const mics = await listMicrophones().catch(() => []);
  const current = micSel.value;
  micSel.replaceChildren(new Option("既定のマイク", ""));
  for (const m of mics) if (m.deviceId) micSel.add(new Option(m.label || "名前のないマイク", m.deviceId));
  micSel.value = current;
  renderInputLabel();
}
void refreshMics();
navigator.mediaDevices?.addEventListener("devicechange", () => void refreshMics());

// ---- 共有 ----
const viewerBase = `${location.origin}/view.html?room=${roomId}`;
const shareTheme = () => document.querySelector<HTMLInputElement>('input[name="share-theme"]:checked')?.value ?? "dark";
const obsTheme = () => document.querySelector<HTMLInputElement>('input[name="obs-theme"]:checked')?.value ?? "transparent-dark";
// トップの「ルームを作る」で選んだ配色を、共有の既定にする
const savedTheme = localStorage.getItem(`room-theme:${roomId}`);
if (savedTheme === "light") document.querySelector<HTMLInputElement>('input[name="share-theme"][value="light"]')!.checked = true;
if (savedTheme?.startsWith("transparent")) {
  const obs = document.querySelector<HTMLInputElement>(`input[name="obs-theme"][value="${savedTheme}"]`);
  if (obs) obs.checked = true;
}

function viewerUrl(): string {
  let url = viewerBase;
  if (shareTheme() === "light") url += "&theme=light";
  if ($<HTMLInputElement>("share-focus").checked) url += "&focus=1";
  return url;
}
function overlayUrl(): string {
  return `${viewerBase}&theme=${obsTheme()}`;
}

let qrUrl = "";
function renderShare(): void {
  const url = viewerUrl();
  $<HTMLInputElement>("viewer-url").value = url;
  $<HTMLInputElement>("overlay-url").value = overlayUrl();
  $<HTMLAnchorElement>("overlay-link").href = overlayUrl();
  if (url !== qrUrl) {
    qrUrl = url;
    void QRCode.toCanvas($<HTMLCanvasElement>("qr"), url, { width: 320, margin: 1, color: { dark: "#0a0a0a", light: "#ffffff" } });
  }
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="share-theme"], input[name="obs-theme"], #share-focus')) {
  input.addEventListener("change", renderShare);
}
renderShare();
setupTabs(document.querySelector<HTMLElement>("#share-pop .tabs")!);

$<HTMLAnchorElement>("export-md").href = api("/transcript?format=md");
$<HTMLAnchorElement>("export-vtt").href = api("/transcript?format=vtt");
$<HTMLAnchorElement>("export-json").href = api("/transcript?format=json");

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(viewerUrl());
  flashLabel($("copy"), "コピーしました");
});
$("copy-overlay").addEventListener("click", async () => {
  await navigator.clipboard.writeText(overlayUrl());
  flashLabel($("copy-overlay"), "コピーしました");
});
$("download-qr").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = $<HTMLCanvasElement>("qr").toDataURL("image/png");
  a.download = `amivoice-live-${roomId}-qr.png`;
  a.click();
});

// ---- 配信 ----
const preview = $("preview");
const captions = new CaptionView($("stage"), { jumpButton: $<HTMLButtonElement>("jump") });
let capture: Capture | null = null;

const socket = new LiveSocket({
  url: wsUrl(`${api("/ws")}?role=speaker&token=${encodeURIComponent(token)}`),
  onOpen: () => {
    setNetState("open", "サーバにつながっています");
    // 配信中に接続が切れてつなぎ直したときは、認識を再開する
    if (capture) sendStart();
  },
  onClose: ({ code, willRetry }) => {
    if (code === 4000) {
      setNetState("error", "別の画面が登壇者として接続しました");
      setStatus("別の画面が登壇者として接続したため、この画面は止まりました。", true);
    } else if (willRetry) {
      setNetState("retry", "接続が切れました。つなぎ直しています");
      setStatus("サーバとの接続が切れました。つなぎ直しています…", true);
    } else {
      setNetState("error", "サーバにつなげません");
    }
  },
  onMessage: (msg) => handleMessage(msg),
});

function setNetState(state: string, label: string): void {
  netState.dataset.state = state;
  netState.title = label;
  netState.setAttribute("aria-label", label);
  setIcon(netState, state === "retry" || state === "error" ? "wifi-off" : "wifi");
}

function setMicState(state: "off" | "starting" | "on" | "error", label: string): void {
  micState.dataset.state = state;
  micState.title = label;
  micState.setAttribute("aria-label", label);
  setIcon(micState, state === "on" ? "mic" : state === "starting" ? "clock" : "mic-off");
}

function handleMessage(msg: ServerMessage): void {
  captions.handle(msg);
  empty.hidden = !captions.isEmpty;
  switch (msg.type) {
    case "snapshot":
      $("title").textContent = msg.room.title;
      document.title = `${msg.room.title} | 登壇者の画面`;
      localStorage.setItem(`speaker-title:${roomId}`, msg.room.title);
      setLive(msg.room.live);
      setViewers(msg.viewers);
      break;
    case "room":
      setLive(msg.room.live);
      break;
    case "viewers":
      setViewers(msg.count);
      break;
    case "stats":
      renderStats(msg.stats);
      break;
    case "talks":
      renderTalks(msg.talks);
      break;
    case "usage":
      renderUsage(msg.usage);
      break;
    case "upstream":
      if (msg.state === "connecting") setStatus("AmiVoice に接続しています…");
      else if (msg.state === "open") setStatus("認識しています。話してください。");
      else if (msg.state === "closed") setStatus("");
      else setStatus(msg.message ?? "エラーが起きました", true);
      break;
    default:
      break;
  }
}

function setViewers(count: number): void {
  $("viewers").textContent = String(count);
  $("viewers-badge").textContent = String(count);
}

function sendStart(): void {
  socket.send(
    JSON.stringify({
      type: "start",
      engine: engineSel.value,
      useDictionary: useDict.checked,
      diarization: diarization.checked,
      archive: archive.checked,
    }),
  );
}

// 経過時間（配信を始めてからの時間。終えたあとは最後の値を残す）
let startedAt = 0;
let elapsedTimer: number | undefined;
function startElapsed(): void {
  startedAt = Date.now();
  $("elapsed").textContent = "0:00";
  clearInterval(elapsedTimer);
  elapsedTimer = window.setInterval(() => {
    $("elapsed").textContent = clock((Date.now() - startedAt) / 1000);
  }, 1000);
}

toggle.addEventListener("click", async () => {
  if (capture) {
    stopLive();
    return;
  }
  toggle.disabled = true;
  setMicState("starting", "マイクを準備しています");
  try {
    if (!socket.isOpen) throw new Error("サーバに接続できていません。少し待ってからもう一度押してください。");
    sendStart();
    const kind = sourceSel.value as AudioSourceKind;
    capture = await startCapture({
      kind,
      deviceId: micSel.value || undefined,
      file: fileInput.files?.[0],
      onChunk: (pcm) => socket.send(pcm),
      onLevel: (level) => {
        meter.style.transform = `scaleX(${Math.min(1, level * 4)})`;
      },
      onEnded: () => stopLive(),
    });
    if (kind === "mic") void refreshMics(); // 許可後はマイク名が取れる
    setMicState("on", kind === "mic" ? "マイクの音声を送っています" : "音声を送っています");
    setToggle(true);
    startElapsed();
    archive.disabled = true; // 録音するかどうかは登壇の途中で変えられない
  } catch (err) {
    socket.send(JSON.stringify({ type: "stop" }));
    setMicState("error", "音声を取り込めませんでした");
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    toggle.disabled = false;
  }
});

function stopLive(): void {
  capture?.stop();
  capture = null;
  socket.send(JSON.stringify({ type: "stop" }));
  meter.style.transform = "scaleX(0)";
  clearInterval(elapsedTimer);
  setMicState("off", "マイクは止まっています");
  setToggle(false);
  archive.disabled = false;
}

function setToggle(live: boolean): void {
  $("toggle-text").textContent = live ? "配信を終える" : "配信を始める";
  setIcon(toggle, live ? "stop" : "play");
  toggle.classList.toggle("primary", !live);
  toggle.classList.toggle("live", live);
}

function setLive(live: boolean): void {
  tally.dataset.live = String(live);
  tallyText.textContent = live ? "配信中" : "待機中";
}

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("is-error", isError);
}

function renderStats(s: LiveStats): void {
  $("stat-finalize").textContent = s.finalizeMedianMs === null ? "–" : `${s.finalizeMedianMs} ms`;
  $("stat-lag").textContent = s.lagMedianMs === null ? "–" : `${s.lagMedianMs} ms`;
  $("stat-count").textContent = String(s.utterances);
  $("stat-audio").textContent = clock(s.audioSentMs / 1000);
}

/** 全部の勉強会を合わせた今月の使用量。録音から作り直す分（アーカイブと振り返りで音声の長さの 2 倍）も含む */
function renderUsage(u: UsageStatus): void {
  const fmt = (sec: number) => {
    const m = Math.round(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)} 時間 ${m % 60} 分` : `${m} 分`;
  };
  const el = $("stat-usage");
  el.textContent = u.limitSeconds === null ? `${fmt(u.seconds)}（上限なし）` : `${fmt(u.seconds)} / ${fmt(u.limitSeconds)}`;
  const low = u.remainingSeconds !== null && u.remainingSeconds < 30 * 60;
  el.classList.toggle("is-warning", low);
  $("usage-left").textContent = u.remainingSeconds === null ? `今月 ${fmt(u.seconds)}` : `残り ${fmt(u.remainingSeconds)}`;
  $("usage-pill").classList.toggle("is-warning", low);
}

// ---- 全画面（プレゼン表示と書き起こし表示） ----
const PRESENT_SIZES = [32, 40, 48, 56, 64, 72, 88];
let presentSize = Number(localStorage.getItem("present-size") ?? 3);
let presentMode: "present" | "continuous" | null = null;
let hideTimer: number | undefined;

function applyPresentSize(): void {
  presentSize = Math.max(0, Math.min(PRESENT_SIZES.length - 1, presentSize));
  localStorage.setItem("present-size", String(presentSize));
  const px = PRESENT_SIZES[presentSize]!;
  preview.style.setProperty("--caption-size", presentMode === "continuous" ? `${Math.round(px * 0.75)}px` : `${px}px`);
}

/** 全画面に入る。Fullscreen API が使えない（拒否された）ときは、ページ全体を覆う表示で代わりにする。 */
async function enterPresent(mode: "present" | "continuous"): Promise<void> {
  if (presentMode === mode) {
    exitPresent();
    return;
  }
  presentMode = mode;
  preview.classList.toggle("is-present", mode === "present");
  preview.classList.toggle("is-continuous", mode === "continuous");
  $("present-label").textContent = mode === "present" ? "プレゼン表示" : "書き起こし表示";
  applyPresentSize();
  if (!document.fullscreenElement && !preview.classList.contains("is-fullpage")) {
    try {
      await preview.requestFullscreen();
    } catch {
      preview.classList.add("is-fullpage");
    }
  }
  scrollStageToBottom();
  showTools();
}

function exitPresent(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else cleanupPresent();
}

function cleanupPresent(): void {
  presentMode = null;
  preview.classList.remove("is-present", "is-continuous", "is-fullpage", "tools-hidden");
  preview.style.removeProperty("--caption-size");
  clearTimeout(hideTimer);
  scrollStageToBottom();
}

function scrollStageToBottom(): void {
  const stage = $("stage");
  requestAnimationFrame(() => (stage.scrollTop = stage.scrollHeight));
}

function showTools(): void {
  preview.classList.remove("tools-hidden");
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => preview.classList.add("tools-hidden"), 2500);
}

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && !preview.classList.contains("is-fullpage")) cleanupPresent();
  else scrollStageToBottom();
});
preview.addEventListener("pointermove", () => {
  if (presentMode) showTools();
});
$("present").addEventListener("click", () => void enterPresent("present"));
$("continuous").addEventListener("click", () => void enterPresent("continuous"));
$("present-exit").addEventListener("click", exitPresent);
$("present-smaller").addEventListener("click", () => {
  presentSize--;
  applyPresentSize();
});
$("present-larger").addEventListener("click", () => {
  presentSize++;
  applyPresentSize();
});
document.addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.isComposing) return;
  const target = ev.target as HTMLElement;
  if (target.closest("input, textarea, select, [contenteditable]")) return;
  if (ev.key === "Escape" && preview.classList.contains("is-fullpage")) cleanupPresent();
  if ($("view-live").hidden) return;
  if (ev.key === "f" || ev.key === "F") void enterPresent("present");
  else if (ev.key === "t" || ev.key === "T") void enterPresent("continuous");
});

// ---- 登壇の記録 ----
const STATUS_TEXT: Record<TalkSummary["status"], string> = {
  live: "配信中",
  interrupted: "録音を回収しています",
  recorded: "アーカイブを準備しています",
  archiving: "AmiVoice で認識し直しています",
  done: "完了",
  error: "失敗",
  "no-audio": "音声なし",
};

function renderTalks(talks: TalkSummary[]): void {
  const list = $("talk-list");
  list.replaceChildren();
  $("talks-empty").hidden = talks.length > 0;
  $("talk-count").textContent = String(talks.length);
  for (const t of talks) {
    const li = document.createElement("li");
    li.className = "talk";
    li.dataset.status = t.status;
    const main = document.createElement("div");
    main.className = "talk-main";
    const when = document.createElement("span");
    when.className = "talk-when";
    when.textContent = new Date(t.startedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const length = document.createElement("span");
    length.className = "talk-length";
    length.textContent = t.audioMs > 0 ? formatDuration(t.audioMs) : "";
    const status = document.createElement("span");
    status.className = "talk-status";
    status.textContent = t.status === "done" && !t.archive ? "完了（録音なし）" : STATUS_TEXT[t.status];
    if (t.error) status.title = t.error;
    main.append(when, length, status);
    const links = document.createElement("div");
    links.className = "talk-links";
    links.append(link(api(`/transcript?talk=${t.id}&format=md`), "ライブ字幕", "download"));
    if (t.archiveReady) links.append(link(api(`/transcript?talk=${t.id}&source=archive&format=vtt`), "アーカイブ（VTT）", "download"));
    if (t.status !== "live") {
      const report = link(`/report.html#room=${encodeURIComponent(roomId)}&talk=${t.id}`, t.reportReady ? "振り返りを見る" : "詳細", "chart");
      report.classList.replace("ghost", "primary");
      links.append(report);
    }
    li.append(main, links);
    list.append(li);
  }
}

function link(href: string, text: string, iconName: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.className = "btn sm ghost";
  a.target = "_blank";
  a.rel = "noopener";
  a.append(icon(iconName), text);
  return a;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, "0")}秒`;
}

// ---- 辞書 ----
const termsBody = $("terms-body");
const dictStatus = $("dict-status");
let terms: DictionaryTerm[] = [];

function setDictStatus(text: string, isError = false): void {
  dictStatus.textContent = text;
  dictStatus.classList.toggle("is-error", isError);
}

const dictWarning = $("dict-warning");
let readingInputs: HTMLInputElement[] = [];

function renderTerms(): void {
  termsBody.replaceChildren();
  readingInputs = [];
  terms.forEach((t, i) => {
    const tr = document.createElement("tr");
    const written = cellInput(t.written, "表記", (v) => {
      terms[i]!.written = v;
      markSharedReadings();
    });
    const readings = cellInput(t.readings.join("、"), "読み", (v) => {
      terms[i]!.readings = v.split(/[、,，\s]+/).filter(Boolean);
      markReadings(readings.input, terms[i]!.readings);
      markSharedReadings();
    });
    markReadings(readings.input, t.readings);
    readingInputs.push(readings.input);
    const source = document.createElement("td");
    source.className = "source";
    source.textContent = t.source ?? "";
    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn icon sm ghost";
    remove.title = "削除";
    remove.setAttribute("aria-label", `${t.written || "この語"} を削除`);
    remove.append(icon("trash"));
    remove.addEventListener("click", () => {
      terms.splice(i, 1);
      renderTerms();
    });
    actions.append(remove);
    tr.append(written.td, readings.td, source, actions);
    termsBody.append(tr);
  });
  $("term-count").textContent = String(terms.length);
  $("term-count-tab").textContent = String(terms.length);
  $("terms-empty").hidden = terms.length > 0;
  markSharedReadings();
}

/** 同じ読みの語があると、どちらの表記が字幕に出るかはエンジン次第になるので、欄に印を付けて組を文で示す。 */
function markSharedReadings(): void {
  const shared = sharedReadings(terms);
  const marked = new Set(shared.flatMap((s) => s.indices));
  readingInputs.forEach((input, i) => input.toggleAttribute("data-shared", marked.has(i)));
  dictWarning.textContent = shared.length
    ? `同じ読みの語があります（${shared
        .map((s) => `${s.reading}: ${s.indices.map((i) => terms[i]!.written || "（表記なし）").join(" と ")}`)
        .join("、")}）。どちらの表記が字幕に出るかはエンジン次第なので、片方を消すか、読みを変えてください。`
    : "";
}

/** ハイブリッドエンジンは読みのない語を使えないので、読みが空か、ひらがなに直せない文字を含む行を赤くする。 */
function markReadings(input: HTMLInputElement, readings: string[]): void {
  const ok = readings.length > 0 && readings.every((r) => isValidReading(normalizeReading(r)));
  input.setAttribute("aria-invalid", String(!ok));
  input.title = ok ? "" : "ひらがな（カタカナも可）で読みを入れてください。読みのない語はハイブリッドエンジンでは使われません";
}

function cellInput(value: string, label: string, onInput: (v: string) => void): { td: HTMLTableCellElement; input: HTMLInputElement } {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => onInput(input.value));
  td.append(input);
  return { td, input };
}

async function loadTerms(): Promise<void> {
  const res = await fetch(api("/dictionary"), { headers: authHeaders });
  if (!res.ok) return;
  terms = ((await res.json()) as { terms: DictionaryTerm[] }).terms;
  renderTerms();
}
void loadTerms();

$("add-term").addEventListener("click", () => {
  terms.push({ written: "", readings: [], source: "手入力" });
  renderTerms();
  (termsBody.lastElementChild?.querySelector("input") as HTMLInputElement | null)?.focus();
});

$<HTMLInputElement>("pdf").addEventListener("change", () => {
  const file = $<HTMLInputElement>("pdf").files?.[0];
  $("pdf-name").textContent = file ? file.name : "スライドの PDF を選ぶ";
});

$("extract").addEventListener("click", async () => {
  const pdf = $<HTMLInputElement>("pdf").files?.[0];
  const text = $<HTMLTextAreaElement>("source-text").value;
  if (!pdf && !text.trim()) {
    setDictStatus("PDF を選ぶか、資料のテキストを貼り付けてください。", true);
    return;
  }
  const button = $<HTMLButtonElement>("extract");
  button.disabled = true;
  setDictStatus("Claude が資料を読んでいます。数十秒かかります…");
  try {
    const res = await fetch(api("/dictionary/extract"), {
      method: "POST",
      headers: { ...authHeaders, "content-type": pdf ? "application/pdf" : "text/plain; charset=utf-8" },
      body: pdf ?? text,
    });
    const body = (await res.json()) as { terms?: DictionaryTerm[]; error?: string };
    if (!res.ok || !body.terms) throw new Error(body.error ?? `HTTP ${res.status}`);
    // 既存の語は残し、新しい語を後ろに足す
    const known = new Set(terms.map((t) => t.written));
    const added = body.terms.filter((t) => !known.has(t.written));
    terms = [...terms, ...added];
    renderTerms();
    setDictStatus(`${added.length} 語を追加しました。読みを確かめてから「辞書を保存」を押してください。`);
  } catch (err) {
    setDictStatus(`抜き出せませんでした: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    button.disabled = false;
  }
});

$("save-dict").addEventListener("click", async () => {
  const cleaned = terms.filter((t) => t.written.trim());
  const res = await fetch(api("/dictionary"), {
    method: "PUT",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ terms: cleaned }),
  });
  const body = (await res.json()) as { terms?: DictionaryTerm[]; error?: string };
  if (!res.ok || !body.terms) {
    setDictStatus(`保存できませんでした: ${body.error ?? res.status}`, true);
    return;
  }
  const dropped = cleaned.length - body.terms.length;
  terms = body.terms;
  renderTerms();
  setDictStatus(dropped > 0 ? `保存しました（表記が重複していた ${dropped} 語はまとめました）。` : "保存しました。");
});
