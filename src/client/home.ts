// トップページ。ルームを作って登壇者の画面に移る。このブラウザで作ったルームの一覧も出す。

import QRCode from "qrcode";
import { icon, setupThemeToggle } from "./ui.ts";

const REPO_URL = "https://github.com/ponyo877/amivoice-live";

setupThemeToggle(document.getElementById("app-theme") as HTMLButtonElement);

// 見本の QR コード（読むとこのリポジトリが開く）
for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas.demo-qr")) {
  void QRCode.toCanvas(canvas, REPO_URL, { width: 240, margin: 0, color: { dark: "#0a0a0a", light: "#ffffff" } });
}

// ---- ルームを作る ----
const dialog = document.getElementById("create-dialog") as HTMLDialogElement;
const form = document.getElementById("create-form") as HTMLFormElement;
const statusEl = document.getElementById("create-status") as HTMLElement;

for (const button of document.querySelectorAll<HTMLElement>("[data-open-create]")) {
  button.addEventListener("click", () => {
    dialog.showModal();
    form.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
  });
}
document.getElementById("create-close")?.addEventListener("click", () => dialog.close());
// ダイアログの外側（背景）を押したら閉じる
dialog.addEventListener("click", (ev) => {
  if (ev.target === dialog) dialog.close();
});

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const data = new FormData(form);
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  button.disabled = true;
  statusEl.textContent = "作っています…";
  statusEl.classList.remove("is-error");
  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: data.get("title"), passphrase: data.get("passphrase") }),
    });
    const body = (await res.json()) as { roomId?: string; token?: string; error?: string };
    if (!res.ok || !body.roomId || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`);
    localStorage.setItem(`speaker-title:${body.roomId}`, String(data.get("title") ?? ""));
    localStorage.setItem(`room-theme:${body.roomId}`, String(data.get("theme") ?? "dark"));
    location.href = `/speaker.html#room=${body.roomId}&token=${body.token}`;
  } catch (err) {
    statusEl.textContent = `作れませんでした: ${err instanceof Error ? err.message : String(err)}`;
    statusEl.classList.add("is-error");
    button.disabled = false;
  }
});

// ---- このブラウザで作ったルーム ----
// 登壇者のトークンはこのブラウザの localStorage にしかないので、一覧から消すとこのブラウザからは開けなくなる
function myRooms(): { id: string; token: string; title: string }[] {
  const rooms: { id: string; token: string; title: string }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith("speaker-token:")) continue;
    const id = key.slice("speaker-token:".length);
    const token = localStorage.getItem(key);
    if (!id || !token) continue;
    rooms.push({ id, token, title: localStorage.getItem(`speaker-title:${id}`) || "名前のないルーム" });
  }
  // 最後に開いたルームを先頭にする
  const last = localStorage.getItem("speaker-room");
  return rooms.sort((a, b) => Number(b.id === last) - Number(a.id === last));
}

function renderRooms(): void {
  const rooms = myRooms();
  const section = document.getElementById("my-rooms") as HTMLElement;
  const list = document.getElementById("room-list") as HTMLElement;
  section.hidden = rooms.length === 0;
  list.replaceChildren();
  for (const room of rooms) {
    const li = document.createElement("li");
    li.className = "room-item";
    const main = document.createElement("div");
    main.className = "room-item-main";
    const title = document.createElement("strong");
    title.textContent = room.title;
    const id = document.createElement("small");
    id.textContent = room.id;
    main.append(title, id);

    const join = document.createElement("a");
    join.className = "btn primary sm";
    join.href = `/speaker.html#room=${room.id}&token=${room.token}`;
    join.textContent = "開く";

    const view = document.createElement("a");
    view.className = "btn icon sm ghost";
    view.href = `/view.html?room=${room.id}`;
    view.target = "_blank";
    view.rel = "noopener";
    view.title = "参加者の画面を開く";
    view.setAttribute("aria-label", `${room.title} の参加者の画面を開く`);
    view.append(icon("arrow-up-right"));

    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "btn icon sm ghost";
    forget.title = "このブラウザの一覧から消す";
    forget.setAttribute("aria-label", `${room.title} をこのブラウザの一覧から消す`);
    forget.append(icon("trash"));
    // 消すと登壇者の画面を開けなくなるので、1 回目の押下では確かめるだけにする
    let armed = false;
    forget.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        forget.classList.add("is-danger");
        forget.title = "もう一度押すと一覧から消えます（このブラウザからは登壇者の画面を開けなくなります）";
        setTimeout(() => {
          armed = false;
          forget.classList.remove("is-danger");
          forget.title = "このブラウザの一覧から消す";
        }, 4000);
        return;
      }
      localStorage.removeItem(`speaker-token:${room.id}`);
      localStorage.removeItem(`speaker-title:${room.id}`);
      localStorage.removeItem(`room-theme:${room.id}`);
      if (localStorage.getItem("speaker-room") === room.id) localStorage.removeItem("speaker-room");
      renderRooms();
    });

    li.append(main, join, view, forget);
    list.append(li);
  }
}
renderRooms();
