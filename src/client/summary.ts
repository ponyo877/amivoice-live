// 「ここまでのまとめ」の描画。配信中に Claude が作り直すたびに、図・流れ・用語・質疑応答を描き直す。
// 図は節を段（矢印の向きで決まる深さ）ごとの行に並べ、行の中の配置はブラウザの折り返しに任せる。
// 節の位置が決まってから矢印を SVG で引く。作り直したときは、残った節を前の位置から新しい位置へ動かし、新しい節を光らせる。

import { layerRows } from "../shared/diagram-layout.ts";
import type { DiagramKind, LiveSummary, RoomInfo, ServerMessage, SummaryState } from "../shared/protocol.ts";

export const KIND_LABELS: Record<DiagramKind, string> = {
  concept: "概念",
  tool: "道具",
  problem: "問題",
  cause: "原因",
  solution: "対策",
  point: "結論",
};

export interface SummaryViewOptions {
  /** 見出し（既定は「ここまでのまとめ」） */
  title?: string;
  /** まとめが新しくなったときに呼ばれる（タブの印や「いま」の帯の更新に使う） */
  onUpdate?: (summary: LiveSummary | null) => void;
}

export class SummaryView {
  private readonly root: HTMLElement;
  private readonly onUpdate?: SummaryViewOptions["onUpdate"];
  private readonly head: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly body: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly diagram: DiagramView;
  private summary: LiveSummary | null = null;
  private room: RoomInfo | null = null;
  private dictionary = new Set<string>();
  private state: SummaryState = "idle";
  /** 参加者が自分でまとめを動かした時刻。しばらくは「いま」の節へ自動で送らない */
  private userScrolledAt = 0;

  constructor(root: HTMLElement, opts: SummaryViewOptions = {}) {
    this.root = root;
    this.onUpdate = opts.onUpdate;
    root.classList.add("summary");
    this.head = el("header", "summary-head");
    const h = el("h2", "summary-title", opts.title ?? "ここまでのまとめ");
    this.meta = el("p", "summary-meta");
    this.meta.setAttribute("aria-live", "polite");
    this.head.append(h, this.meta);
    this.body = el("div", "summary-body");
    this.empty = el("div", "summary-empty");
    this.diagram = new DiagramView();
    root.replaceChildren(this.head, this.body, this.empty);
    for (const type of ["wheel", "touchmove", "keydown", "pointerdown"]) {
      this.body.addEventListener(type, () => (this.userScrolledAt = Date.now()), { passive: true });
    }
    this.render();
  }

  get current(): LiveSummary | null {
    return this.summary;
  }

  handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "snapshot":
        this.room = msg.room;
        this.dictionary = new Set(msg.terms.map((t) => t.toLowerCase()));
        this.state = msg.summaryState === "working" ? "working" : "idle";
        this.setSummary(msg.summary);
        return;
      case "room": {
        const wasLive = this.room?.live;
        this.room = msg.room;
        // 配信の開始・終了で「いま」の表示が変わるので描き直す（前と同じまとめなので光らせない）
        if (wasLive !== msg.room.live) this.render(this.summary);
        else {
          this.renderMeta();
          this.renderEmpty();
        }
        return;
      }
      case "terms":
        this.dictionary = new Set(msg.terms.map((t) => t.toLowerCase()));
        return;
      case "summary":
        this.setSummary(msg.summary);
        return;
      case "summary-state":
        this.state = msg.state;
        this.renderMeta(msg.message);
        return;
      default:
        return;
    }
  }

  /** 振り返りの画面など、WebSocket を使わずに 1 回だけ描くとき。 */
  show(summary: LiveSummary | null, dictionary: string[] = []): void {
    this.dictionary = new Set(dictionary.map((t) => t.toLowerCase()));
    this.setSummary(summary);
  }

  private setSummary(summary: LiveSummary | null): void {
    const previous = this.summary;
    this.summary = summary;
    this.render(previous);
    this.onUpdate?.(summary);
  }

  private render(previous: LiveSummary | null = null): void {
    this.renderMeta();
    this.renderEmpty();
    const s = this.summary;
    if (!s) {
      this.body.replaceChildren();
      this.diagram.reset();
      return;
    }
    // 前の登壇のまとめから切り替わったときは、比べずに描き直す
    const prev = previous && previous.talkId === s.talkId ? previous : null;
    const oldTerms = new Set(prev?.terms.map((t) => t.term) ?? []);
    const oldSections = new Set(prev?.sections.map((x) => x.title) ?? []);

    const topic = el("p", "summary-topic", s.topic);
    const now = el("div", "summary-now");
    now.append(el("span", "summary-now-label", "いま"), el("p", "", s.now));
    if (prev && prev.now !== s.now) flash(now);

    // 「いま」は配信中だけ出す（終わったあとや振り返りの画面では、最後の発言にすぎないため）
    const parts: HTMLElement[] = this.room?.live ? [topic, now] : [topic];
    if (s.diagram.nodes.length > 0) parts.push(this.diagram.element);

    if (s.sections.length > 0) {
      const flow = section("流れ", "is-flow");
      const ol = el("ol", "flow");
      s.sections.forEach((sec, i) => {
        const li = el("li", "flow-item");
        if (i === s.sections.length - 1 && this.room?.live) li.classList.add("is-current");
        if (prev && !oldSections.has(sec.title)) flash(li);
        const time = el("time", "flow-time", clock(sec.startMs));
        const box = el("div", "flow-box");
        box.append(el("strong", "flow-title", sec.title));
        if (sec.points.length > 0) {
          const ul = el("ul", "flow-points");
          for (const p of sec.points) ul.append(el("li", "", p));
          box.append(ul);
        }
        li.append(time, box);
        ol.append(li);
      });
      flow.append(ol);
      parts.push(flow);
    }

    if (s.terms.length > 0) {
      const terms = section("用語", "is-terms");
      const dl = el("dl", "terms");
      for (const t of s.terms) {
        const item = el("div", "term-item");
        const dt = el("dt", this.dictionary.has(t.term.toLowerCase()) ? "is-dict" : "", t.term);
        item.append(dt, el("dd", "", t.note));
        if (prev && !oldTerms.has(t.term)) flash(item);
        dl.append(item);
      }
      terms.append(dl);
      parts.push(terms);
    }

    if (s.qa.length > 0) {
      const qa = section("質疑応答", "is-qa");
      for (const q of s.qa) {
        const item = el("div", "qa-item");
        const qp = el("p", "qa-q");
        qp.append(el("b", "", "Q"), q.question);
        item.append(qp);
        const ap = el("p", "qa-a");
        ap.append(el("b", "", "A"), q.answer || "（回答を待っています）");
        if (!q.answer) ap.classList.add("is-pending");
        item.append(ap);
        qa.append(item);
      }
      parts.push(qa);
    }
    this.body.replaceChildren(...parts);
    // 配信が終わったあと（振り返りの画面も）は「いま」の印を出さない
    const live = this.room?.live ?? false;
    if (s.diagram.nodes.length > 0) this.diagram.render(s.diagram, prev?.diagram ?? null, live);
    // 図が欄より高いと「いま」の節が隠れるので、節が動き終わってから見える位置まで送る
    if (live && prev && Date.now() - this.userScrolledAt > FOLLOW_PAUSE_MS) window.setTimeout(() => this.scrollToFocus(), 450);
  }

  private scrollToFocus(): void {
    const node = this.body.querySelector<HTMLElement>(".dnode.is-focus");
    if (!node || Date.now() - this.userScrolledAt <= FOLLOW_PAUSE_MS) return;
    const view = this.body.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    if (view.height === 0 || (r.top >= view.top + 8 && r.bottom <= view.bottom - 8)) return;
    const top = this.body.scrollTop + (r.top - view.top) - view.height / 2 + r.height / 2;
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.body.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  }

  private renderMeta(message?: string): void {
    this.meta.replaceChildren();
    if (this.state === "working") {
      const dot = el("span", "summary-spinner");
      dot.setAttribute("aria-hidden", "true");
      this.meta.append(dot, "Claude が更新しています…");
      return;
    }
    if (this.state === "error" && message) {
      this.meta.append(el("span", "summary-error", message));
      return;
    }
    if (this.summary) this.meta.append(`${clock(this.summary.upToMs)} までの字幕から Claude が作成`);
  }

  private renderEmpty(): void {
    this.empty.hidden = this.summary !== null;
    if (this.summary) return;
    let text = "配信が始まると、話の内容のまとめと図解がここに出ます。";
    if (this.room && !this.room.summary) text = "このルームでは、まとめを作らない設定です。";
    else if (this.room?.live) text = "話が少したまると、Claude がここに内容のまとめと図解を作ります。";
    this.empty.replaceChildren(el("p", "", text));
  }
}

