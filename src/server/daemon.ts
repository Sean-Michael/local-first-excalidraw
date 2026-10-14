import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChatEvent, ChatRequest } from "../shared/chat.js";
import { Assistant, AssistantError } from "./ai/agent.js";
import { listAnthropicModels } from "./ai/anthropic.js";
import { listOllamaModels } from "./ai/ollama.js";
import { listOpenAIModels } from "./ai/openai.js";
import { apiKeyFor, type Endpoint, findClaude, SettingsError, SettingsStore } from "./ai/settings.js";
import { CodeError, suggestFiles } from "./code.js";
import {
  baseUrl,
  type Config,
  ensureStateDir,
  loadOrCreateToken,
  readJson,
  VERSION,
  writeFileAtomic,
} from "./config.js";
import { layoutGraph, type GraphSpec } from "./layout.js";
import { findShape, labelSize, Libraries, LibraryError, type LibraryShape, PRIMITIVE_SHAPES, placeShape, shapeScale, slug } from "./library.js";
import { fetchCatalog, fetchCatalogLibrary } from "./catalog.js";
import {
  addSkeletons,
  bounds,
  deleteElements,
  describe,
  type El,
  type ElementUpdate,
  live,
  type Region,
  type Scene,
  SceneError,
  selectForRender,
  type SkeletonEl,
  updateElements,
} from "./scene.js";
import {
  bearer,
  hostAllowed,
  originAllowed,
  parseCookies,
  PathError,
  resolveSafePath,
  safeEqual,
  SECURITY_HEADERS,
} from "./security.js";
import { DocStore, listDrawings, type SceneChange } from "./store.js";

const MAX_BODY = 60 * 1024 * 1024;
const SESSION_COOKIE = "lfx_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const LOGIN_CODE_TTL_MS = 120 * 1000;
const RPC_TIMEOUT_MS = 30_000;
const CLAUDE_CODE_MODELS = ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface Client {
  id: string;
  ws: WebSocket;
  path?: string;
  unwatch?: () => void;
  lastActive: number;
}

type Auth = "bearer" | "session" | null;

