// 参加者の字幕画面。?room=<id> で開く。?mode=overlay で OBS・プロジェクター向けの透過表示になる。

import { CaptionView, speakerName } from "./captions.ts";
import { LiveSocket, wsUrl } from "./socket.ts";

const params = new URLSearchParams(location.search);
const roomId = params.get("room") ?? "";
const overlay = params.get("mode") === "overlay";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("stage");
const empty = $("empty");
const tally = $("tally");
const tallyText = $("tally-text");
const titleEl = $("title");
const connection = $("connection");
const legend = $("legend");
const recording = $("recording");

if (overlay) document.body.classList.add("is-overlay");

// ---- 文字の大きさと配色（端末ごとに保存） ----
const SIZES = [20, 24, 28, 34, 40, 48, 56];
let sizeIndex = Number(localStorage.getItem("caption-size") ?? (overlay ? 5 : 2));
let light = localStorage.getItem("caption-theme") === "light";
function applyPrefs(): void {
  sizeIndex = Math.max(0, Math.min(SIZES.length - 1, sizeIndex));
  document.documentElement.style.setProperty("--caption-size", `${SIZES[sizeIndex]}px`);
  document.body.classList.toggle("is-light", light && !overlay);
  $("theme").setAttribute("aria-label", light ? "暗い表示に切り替える" : "明るい表示に切り替える");
  localStorage.setItem("caption-size", String(sizeIndex));
  localStorage.setItem("caption-theme", light ? "light" : "dark");
}
$("smaller").addEventListener("click", () => {
  sizeIndex--;
  applyPrefs();
});
$("larger").addEventListener("click", () => {
  sizeIndex++;
  applyPrefs();
});
$("theme").addEventListener("click", () => {
  light = !light;
  applyPrefs();
});
applyPrefs();

// ---- 字幕 ----
const captions = new CaptionView(stage, {
  jumpButton: $("jump") as HTMLButtonElement,
  showUnsure: !overlay,
  onLegend: ({ speakers, unsure }) => renderLegend(speakers, unsure),
});

/** 字幕に出てきた話者の色と、点線の意味を示す。 */
function renderLegend(speakers: number[], unsure: boolean): void {
  legend.replaceChildren();
  for (const s of speakers) {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.dataset.speaker = String(s % 6);
    item.textContent = speakerName(s);
    legend.append(item);
  }
  if (unsure) {
    const item = document.createElement("span");
    item.className = "legend-item legend-unsure";
    const sample = document.createElement("span");
    sample.className = "unsure";
    sample.textContent = "点線";
    item.append(sample, "は認識に自信のない語");
    legend.append(item);
  }
  legend.hidden = overlay || legend.childElementCount === 0;
}

if (!roomId) {
  empty.textContent = "URL にルームの指定がありません。登壇者から共有された QR コードか URL を開いてください。";
} else {
  new LiveSocket({
    url: wsUrl(`/api/rooms/${encodeURIComponent(roomId)}/ws?role=viewer`),
    onOpen: () => {
      connection.hidden = true;
    },
    onClose: ({ willRetry }) => {
      connection.hidden = false;
      connection.textContent = willRetry ? "接続が切れました。つなぎ直しています…" : "接続できませんでした。URL を確かめてください。";
    },
    onMessage: (msg) => {
      captions.handle(msg);
      if (msg.type === "snapshot" || msg.type === "room") {
        const room = msg.room;
        titleEl.textContent = room.title;
        document.title = `${room.title} の字幕 | amivoice-live`;
        tally.dataset.live = String(room.live);
        tallyText.textContent = room.live ? "配信中" : "待機中";
        recording.hidden = !room.recording;
      }
      empty.hidden = !captions.isEmpty;
    },
  });
}