// ---------------------------------------------------------------------------
// 図
// ---------------------------------------------------------------------------

type Diagram = LiveSummary["diagram"];

let uid = 0;

class DiagramView {
  readonly element: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly labels: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly markerId = `arrow-${++uid}`;
  private readonly focusMarkerId = `arrow-focus-${uid}`;
  private diagram: Diagram | null = null;
  /** 段ごとの行の要素と、節がどの段にあるか（長い矢印を途中の段の隙間に通すのに使う） */
  private nodes = new Map<string, HTMLElement>();
  /** 配信中か（「いま」の節とその矢印を目立たせるのは配信中だけ） */
  private live = false;
  private resizeObserver: ResizeObserver;
  private frame = 0;

  constructor() {
    this.element = el("figure", "diagram");
    this.caption = el("figcaption", "diagram-title");
    this.canvas = el("div", "diagram-canvas");
    this.svg = document.createElementNS(SVG, "svg");
    this.svg.classList.add("diagram-edges");
    this.svg.setAttribute("aria-hidden", "true");
    this.labels = el("div", "diagram-labels");
    this.labels.setAttribute("aria-hidden", "true");
    this.legend = el("ul", "diagram-legend");
    this.element.append(this.caption, this.canvas, this.legend);
    this.resizeObserver = new ResizeObserver(() => this.scheduleEdges());
    this.resizeObserver.observe(this.canvas);
  }

  reset(): void {
    this.diagram = null;
    this.nodes.clear();
    this.canvas.replaceChildren();
  }

  render(diagram: Diagram, previous: Diagram | null, live: boolean): void {
    // 描き直す前の節の位置を覚えておき、新しい位置へ動かす（FLIP）
    const before = new Map<string, DOMRect>();
    for (const [id, node] of this.nodes) if (node.isConnected) before.set(id, node.getBoundingClientRect());
    const known = new Set(previous?.nodes.map((n) => n.id) ?? []);

    this.diagram = diagram;
    this.live = live;
    this.caption.textContent = diagram.title;
    this.nodes = new Map();
    const rows = layerRows(diagram);
    const rowEls = rows.map((row) => {
      const r = el("div", "diagram-row");
      for (const id of row) {
        const n = diagram.nodes.find((x) => x.id === id)!;
        const node = el("div", "dnode");
        node.dataset.kind = n.kind;
        node.dataset.id = n.id;
        node.append(el("span", "dnode-kind", KIND_LABELS[n.kind]), el("span", "dnode-label", n.label));
        if (live && n.id === diagram.focus) {
          node.classList.add("is-focus");
          node.append(el("span", "dnode-now", "いま"));
        }
        if (previous && !known.has(n.id)) node.classList.add("is-new");
        this.nodes.set(n.id, node);
        r.append(node);
      }
      return r;
    });
    this.svg.replaceChildren(this.markers());
    this.labels.replaceChildren();
    this.canvas.replaceChildren(this.svg, ...rowEls, this.labels);
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", describe(diagram));

    const kinds = DIAGRAM_ORDER.filter((k) => diagram.nodes.some((n) => n.kind === k));
    this.legend.replaceChildren(
      ...kinds.map((k) => {
        const li = el("li", "");
        li.dataset.kind = k;
        li.append(el("span", "legend-swatch"), KIND_LABELS[k]);
        return li;
      }),
    );

    const animate = before.size > 0 && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (animate) {
      for (const [id, node] of this.nodes) {
        const old = before.get(id);
        if (!old) continue;
        const now = node.getBoundingClientRect();
        const dx = old.left - now.left;
        const dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        node.style.transform = `translate(${dx}px, ${dy}px)`;
        node.style.transition = "none";
      }
      // 次のフレームで元に戻し、transition で動かす
      requestAnimationFrame(() => {
        for (const node of this.nodes.values()) {
          if (!node.style.transform) continue;
          node.style.transition = "";
          node.style.transform = "";
        }
      });
      this.canvas.classList.add("is-moving");
      window.setTimeout(() => {
        this.canvas.classList.remove("is-moving");
        this.drawEdges();
      }, 420);
    }
    this.drawEdges();
  }

