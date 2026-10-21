import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChatEvent, ChatRequest } from "../shared/chat.js";
import { Assistant, AssistantError, toolCatalog } from "./ai/agent.js";
import { listAnthropicModels } from "./ai/anthropic.js";
import { listOllamaModels } from "./ai/ollama.js";
import { listOpenAIModels } from "./ai/openai.js";
import { apiKeyFor, type Endpoint, findClaude, SettingsError, SettingsStore } from "./ai/settings.js";
import { CodeError, resolveInRoot } from "./code.js";
import { checkLinks, formatCodeLink, hashFile, parseCodeLink, refreshLinks, stampCodeLinks, summarizeLinks } from "./codelinks.js";
import {
  baseUrl,
  type Config,
  ensureStateDir,
  loadOrCreateToken,
  readJson,
  VERSION,
  writeFileAtomic,
} from "./config.js";
import { copyName, duplicateFile, FileOpError, listFolders, makeFolder, moveFile, moveToTrash } from "./files.js";
import { DrawingSetWatcher } from "./drawing-watch.js";
import { changedFiles, drawingStatus } from "./git.js";
import { type MentionSuggestion, suggestMentions } from "./mentions.js";
import { HeadlessBrowser, headlessMode, HeadlessUnavailable } from "./headless.js";
import { layoutGraph, PSEUDO_SHAPES, type GraphSpec } from "./layout.js";
import { findShape, labelSize, Libraries, LibraryError, type LibraryShape, PRIMITIVE_SHAPES, placeShape, shapeScale, slug } from "./library.js";
import { fetchCatalog, fetchCatalogLibrary } from "./catalog.js";
import {
  addSkeletons,
  type Align,
  arrangeElements,
  bounds,
  cleared,
  connectArrow,
  contentRev,
  deleteElements,
  describe,
  type Distribute,
  findElements,
  type El,
  type ElementUpdate,
  live,
  type Region,
  type Scene,
  restoreElements,
  SceneError,
  selectForRender,
  type SkeletonEl,
  updateElements,
} from "./scene.js";
import { Snapshots } from "./snapshots.js";
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
import { editorCommand, editorSetting, launch } from "./open-code.js";
import { DocStore, InvalidDrawingError, listDrawings, type SceneChange } from "./store.js";
import { contextFromHeaders, runIn, shutdownTelemetry, withSpan } from "./telemetry.js";

const MAX_BODY = 60 * 1024 * 1024;
const SESSION_COOKIE = "lfx_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const LOGIN_CODE_TTL_MS = 120 * 1000;
const RPC_TIMEOUT_MS = 30_000;
// How long a new headless browser gets to load the renderer page and connect (overridable for tests).
const HEADLESS_START_MS = Number(process.env.LFX_HEADLESS_START_MS) || 30_000;
const HEADLESS_RETRY_MS = 5 * 60_000;
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
  /** The headless renderer: answers render/mermaid requests only, never opens or saves a drawing. */
  renderer?: boolean;
}

type Auth = "bearer" | "session" | "renderer" | null;

/** Operations that change a drawing: they take `if_rev` and report the new content revision. */
const WRITE_OPS = new Set(["add", "update", "delete", "apply", "arrange", "connect", "diagram", "insert_shape", "mermaid", "restore"]);

/**
 * Turns `code: "src/foo.ts:42"` on new elements or updates into the code-link convention
 * (codelinks.ts): `link` holds the project-relative path with an optional `#L<line>`, and
 * `customData.lfxCode` the same plus the file's hash now. A `link` that is already a project
 * path gets the same treatment; a web link drops any stale code reference. `code: null`
 * removes the link. Missing files are linked anyway and noted.
 */
function codeLinks<T extends { id?: string; code?: unknown; link?: unknown; customData?: unknown; type?: string }>(
  items: T[],
  root: string,
  notes: string[],
  existing: El[] = [],
): T[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  return items.map((item) => {
    if (item.type === "placed" || (item.code === undefined && typeof item.link !== "string" && item.link !== null)) return item;
    const { code, ...rest } = item;
    const prev = (item.customData ?? (item.id ? byId.get(item.id)?.customData : undefined) ?? {}) as Record<string, unknown>;
    const { lfxCode: _old, ...custom } = prev;
    const raw = code !== undefined ? code : item.link;
    if (raw === null || raw === "") return { ...rest, link: null, customData: custom } as unknown as T;
    if (typeof raw !== "string") throw new SceneError(`${item.id ?? "element"}: code must be a project path like "src/foo.ts" or "src/foo.ts:42"`);
    let s = raw.trim();
    if (path.isAbsolute(s)) {
      const rel = path.relative(root, s);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) s = rel.split(path.sep).join("/");
    }
    const ref = parseCodeLink(s);
    if (!ref) {
      if (code !== undefined) throw new SceneError(`${item.id ?? "element"}: "${raw}" isn't a path inside the project (use e.g. "src/foo.ts" or "src/foo.ts:42")`);
      // An ordinary web link: drop a stale code reference, if there was one.
      return ("lfxCode" in prev ? { ...rest, customData: custom } : rest) as unknown as T;
    }
    const sha = hashFile(path.resolve(root, ref.path));
    if (!sha) notes.push(`${item.id ?? "element"}: ${ref.path} doesn't exist (linked anyway)`);
    return { ...rest, link: formatCodeLink(ref), customData: { ...custom, lfxCode: { ...ref, ...(sha ? { sha } : {}) } } } as unknown as T;
  });
}