export async function startDaemon(cfg: Config): Promise<http.Server> {
  ensureStateDir(cfg);
  const token = loadOrCreateToken(cfg);
  const store = new DocStore();

  // ---- persisted state -------------------------------------------------------
  const rootsFile = path.join(cfg.stateDir, "roots.json");
  const sessionsFile = path.join(cfg.stateDir, "sessions.json");
  const libraryFile = path.join(cfg.stateDir, "library.json");
  const libraries = new Libraries(cfg.stateDir, libraryFile, cfg.librariesDir);
  const registered = new Set<string>(readJson<string[]>(rootsFile, []).filter((r) => fs.existsSync(r)));
  for (const r of cfg.defaultRoots) fs.mkdirSync(r, { recursive: true });
  const roots = () => [...new Set([...cfg.defaultRoots, ...registered])];

  const sessions = new Map<string, number>(Object.entries(readJson<Record<string, number>>(sessionsFile, {})));
  const saveSessions = () => {
    const now = Date.now();
    for (const [k, t] of sessions) if (now - t > SESSION_TTL_MS) sessions.delete(k);
    writeFileAtomic(sessionsFile, JSON.stringify(Object.fromEntries(sessions)), 0o600);
  };
  const loginCodes = new Map<string, { expires: number; file?: string }>();

  // ---- auth --------------------------------------------------------------------
  const authOf = (req: IncomingMessage): Auth => {
    const b = bearer(req);
    if (b && safeEqual(b, token)) return "bearer";
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid && sessions.has(sid)) {
      const created = sessions.get(sid)!;
      if (Date.now() - created < SESSION_TTL_MS) return "session";
    }
    return null;
  };

  const safe = (p: unknown) => {
    try {
      return resolveSafePath(String(p ?? ""), roots());
    } catch (e) {
      if (e instanceof PathError) throw new HttpError(403, e.message);
      throw e;
    }
  };

  // ---- websocket clients -----------------------------------------------------------
  const clients = new Map<string, Client>();
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  const send = (c: Client, msg: unknown) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  };

  store.on("change", (ch: SceneChange) => {
    for (const c of clients.values()) {
      if (c.path === ch.path && c.id !== ch.origin) {
        send(c, { t: "scene", path: ch.path, rev: ch.rev, scene: ch.scene, agent: ch.origin === "agent" || undefined });
      }
    }
  });

  store.on("deleted", (p: string) => {
    for (const c of clients.values()) if (c.path === p) send(c, { t: "deleted", path: p });
  });

  const waitForClient = async (ms: number): Promise<Client | undefined> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const c = pickClient();
      if (c) return c;
      await new Promise((r) => setTimeout(r, 250));
    }
    return pickClient();
  };
  const pickClient = () =>
    [...clients.values()].filter((c) => c.ws.readyState === c.ws.OPEN).sort((a, b) => b.lastActive - a.lastActive)[0];

  /** Ask a connected editor tab to do something only a real browser can (render, mermaid). */
  const rpc = async (msg: Record<string, unknown>, waitMs: number): Promise<unknown> => {
    const c = await waitForClient(waitMs);
    if (!c) {
      throw new HttpError(409, "No editor is open. Open the drawing in the browser first (open_drawing / `lfx open`).", {
        code: "no-editor",
      });
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new HttpError(504, "The editor did not respond in time"));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      send(c, { ...msg, id });
    });
  };

  // ---- operations shared by the HTTP API -------------------------------------------------
  const appendPlacement = (scene: Scene, els: SkeletonEl[], placement: string | undefined) => {
    // New content goes to the right of whatever is already on the canvas unless positioned.
    const b = bounds(scene.elements);
    if (!b || placement === "absolute") return els;
    const nb = { minX: Infinity, minY: Infinity };
    for (const e of els) {
      if (typeof e.x === "number") nb.minX = Math.min(nb.minX, e.x);
      if (typeof e.y === "number") nb.minY = Math.min(nb.minY, e.y);
    }
    if (!Number.isFinite(nb.minX)) return els;
    const dx = placement === "below" ? b.minX - nb.minX : b.maxX + 120 - nb.minX;
    const dy = placement === "below" ? b.maxY + 120 - nb.minY : b.minY - nb.minY;
    return els.map((e) => (typeof e.x === "number" ? { ...e, x: e.x + dx, y: (e.y ?? 0) + dy } : e));
  };

  // Drawings with an assistant turn in progress: their edits are tagged so the canvas can undo them.
  const agentPaths = new Set<string>();

  const op = async (body: Record<string, unknown>) => {
    const p = safe(body.path);
    const { scene } = store.get(p);
    const origin = agentPaths.has(p) ? "agent" : undefined;
    switch (body.op) {
      case "read": {
        const doc = store.getLive(p);
        if (!doc.exists) throw new HttpError(404, `No drawing at ${p}`);
        return { path: p, rev: doc.rev, summary: describe(doc.scene), scene: body.full ? doc.scene : undefined };
      }
      case "create": {
        if (store.exists(p) && !body.overwrite) throw new HttpError(409, `${p} already exists (pass overwrite: true to replace it)`);
        const { elements, created } = addSkeletons([], (body.elements as SkeletonEl[]) ?? []);
        const r = store.apply(p, { elements, replace: true, appState: { viewBackgroundColor: "#ffffff", gridSize: 20 } }, origin);
        return { path: p, rev: r.rev, created };
      }
      case "add": {
        const els = appendPlacement(scene, (body.elements as SkeletonEl[]) ?? [], body.placement as string | undefined);
        const { elements, created } = addSkeletons(scene.elements, els);
        const r = store.apply(p, { elements }, origin);
        return { path: p, rev: r.rev, created };
      }
      case "diagram": {
        const spec = body.graph as GraphSpec;
        // Nodes may name a library shape: size them to it so the layout leaves room.
        const lib = new Map<string, LibraryShape>();
        let shapes: LibraryShape[] | undefined;
        for (const n of spec.nodes) {
          if (!n.shape || PRIMITIVE_SHAPES.has(n.shape)) continue;
          shapes ??= libraries.shapes(projectRootFor(p));
          const shape = findShape(shapes, n.shape);
          const scale = shapeScale(shape, { normalize: true });
          const label = labelSize(n.label);
          n.shape = `lib:${shape.key}`;
          n.size = { w: Math.round(Math.max(shape.width * scale, label.width)), h: Math.round(shape.height * scale + label.height) };
          lib.set(n.shape, shape);
        }
        const els = appendPlacement(scene, layoutGraph(spec), (body.placement as string) ?? "right");
        // Namespace ids when appending so repeated diagrams don't collide.
        const taken = new Set(live(scene.elements).map((e) => e.id));
        let prefix = "";
        if (els.some((e) => e.id && taken.has(e.id))) prefix = `${crypto.randomBytes(2).toString("hex")}-`;
        const ren = (id?: string) => (id ? prefix + id : id);
        const renamed = els.map((e) => ({
          ...e,
          id: ren(e.id),
          start: e.start ? { id: ren(e.start.id)! } : undefined,
          end: e.end ? { id: ren(e.end.id)! } : undefined,
          children: e.children?.map((c) => ren(c)!),
        }));
        // Swap library nodes for copies of their elements; arrows bind to each shape's main part.
        const parts = new Map<string, string[]>();
        const expanded = renamed.flatMap((e): SkeletonEl[] => {
          const shape = lib.get(e.type);
          if (!shape) return [e];
          const scale = shapeScale(shape, { normalize: true });
          const placed = placeShape(shape, {
            x: (e.x ?? 0) + ((e.width ?? 0) - shape.width * scale) / 2,
            y: e.y ?? 0,
            scale,
            label: typeof e.label === "string" ? e.label : undefined,
            anchorId: e.id,
          });
          parts.set(e.id!, placed.ids);
          return placed.elements.map((el): SkeletonEl => ({ type: "placed", element: el }));
        });
        for (const e of expanded) if (e.type === "frame" && e.children) e.children = e.children.flatMap((c) => parts.get(c) ?? [c]);
        const { elements, created } = addSkeletons(scene.elements, expanded);
        const r = store.apply(p, { elements }, origin);
        return { path: p, rev: r.rev, created };
      }
      case "shapes": {
        const shapes = libraries.shapes(projectRootFor(p));
        return { libraries: libraries.list(projectRootFor(p)), shapes: shapes.map(({ elements: _els, ...rest }: LibraryShape) => rest) };
      }
      case "shapes_preview": {
        // A contact sheet of library shapes, labelled with their names, rendered by an editor tab.
        const all = libraries.shapes(projectRootFor(p));
        const picked = ((body.keys as string[]) ?? []).slice(0, 30).flatMap((k) => all.filter((s) => s.key === k));
        if (!picked.length) throw new HttpError(400, "No shapes to preview");
        const cols = Math.min(6, picked.length);
        const cell = { w: 170, h: 170 };
        const elements = picked.flatMap((shape, i) => {
          const scale = Math.min(110 / Math.max(shape.width, 1), 110 / Math.max(shape.height, 1), 2);
          const x = (i % cols) * cell.w + (cell.w - shape.width * scale) / 2;
          const y = Math.floor(i / cols) * cell.h + (110 - shape.height * scale) / 2;
          return placeShape(shape, { x, y, scale, label: shape.name.length > 22 ? shape.name.slice(0, 21) + "…" : shape.name }).elements;
        });
        return (await rpc(
          { t: "render", scene: { elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} }, opts: { format: "png", maxSize: 1200 } },
          Math.max(3_000, Number(body.waitMs ?? 0)),
        )) as { data: string; mime: string };
      }
      case "insert_shape": {
        const shape = findShape(libraries.shapes(projectRootFor(p)), String(body.shape ?? ""));
        const id = typeof body.id === "string" ? body.id : undefined;
        if (id && live(scene.elements).some((e) => e.id === id)) throw new HttpError(409, `Element id "${id}" already exists`);
        const b = bounds(scene.elements);
        const size = (k: string) => (typeof body[k] === "number" && (body[k] as number) > 0 ? (body[k] as number) : undefined);
        const scale = shapeScale(shape, { width: size("width"), height: size("height") });
        const label = typeof body.label === "string" && body.label ? body.label : undefined;
        let x = typeof body.x === "number" ? body.x : b ? b.maxX + 120 : 0;
        let y = typeof body.y === "number" ? body.y : b ? b.minY : 0;
        const near = body.next_to as { id?: string; side?: string; gap?: number } | undefined;
        if (near?.id) {
          // Beside an existing element, centred on it, so callers needn't do coordinate arithmetic.
          const target = live(scene.elements).find((e) => e.id === near.id);
          if (!target) throw new HttpError(404, `Element "${near.id}" not found`);
          const t = bounds([target])!;
          const probe = placeShape(shape, { x: 0, y: 0, scale, label }).bounds;
          const gap = typeof near.gap === "number" ? near.gap : 100;
          const cx = (t.minX + t.maxX) / 2;
          const cy = (t.minY + t.maxY) / 2;
          const side = near.side ?? "right";
          if (side === "left") [x, y] = [t.minX - gap - probe.width, cy - probe.height / 2];
          else if (side === "above") [x, y] = [cx - probe.width / 2, t.minY - gap - probe.height];
          else if (side === "below") [x, y] = [cx - probe.width / 2, t.maxY + gap];
          else [x, y] = [t.maxX + gap, cy - probe.height / 2];
        }
        const placed = placeShape(shape, { x, y, scale, label, anchorId: id });
        const r = store.apply(p, { elements: placed.elements }, origin);
        return { path: p, rev: r.rev, shape: shape.key, anchor: placed.anchorId, created: placed.ids, bounds: placed.bounds };
      }
      case "update": {
        const elements = updateElements(scene.elements, (body.updates as ElementUpdate[]) ?? []);
        const r = store.apply(p, { elements }, origin);
        return { path: p, rev: r.rev };
      }
      case "delete": {
        const { elements, deleted } = deleteElements(scene.elements, (body.ids as string[]) ?? []);
        const r = store.apply(p, { elements }, origin);
        return { path: p, rev: r.rev, deleted };
      }
      case "replace": {
        const r = store.apply(p, { elements: body.elements as El[], replace: true }, origin);
        return { path: p, rev: r.rev };
      }
      case "clear": {
        const r = store.apply(p, { elements: [], replace: true }, origin);
        return { path: p, rev: r.rev };
      }
      case "render": {
        const doc = store.getLive(p);
        if (!doc.exists) throw new HttpError(404, `No drawing at ${p}`);
        let scene = doc.scene;
        let missing: string[] = [];
        const ids = Array.isArray(body.elementIds) ? (body.elementIds as string[]) : undefined;
        const region = body.region as Region | undefined;
        if (ids?.length || region) {
          const sel = selectForRender(scene.elements, { ids, region });
          if (!sel.elements.length) {
            throw new HttpError(400, ids?.length ? `None of these elements exist: ${sel.missing.join(", ")}` : "No elements overlap that region");
          }
          scene = { ...scene, elements: sel.elements };
          missing = sel.missing;
        }
        const out = (await rpc(
          { t: "render", scene, opts: body.opts ?? {} },
          Math.max(3_000, Number(body.waitMs ?? 0)),
        )) as { data: string; mime: string; scale?: number };
        const texts = scene.elements.filter((e) => e.type === "text" && !e.isDeleted && typeof e.fontSize === "number");
        const minFont = texts.length ? Math.min(...texts.map((e) => e.fontSize as number)) : undefined;
        return { ...out, missing, minFont, elements: scene.elements.filter((e) => !e.isDeleted).length };
      }
      case "mermaid": {
        const conv = (await rpc({ t: "mermaid", text: body.text }, Math.max(3_000, Number(body.waitMs ?? 0)))) as {
          elements: El[];
          files?: Record<string, unknown>;
        };
        let incoming = conv.elements;
        const b = bounds(scene.elements);
        const nb = bounds(incoming);
        if (b && nb) incoming = incoming.map((e) => ({ ...e, x: e.x + b.maxX + 120 - nb.minX, y: e.y + b.minY - nb.minY }));
        const r = store.apply(p, { elements: [...scene.elements, ...incoming], files: conv.files }, origin);
        return { path: p, rev: r.rev, created: incoming.filter((e) => !e.containerId).map((e) => e.id) };
      }
      default:
        throw new HttpError(400, `Unknown op ${String(body.op)}`);
    }
  };

  // ---- assistant ----------------------------------------------------------------------------
  const settings = new SettingsStore(cfg.stateDir);

  /**
   * The assistant's project root for a drawing: the git repository it lives in (`lfx open`
   * registers only the drawing's folder, but the code worth reading is the whole repo),
   * else the most specific allowed root. Never the home directory or the filesystem root.
   */
  const projectRootFor = (file: string) => {
    let allowed: string | undefined;
    for (const r of roots()) {
      const rr = fs.existsSync(r) ? fs.realpathSync.native(r) : r;
      const rel = path.relative(rr, file);
      if ((rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) && (!allowed || rr.length > allowed.length)) allowed = rr;
    }
    if (!allowed) throw new HttpError(403, "Drawing is outside the allowed roots");
    const home = fs.realpathSync.native(os.homedir());
    for (let dir = path.dirname(file); dir !== home && dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    }
    return allowed;
  };

  const broadcastChat = (p: string, ev: ChatEvent) => {
    for (const c of clients.values()) if (c.path === p) send(c, { t: "chat", path: p, ev });
  };

  const assistant = new Assistant({
    stateDir: cfg.stateDir,
    settings,
    store,
    op,
    list: (root) => listDrawings([safeDir(root)]),
    safe,
    projectRootFor,
    emit: broadcastChat,
    agentPaths,
    mcpEnv: { LFX_STATE_DIR: cfg.stateDir, LFX_PORT: String(cfg.port), LFX_URL: baseUrl(cfg) },
  });

  const publicSettings = () => {
    const bin = findClaude();
    return settings.public({ available: !!bin, path: bin });
  };

  /** Model ids an endpoint offers, using the stored key when the form didn't send a new one. */
  const listModels = async (body: Record<string, unknown>): Promise<string[]> => {
    const kind = body.kind as Endpoint["kind"];
    if (kind === "claude-code") return CLAUDE_CODE_MODELS;
    const stored = settings.get().endpoints.find((e) => e.id === body.id);
    const ep = { kind, baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") || undefined : undefined } as Endpoint;
    if (ep.baseUrl) {
      const u = new URL(ep.baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "Endpoint URL must be http or https");
    }
    const sameHost = stored && stored.kind === kind && stored.baseUrl === ep.baseUrl;
    ep.apiKey = typeof body.apiKey === "string" && body.apiKey ? body.apiKey : sameHost ? stored.apiKey : undefined;
    const key = apiKeyFor(ep);
    try {
      if (kind === "anthropic") return await listAnthropicModels(ep.baseUrl, key);
      if (kind === "ollama") return await listOllamaModels(ep.baseUrl);
      if (!ep.baseUrl) throw new HttpError(400, "Base URL required");
      return await listOpenAIModels(ep.baseUrl, key);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `Could not list models: ${(e as Error).message}`);
    }
  };

  // ---- HTTP ---------------------------------------------------------------------------------
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const ct = req.headers["content-type"] ?? "";
      if (!ct.startsWith("application/json")) return reject(new HttpError(415, "Expected application/json"));
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, "Body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          reject(new HttpError(400, "Invalid JSON"));
        }
      });
      req.on("error", reject);
    });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const page = (res: ServerResponse, status: number, title: string, msg: string) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<style>body{font:16px system-ui;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#1e1e1e}code{background:#f1f3f5;padding:.1em .3em;border-radius:4px}</style>` +
        `<h1>${title}</h1><p>${msg}</p>`,
    );
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    let rel = decodeURIComponent(pathname);
    if (rel === "/" || !path.extname(rel)) rel = "/index.html";
    const file = path.resolve(cfg.webDir, "." + rel);
    if (!file.startsWith(path.resolve(cfg.webDir) + path.sep)) return json(res, 403, { error: "Forbidden" });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return json(res, 404, { error: "Not found" });
      const immutable = rel.startsWith("/assets/") || rel.startsWith("/fonts/");
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Content-Length": st.size,
        ...(immutable ? { "Cache-Control": "private, max-age=31536000, immutable" } : {}),
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req, cfg.allowedHosts)) return json(res, 421, { error: "Host not allowed" });
    if (!originAllowed(req, cfg.allowedHosts)) return json(res, 403, { error: "Cross-origin request refused" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;
    const method = req.method ?? "GET";

    if (pathname === "/api/health") return json(res, 200, { ok: true, name: "local-first-excalidraw", version: VERSION });

    if (pathname === "/login" && method === "GET") {
      const code = url.searchParams.get("code") ?? "";
      const entry = loginCodes.get(code);
      loginCodes.delete(code);
      if (!entry || entry.expires < Date.now()) {
        return page(res, 401, "Link expired", "This sign-in link was already used or has expired. Run <code>lfx open</code> to get a new one.");
      }
      const sid = crypto.randomBytes(32).toString("base64url");
      sessions.set(sid, Date.now());
      saveSessions();
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        "Set-Cookie": `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
        Location: entry.file ? `/?file=${encodeURIComponent(entry.file)}` : "/",
      });
      return res.end();
    }

    const auth = authOf(req);
    if (!pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
      if (!auth) {
        return page(res, 401, "Sign in required", "Open the editor from your terminal with <code>lfx open</code> (or ask your agent to open a drawing). It prints a one-time sign-in link.");
      }
      return serveStatic(req, res, pathname);
    }
    if (!auth) return json(res, 401, { error: "Unauthorized" });
    const bearerOnly = () => {
      if (auth !== "bearer") throw new HttpError(403, "This endpoint is only available to local clients");
    };

    if (pathname === "/api/files" && method === "GET") {
      const rs = roots();
      return json(res, 200, { roots: rs, drawings: listDrawings(rs) });
    }
    if (pathname === "/api/scene" && method === "GET") {
      const p = safe(url.searchParams.get("path"));
      const doc = store.get(p);
      return json(res, 200, { path: p, rev: doc.rev, exists: doc.exists, scene: doc.scene });
    }
    if (pathname === "/api/new" && method === "POST") {
      const body = await readBody(req);
      const p = safe(body.path);
      if (store.exists(p)) throw new HttpError(409, "A drawing with that name already exists");
      store.apply(p, { elements: [], replace: true, appState: { viewBackgroundColor: "#ffffff", gridSize: 20 } });
      return json(res, 200, { path: p });
    }
    if (pathname === "/api/library") {
      if (method === "GET") return json(res, 200, readJson(libraryFile, { libraryItems: [] }));
      if (method === "PUT") {
        const body = await readBody(req);
        writeFileAtomic(libraryFile, JSON.stringify({ libraryItems: body.libraryItems ?? [] }), 0o600);
        return json(res, 200, { ok: true });
      }
    }

    // ---- assistant ----
    if (pathname === "/api/ai/settings") {
      if (method === "GET") return json(res, 200, publicSettings());
      if (method === "PUT") {
        try {
          settings.update(await readBody(req));
        } catch (e) {
          if (e instanceof SettingsError) throw new HttpError(400, e.message);
          throw e;
        }
        return json(res, 200, publicSettings());
      }
    }
    if (pathname === "/api/ai/models" && method === "POST") {
      return json(res, 200, { models: await listModels(await readBody(req)) });
    }
    if (pathname === "/api/ai/mentions" && method === "GET") {
      const p = safe(url.searchParams.get("path"));
      const q = (url.searchParams.get("q") ?? "").slice(0, 200);
      const root = projectRootFor(p);
      const lower = q.toLowerCase();
      const drawings = listDrawings([root])
        .filter((d) => d.path !== p && path.relative(root, d.path).toLowerCase().includes(lower))
        .slice(0, 8)
        .map((d) => ({ kind: "drawing", path: d.path, rel: path.relative(root, d.path) }));
      let files: { kind: string; path: string; rel: string }[] = [];
      if (settings.get().codeAccess) {
        try {
          files = suggestFiles(root, q, 20)
            .filter((f) => !f.endsWith(".excalidraw"))
            .map((f) => ({ kind: "file", path: f, rel: path.relative(root, f) }));
        } catch (e) {
          if (!(e instanceof CodeError)) throw e;
        }
      }
      return json(res, 200, { root, items: [...drawings, ...files] });
    }

    // ---- shape libraries ----
    if (pathname.startsWith("/api/libraries")) {
      const projectFor = (q: string | null | undefined) => (q ? projectRootFor(safe(q)) : undefined);
      try {
        if (pathname === "/api/libraries" && method === "GET") {
          return json(res, 200, { libraries: libraries.list(projectFor(url.searchParams.get("path"))) });
        }
        if (pathname === "/api/libraries/items" && method === "GET") {
          const id = url.searchParams.get("id") ?? "";
          const items = libraries.shapes(projectFor(url.searchParams.get("path")), id);
          return json(res, 200, { items: items.map((s) => ({ key: s.key, name: s.name, itemId: s.itemId, elements: s.elements })) });
        }
        if (pathname === "/api/libraries/import" && method === "POST") {
          const body = await readBody(req);
          if (typeof body.content !== "string") throw new HttpError(400, "content must be the library file's text");
          const info = libraries.install(body.content, { name: body.name as string | undefined, fileName: body.fileName as string | undefined });
          return json(res, 200, { library: info });
        }
        if (pathname === "/api/libraries/update" && method === "POST") {
          const body = await readBody(req);
          const id = String(body.id ?? "");
          if (typeof body.enabled === "boolean") libraries.setEnabled(id, body.enabled);
          const rn = body.rename as { itemId?: unknown; name?: unknown } | undefined;
          if (rn && typeof rn.itemId === "string") libraries.rename(id, rn.itemId, typeof rn.name === "string" ? rn.name : null);
          return json(res, 200, { ok: true });
        }
        if (pathname === "/api/libraries/remove" && method === "POST") {
          libraries.remove(String((await readBody(req)).id ?? ""));
          return json(res, 200, { ok: true });
        }
        if (pathname === "/api/libraries/catalog" && method === "GET") {
          const installed = libraries.installedUrls();
          const builtIn = new Set(libraries.list().filter((l) => l.origin === "built-in").map((l) => l.url));
          // Files imported by hand carry no catalog URL; they're installed under their file name.
          const ids = new Set(libraries.list().map((l) => l.id));
          const entries = await fetchCatalog();
          return json(res, 200, {
            entries: entries.map((e) => ({
              ...e,
              itemNames: undefined,
              installed: installed.has(e.url) || builtIn.has(e.url) || ids.has(`installed:${slug(path.basename(e.source, ".excalidrawlib"))}`),
            })),
          });
        }
        if (pathname === "/api/libraries/install" && method === "POST") {
          const { entry, content } = await fetchCatalogLibrary(String((await readBody(req)).source ?? ""));
          const info = libraries.install(content, { name: entry.name, description: entry.description, authors: entry.authors, url: entry.url, itemNames: entry.itemNames });
          return json(res, 200, { library: info });
        }
      } catch (e) {
        if (e instanceof LibraryError || e instanceof SyntaxError) throw new HttpError(400, e.message);
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, (e as Error).message);
      }
    }

    // ---- local clients only (MCP server, CLI) ----
    if (pathname === "/api/op" && method === "POST") {
      bearerOnly();
      return json(res, 200, await op(await readBody(req)));
    }
    if (pathname === "/api/list" && method === "POST") {
      bearerOnly();
      const body = await readBody(req);
      const within = body.root ? [safeDir(String(body.root))] : roots();
      return json(res, 200, { drawings: listDrawings(within) });
    }
    if (pathname === "/api/roots" && method === "POST") {
      bearerOnly();
      if (!cfg.allowRootRegistration) throw new HttpError(403, "Root registration is disabled (LFX_LOCK_ROOTS=1)");
      const body = await readBody(req);
      const r = fs.realpathSync.native(path.resolve(String(body.path)));
      if (!fs.statSync(r).isDirectory()) throw new HttpError(400, "Root must be a directory");
      if (r === path.parse(r).root) throw new HttpError(400, "Refusing to register the filesystem root");
      registered.add(r);
      writeFileAtomic(rootsFile, JSON.stringify([...registered], null, 2), 0o600);
      return json(res, 200, { roots: roots() });
    }
    if (pathname === "/api/login-code" && method === "POST") {
      bearerOnly();
      const body = await readBody(req);
      const file = body.path ? safe(body.path) : undefined;
      const code = crypto.randomBytes(24).toString("base64url");
      loginCodes.set(code, { expires: Date.now() + LOGIN_CODE_TTL_MS, file });
      for (const [k, v] of loginCodes) if (v.expires < Date.now()) loginCodes.delete(k);
      return json(res, 200, { code, file, editors: clients.size });
    }
    if (pathname === "/api/status" && method === "GET") {
      bearerOnly();
      return json(res, 200, {
        version: VERSION,
        pid: process.pid,
        roots: roots(),
        editors: [...clients.values()].map((c) => ({ path: c.path ?? null })),
      });
    }
    if (pathname === "/api/shutdown" && method === "POST") {
      bearerOnly();
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 50);
      return;
    }
    throw new HttpError(404, "Not found");
  };

  const safeDir = (dir: string) => {
    const real = fs.realpathSync.native(path.resolve(dir));
    for (const r of roots()) {
      const rr = fs.existsSync(r) ? fs.realpathSync.native(r) : r;
      const rel = path.relative(rr, real);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return real;
    }
    throw new HttpError(403, "Directory is outside the allowed roots");
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...e.extra });
      if (e instanceof SceneError || e instanceof PathError || e instanceof LibraryError) return json(res, 400, { error: e.message });
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return json(res, 404, { error: "Not found" });
      console.error(e);
      json(res, 500, { error: err.message ?? "Internal error" });
    });
  });

  // ---- WebSocket ----------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (
      url.pathname !== "/ws" ||
      !hostAllowed(req, cfg.allowedHosts) ||
      // Browsers must present a same-origin Origin header; this blocks cross-site WebSocket hijacking.
      !req.headers.origin ||
      !originAllowed(req, cfg.allowedHosts) ||
      !authOf(req)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Client = { id: crypto.randomUUID(), ws, lastActive: Date.now() };
      clients.set(c.id, c);
      ws.on("message", (raw) => {
        c.lastActive = Date.now();
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        try {
          onMessage(c, msg);
        } catch (e) {
          send(c, { t: "error", message: (e as Error).message });
        }
      });
      ws.on("close", () => {
        c.unwatch?.();
        clients.delete(c.id);
      });
    });
  });

  const onMessage = (c: Client, msg: Record<string, unknown>) => {
    switch (msg.t) {
      case "open": {
        const p = safe(msg.path);
        c.unwatch?.();
        c.path = p;
        c.unwatch = store.watch(p);
        const doc = store.get(p);
        send(c, { t: "scene", path: p, rev: doc.rev, exists: doc.exists, scene: doc.scene });
        send(c, { t: "chat", path: p, ev: { type: "history", ...assistant.history(p) } });
        return;
      }
      case "chat-send": {
        if (!c.path || safe(msg.path) !== c.path) throw new Error("Chat for a drawing that is not open");
        const reqId = msg.reqId;
        assistant.send(msg as unknown as ChatRequest).catch((e: Error) => {
          send(c, { t: "chat-error", reqId, message: e instanceof AssistantError || e instanceof HttpError ? e.message : `Assistant error: ${e.message}` });
        });
        return;
      }
      case "chat-history":
        if (c.path) send(c, { t: "chat", path: c.path, ev: { type: "history", ...assistant.history(c.path) } });
        return;
      case "chat-stop":
        if (c.path) assistant.stop(c.path);
        return;
      case "chat-reset":
      case "chat-revert":
        if (!c.path) return;
        try {
          if (msg.t === "chat-reset") assistant.reset(c.path);
          else assistant.revert(c.path, String(msg.id));
        } catch (e) {
          send(c, { t: "chat-error", message: (e as Error).message });
        }
        return;
      case "save": {
        if (!c.path || msg.path !== c.path) throw new Error("Save for a drawing that is not open");
        // A tab may only create a missing file when the user explicitly asks it to (restore / new drawing).
        if (!store.get(c.path).exists && !msg.create) {
          send(c, { t: "deleted", path: c.path });
          return;
        }
        store.apply(
          c.path,
          {
            elements: msg.elements as El[],
            appState: msg.appState as Record<string, unknown>,
            files: msg.files as Record<string, unknown>,
          },
          c.id,
        );
        return;
      }
      case "focus":
        return;
      case "reply": {
        const p = pending.get(String(msg.id));
        if (!p) return;
        pending.delete(String(msg.id));
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new HttpError(500, String(msg.error ?? "Editor error")));
        return;
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  return server;
}