  private scheduleEdges(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.drawEdges());
  }

  /** 節の今の位置から矢印を引き直す。 */
  private drawEdges(): void {
    const d = this.diagram;
    if (!d || !this.canvas.isConnected) return;
    const box = this.canvas.getBoundingClientRect();
    if (box.width === 0) return; // タブで隠れている。見えたときに ResizeObserver が呼び直す
    this.svg.setAttribute("width", String(box.width));
    this.svg.setAttribute("height", String(box.height));
    this.svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    this.svg.replaceChildren(this.markers());
    this.labels.replaceChildren();
    // 下の段へ向かう矢印は、同じ節から出る（入る）ものを相手の位置の順に節の幅へ散らす
    const boxes = new Map<string, Box>();
    for (const [id, node] of this.nodes) boxes.set(id, offsetRect(node, box));
    const down = d.edges.filter((e) => boxes.has(e.from) && boxes.has(e.to) && boxes.get(e.to)!.top >= boxes.get(e.from)!.bottom - 4);
    const outPort = new Map<(typeof d.edges)[number], number>();
    const inPort = new Map<(typeof d.edges)[number], number>();
    const spread = (key: "from" | "to", other: "from" | "to", ports: Map<(typeof d.edges)[number], number>) => {
      const groups = new Map<string, typeof down>();
      for (const e of down) groups.set(e[key], [...(groups.get(e[key]) ?? []), e]);
      for (const [id, edges] of groups) {
        const b = boxes.get(id)!;
        edges.sort((x, y) => boxes.get(x[other])!.cx - boxes.get(y[other])!.cx);
        const width = Math.min(b.right - b.left - 16, edges.length * 22);
        edges.forEach((e, i) => ports.set(e, edges.length === 1 ? b.cx : b.cx - width / 2 + (width * i) / (edges.length - 1)));
      }
    };
    spread("from", "to", outPort);
    spread("to", "from", inPort);
    // ラベルどうしが重なったら上下にずらす（同じ節から扇状に出る矢印のラベルが重なりやすい）
    const placed: DOMRect[] = [];
    const overlaps = (r: DOMRect) => placed.some((q) => r.left < q.right + 2 && q.left < r.right + 2 && r.top < q.bottom + 1 && q.top < r.bottom + 1);
    for (const e of d.edges) {
      const ra = boxes.get(e.from);
      const rb = boxes.get(e.to);
      if (!ra || !rb) continue;
      const { path, mid } = this.route(e, ra, rb, boxes, box.width, outPort.get(e), inPort.get(e));
      const p = document.createElementNS(SVG, "path");
      p.setAttribute("d", path);
      const focus = this.live && d.focus !== "" && (e.from === d.focus || e.to === d.focus);
      p.setAttribute("class", focus ? "dedge is-focus" : "dedge");
      p.setAttribute("marker-end", `url(#${focus ? this.focusMarkerId : this.markerId})`);
      this.svg.append(p);
      if (e.label) {
        const label = el("span", focus ? "dedge-label is-focus" : "dedge-label", e.label);
        label.style.left = `${mid.x}px`;
        label.style.top = `${mid.y}px`;
        this.labels.append(label);
        let r = label.getBoundingClientRect();
        for (const k of [1, -1, 2, -2]) {
          if (!overlaps(r)) break;
          label.style.top = `${mid.y + k * (r.height + 2)}px`;
          r = label.getBoundingClientRect();
        }
        placed.push(r);
      }
    }
  }

  /**
   * 下の節へ向かう矢印が、途中にある節の行（狭い画面で段が折り返した行も含む）をまたぐときは、
   * その行では節と節の隙間を縦に通す（節の裏を横切らないように）。またがなければ edgePath の曲線のまま。
   */
  private route(e: Diagram["edges"][number], a: Box, b: Box, boxes: Map<string, Box>, width: number, fromX?: number, toX?: number) {
    if (b.top < a.bottom) return edgePath(a, b, fromX, toX);
    const x1 = fromX ?? a.cx;
    const x2 = toX ?? b.cx;
    const y1 = a.bottom + 3;
    const y2 = b.top - 3;
    // 画面上で縦に重なる節を 1 行にまとめ、両端の節のあいだにある行だけを取り出す
    const others = [...boxes].filter(([id]) => id !== e.from && id !== e.to).map(([, r]) => r);
    const lines = visualLines(others).filter((l) => l.top >= a.bottom - 2 && l.bottom <= b.top + 2);
    if (lines.length === 0) return edgePath(a, b, fromX, toX);
    const points: [number, number][] = [[x1, y1]];
    for (const line of lines) {
      const want = x1 + ((x2 - x1) * ((line.top + line.bottom) / 2 - y1)) / (y2 - y1);
      // 行の中の節の左右に 10px の余白を取り、その外側（隙間）で want にいちばん近い位置を選ぶ
      const free: [number, number][] = [];
      let from = 4;
      for (const n of line.blocks) {
        if (n.left - 10 > from) free.push([from, n.left - 10]);
        from = Math.max(from, n.right + 10);
      }
      free.push([from, width - 4]);
      let x = want;
      let best = Infinity;
      for (const [lo, hi] of free) {
        if (hi < lo) continue;
        const c = Math.min(hi, Math.max(lo, want));
        if (Math.abs(c - want) < best) {
          best = Math.abs(c - want);
          x = c;
        }
      }
      points.push([x, line.top - 6], [x, line.bottom + 6]);
    }
    points.push([x2, y2]);
    let path = `M ${points[0]![0]} ${points[0]![1]}`;
    for (let i = 1; i < points.length; i++) {
      const [px, py] = points[i - 1]!;
      const [qx, qy] = points[i]!;
      const dy = (qy - py) / 2;
      path += px === qx ? ` L ${qx} ${qy}` : ` C ${px} ${py + dy}, ${qx} ${qy - dy}, ${qx} ${qy}`;
    }
    // ラベルは最初の区間（出元の節のすぐ下）の中ほどに置く
    const [p0, p1] = [points[0]!, points[1]!];
    return { path, mid: { x: (p0[0] + p1[0]) / 2, y: (p0[1] + p1[1]) / 2 } };
  }

  private markers(): SVGDefsElement {
    const defs = document.createElementNS(SVG, "defs");
    for (const [id, cls] of [
      [this.markerId, "dedge-head"],
      [this.focusMarkerId, "dedge-head is-focus"],
    ] as const) {
      const marker = document.createElementNS(SVG, "marker");
      marker.setAttribute("id", id);
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "9");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "7");
      marker.setAttribute("markerHeight", "7");
      marker.setAttribute("orient", "auto-start-reverse");
      const head = document.createElementNS(SVG, "path");
      head.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
      head.setAttribute("class", cls);
      marker.append(head);
      defs.append(marker);
    }
    return defs;
  }
}

