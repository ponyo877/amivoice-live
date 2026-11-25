// 字幕の描画。放送のロールアップ字幕のように下から積み上げ、話している途中の行は淡い色で出して確定したら白にする。
// - 辞書に登録した語は、認識できたことが分かるよう下線で示す
// - 認識エンジンが自信を持てなかった語（信頼度の低いトークン）は点線で示す
// - 話者ダイアライゼーションを使っているときは、話者ごとに色の帯を付け、話者が替わった行に名前を出す

import type { CaptionLine, ServerMessage } from "../shared/protocol.ts";

const MAX_LINES_IN_DOM = 300;
/** 信頼度がこれより低いトークンに点線を付ける。 */
export const UNSURE_BELOW = 0.5;
/** 色を割り当てる話者の数。これを超えたら色を使い回す */
const SPEAKER_COLORS = 6;

export interface CaptionViewOptions {
  jumpButton?: HTMLButtonElement | null;
  /** 自信のない語に印を付けるか（投影用の表示では付けない） */
  showUnsure?: boolean;
  /** 字幕に出てきた話者・自信のない語の有無が変わったときに呼ばれる（凡例の表示に使う） */
  onLegend?: (legend: { speakers: number[]; unsure: boolean }) => void;
}

export function speakerName(speaker: number): string {
  return `話者${speaker + 1}`;
}

export class CaptionView {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly partialEl: HTMLElement;
  private readonly jumpButton: HTMLButtonElement | null;
  private readonly showUnsure: boolean;
  private readonly onLegend?: CaptionViewOptions["onLegend"];
  private termPattern: RegExp | null = null;
  private follow = true;
  private lastId = 0;
  private lastSpeaker: number | undefined;
  private readonly speakers = new Set<number>();
  private hasUnsure = false;

  constructor(root: HTMLElement, opts: CaptionViewOptions = {}) {
    this.root = root;
    this.jumpButton = opts.jumpButton ?? null;
    this.showUnsure = opts.showUnsure ?? true;
    this.onLegend = opts.onLegend;
    this.list = document.createElement("div");
    this.list.className = "caption-lines";
    // 確定した行だけを読み上げ対象にする（途中結果まで読み上げるとうるさい）
    this.list.setAttribute("role", "log");
    this.list.setAttribute("aria-live", "polite");
    this.partialEl = document.createElement("p");
    this.partialEl.className = "caption-line is-partial";
    this.partialEl.setAttribute("aria-hidden", "true");
    root.append(this.list, this.partialEl);

    root.addEventListener("scroll", () => {
      const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 48;
      this.setFollow(nearBottom);
    });
    this.jumpButton?.addEventListener("click", () => {
      this.setFollow(true);
      this.scrollToBottom();
    });
  }

