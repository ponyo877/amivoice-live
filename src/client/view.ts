// 参加者の字幕画面。?room=<id> で開く。
// ?theme=dark|light で配色を、?focus=1 で字幕だけの表示を指定できる。
// ?theme=transparent-dark|transparent-light は OBS・プロジェクター向けの透過表示（最新の 2 行だけを帯に乗せる）。
// 以前の ?mode=overlay は ?theme=transparent-dark と同じに扱う。

import { CaptionView, speakerName } from "./captions.ts";
import { LiveSocket, wsUrl } from "./socket.ts";
import { flashLabel, setIcon } from "./ui.ts";

const params = new URLSearchParams(location.search);
const roomId = params.get("room") ?? "";
const themeParam = params.get("mode") === "overlay" ? "transparent-dark" : params.get("theme");
const overlay = themeParam === "transparent-dark" || themeParam === "transparent-light";
const focus = overlay || params.get("focus") === "1" || params.get("focus") === "true";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("stage");
const empty = $("empty");
const tally = $("tally");
const tallyText = $("tally-text");
const titleEl = $("title");
const connection = $("connection");
const legend = $("legend");
const recording = $("recording");
const netState = $("net-state");

document.body.classList.toggle("is-overlay", overlay);
document.body.classList.toggle("is-overlay-light", themeParam === "transparent-light");
document.body.classList.toggle("is-focus", focus);

// ---- 文字の大きさと配色（端末ごとに保存。URL で配色が指定されていればそれを優先する） ----
const SIZES = [20, 24, 28, 34, 40, 48, 56];
let sizeIndex = Number(localStorage.getItem("caption-size") ?? (focus ? 5 : 2));
let light = themeParam === "light" || (themeParam !== "dark" && localStorage.getItem("caption-theme") === "light");

function applyPrefs(): void {
  sizeIndex = Math.max(0, Math.min(SIZES.length - 1, sizeIndex));
  document.documentElement.style.setProperty("--caption-size", `${SIZES[sizeIndex]}px`);
  document.body.dataset.captionTheme = light && !overlay ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light && !overlay ? "#f6f6f6" : "#141414");
  const themeButton = $("theme");
  themeButton.querySelector("span")!.textContent = light ? "暗く" : "明るく";
  themeButton.setAttribute("aria-label", light ? "暗い表示に切り替える" : "明るい表示に切り替える");
  setIcon(themeButton, light ? "moon" : "sun");
  localStorage.setItem("caption-size", String(sizeIndex));
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
  localStorage.setItem("caption-theme", light ? "light" : "dark");
  applyPrefs();
});
applyPrefs();

// ---- 全画面と共有 ----
const fullscreenButton = $("fullscreen");
if (!document.fullscreenEnabled) fullscreenButton.hidden = true;
fullscreenButton.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
});
document.addEventListener("fullscreenchange", () => {
  const full = Boolean(document.fullscreenElement);
  const label = full ? "全画面をやめる" : "全画面にする";
  fullscreenButton.setAttribute("aria-label", label);
  fullscreenButton.title = label;
  setIcon(fullscreenButton, full ? "minimize" : "maximize");
});

$("share").addEventListener("click", async () => {
  const url = `${location.origin}/view.html?room=${encodeURIComponent(roomId)}`;
  if (navigator.share) {
    await navigator.share({ title: titleEl.textContent ?? "字幕", url }).catch(() => undefined);
    return;
  }
  await navigator.clipboard.writeText(url);
  flashLabel($("share"), "コピーしました");
});

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

function setNetState(state: string, label: string): void {
  netState.dataset.state = state;
  netState.title = label;
  netState.setAttribute("aria-label", label);
  setIcon(netState, state === "retry" || state === "error" ? "wifi-off" : "wifi");
}

if (!roomId) {
  $("empty-text").textContent = "URL にルームの指定がありません。登壇者から共有された QR コードか URL を開いてください。";
  setNetState("error", "ルームの指定がありません");
} else {
  // 一度もつながらないうちに切れたら、ルームがあるかを 1 回だけ確かめる。無ければつなぎ直さずにそう伝える
  let opened = false;
  let checked = false;
  let missing = false;
  const socket: LiveSocket = new LiveSocket({
    url: wsUrl(`/api/rooms/${encodeURIComponent(roomId)}/ws?role=viewer`),
    onOpen: () => {
      opened = true;
      connection.hidden = true;
      setNetState("open", "つながっています");
    },
    onClose: ({ willRetry }) => {
      if (missing) return;
      connection.hidden = false;
      connection.textContent = willRetry ? "接続が切れました。つなぎ直しています…" : "接続できませんでした。URL を確かめてください。";
      setNetState(willRetry ? "retry" : "error", willRetry ? "つなぎ直しています" : "つなげません");
      if (opened || checked) return;
      checked = true;
      void fetch(`/api/rooms/${encodeURIComponent(roomId)}`)
        .then((res) => {
          if (res.status !== 404) return;
          missing = true;
          socket.close();
          connection.textContent = "このルームは見つかりません。URL を確かめてください。";
          setNetState("error", "ルームが見つかりません");
          $("empty-text").textContent = "このルームは見つかりません。登壇者から共有された QR コードか URL を開き直してください。";
        })
        .catch(() => {
          // 確かめられないときは、つなぎ直しを続ける
        });
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
