// トップページ。ルームを作って登壇者の画面に移る。

const form = document.getElementById("create-form") as HTMLFormElement;
const statusEl = document.getElementById("create-status") as HTMLElement;

const lastRoom = localStorage.getItem("speaker-room");
if (lastRoom && localStorage.getItem(`speaker-token:${lastRoom}`)) {
  (document.getElementById("resume") as HTMLElement).hidden = false;
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const data = new FormData(form);
  const button = form.querySelector("button") as HTMLButtonElement;
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
    location.href = `/speaker.html#room=${body.roomId}&token=${body.token}`;
  } catch (err) {
    statusEl.textContent = `作れませんでした: ${err instanceof Error ? err.message : String(err)}`;
    statusEl.classList.add("is-error");
    button.disabled = false;
  }
});
