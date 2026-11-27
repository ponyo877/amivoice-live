// 画面の部品で共通に使うもの: アイコン、明るい表示と暗い表示の切り替え、ポップオーバーの位置合わせ。

const SVG_NS = "http://www.w3.org/2000/svg";

/** public/icons.svg のアイコンを 1 つ作る。 */
export function icon(name: string, className = "i"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

/** ボタンの中のアイコンを差し替える。 */
export function setIcon(el: Element, name: string): void {
  el.querySelector("use")?.setAttribute("href", `/icons.svg#${name}`);
}

const THEME_KEY = "app-theme";

/**
 * 明るい表示と暗い表示を切り替えるボタンにする。選んだ表示は端末に保存する。
 * 最初の表示は <head> のインラインスクリプトで描画の前に決めている（ちらつきを防ぐため）。
 */
export function setupThemeToggle(button: HTMLButtonElement): void {
  const render = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    const label = dark ? "明るい表示に切り替える" : "暗い表示に切り替える";
    button.setAttribute("aria-label", label);
    button.title = label;
    setIcon(button, dark ? "sun" : "moon");
  };
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    render();
  });
  render();
}

/**
 * popover 属性の要素を、開いたボタンのそばに出す。
 * ボタンが画面の下半分にあれば上に、上半分にあれば下に開き、右端をボタンにそろえる。
 */
export function anchorPopovers(): void {
  const invokers = new Map<string, HTMLElement>();
  document.addEventListener(
    "click",
    (ev) => {
      const button = (ev.target as Element | null)?.closest<HTMLElement>("[popovertarget]");
      const target = button?.getAttribute("popovertarget");
      if (button && target) invokers.set(target, button);
    },
    true,
  );
  const place = (pop: HTMLElement) => {
    const invoker = invokers.get(pop.id);
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    if (!invoker || !invoker.isConnected) {
      pop.style.left = `${Math.round((window.innerWidth - w) / 2)}px`;
      pop.style.top = `${Math.round((window.innerHeight - h) / 2)}px`;
      pop.dataset.placed = "";
      return;
    }
    const gap = 8;
    const margin = 12;
    const r = invoker.getBoundingClientRect();
    let left = Math.min(r.right - w, window.innerWidth - w - margin);
    left = Math.max(margin, left);
    const below = r.bottom + gap;
    const above = r.top - gap - h;
    const preferAbove = r.top > window.innerHeight / 2;
    let top = preferAbove ? above : below;
    if (top < margin) top = below;
    if (top + h > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - h);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.dataset.placed = "";
  };
  for (const pop of document.querySelectorAll<HTMLElement>("[popover]")) {
    pop.addEventListener("toggle", (ev) => {
      if ((ev as ToggleEvent).newState === "open") place(pop);
      else delete pop.dataset.placed;
    });
  }
  const replace = () => {
    for (const pop of document.querySelectorAll<HTMLElement>("[popover]:popover-open")) place(pop);
  };
  window.addEventListener("resize", replace);
  window.addEventListener("scroll", replace, { passive: true });
}

/** 秒を「1:05」や「1:02:03」の形にする。 */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * role="tablist" の中のタブを切り替えられるようにする。パネルは各タブの aria-controls で指す。
 * 左右の矢印キーでも移れる。
 */
export function setupTabs(tablist: HTMLElement, onChange?: (tab: HTMLElement) => void): (tab: HTMLElement) => void {
  const tabs = [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')];
  const select = (tab: HTMLElement) => {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      t.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !selected;
    }
    onChange?.(tab);
  };
  for (const tab of tabs) tab.addEventListener("click", () => select(tab));
  tablist.addEventListener("keydown", (ev) => {
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    if (i === -1) return;
    const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length]!;
    next.focus();
    select(next);
  });
  return select;
}

/** ボタンの文字を一時的に変える（「コピーしました」など）。 */
export function flashLabel(button: HTMLElement, text: string, ms = 1500): void {
  const label = button.querySelector("span") ?? button;
  const original = label.textContent;
  label.textContent = text;
  setTimeout(() => (label.textContent = original), ms);
}
