import type { ChatEvent } from "../shared/chat";

export type ServerMsg =
  | { t: "scene"; path: string; rev: number; exists?: boolean; scene: SceneData; agent?: boolean }
  | { t: "chat"; path: string; ev: ChatEvent }
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

/** WebSocket to the local daemon with automatic reconnect. Same-origin only. */
export class Sync {
  private ws?: WebSocket;
  private retry = 0;
  private closed = false;
  private queue: string[] = [];

  constructor(
    private onMessage: (m: ServerMsg) => void,
    private onStatus: (s: Status) => void,
    private onOpen: () => void,
  ) {
    this.connect();
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
      this.onStatus("live");
      this.onOpen();
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
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
