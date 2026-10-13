import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type Config,
  ensureStateDir,
  loadOrCreateToken,
  readJson,
  VERSION,
  writeFileAtomic,
} from "./config.js";
import { layoutGraph, type GraphSpec } from "./layout.js";
import {
  addSkeletons,
  bounds,
  deleteElements,
  describe,
  type El,
  type ElementUpdate,
  live,
  type Scene,
  SceneError,
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
      if (c.path === ch.path && c.id !== ch.origin) send(c, { t: "scene", path: ch.path, rev: ch.rev, scene: ch.scene });
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

  const op = async (body: Record<string, unknown>) => {
    const p = safe(body.path);
    const { scene } = store.get(p);
    switch (body.op) {
      case "read": {
        const doc = store.getLive(p);
        if (!doc.exists) throw new HttpError(404, `No drawing at ${p}`);
        return { path: p, rev: doc.rev, summary: describe(doc.scene), scene: body.full ? doc.scene : undefined };
      }
      case "create": {
        if (store.exists(p) && !body.overwrite) throw new HttpError(409, `${p} already exists (pass overwrite: true to replace it)`);
        const { elements, created } = addSkeletons([], (body.elements as SkeletonEl[]) ?? []);
        const r = store.apply(p, { elements, replace: true, appState: { viewBackgroundColor: "#ffffff", gridSize: 20 } });
        return { path: p, rev: r.rev, created };
      }
      case "add": {
        const els = appendPlacement(scene, (body.elements as SkeletonEl[]) ?? [], body.placement as string | undefined);
        const { elements, created } = addSkeletons(scene.elements, els);
        const r = store.apply(p, { elements });
        return { path: p, rev: r.rev, created };
      }
      case "diagram": {
        const spec = body.graph as GraphSpec;
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
        const { elements, created } = addSkeletons(scene.elements, renamed);
        const r = store.apply(p, { elements });
        return { path: p, rev: r.rev, created };
      }
      case "update": {
        const elements = updateElements(scene.elements, (body.updates as ElementUpdate[]) ?? []);
        const r = store.apply(p, { elements });
        return { path: p, rev: r.rev };
      }
      case "delete": {
        const { elements, deleted } = deleteElements(scene.elements, (body.ids as string[]) ?? []);
        const r = store.apply(p, { elements });
        return { path: p, rev: r.rev, deleted };
      }
      case "replace": {
        const r = store.apply(p, { elements: body.elements as El[], replace: true });
        return { path: p, rev: r.rev };
      }
      case "clear": {
        const r = store.apply(p, { elements: [], replace: true });
        return { path: p, rev: r.rev };
      }
      case "render": {
        const doc = store.getLive(p);
        if (!doc.exists) throw new HttpError(404, `No drawing at ${p}`);
        const out = (await rpc(
          { t: "render", scene: doc.scene, opts: body.opts ?? {} },
          Math.max(3_000, Number(body.waitMs ?? 0)),
        )) as { data: string; mime: string };
        return out;
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
        const r = store.apply(p, { elements: [...scene.elements, ...incoming], files: conv.files });
        return { path: p, rev: r.rev, created: incoming.filter((e) => !e.containerId).map((e) => e.id) };
      }
      default:
        throw new HttpError(400, `Unknown op ${String(body.op)}`);
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
      if (e instanceof SceneError || e instanceof PathError) return json(res, 400, { error: e.message });
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
        return;
      }
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
