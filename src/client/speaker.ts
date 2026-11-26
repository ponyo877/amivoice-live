// 登壇者の画面。/speaker.html#room=<id>&token=<token> で開く（トークンはサーバのログに残らないよう # の後ろに置く）。

import QRCode from "qrcode";
import { ENGINES, isValidReading, normalizeReading, type DictionaryTerm } from "../shared/amivoice.ts";
import type { LiveStats, ServerMessage, TalkSummary, UsageStatus } from "../shared/protocol.ts";
import { listMicrophones, startCapture, type AudioSourceKind, type Capture } from "./audio.ts";
import { CaptionView } from "./captions.ts";
import { LiveSocket, wsUrl } from "./socket.ts";

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

// ---- 要素 ----
const sourceSel = $<HTMLSelectElement>("source");
const micSel = $<HTMLSelectElement>("mic");
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

sourceSel.addEventListener("change", () => {
  const kind = sourceSel.value as AudioSourceKind;
  $("mic-field").hidden = kind !== "mic";
  $("file-field").hidden = kind !== "file";
});

async function refreshMics(): Promise<void> {
  const mics = await listMicrophones().catch(() => []);
  const current = micSel.value;
  micSel.replaceChildren(new Option("既定のマイク", ""));
  for (const m of mics) if (m.deviceId) micSel.add(new Option(m.label || "名前のないマイク", m.deviceId));
  micSel.value = current;
}
void refreshMics();
navigator.mediaDevices?.addEventListener("devicechange", () => void refreshMics());

// ---- 共有 ----
const viewerUrl = `${location.origin}/view.html?room=${roomId}`;
$<HTMLInputElement>("viewer-url").value = viewerUrl;
$<HTMLAnchorElement>("overlay-link").href = `${viewerUrl}&mode=overlay`;
$<HTMLAnchorElement>("export-md").href = api("/transcript?format=md");
$<HTMLAnchorElement>("export-vtt").href = api("/transcript?format=vtt");
$<HTMLAnchorElement>("export-json").href = api("/transcript?format=json");
void QRCode.toCanvas($<HTMLCanvasElement>("qr"), viewerUrl, {
  width: 168,
  margin: 1,
  color: { dark: "#1b2033", light: "#ffffff" },
});
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(viewerUrl);
  $("copy").textContent = "コピーしました";
  setTimeout(() => ($("copy").textContent = "コピー"), 1500);
});

// ---- 配信 ----
const captions = new CaptionView($("stage"), { jumpButton: $<HTMLButtonElement>("jump") });
let capture: Capture | null = null;

const socket = new LiveSocket({
  url: wsUrl(`${api("/ws")}?role=speaker&token=${encodeURIComponent(token)}`),
  onOpen: () => {
    // 配信中に接続が切れてつなぎ直したときは、認識を再開する
    if (capture) sendStart();
  },
  onClose: ({ code, willRetry }) => {
    if (code === 4000) setStatus("別の画面が登壇者として接続したため、この画面は止まりました。", true);
    else if (willRetry) setStatus("サーバとの接続が切れました。つなぎ直しています…", true);
  },
  onMessage: (msg) => handleMessage(msg),
});

function handleMessage(msg: ServerMessage): void {
  captions.handle(msg);
  empty.hidden = !captions.isEmpty;
  switch (msg.type) {
    case "snapshot":
      $("title").textContent = msg.room.title;
      document.title = `${msg.room.title} | 登壇者の画面`;
      setLive(msg.room.live);
      $("viewers").textContent = String(msg.viewers);
      break;
    case "room":
      setLive(msg.room.live);
      break;
    case "viewers":
      $("viewers").textContent = String(msg.count);
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

toggle.addEventListener("click", async () => {
  if (capture) {
    stopLive();
    return;
  }
  toggle.disabled = true;
  try {
    if (!socket.isOpen) throw new Error("サーバに接続できていません。少し待ってからもう一度押してください。");
    sendStart();
    const kind = sourceSel.value as AudioSourceKind;
    capture = await startCapture({
      kind,
      deviceId: micSel.value || undefined,
      file: $<HTMLInputElement>("audio-file").files?.[0],
      onChunk: (pcm) => socket.send(pcm),
      onLevel: (level) => {
        meter.style.transform = `scaleX(${Math.min(1, level * 4)})`;
      },
      onEnded: () => stopLive(),
    });
    if (kind === "mic") void refreshMics(); // 許可後はマイク名が取れる
    toggle.textContent = "配信を止める";
    toggle.classList.add("is-live");
    archive.disabled = true; // 録音するかどうかは登壇の途中で変えられない
  } catch (err) {
    socket.send(JSON.stringify({ type: "stop" }));
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
  toggle.textContent = "配信を始める";
  toggle.classList.remove("is-live");
  archive.disabled = false;
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
  const sec = Math.floor(s.audioSentMs / 1000);
  $("stat-audio").textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** 全部の勉強会を合わせた今月の使用量。録音から作り直す分（アーカイブと振り返りで音声の長さの 2 倍）も含む */
function renderUsage(u: UsageStatus): void {
  const fmt = (sec: number) => {
    const m = Math.round(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)} 時間 ${m % 60} 分` : `${m} 分`;
  };
  const el = $("stat-usage");
  el.textContent = u.limitSeconds === null ? `${fmt(u.seconds)}（上限なし）` : `${fmt(u.seconds)} / ${fmt(u.limitSeconds)}`;
  el.classList.toggle("is-warning", u.remainingSeconds !== null && u.remainingSeconds < 30 * 60);
}

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
  for (const t of talks) {
    const li = document.createElement("li");
    li.className = "talk";
    li.dataset.status = t.status;
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
    const links = document.createElement("span");
    links.className = "talk-links";
    links.append(link(api(`/transcript?talk=${t.id}&format=md`), "ライブ字幕"));
    if (t.archiveReady) links.append(link(api(`/transcript?talk=${t.id}&source=archive&format=vtt`), "アーカイブ（VTT）"));
    if (t.status !== "live") {
      const report = link(`/report.html#room=${encodeURIComponent(roomId)}&talk=${t.id}`, t.reportReady ? "振り返りを見る" : "詳細");
      report.classList.add("button", "small");
      links.append(report);
    }
    li.append(when, length, status, links);
    list.append(li);
  }
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  a.target = "_blank";
  a.rel = "noopener";
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

function renderTerms(): void {
  termsBody.replaceChildren();
  terms.forEach((t, i) => {
    const tr = document.createElement("tr");
    const written = cellInput(t.written, "表記", (v) => (terms[i]!.written = v));
    const readings = cellInput(t.readings.join("、"), "読み", (v) => {
      terms[i]!.readings = v.split(/[、,，\s]+/).filter(Boolean);
      markReadings(readings.input, terms[i]!.readings);
    });
    markReadings(readings.input, t.readings);
    const source = document.createElement("td");
    source.className = "source";
    source.textContent = t.source ?? "";
    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button small";
    remove.textContent = "削除";
    remove.setAttribute("aria-label", `${t.written || "この語"} を削除`);
    remove.addEventListener("click", () => {
      terms.splice(i, 1);
      renderTerms();
    });
    actions.append(remove);
    tr.append(written.td, readings.td, source, actions);
    termsBody.append(tr);
  });
  $("term-count").textContent = String(terms.length);
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