const SVG = "http://www.w3.org/2000/svg";
/** 参加者が自分でまとめを動かしてから、自動で送るのを控える時間 */
const FOLLOW_PAUSE_MS = 15_000;
const DIAGRAM_ORDER: DiagramKind[] = ["tool", "concept", "problem", "cause", "solution", "point"];

/** 縦に重なる節を、画面上の 1 行としてまとめる（上から順、行の中は左から順） */
function visualLines(boxes: Box[]): { top: number; bottom: number; blocks: Box[] }[] {
  const lines: { top: number; bottom: number; blocks: Box[] }[] = [];
  for (const b of [...boxes].sort((p, q) => p.top - q.top)) {
    const line = lines.at(-1);
    if (line && b.top < line.bottom - 4) {
      line.blocks.push(b);
      line.bottom = Math.max(line.bottom, b.bottom);
    } else lines.push({ top: b.top, bottom: b.bottom, blocks: [b] });
  }
  for (const l of lines) l.blocks.sort((p, q) => p.left - q.left);
  return lines;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  cx: number;
  cy: number;
}

function offsetRect(node: HTMLElement, canvas: DOMRect): Box {
  const r = node.getBoundingClientRect();
  const left = r.left - canvas.left;
  const top = r.top - canvas.top;
  return { left, top, right: left + r.width, bottom: top + r.height, cx: left + r.width / 2, cy: top + r.height / 2 };
}