export async function startDaemon(cfg: Config): Promise<http.Server> {
  ensureStateDir(cfg);
  const token = loadOrCreateToken(cfg);
  const store = new DocStore({ stateDir: cfg.stateDir });
  const snapshots = new Snapshots(cfg.stateDir);

  // ---- persisted state -------------------------------------------------------
  const rootsFile = path.join(cfg.stateDir, "roots.json");
  const sessionsFile = path.join(cfg.stateDir, "sessions.json");
  const libraryFile = path.join(cfg.stateDir, "library.json");
  const libraries = new Libraries(cfg.stateDir, libraryFile, cfg.librariesDir);
  // Roots the user added (`lfx open`, the macOS app) persist; roots MCP servers register for
  // their project last only as long as this daemon, so they don't pile up forever.
  const registered = new Set<string>(readJson<string[]>(rootsFile, []).filter((r) => fs.existsSync(r)));
  const sessionRoots = new Set<string>();
  for (const r of cfg.defaultRoots) fs.mkdirSync(r, { recursive: true });
  const roots = () => [...new Set([...cfg.defaultRoots, ...registered, ...sessionRoots])];
  const saveRoots = () => writeFileAtomic(rootsFile, JSON.stringify([...registered], null, 2), 0o600);
  const outsideRoots = (what: string) =>
    new HttpError(403, `${what} is outside the allowed roots. Allowed roots: ${roots().join(", ")}`, { code: "outside-roots" });

  const sessions = new Map<string, number>(Object.entries(readJson<Record<string, number>>(sessionsFile, {})));
  const saveSessions = () => {
    const now = Date.now();
    for (const [k, t] of sessions) if (now - t > SESSION_TTL_MS) sessions.delete(k);
    writeFileAtomic(sessionsFile, JSON.stringify(Object.fromEntries(sessions)), 0o600);
  };
  const loginCodes = new Map<string, { expires: number; file?: string; renderer?: boolean }>();
  // The headless renderer's session: in memory only, and good for nothing but the page and its WebSocket.
  const rendererSessions = new Set<string>();

  // ---- auth --------------------------------------------------------------------
  const authOf = (req: IncomingMessage): Auth => {
    const b = bearer(req);
    if (b && safeEqual(b, token)) return "bearer";
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid && rendererSessions.has(sid)) return "renderer";
    if (sid && sessions.has(sid)) {
      const created = sessions.get(sid)!;
      if (Date.now() - created < SESSION_TTL_MS) return "session";
    }
    return null;
  };

  /** git status per project root, reused for a few seconds while the user types a mention. */
  const changedCache = new Map<string, { at: number; files: Promise<Set<string>> }>();
  const changedFilesCached = (root: string) => {
    const hit = changedCache.get(root);
    if (hit && Date.now() - hit.at < 5_000) return hit.files;
    const files = changedFiles(root);
    changedCache.set(root, { at: Date.now(), files });
    return files;
  };

  const safe = (p: unknown) => {
    try {
      return resolveSafePath(String(p ?? ""), roots());
    } catch (e) {
      if (e instanceof PathError) throw new HttpError(403, e.message, e.message.startsWith("Path is outside") ? { code: "outside-roots" } : {});
      throw e;
    }
  };

  // ---- websocket clients -----------------------------------------------------------
  const clients = new Map<string, Client>();
  /** Editor RPCs awaiting a reply, with the tab that owes it. */
  const pending = new Map<string, { owner: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  const send = (c: Client, msg: unknown) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  };

  store.on("change", (ch: SceneChange) => {
    drawingSet.saw(ch.path);
    for (const c of clients.values()) {
      if (c.path === ch.path && c.id !== ch.origin) {
        // "agent": the in-app assistant; "mcp:<client>": an MCP agent; "daemon": the daemon's own
        // bookkeeping (code-link hashes), which the tab that saved also needs to see.
        const mcp = ch.origin?.startsWith("mcp:") ? ch.origin.slice(4) : undefined;
        send(c, {
          t: "scene",
          path: ch.path,
          rev: ch.rev,
          scene: ch.scene,
          agent: ch.origin === "agent" || mcp !== undefined || undefined,
          by: mcp ?? (ch.origin === "agent" ? "assistant" : undefined),
          quiet: ch.origin === "daemon" || undefined,
        });
      }
    }
  });

  store.on("deleted", (p: string) => {
    for (const c of clients.values()) if (c.path === p) send(c, { t: "deleted", path: p });
    drawingSet.nudge();
  });

  const isOpen = (c: Client) => c.ws.readyState === c.ws.OPEN;
  /** Tabs the user can see; the headless renderer is not one of them. */
  const visibleClients = () => [...clients.values()].filter((c) => !c.renderer);

  // ---- drawing set changes: the sidebar trees (tabs) and the macOS app (/api/events) ----
  const eventStreams = new Set<ServerResponse>();
  const drawingSet = new DrawingSetWatcher(roots, () => {
    for (const c of visibleClients()) send(c, { t: "files-changed" });
    for (const res of eventStreams) res.write("event: files-changed\ndata: {}\n\n");
  });
  /** Watch only while something shows the drawing list. */
  const updateWatching = () => drawingSet.setActive(visibleClients().length > 0 || eventStreams.size > 0);

  const waitForClient = async (ms: number): Promise<Client | undefined> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const c = pickClient();
      if (c) return c;
      await new Promise((r) => setTimeout(r, 250));
    }
    return pickClient();
  };
  const pickClient = (onPath?: string) =>
    visibleClients()
      .filter((c) => isOpen(c) && (!onPath || c.path === onPath))
      .sort((a, b) => b.lastActive - a.lastActive)[0];

  // ---- headless renderer (LFX_HEADLESS) ----
  const headlessModeSetting = headlessMode();
  const headless = new HeadlessBrowser({
    idleMs: (Number(process.env.LFX_HEADLESS_IDLE_MIN) || 5) * 60_000,
    loginUrl: () => {
      // Each launch is a fresh browser with a fresh profile: earlier renderer sessions are dead.
      rendererSessions.clear();
      const code = crypto.randomBytes(24).toString("base64url");
      loginCodes.set(code, { expires: Date.now() + LOGIN_CODE_TTL_MS, renderer: true });
      return `${baseUrl(cfg)}/login?code=${encodeURIComponent(code)}`;
    },
  });
  const liveRenderer = () => [...clients.values()].filter((c) => c.renderer && isOpen(c)).sort((a, b) => b.lastActive - a.lastActive)[0];
  let launching: Promise<Client> | undefined;

  /** The headless renderer's connection, launching the browser and waiting for its page if needed. */
  const rendererClient = (): Promise<Client> => {
    const r = liveRenderer();
    if (r) {
      headless.touch();
      return Promise.resolve(r);
    }
    return (launching ??= (async () => {
      try {
        headless.start();
      } catch (e) {
        if (e instanceof HeadlessUnavailable) throw new HttpError(503, e.message, { code: "no-editor", headless: "unavailable" });
        throw e;
      }
      const deadline = Date.now() + HEADLESS_START_MS;
      while (Date.now() < deadline) {
        const c = liveRenderer();
        if (c) return c;
        if (!headless.running) throw new HttpError(502, "The headless browser exited before it connected; see the daemon log");
        await new Promise((r) => setTimeout(r, 100));
      }
      // Usually an editor bundle without renderer mode (a stale dist/web) or a browser that can't load it.
      headless.stop();
      throw new HttpError(504, "The headless browser did not connect in time; see the daemon log");
    })().finally(() => {
      launching = undefined;
    }));
  };

  // A launch that failed isn't retried for a while, so every render doesn't wait out the start timeout again.
  let headlessFailed: { message: string; until: number } | undefined;

  /**
   * Who serves a browser-backed request: a visible tab of that drawing (so the user sees the
   * work happen), else the headless renderer, else any visible tab (LFX_HEADLESS=off, no
   * browser binary, or a headless launch that failed).
   */
  const editorFor = async (onPath: string | undefined, waitMs: number): Promise<Client> => {
    if (headlessModeSetting !== "always" && onPath) {
      const own = pickClient(onPath);
      if (own) return own;
    }
    if (headlessModeSetting !== "off" && headless.available) {
      if (headlessFailed && headlessFailed.until < Date.now()) headlessFailed = undefined;
      if (!headlessFailed) {
        try {
          return await rendererClient();
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          headlessFailed = { message: e.message, until: Date.now() + HEADLESS_RETRY_MS };
          console.error(`Headless rendering failed: ${e.message}`);
        }
      }
      if (headlessModeSetting === "always") {
        throw new HttpError(502, `Headless rendering is unavailable: ${headlessFailed!.message}`, { code: "headless-failed" });
      }
    }
    const c = await waitForClient(waitMs);
    if (c) return c;
    const hint =
      headlessModeSetting === "off"
        ? ""
        : headlessFailed
          ? ` Headless rendering failed: ${headlessFailed.message}.`
          : " Headless rendering needs a Chromium-family browser: install Chrome/Chromium or set LFX_BROWSER.";
    throw new HttpError(409, `No editor is open. Open the drawing in the browser first (open_drawing / \`lfx open\`).${hint}`, {
      code: "no-editor",
      headless: headlessModeSetting === "off" ? "off" : headlessFailed ? "failed" : "unavailable",
    });
  };

  /** Ask a browser to do something only a real browser can (render, mermaid). */
  const rpc = (msg: Record<string, unknown>, waitMs: number, onPath?: string): Promise<unknown> =>
    withSpan(`lfx.editor ${String(msg.t)}`, { "lfx.editor.request": String(msg.t), "lfx.editor.wait_ms": waitMs }, async (span) => {
      const release = headless.hold();
      try {
        const c = await editorFor(onPath, waitMs);
        span.setAttribute("lfx.editor.headless", !!c.renderer);
        return await editorRpc(c, msg);
      } finally {
        release();
      }
    });

  const editorRpc = (c: Client, msg: Record<string, unknown>): Promise<unknown> => {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new HttpError(504, "The editor did not respond in time"));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { owner: c.id, resolve, reject, timer });
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

  /** One drawing operation, from the HTTP API (MCP agents) or the assistant's tools. */
  /** `via` tags edits from an MCP client ("mcp:<client name>") so its tabs can undo and highlight them. */
  const op = (body: Record<string, unknown>, via?: string) =>
    withSpan(`lfx.op ${String(body.op)}`, { "lfx.op": String(body.op) }, async (span) => {
      const out = (await runOp(body, via)) as Record<string, unknown>;
      const p = String(out.path ?? body.path);
      // Writes report the new content revision, so the caller can chain if_rev.
      if (WRITE_OPS.has(String(body.op)) && typeof out.rev === "number") out.contentRev = contentRev(store.get(p).scene.elements);
      let rel = path.basename(p);
      try {
        rel = path.relative(projectRootFor(p), p) || rel;
      } catch {
        // outside every root: keep the file name
      }
      span.setAttributes({
        "lfx.drawing": rel,
        "lfx.op.assistant": agentPaths.has(p),
        "lfx.scene.rev": typeof out.rev === "number" ? out.rev : undefined,
        "lfx.op.created": Array.isArray(out.created) ? out.created.length : undefined,
      });
      return out;
    });

  /** Records the hash of newly linked files (customData.lfxCode) on the way in. */
  const stamped = (p: string, elements: El[]): { elements: El[]; stamped: number } => {
    let root: string;
    try {
      root = projectRootFor(p);
    } catch {
      return { elements, stamped: 0 };
    }
    return stampCodeLinks(elements, root);
  };
  const apply = (p: string, change: Parameters<DocStore["apply"]>[1], origin?: string) =>
    store.apply(p, change.elements ? { ...change, elements: stamped(p, change.elements).elements } : change, origin);

  const runOp = async (body: Record<string, unknown>, via?: string) => {
    const p = safe(body.path);
    // Overwriting is how an unreadable file (e.g. with merge conflict markers) is recovered.
    if (body.op === "create" && body.overwrite) store.discardInvalid(p);
    const { scene } = store.get(p);
    const origin = agentPaths.has(p) ? "agent" : via;
    // Read-modify-write safety: refuse the write if the drawing changed since the caller read it.
    if (typeof body.if_rev === "string" && body.if_rev && WRITE_OPS.has(String(body.op))) {
      const now = contentRev(scene.elements);
      if (now !== body.if_rev) {
        throw new HttpError(
          409,
          `The drawing changed since you read it (you had rev ${body.if_rev}, it is now ${now}). Call read_drawing again and redo the edit against what is there now; the user may have edited it.`,
          { code: "stale-rev", rev: now },
        );
      }
    }
    const notes: string[] = [];
    const root = () => projectRootFor(p);
    switch (body.op) {
      case "read": {
        const doc = store.getLive(p);
        if (!doc.exists) throw new HttpError(404, `No drawing at ${p}`);
        const filter = { query: body.query as string | undefined, ids: body.ids as string[] | undefined, type: body.type as string | undefined };
        const only = filter.query || filter.ids?.length || filter.type ? findElements(doc.scene.elements, filter) : undefined;
        let summary = describe(doc.scene, only);
        try {
          const links = checkLinks(only ? doc.scene.elements.filter((e) => only.has(e.id)) : doc.scene.elements, projectRootFor(p));
          if (links.length) summary += `\n${summarizeLinks(links)}`;
        } catch {
          // outside every root: no link check
        }
        return {
          path: p,
          rev: doc.rev,
          contentRev: contentRev(doc.scene.elements),
          total: doc.scene.elements.filter((e) => !(e.type === "text" && e.containerId)).length,
          matched: only?.size,
          summary,
          scene: body.full ? (only ? { ...doc.scene, elements: doc.scene.elements.filter((e) => only.has(e.id) || only.has(e.containerId)) } : doc.scene) : undefined,
        };
      }
      case "snapshot": {
        const doc = store.getLive(p);
        if (!doc.exists) throw new HttpError(404, `No drawing at ${p}`);
        return { path: p, snapshot: snapshots.save(p, doc.scene, body.name as string | undefined) };
      }
      case "snapshots":
        return { path: p, snapshots: snapshots.list(p) };
      case "restore": {
        const snap = snapshots.get(p, body.snapshot as string | undefined);
        if (!snap) {
          const have = snapshots.list(p);
          throw new HttpError(404, have.length ? `No snapshot "${String(body.snapshot)}". Snapshots: ${have.map((s) => `${s.id} (${s.name})`).join(", ")}` : `${p} has no snapshots`);
        }
        // Keep what is being replaced, so a restore can itself be undone.
        const before = snapshots.save(p, store.getLive(p).scene, `before restoring ${snap.info.name}`);
        const r = apply(p, { elements: restoreElements(scene.elements, snap.elements), files: snap.files, replace: true }, origin);
        return { path: p, rev: r.rev, restored: snap.info, saved: before };
      }
      case "apply": {
        // Deletes first (so their ids can be reused), then adds, then updates (which may refer to new elements).
        let elements = scene.elements;
        let deleted: string[] = [];
        if (Array.isArray(body.delete) && body.delete.length) ({ elements, deleted } = deleteElements(elements, body.delete as string[]));
        let created: string[] = [];
        if (Array.isArray(body.add) && body.add.length) {
          const cur = { ...scene, elements };
          const els = codeLinks(appendPlacement(cur, body.add as SkeletonEl[], (body.placement as string) ?? "absolute"), root(), notes);
          ({ elements, created } = addSkeletons(elements, els));
        }
        if (Array.isArray(body.update) && body.update.length) elements = updateElements(elements, codeLinks(body.update as ElementUpdate[], root(), notes, elements));
        const r = apply(p, { elements }, origin);
        return { path: p, rev: r.rev, created, deleted, notes };
      }
      case "arrange": {
        const elements = arrangeElements(scene.elements, (body.ids as string[]) ?? [], { align: body.align as Align | undefined, distribute: body.distribute as Distribute | undefined });
        const r = apply(p, { elements }, origin);
        return { path: p, rev: r.rev };
      }
      case "check_links": {
        const doc = store.getLive(p);
        if (!doc.exists) throw new HttpError(404, `No drawing at ${p}`);
        const links = checkLinks(doc.scene.elements, projectRootFor(p));
        return { path: p, rev: doc.rev, links, summary: summarizeLinks(links) };
      }
      case "review_links": {
        // "Mark as reviewed": the linked code was checked, so its current hash becomes the baseline.
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : undefined;
        const updated = refreshLinks(live(scene.elements), projectRootFor(p), ids);
        if (!updated.length) return { path: p, rev: store.get(p).rev, reviewed: 0 };
        const r = apply(p, { elements: updated }, origin);
        return { path: p, rev: r.rev, reviewed: updated.length };
      }
      case "create": {
        if (store.exists(p) && !body.overwrite) throw new HttpError(409, `${p} already exists (pass overwrite: true to replace it)`);
        // Built over tombstones of the old content, so reused ids outrank it.
        const { elements, created } = addSkeletons(cleared(scene.elements), codeLinks((body.elements as SkeletonEl[]) ?? [], root(), notes));
        const r = apply(p, { elements, replace: true, appState: { viewBackgroundColor: "#ffffff", gridSize: 20 } }, origin);
        return { path: p, rev: r.rev, created, notes };
      }
      case "connect": {
        // Re-bind an existing arrow, or draw a new one.
        const id = typeof body.id === "string" ? body.id : undefined;
        const from = String(body.from);
        const to = String(body.to);
        const existing = id ? live(scene.elements).find((e) => e.id === id) : undefined;
        if (!existing) {
          const arrow = { type: "arrow", id, start: { id: from }, end: { id: to }, label: body.label, strokeStyle: body.style ?? "solid", startArrowhead: body.bidirectional ? "arrow" : null };
          const { elements, created } = addSkeletons(scene.elements, [arrow as SkeletonEl]);
          const r = apply(p, { elements }, origin);
          return { path: p, rev: r.rev, id: created[0], rebound: false };
        }
        let elements = connectArrow(scene.elements, existing.id, from, to);
        const style: ElementUpdate = { id: existing.id };
        if (typeof body.label === "string") style.label = body.label;
        if (typeof body.style === "string") style.strokeStyle = body.style;
        if (typeof body.bidirectional === "boolean") style.startArrowhead = body.bidirectional ? "arrow" : null;
        if (Object.keys(style).length > 1) elements = updateElements(elements, [style]);
        const r = apply(p, { elements }, origin);
        return { path: p, rev: r.rev, id: existing.id, rebound: true };
      }
      case "add": {
        const els = codeLinks(appendPlacement(scene, (body.elements as SkeletonEl[]) ?? [], body.placement as string | undefined), root(), notes);
        const { elements, created } = addSkeletons(scene.elements, els);
        const r = apply(p, { elements }, origin);
        return { path: p, rev: r.rev, created, notes };
      }
      case "diagram": {
        const spec = body.graph as GraphSpec;
        // Nodes may name a library shape: size them to it so the layout leaves room.
        const lib = new Map<string, LibraryShape>();
        let shapes: LibraryShape[] | undefined;
        for (const n of spec.nodes) {
          if (!n.shape || PRIMITIVE_SHAPES.has(n.shape) || PSEUDO_SHAPES.has(n.shape)) continue;
          shapes ??= libraries.shapes(projectRootFor(p));
          const shape = findShape(shapes, n.shape);
          const scale = shapeScale(shape, { normalize: true });
          const label = labelSize(n.label);
          n.shape = `lib:${shape.key}`;
          n.size = { w: Math.round(Math.max(shape.width * scale, label.width)), h: Math.round(shape.height * scale + label.height) };
          lib.set(n.shape, shape);
        }
        // `replace` swaps the old content for the diagram in one write, so a failure leaves it intact.
        const replace = body.replace === true;
        const base = replace ? cleared(scene.elements) : scene.elements;
        const els = replace ? layoutGraph(spec) : appendPlacement(scene, layoutGraph(spec), (body.placement as string) ?? "right");
        // Namespace ids when appending so repeated diagrams don't collide.
        const taken = new Set(live(base).map((e) => e.id));
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
        // Node code links go on the node's shape (a library shape's main part).
        const code = new Map(spec.nodes.filter((n) => typeof n.code === "string" && n.code).map((n) => [ren(n.id)!, n.code!]));
        const linked = expanded.map((e): SkeletonEl => {
          const id = e.type === "placed" ? (e.element as El).id : e.id;
          const c = id ? code.get(id) : undefined;
          if (!c) return e;
          if (e.type !== "placed") return { ...e, code: c };
          const [withLink] = codeLinks([{ type: "rectangle", id, code: c } as SkeletonEl], root(), notes);
          return { ...e, element: { ...(e.element as El), link: withLink.link, customData: { ...(e.element as El).customData, ...(withLink.customData as object) } } };
        });
        const { elements, created } = addSkeletons(base, codeLinks(linked, root(), notes));
        const r = apply(p, { elements }, origin);
        return { path: p, rev: r.rev, created, notes };
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
          p,
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
        const r = apply(p, { elements: placed.elements }, origin);
        return { path: p, rev: r.rev, shape: shape.key, anchor: placed.anchorId, created: placed.ids, bounds: placed.bounds };
      }
      case "update": {
        const elements = updateElements(scene.elements, codeLinks((body.updates as ElementUpdate[]) ?? [], root(), notes, scene.elements));
        const r = apply(p, { elements }, origin);
        return { path: p, rev: r.rev, notes };
      }
      case "delete": {
        const { elements, deleted } = deleteElements(scene.elements, (body.ids as string[]) ?? []);
        const r = apply(p, { elements }, origin);
        return { path: p, rev: r.rev, deleted };
      }
      case "replace": {
        const r = apply(p, { elements: body.elements as El[], replace: true }, origin);
        return { path: p, rev: r.rev };
      }
      case "clear": {
        const r = apply(p, { elements: [], replace: true }, origin);
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
          p,
        )) as { data: string; mime: string; scale?: number };
        const texts = scene.elements.filter((e) => e.type === "text" && !e.isDeleted && typeof e.fontSize === "number");
        const minFont = texts.length ? Math.min(...texts.map((e) => e.fontSize as number)) : undefined;
        return { ...out, missing, minFont, elements: scene.elements.filter((e) => !e.isDeleted).length };
      }
      case "mermaid": {
        const conv = (await rpc({ t: "mermaid", text: body.text }, Math.max(3_000, Number(body.waitMs ?? 0)), p)) as {
          elements: El[];
          files?: Record<string, unknown>;
        };
        let incoming = conv.elements;
        const b = bounds(scene.elements);
        const nb = bounds(incoming);
        if (b && nb) incoming = incoming.map((e) => ({ ...e, x: e.x + b.maxX + 120 - nb.minX, y: e.y + b.minY - nb.minY }));
        const r = apply(p, { elements: [...scene.elements, ...incoming], files: conv.files }, origin);
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
    if (!allowed) throw outsideRoots("Drawing");
    const home = fs.realpathSync.native(os.homedir());
    for (let dir = path.dirname(file); dir !== home && dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    }
    return allowed;
  };

  const broadcastChat = (p: string, session: string | undefined, ev: ChatEvent) => {
    for (const c of clients.values()) if (c.path === p) send(c, { t: "chat", path: p, session, ev });
  };
  const sendHistory = (c: Client, p: string) => {
    const ev = assistant.history(p);
    send(c, { t: "chat", path: p, session: ev.session, ev });
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
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return json(res, 400, { error: "Malformed URL" });
    }
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

  /** Tells tabs showing `from` where their drawing went. */
  const announceMove = (from: string, to: string) => {
    for (const c of clients.values()) if (c.path === from) send(c, { t: "moved", path: from, to });
  };

  /** Drawing file management for the drawing list and editor menu. Every path is checked against the roots. */
  const fileOp = async (name: string, method: string, req: IncomingMessage): Promise<unknown> => {
    if (name === "git" && method === "GET") return { status: await drawingStatus(roots()) };
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readBody(req);
    const result = await changeFiles(name, body);
    drawingSet.nudge();
    return result;
  };

  /** A folder under a root (not a root itself), canonicalised. */
  const subfolder = (dir: unknown) => {
    const real = safeDir(String(dir ?? ""));
    if (roots().some((r) => (fs.existsSync(r) ? fs.realpathSync.native(r) : r) === real)) throw new HttpError(400, "That is a root folder; remove or re-add it instead");
    if (!fs.statSync(real).isDirectory()) throw new HttpError(400, "Not a folder");
    return real;
  };

  const changeFiles = async (name: string, body: Record<string, any>): Promise<unknown> => {
    try {
      switch (name) {
        case "rename":
        case "move": {
          const from = safe(body.path);
          // `to` is a full new path; `dir` keeps the name and changes the folder.
          const to = name === "move" ? safe(path.join(safeDir(String(body.dir ?? "")), path.basename(from))) : safe(body.to);
          if (to === from) return { path: to };
          if (!store.exists(from)) throw new HttpError(404, `No drawing at ${from}`);
          announceMove(from, to);
          moveFile(from, to);
          store.get(from); // notices the file is gone
          return { path: to };
        }
        case "duplicate": {
          const from = safe(body.path);
          const to = body.to ? safe(body.to) : copyName(from);
          duplicateFile(from, safe(to));
          return { path: to };
        }
        case "trash": {
          const p = safe(body.path);
          if (!store.exists(p)) throw new HttpError(404, `No drawing at ${p}`);
          const trashed = moveToTrash(p);
          store.get(p); // tabs on it get "deleted" and offer to restore
          return { path: p, trashed };
        }
        case "folder": {
          let dir: string;
          try {
            dir = resolveSafePath(String(body.path ?? ""), roots(), [""]);
          } catch (e) {
            if (e instanceof PathError) throw new HttpError(403, e.message);
            throw e;
          }
          if (roots().some((r) => path.resolve(r) === dir)) throw new HttpError(409, "That folder already exists");
          makeFolder(dir);
          return { path: dir };
        }
        case "rename-folder": {
          // A new name in the same parent; open tabs on drawings inside follow.
          const from = subfolder(body.path);
          const name = String(body.name ?? "").trim();
          if (!name || /[\\/\0]/.test(name) || name === "." || name === "..") throw new HttpError(400, "Give the folder a plain name, without slashes");
          const to = path.join(path.dirname(from), name);
          if (to === from) return { path: to };
          const inside = listDrawings([from], 12, 5_000, { gitignore: false }).map((d) => d.path);
          moveFile(from, to);
          for (const p of inside) announceMove(p, path.join(to, path.relative(from, p)));
          for (const p of inside) store.get(p);
          return { path: to };
        }
        case "reveal": {
          // Show a drawing or folder in the Finder (macOS only).
          if (process.platform !== "darwin") throw new HttpError(501, "Revealing files is only supported on macOS");
          let target: string;
          try {
            target = safe(body.path);
          } catch {
            target = safeDir(String(body.path ?? ""));
          }
          if (!fs.existsSync(target)) throw new HttpError(404, `No such file: ${target}`);
          await launch({ cmd: "open", args: ["-R", target], via: "finder" });
          return { path: target };
        }
      }
    } catch (e) {
      if (e instanceof FileOpError) throw new HttpError(e.status, e.message);
      throw e;
    }
    throw new HttpError(404, "Not found");
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req, cfg.allowedHosts)) return json(res, 421, { error: "Host not allowed" });
    if (!originAllowed(req, cfg.allowedHosts)) return json(res, 403, { error: "Cross-origin request refused" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;
    const method = req.method ?? "GET";

    if (pathname === "/api/health") {
      // onDemand: started by DaemonClient.ensure(), which may replace it with a newer version.
      return json(res, 200, { ok: true, name: "local-first-excalidraw", version: VERSION, pid: process.pid, onDemand: process.env.LFX_ON_DEMAND === "1" });
    }

    if (pathname === "/login" && method === "GET") {
      const code = url.searchParams.get("code") ?? "";
      const entry = loginCodes.get(code);
      loginCodes.delete(code);
      if (!entry || entry.expires < Date.now()) {
        return page(res, 401, "Link expired", "This sign-in link was already used or has expired. Run <code>lfx open</code> to get a new one.");
      }
      const sid = crypto.randomBytes(32).toString("base64url");
      if (entry.renderer) {
        rendererSessions.add(sid);
        res.writeHead(303, {
          ...SECURITY_HEADERS,
          "Set-Cookie": `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`,
          Location: "/?renderer=1",
        });
        return res.end();
      }
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
    // The headless renderer reads nothing and writes nothing: drawings reach it only inside render requests.
    if (auth === "renderer") return json(res, 403, { error: "Not available to the renderer" });
    const bearerOnly = () => {
      if (auth !== "bearer") throw new HttpError(403, "This endpoint is only available to local clients");
    };

    if (pathname === "/api/events" && method === "GET") {
      // Server-sent events for clients without a WebSocket (the macOS app): "files-changed" so far.
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      eventStreams.add(res);
      updateWatching();
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        eventStreams.delete(res);
        updateWatching();
      });
      return;
    }
    if (pathname === "/api/files" && method === "GET") {
      const rs = roots();
      return json(res, 200, { roots: rs, drawings: listDrawings(rs), folders: listFolders(rs) });
    }
    if (pathname.startsWith("/api/files/")) return json(res, 200, await fileOp(pathname.slice("/api/files/".length), method, req));
    if (pathname === "/api/open-code" && method === "POST") {
      // A code link clicked in the editor: open that file in the user's editor, never a browser tab.
      const body = await readBody(req);
      const drawing = safe(body.drawing);
      const target = parseCodeLink(String(body.link ?? ""));
      if (!target) throw new HttpError(400, "Not a code link (expected a project-relative path like src/a.ts#L42)");
      let file: string;
      try {
        file = resolveInRoot(projectRootFor(drawing), target.path).abs;
      } catch (e) {
        if (e instanceof CodeError) throw new HttpError(/No such file/.test(e.message) ? 404 : 403, e.message);
        throw e;
      }
      if (!fs.statSync(file).isFile()) throw new HttpError(400, `${target.path} is not a file`);
      let l;
      try {
        l = editorCommand(file, target.line, editorSetting(cfg.stateDir));
        await launch(l);
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
      return json(res, 200, { ok: true, file, line: target.line ?? null, editor: l.via });
    }
    if (pathname === "/api/links" && method === "GET") {
      return json(res, 200, await op({ op: "check_links", path: url.searchParams.get("path") }));
    }
    if (pathname === "/api/links/review" && method === "POST") {
      const body = await readBody(req);
      // Only bookkeeping changes, so tabs take it quietly.
      return json(res, 200, await op({ op: "review_links", path: body.path, ids: body.ids }, "daemon"));
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
    if (pathname === "/api/ai/tools" && method === "GET") return json(res, 200, toolCatalog(settings));
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
      let files: MentionSuggestion[] = [];
      if (settings.get().codeAccess) {
        try {
          // Files with uncommitted changes rank first: they're usually what the question is about.
          files = suggestMentions(root, q, { changed: await changedFilesCached(root), limit: 20 });
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
              itemUse: undefined,
              installed: installed.has(e.url) || builtIn.has(e.url) || ids.has(`installed:${slug(path.basename(e.source, ".excalidrawlib"))}`),
            })),
          });
        }
        if (pathname === "/api/libraries/install" && method === "POST") {
          const { entry, content } = await fetchCatalogLibrary(String((await readBody(req)).source ?? ""));
          const info = libraries.install(content, { name: entry.name, description: entry.description, authors: entry.authors, url: entry.url, itemNames: entry.itemNames, itemUse: entry.itemUse });
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
      // Edits from MCP clients go on the open tabs' undo stack, labelled with the client's name.
      const agent = String(req.headers["x-lfx-agent"] ?? "").replace(/[^\w .@/-]/g, "").slice(0, 40);
      return json(res, 200, await op(await readBody(req), `mcp:${agent}`));
    }
    if (pathname === "/api/list" && method === "POST") {
      bearerOnly();
      const body = await readBody(req);
      const within = body.root ? [safeDir(String(body.root))] : roots();
      return json(res, 200, { drawings: listDrawings(within) });
    }
    if (pathname === "/api/roots" && method === "GET") {
      bearerOnly();
      return json(res, 200, { roots: roots(), defaults: cfg.defaultRoots, registered: [...registered], session: [...sessionRoots] });
    }
    if (pathname === "/api/roots" && method === "POST") {
      bearerOnly();
      if (!cfg.allowRootRegistration) throw new HttpError(403, "Root registration is disabled (LFX_LOCK_ROOTS=1)");
      const body = await readBody(req);
      const r = fs.realpathSync.native(path.resolve(String(body.path)));
      if (!fs.statSync(r).isDirectory()) throw new HttpError(400, "Root must be a directory");
      if (r === path.parse(r).root) throw new HttpError(400, "Refusing to register the filesystem root");
      if (body.session === true) {
        if (!registered.has(r)) sessionRoots.add(r);
      } else {
        sessionRoots.delete(r);
        registered.add(r);
        saveRoots();
      }
      return json(res, 200, { roots: roots() });
    }
    if (pathname === "/api/roots" && method === "DELETE") {
      bearerOnly();
      const body = await readBody(req);
      const input = path.resolve(String(body.path ?? ""));
      const r = fs.existsSync(input) ? fs.realpathSync.native(input) : input;
      if (cfg.defaultRoots.includes(r) || cfg.defaultRoots.includes(input)) {
        throw new HttpError(400, `${input} is a default root; change LFX_ROOTS to remove it`);
      }
      const found = [registered.delete(r), registered.delete(input), sessionRoots.delete(r), sessionRoots.delete(input)].some(Boolean);
      if (!found) throw new HttpError(404, `${input} is not a registered root`);
      saveRoots();
      return json(res, 200, { roots: roots() });
    }
    if (pathname === "/api/login-code" && method === "POST") {
      bearerOnly();
      const body = await readBody(req);
      const file = body.path ? safe(body.path) : undefined;
      const code = crypto.randomBytes(24).toString("base64url");
      loginCodes.set(code, { expires: Date.now() + LOGIN_CODE_TTL_MS, file });
      for (const [k, v] of loginCodes) if (v.expires < Date.now()) loginCodes.delete(k);
      return json(res, 200, { code, file, editors: visibleClients().length });
    }
    if (pathname === "/api/status" && method === "GET") {
      bearerOnly();
      return json(res, 200, {
        version: VERSION,
        pid: process.pid,
        roots: roots(),
        editors: visibleClients().map((c) => ({ path: c.path ?? null })),
        headless: { mode: headlessModeSetting, browser: headless.browser ?? null, pid: headless.pid ?? null, connected: !!liveRenderer(), failed: headlessFailed?.message ?? null },
      });
    }
    if (pathname === "/api/shutdown" && method === "POST") {
      bearerOnly();
      json(res, 200, { ok: true });
      setTimeout(() => void shutdownTelemetry().finally(() => process.exit(0)), 50);
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
    throw outsideRoots("Directory");
  };

  // Anything that talks to the daemon keeps an idle daemon alive (see LFX_IDLE_EXIT_MIN below).
  let lastActivity = Date.now();

  const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    // `lfx mcp` passes its tool span along, so the operations it asks for join that trace.
    runIn(contextFromHeaders(req.headers), () => handle(req, res)).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...e.extra });
      if (e instanceof InvalidDrawingError) return json(res, 422, { error: e.message });
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
    const renderer = authOf(req) === "renderer";
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Client = { id: crypto.randomUUID(), ws, lastActive: Date.now(), renderer };
      clients.set(c.id, c);
      updateWatching();
      ws.on("message", (raw) => {
        c.lastActive = lastActivity = Date.now();
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
        updateWatching();
        // Fail this tab's outstanding renders now rather than after the full timeout.
        for (const [id, p] of pending) {
          if (p.owner !== c.id) continue;
          pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new HttpError(503, "The editor tab closed before it replied; try again", { code: "editor-closed" }));
        }
      });
    });
  });

  const onMessage = (c: Client, msg: Record<string, unknown>) => {
    // The headless renderer only answers requests: it never opens, saves or chats.
    if (msg.t === "ping") return send(c, { t: "pong" });
    if (c.renderer && msg.t !== "reply") return;
    switch (msg.t) {
      case "open": {
        const p = safe(msg.path);
        c.unwatch?.();
        c.path = p;
        c.unwatch = store.watch(p);
        const doc = store.get(p);
        send(c, { t: "scene", path: p, rev: doc.rev, exists: doc.exists, scene: doc.scene });
        sendHistory(c, p);
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
        if (c.path) sendHistory(c, c.path);
        return;
      case "chat-stop":
        if (c.path) assistant.stop(c.path, typeof msg.session === "string" ? msg.session : undefined);
        return;
      case "chat-new":
      case "chat-open":
      case "chat-delete":
      case "chat-endpoint":
      case "chat-revert":
        if (!c.path) return;
        try {
          const session = String(msg.session ?? "");
          if (msg.t === "chat-new") assistant.openNew(c.path);
          else if (msg.t === "chat-open") assistant.open(c.path, session);
          else if (msg.t === "chat-delete") assistant.delete(c.path, session);
          else if (msg.t === "chat-endpoint") assistant.setEndpoint(c.path, session, String(msg.endpoint ?? ""));
          else assistant.revert(c.path, session || undefined, String(msg.id));
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
        // A link the user just typed gets its file's hash; the saving tab must then hear back.
        const s = stamped(c.path, Array.isArray(msg.elements) ? (msg.elements as El[]) : []);
        store.apply(
          c.path,
          {
            fromEditor: true,
            elements: Array.isArray(msg.elements) ? s.elements : undefined,
            appState: msg.appState as Record<string, unknown>,
            files: msg.files as Record<string, unknown>,
          },
          s.stamped ? "daemon" : c.id,
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

  // ---- lifetime ------------------------------------------------------------------------------
  const exit = (why: string) => {
    console.error(`Stopping: ${why}.`);
    void shutdownTelemetry().finally(() => process.exit(0));
  };
  // Started by the macOS app: go when it goes, even if it crashed or was force-quit.
  const parent = Number(process.env.LFX_PARENT_PID) || 0;
  if (parent) {
    setInterval(() => {
      if (!processAlive(parent)) exit(`parent process ${parent} exited`);
    }, 1000).unref();
  }
  // Started on demand by the CLI or an agent: go once nothing has used it for a while.
  const idleMin = Number(process.env.LFX_IDLE_EXIT_MIN) || 0;
  if (idleMin > 0) {
    setInterval(() => {
      if (visibleClients().length || assistant.busy() || Date.now() - lastActivity < idleMin * 60_000) return;
      exit(`idle for ${idleMin} minutes`);
    }, 30_000).unref();
  }
  return server;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