  /** サーバからのメッセージのうち字幕に関係するものを反映する。 */
  handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "snapshot":
        this.setTerms(msg.terms);
        this.list.replaceChildren();
        this.lastId = 0;
        this.lastSpeaker = undefined;
        for (const line of msg.lines) this.appendLine(line, false);
        this.setPartial(msg.partial);
        break;
      case "terms":
        this.setTerms(msg.terms);
        break;
      case "partial":
        this.setPartial(msg.text);
        break;
      case "final":
        this.appendLine(msg.line, true);
        this.setPartial("");
        break;
      default:
        return;
    }
    if (this.follow) this.scrollToBottom();
  }

  get isEmpty(): boolean {
    return this.list.childElementCount === 0 && !this.partialEl.textContent;
  }

  private setTerms(terms: string[]): void {
    const usable = terms.map((t) => t.trim()).filter((t) => t.length >= 2);
    if (usable.length === 0) {
      this.termPattern = null;
      return;
    }
    // 長い語から先に当てる（"Workers AI" を "Workers" より優先）
    usable.sort((a, b) => b.length - a.length);
    this.termPattern = new RegExp(usable.map(escapeRegExp).join("|"), "giu");
  }

  private appendLine(line: CaptionLine, fresh: boolean): void {
    if (line.id <= this.lastId) return; // 再接続時の重複を防ぐ
    this.lastId = line.id;
    const p = document.createElement("p");
    p.className = fresh ? "caption-line is-fresh" : "caption-line";
    p.dataset.id = String(line.id);
    if (line.speaker !== undefined) {
      p.dataset.speaker = String(line.speaker % SPEAKER_COLORS);
      // 話者が替わった行にだけ名前を出す（毎行出すと字幕が読みにくい）
      if (line.speaker !== this.lastSpeaker) {
        const who = document.createElement("span");
        who.className = "speaker-name";
        who.textContent = speakerName(line.speaker);
        p.append(who);
      }
      this.noteSpeaker(line.speaker);
    }
    this.lastSpeaker = line.speaker;
    const body = document.createElement("span");
    renderCaptionText(body, line.text, this.termPattern, this.showUnsure ? line.tokens : undefined);
    if (this.showUnsure && !this.hasUnsure && body.querySelector(".unsure")) {
      this.hasUnsure = true;
      this.emitLegend();
    }
    p.append(body);
    this.list.append(p);
    while (this.list.childElementCount > MAX_LINES_IN_DOM) this.list.firstElementChild?.remove();
  }

  private noteSpeaker(speaker: number): void {
    if (this.speakers.has(speaker)) return;
    this.speakers.add(speaker);
    this.emitLegend();
  }

  private emitLegend(): void {
    this.onLegend?.({ speakers: [...this.speakers].sort((a, b) => a - b), unsure: this.hasUnsure });
  }

  private setPartial(text: string): void {
    renderCaptionText(this.partialEl, text, this.termPattern);
    this.partialEl.hidden = text.length === 0;
  }

  private setFollow(follow: boolean): void {
    this.follow = follow;
    if (this.jumpButton) this.jumpButton.hidden = follow;
  }

  private scrollToBottom(): void {
    this.root.scrollTop = this.root.scrollHeight;
  }
}

/**
 * 字幕の 1 行を描画する（innerHTML は使わない）。
 * 文字ごとに「辞書の語か」「自信のない語か」を求め、同じ組み合わせが続く範囲をまとめて 1 つの要素にする。
 * トークンは行の文字列の中を先頭から順に探して位置を合わせる（英単語の間の空白などで単純な連結とは一致しないため）。
 */
export function renderCaptionText(el: HTMLElement, text: string, termPattern: RegExp | null, tokens?: [string, number][]): void {
  el.replaceChildren();
  const n = text.length;
  const term = new Uint8Array(n);
  const unsure = new Float32Array(n).fill(1);
  if (termPattern) {
    for (const m of text.matchAll(termPattern)) {
      const start = m.index ?? 0;
      term.fill(1, start, start + m[0].length);
    }
  }
  let anyUnsure = false;
  if (tokens) {
    let cursor = 0;
    for (const [written, confidence] of tokens) {
      if (!written) continue;
      const at = text.indexOf(written, cursor);
      if (at === -1) continue;
      cursor = at + written.length;
      // 句読点や記号だけのトークンには印を付けない
      if (confidence < UNSURE_BELOW && /[\p{L}\p{N}]/u.test(written)) {
        unsure.fill(confidence, at, cursor);
        anyUnsure = true;
      }
    }
  }
  if (!termPattern && !anyUnsure) {
    el.textContent = text;
    return;
  }
  let start = 0;
  for (let i = 1; i <= n; i++) {
    const boundary = i === n || term[i] !== term[start] || (unsure[i]! < UNSURE_BELOW) !== (unsure[start]! < UNSURE_BELOW);
    if (!boundary) continue;
    const chunk = text.slice(start, i);
    const isTerm = term[start] === 1;
    const isUnsure = unsure[start]! < UNSURE_BELOW;
    if (!isTerm && !isUnsure) {
      el.append(chunk);
    } else {
      const span = document.createElement(isTerm ? "mark" : "span");
      span.className = [isTerm ? "term" : "", isUnsure ? "unsure" : ""].filter(Boolean).join(" ");
      if (isUnsure) span.title = `認識に自信のない語（信頼度 ${unsure[start]!.toFixed(2)}）`;
      span.textContent = chunk;
      el.append(span);
    }
    start = i;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
