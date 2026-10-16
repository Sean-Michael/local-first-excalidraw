import type { ChatEvent } from "../shared/chat";

export type ServerMsg =
  | {
      t: "scene";
      path: string;
      rev: number;
      exists?: boolean;
      scene: SceneData;
      /** Made by an agent: goes on the undo stack. */
      agent?: boolean;
      /** "assistant", or the MCP client's name ("" when it gave none). */
      by?: string;
      /** The daemon's own bookkeeping (code-link hashes): no "Drawing updated" toast. */
      quiet?: boolean;
    }
  | { t: "moved"; path: string; to: string }
  | { t: "pong" }
  | { t: "chat"; path: string; session?: string; ev: ChatEvent }
  | { t: "chat-error"; message: string }
  | { t: "render"; id: string; scene: SceneData; opts: RenderOpts }
  | { t: "mermaid"; id: string; text: string }
  | { t: "deleted"; path: string }
  | { t: "error"; message: string };

export interface SceneData {
  elements: any[];
  appState: Record<string, unknown>;
  files: Record<string, any>;
}

export interface RenderOpts {
  format?: "png" | "svg";
  maxSize?: number;
  dark?: boolean;
  embedScene?: boolean;
  scale?: number;
}

export type Status = "connecting" | "live" | "offline";

const PING_MS = 10_000;
// Nothing heard (not even a pong) for this long: the connection is dead even if the socket hasn't noticed.
const DEAD_MS = 25_000;

/** WebSocket to the local daemon with automatic reconnect and a heartbeat. Same-origin only. */
export class Sync {
  private ws?: WebSocket;
  private retry = 0;
  private closed = false;
  private queue: string[] = [];
  private lastHeard = 0;
  private heartbeat?: number;

  constructor(
    private onMessage: (m: ServerMsg) => void,
    private onStatus: (s: Status) => void,
    private onOpen: () => void,
  ) {
    this.connect();
    this.heartbeat = window.setInterval(() => {
      const ws = this.ws;
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastHeard > DEAD_MS) ws.close();
      else ws.send(JSON.stringify({ t: "ping" }));
    }, PING_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.send({ t: "focus" });
    });
  }

  private connect() {
    this.onStatus("connecting");
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.lastHeard = Date.now();
      this.onStatus("live");
      this.onOpen();
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
      this.lastHeard = Date.now();
      try {
        this.onMessage(JSON.parse(ev.data));
      } catch (e) {
        console.error(e);
      }
    };
    ws.onclose = () => {
      this.onStatus("offline");
      if (this.closed) return;
      const delay = Math.min(2_000, 250 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: unknown) {
    const s = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  close() {
    this.closed = true;
    window.clearInterval(this.heartbeat);
    this.ws?.close();
  }
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const basename = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.excalidraw$/, "");