/** 2 つの節を結ぶ曲線と、ラベルを置く中点。下の段へは縦に、同じ行では上に弧を描いて、上の段へは横から回り込む。 */
function edgePath(a: Box, b: Box, fromX = a.cx, toX = b.cx): { path: string; mid: { x: number; y: number } } {
  const gap = 3;
  if (b.top >= a.bottom - 4) {
    const x1 = fromX;
    const y1 = a.bottom + gap;
    const x2 = toX;
    const y2 = b.top - gap;
    const dy = Math.max(18, (y2 - y1) / 2);
    return cubic(x1, y1, x1, y1 + dy, x2, y2 - dy, x2, y2);
  }
  if (a.top >= b.bottom - 4) {
    // 上の段へ戻る矢印は、節の横から出して横に入れる
    const right = b.cx >= a.cx;
    const x1 = right ? a.right + gap : a.left - gap;
    const x2 = right ? b.right + gap : b.left - gap;
    const y1 = a.cy;
    const y2 = b.cy;
    const bulge = (right ? 1 : -1) * Math.max(28, Math.abs(y1 - y2) / 3);
    return cubic(x1, y1, x1 + bulge, y1, x2 + bulge, y2, x2, y2);
  }
  // 同じ行
  const forward = b.cx >= a.cx;
  const x1 = forward ? a.right + gap : a.left - gap;
  const x2 = forward ? b.left - gap : b.right + gap;
  const y = Math.min(a.top, b.top);
  const lift = Math.max(22, Math.abs(x2 - x1) / 4);
  return cubic(x1, a.cy, x1 + (forward ? 12 : -12), y - lift, x2 + (forward ? -12 : 12), y - lift, x2, b.cy);
}

function cubic(x1: number, y1: number, c1x: number, c1y: number, c2x: number, c2y: number, x2: number, y2: number) {
  const mid = { x: (x1 + 3 * c1x + 3 * c2x + x2) / 8, y: (y1 + 3 * c1y + 3 * c2y + y2) / 8 };
  return { path: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`, mid };
}

/** 画面読み上げ向けに、図を文章にする。 */
function describe(d: Diagram): string {
  const label = new Map(d.nodes.map((n) => [n.id, n.label]));
  const edges = d.edges.map((e) => `${label.get(e.from)}${e.label ? `（${e.label}）` : ""}から${label.get(e.to)}へ`);
  return `${d.title}。${d.nodes.map((n) => `${KIND_LABELS[n.kind]}: ${n.label}`).join("、")}。${edges.join("、")}。`;
}

// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title: string, kind: string): HTMLElement {
  const s = el("section", `summary-section ${kind}`);
  s.append(el("h3", "", title));
  return s;
}

/** 新しくなった項目を一瞬だけ目立たせる。 */
function flash(node: HTMLElement): void {
  node.classList.add("is-updated");
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
