// 切れたら自動でつなぎ直す WebSocket。会場の Wi-Fi は不安定なことが多いので、参加者も登壇者もこれを使う。

import type { ServerMessage } from "../shared/protocol.ts";

export interface LiveSocketOptions {
  url: string;
  onMessage: (msg: ServerMessage) => void;
  onOpen?: () => void;
  onClose?: (info: { code: number; reason: string; willRetry: boolean }) => void;
}

export class LiveSocket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  private timer: number | undefined;
  private readonly opts: LiveSocketOptions;

  constructor(opts: LiveSocketOptions) {
    this.opts = opts;
    this.connect();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(data: string | ArrayBuffer): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(data);
    return true;
  }

  close(): void {
    this.closedByUser = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, "bye");
  }

  private connect(): void {
    const ws = new WebSocket(this.opts.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.opts.onOpen?.();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        this.opts.onMessage(JSON.parse(ev.data) as ServerMessage);
      } catch {
        // 壊れたメッセージは捨てる
      }
    };
    ws.onclose = (ev) => {
      // 4000: 別の画面が登壇者として接続した。403 相当（4003）も含め、つなぎ直さない
      const willRetry = !this.closedByUser && ev.code !== 4000 && ev.code !== 4003;
      this.opts.onClose?.({ code: ev.code, reason: ev.reason, willRetry });
      if (!willRetry) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++) * (0.75 + Math.random() * 0.5);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }
}

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}
