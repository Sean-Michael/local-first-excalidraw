import {
  bumpVersion,
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  FONT_FAMILY,
  hashElementsVersion,
  MainMenu,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, LibraryItems } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chat, type ChatBridge } from "./Chat";
import { dirOf, files, folderOptions, useDialog } from "./FileActions";
import { api, basename, type RenderOpts, type SceneData, type ServerMsg, type Status, Sync } from "./sync";

const SAVE_DEBOUNCE_MS = 250;
const PERSISTED_APP_STATE = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled"] as const;

const THEME_KEY = "lfx-theme";
const CHAT_KEY = "lfx-chat-open";

function storedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
export function storedTheme(): "light" | "dark" {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    // storage unavailable
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const FONT_NAMES = new Map<number, string>(Object.entries(FONT_FAMILY).map(([name, id]) => [id as number, name]));

/** Text must be measured with the real fonts, so make sure the faces (and glyph subsets) are loaded first. */
async function ensureFonts(elements: any[]): Promise<void> {
  const loads = new Map<string, Promise<unknown>>();
  for (const e of elements) {
    if (e.type !== "text" || e.isDeleted) continue;
    const name = FONT_NAMES.get(e.fontFamily);
    if (!name) continue;
    const key = `${name}|${e.text}`;
    if (!loads.has(key)) loads.set(key, document.fonts.load(`20px "${name}"`, e.text || "a").catch(() => {}));
  }
  await Promise.all(loads.values());
}

const GEOMETRY = ["x", "y", "width", "height"] as const;
const moved = (a: any, b: any) => GEOMETRY.some((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 0.5);

/**
 * Restores elements with real font metrics and bumps any text whose geometry changed, so the
 * fix is saved with the next save. It doesn't save anything itself.
 */
async function normalize(elements: any[]): Promise<{ elements: any[]; fixed: number }> {
  await ensureFonts(elements);
  const before = new Map(elements.map((e) => [e.id, e]));
  const opts = { refreshDimensions: true, repairBindings: true };
  let restored = restoreElements(elements, null, opts);
  // Excalidraw needs a second pass when a label's line count changes: the first fixes its height,
  // the second recentres it on an arrow with that height. Run to the fixed point so the next
  // load doesn't find more to fix.
  for (let i = 0; i < 2; i++) {
    const again = restoreElements(restored, null, opts);
    const prev = new Map(restored.map((e: any) => [e.id, e]));
    restored = again;
    if (!again.some((e: any) => e.type === "text" && prev.has(e.id) && moved(prev.get(e.id), e))) break;
  }
  let fixed = 0;
  const out = restored.map((el: any) => {
    const o = before.get(el.id);
    if (o && el.type === "text" && !el.isDeleted && moved(o, el)) {
      fixed++;
      return bumpVersion({ ...el });
    }
    return el;
  });
  return { elements: out, fixed };
}

/** Live elements an incoming scene adds or changes, with bound labels folded into their containers. */
function changedIds(local: any[], remote: any[]): string[] {
  const before = new Map(local.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const e of remote) {
    if (e.isDeleted) continue;
    const old = before.get(e.id);
    if (old && !old.isDeleted && old.version >= e.version) continue;
    out.add(e.containerId && remote.some((c) => c.id === e.containerId) ? e.containerId : e.id);
  }
  return [...out];
}

const HIGHLIGHT_MS = 1500;
const AGENT_TOAST_MS = 6000;
const OFFLINE_BANNER_MS = 3000;
const LINKS_REFRESH_MS = 10_000;
// A canvas smaller than this is hidden or collapsed: too small to fit a drawing into.
const MIN_FIT_PX = 50;

/** "claude-code" -> "Claude Code"; the in-app assistant and unnamed clients get generic names. */
export function agentName(by: string | undefined): string {
  if (by === "assistant") return "The assistant";
  if (!by) return "An agent";
  if (/^claude[- ]code$/i.test(by)) return "Claude Code";
  return by;
}

interface LinkReport {
  id: string;
  path: string;
  line?: number;
  state: "ok" | "changed" | "missing" | "unknown";
}

/** "3 links changed", "1 link missing", "2 links changed, 1 missing". */
export function linksLabel(stale: Pick<LinkReport, "state">[]): string {
  const changed = stale.filter((l) => l.state === "changed").length;
  const missing = stale.filter((l) => l.state === "missing").length;
  const n = (k: number) => `${k} link${k === 1 ? "" : "s"}`;
  if (changed && missing) return `${n(changed)} changed, ${missing} missing`;
  return changed ? `${n(changed)} changed` : `${n(missing)} missing`;
}

/** Scene-space box of an element, for the highlight overlay. */
function sceneBox(e: any): { x: number; y: number; w: number; h: number } {
  if (Array.isArray(e.points) && e.points.length) {
    const xs = e.points.map((p: number[]) => p[0]);
    const ys = e.points.map((p: number[]) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: e.x + minX, y: e.y + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }
  return { x: e.x, y: e.y, w: e.width, h: e.height };
}

const isCodeLink = (link: string) => !!link && !/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith("/") && !link.startsWith("#");

export async function render(scene: SceneData, opts: RenderOpts): Promise<{ data: string; mime: string; scale?: number }> {
  const elements = (await normalize(scene.elements)).elements.filter((e) => !e.isDeleted);
  if (!elements.length) throw new Error("The drawing is empty");
  const appState = {
    ...scene.appState,
    exportBackground: true,
    exportWithDarkMode: !!opts.dark,
    exportEmbedScene: !!opts.embedScene,
    exportScale: opts.scale ?? 1,
  } as any;
  if (opts.format === "svg") {
    const svg = await exportToSvg({ elements, appState, files: scene.files as any, exportPadding: 24 });
    return { data: toBase64(new TextEncoder().encode(svg.outerHTML)), mime: "image/svg+xml" };
  }
  // With maxSize, fit the longest side but don't blow small renders up past 2x.
  let scale = opts.scale ?? 1;
  const blob = await exportToBlob({
    elements,
    appState,
    files: scene.files as any,
    mimeType: "image/png",
    exportPadding: 24,
    getDimensions: (w: number, h: number) => {
      if (opts.maxSize) scale = Math.min(2, opts.maxSize / Math.max(w, h));
      return { width: Math.round(w * scale), height: Math.round(h * scale), scale };
    },
  });
  return { data: toBase64(new Uint8Array(await blob.arrayBuffer())), mime: "image/png", scale };
}

export async function mermaid(text: string): Promise<{ elements: any[]; files: Record<string, unknown> }> {
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const { elements, files } = await parseMermaidToExcalidraw(text, { themeVariables: { fontSize: "16px" } } as any);
  return { elements: convertToExcalidrawElements(elements as any, { regenerateIds: true }) as any[], files: files ?? {} };
}

export interface EditorProps {
  path: string;
  /** Opens another drawing (or the list, with null) in place; without it, links load a new page. */
  onNavigate?: (path: string | null) => void;
  /** This drawing was renamed or moved, by anyone. */
  onMoved?: (from: string, to: string) => void;
  onTheme?: (theme: "light" | "dark") => void;
  sidebar?: { open: boolean; toggle: () => void };
}

const MOD = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";

export function Editor({ path, onNavigate, onMoved, onTheme, sidebar }: EditorProps) {
  const go = useCallback(
    (p: string | null) => (onNavigate ? onNavigate(p) : void (location.href = p ? `/?file=${encodeURIComponent(p)}` : "/")),
    [onNavigate],
  );
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  // The file vanished on disk (deleted, moved, branch switch). Stop autosaving until the user decides.
  const [deleted, setDeleted] = useState(false);
  const deletedRef = useRef(false);
  const createNext = useRef(false);
  const syncRef = useRef<Sync | null>(null);
  const loaded = useRef(false);
  const lastHash = useRef<number | null>(null);
  const lastBg = useRef<unknown>(null);
  const sentFiles = useRef(new Set<string>());
  const saveTimer = useRef<number | undefined>(undefined);
  const libraryHash = useRef<string>("");
  const [theme] = useState(storedTheme);
  const [liveTheme, setLiveTheme] = useState(theme);
  const [chatOpen, setChatOpen] = useState(() => storedFlag(CHAT_KEY));
  const [selectionCount, setSelectionCount] = useState(0);
  const selectionKey = useRef("");
  const chatListeners = useRef(new Set<(m: ServerMsg) => void>());
  const [offline, setOffline] = useState(false);
  const [agentEdit, setAgentEdit] = useState<{ ids: string[]; who: string; key: number } | null>(null);
  const [highlight, setHighlight] = useState<{ boxes: { x: number; y: number; w: number; h: number }[]; key: number } | null>(null);
  const [view, setView] = useState({ scrollX: 0, scrollY: 0, zoom: 1 });
  const [links, setLinks] = useState<LinkReport[]>([]);
  const [dialog, ask] = useDialog();

  // Stable entry points for the sync callbacks; the refs hold the current implementations.
  const linksImpl = useRef<() => void>(() => {});
  const refreshLinks = useCallback(() => linksImpl.current(), []);
  const agentEditImpl = useRef<(ids: string[], by?: string) => void>(() => {});
  const showAgentEdit = useCallback((ids: string[], by?: string) => agentEditImpl.current(ids, by), []);

  const select = useCallback(
    (ids: string[]) => {
      if (!excalidraw || !ids.length) return;
      const set = new Set(ids);
      const els = excalidraw.getSceneElements().filter((e) => set.has(e.id));
      excalidraw.updateScene({
        appState: { selectedElementIds: Object.fromEntries(els.map((e) => [e.id, true])) } as any,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (els.length) excalidraw.scrollToContent(els, { fitToContent: els.length > 1, animate: true });
    },
    [excalidraw],
  );

  agentEditImpl.current = (ids, by) => {
    if (!excalidraw) return;
    const set = new Set(ids);
    const boxes = excalidraw
      .getSceneElements()
      .filter((e) => set.has(e.id))
      .map(sceneBox);
    const st = excalidraw.getAppState();
    setView({ scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value });
    const key = Date.now();
    setHighlight({ boxes, key });
    setAgentEdit({ ids, who: agentName(by), key });
  };

  useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [highlight]);
  useEffect(() => {
    if (!agentEdit) return;
    const t = window.setTimeout(() => setAgentEdit(null), AGENT_TOAST_MS);
    return () => window.clearTimeout(t);
  }, [agentEdit]);

  // A short blip isn't worth a banner; a few seconds without the daemon is.
  // (Keyed on live or not: reconnect attempts flip between offline and connecting.)
  const live = status === "live";
  useEffect(() => {
    if (live) return setOffline(false);
    const t = window.setTimeout(() => setOffline(true), OFFLINE_BANNER_MS);
    return () => window.clearTimeout(t);
  }, [live]);

  // Code-link staleness: the linked files change outside the app, so poll while visible.
  linksImpl.current = () => {
    api<{ links: LinkReport[] }>("GET", `/api/links?path=${encodeURIComponent(path)}`)
      .then((r) => setLinks(r.links))
      .catch(() => {});
  };
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && refreshLinks();
    const timer = window.setInterval(tick, LINKS_REFRESH_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [refreshLinks]);
  const stale = links.filter((l) => l.state === "changed" || l.state === "missing");

  const reviewLinks = useCallback(async () => {
    try {
      const r = await api<{ reviewed: number }>("POST", "/api/links/review", { path, ids: stale.map((l) => l.id) });
      excalidraw?.setToast({ message: `Marked ${r.reviewed} link${r.reviewed === 1 ? "" : "s"} as reviewed`, duration: 1500, closable: false });
    } catch (e) {
      setError((e as Error).message);
    }
    refreshLinks();
  }, [excalidraw, path, stale, refreshLinks]);

  const onLinkOpen = useCallback(
    (element: any, event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>) => {
      const link = String(element.link ?? "");
      if (!isCodeLink(link)) return;
      // A code link: open it in the user's editor rather than as a URL relative to this page.
      event.preventDefault();
      api<{ editor: string }>("POST", "/api/open-code", { drawing: path, link })
        .then(() => excalidraw?.setToast({ message: `Opening ${link}`, duration: 1500, closable: false }))
        .catch((e: Error) => setError(`Could not open ${link}: ${e.message}`));
    },
    [excalidraw, path],
  );


  const toggleChat = useCallback((open?: boolean) => {
    setChatOpen((v) => {
      const next = open ?? !v;
      try {
        localStorage.setItem(CHAT_KEY, next ? "1" : "0");
      } catch {
        // storage unavailable
      }
      return next;
    });
  }, []);

  // ⇧⌘A can reach both the macOS app's menu and this page; one press must toggle once.
  const lastToggle = useRef(0);
  const toggleOnce = useCallback(() => {
    if (Date.now() - lastToggle.current < 300) return;
    lastToggle.current = Date.now();
    toggleChat();
  }, [toggleChat]);

  // The macOS app toggles the panel from its toolbar and menu.
  useEffect(() => {
    (window as any).lfx = { toggleChat: toggleOnce };
  }, [toggleOnce]);

  useEffect(() => {
    document.title = `${basename(path)} · Excalidraw`;
  }, [path]);

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const x = excalidraw;
    if (!x || !loaded.current || deletedRef.current) return;
    const elements = x.getSceneElementsIncludingDeleted();
    const appState = x.getAppState() as any;
    const files = x.getFiles();
    lastHash.current = hashElementsVersion(elements);
    lastBg.current = appState.viewBackgroundColor;
    const newFiles: Record<string, unknown> = {};
    for (const [id, f] of Object.entries(files)) {
      if (!sentFiles.current.has(id)) {
        newFiles[id] = f;
        sentFiles.current.add(id);
      }
    }
    const persisted: Record<string, unknown> = {};
    for (const k of PERSISTED_APP_STATE) persisted[k] = appState[k];
    syncRef.current?.send({ t: "save", path, elements, appState: persisted, files: newFiles, create: createNext.current });
    createNext.current = false;
  }, [excalidraw, path]);

  // The first fit waits until Excalidraw has measured the canvas at its settled size and place.
  // Fitting earlier (a tab or window still sized 0x0, the shell's layout not yet applied) centres
  // the drawing on a stale viewport and leaves it off-screen at the top-left.
  const canvasRef = useRef<HTMLDivElement>(null);
  const pendingFit = useRef(false);
  const fitTries = useRef(0);
  const tryFit = useRef<() => void>(() => {});
  tryFit.current = () => {
    const x = excalidraw;
    const box = canvasRef.current?.querySelector(".excalidraw") ?? canvasRef.current;
    if (!x || !box || !pendingFit.current) return;
    const r = box.getBoundingClientRect();
    if (r.width < MIN_FIT_PX || r.height < MIN_FIT_PX) return; // hidden or collapsed: the resize observer tries again
    const st = x.getAppState();
    const measured = [st.width - r.width, st.height - r.height, st.offsetLeft - r.left, st.offsetTop - r.top].every((d) => Math.abs(d) < 1);
    if (!measured && fitTries.current++ < 30) {
      // Excalidraw re-measures its container on a window resize; then try again next frame.
      window.dispatchEvent(new Event("resize"));
      requestAnimationFrame(() => tryFit.current());
      return;
    }
    pendingFit.current = false;
    x.scrollToContent(undefined, { fitToContent: true, animate: false, maxZoom: 1 });
  };
  const fitWhenSized = useCallback(() => {
    pendingFit.current = true;
    fitTries.current = 0;
    requestAnimationFrame(() => tryFit.current());
  }, []);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => pendingFit.current && requestAnimationFrame(() => tryFit.current()));
    ro.observe(el);
    // The user took the viewport into their own hands before the first fit happened.
    const cancel = () => (pendingFit.current = false);
    el.addEventListener("pointerdown", cancel, true);
    el.addEventListener("wheel", cancel, true);
    return () => {
      ro.disconnect();
      el.removeEventListener("pointerdown", cancel, true);
      el.removeEventListener("wheel", cancel, true);
    };
  }, []);

  const applyRemote = useCallback(
    async (scene: SceneData, first: boolean, agent = false, by?: string, quiet = false) => {
      const x = excalidraw!;
      const { elements: remote, fixed } = await normalize(scene.elements);
      const local = x.getSceneElementsIncludingDeleted();
      const wasEmpty = !local.some((e) => !e.isDeleted);
      const changed = agent && !first ? changedIds(local as any[], remote) : [];
      const merged = reconcileElements(local, remote as any, x.getAppState());
      const files = Object.values(scene.files ?? {}) as any[];
      for (const f of files) sentFiles.current.add(f.id);
      if (files.length) x.addFiles(files);
      x.updateScene({
        elements: merged,
        appState: scene.appState?.viewBackgroundColor ? { viewBackgroundColor: scene.appState.viewBackgroundColor as string } : undefined,
        // Assistant edits go on the undo stack so ⌘Z takes them back.
        captureUpdate: agent ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER,
      });
      lastBg.current = x.getAppState().viewBackgroundColor;
      // Whatever the load normalized (real font metrics, label positions, indices) is not an edit:
      // opening or viewing a drawing must never rewrite the file. The fixes stay in the scene and
      // ride along with the next real edit. An agent's edit has already changed the file, so its
      // fixes are saved straight away.
      const saveFixes = fixed > 0 && agent && !first;
      if (!saveFixes) lastHash.current = hashElementsVersion(x.getSceneElementsIncludingDeleted());
      if (first) {
        loaded.current = true;
        // Drawings don't store a viewport: fit the content (never past 100%) once the canvas has its real size.
        if (merged.some((e) => !e.isDeleted)) fitWhenSized();
      } else if (!agent) {
        if (!quiet) x.setToast({ message: "Drawing updated", duration: 1200, closable: false });
      } else {
        if (wasEmpty && merged.some((e) => !e.isDeleted)) {
          // The agent just drew on a blank canvas: bring its work into view.
          requestAnimationFrame(() => x.scrollToContent(undefined, { fitToContent: true, animate: true }));
        }
        if (changed.length) showAgentEdit(changed, by);
      }
      if (saveFixes) flush();
      refreshLinks();
    },
    [excalidraw, flush, fitWhenSized],
  );

  const fileAction = useCallback(
    async (kind: "rename" | "duplicate" | "move" | "trash") => {
      try {
        if (kind === "rename") {
          const v = await ask({ title: "Rename drawing", value: basename(path), confirm: "Rename" });
          if (v && v !== basename(path)) await files.rename(path, v); // the daemon then tells this tab where it went
        } else if (kind === "duplicate") {
          const r = await files.duplicate(path);
          go(r.path);
        } else if (kind === "move") {
          const d = await files.list();
          const options = folderOptions(d.roots, d.folders, dirOf(path));
          if (!options.length) return setError("There is no other folder to move it to. Create one from All drawings.");
          const v = await ask({ title: `Move ${basename(path)} to`, options, confirm: "Move" });
          if (v) await files.move(path, v);
        } else {
          const ok = await ask({ title: `Move ${basename(path)} to the trash?`, message: "You can restore it from the system trash.", confirm: "Move to trash", danger: true });
          if (ok) {
            flush();
            await files.trash(path);
          }
        }
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [ask, path, flush, go],
  );

  useEffect(() => {
    if (!excalidraw) return;
    let first = true;
    let chain: Promise<unknown> = Promise.resolve();
    const reply = (id: string, p: Promise<unknown>) =>
      p.then(
        (result) => sync.send({ t: "reply", id, ok: true, result }),
        (e: Error) => sync.send({ t: "reply", id, ok: false, error: e.message }),
      );
    const sync = new Sync(
      (m: ServerMsg) => {
        if (m.t === "deleted" && m.path === path) {
          deletedRef.current = true;
          setDeleted(true);
        } else if (m.t === "scene" && m.path === path) {
          if (m.exists === false && !first) {
            deletedRef.current = true;
            setDeleted(true);
            return;
          }
          if (m.exists !== false) {
            deletedRef.current = false;
            setDeleted(false);
          }
          // Opening a drawing that doesn't exist yet: the first edit creates it.
          if (m.exists === false && first) createNext.current = true;
          const isFirst = first;
          first = false;
          chain = chain.then(() => applyRemote(m.scene, isFirst, !!m.agent, m.by, !!m.quiet)).catch((e: Error) => setError(e.message));
        } else if (m.t === "moved" && m.path === path) {
          // Renamed or moved from the drawing list or another tab: follow it.
          deletedRef.current = true;
          if (onMoved) onMoved(m.path, m.to);
          else location.replace(`/?file=${encodeURIComponent(m.to)}`);
        } else if ((m.t === "chat" && m.path === path) || m.t === "chat-error") {
          for (const fn of chatListeners.current) fn(m);
        } else if (m.t === "render") reply(m.id, render(m.scene, m.opts));
        else if (m.t === "mermaid") reply(m.id, mermaid(m.text));
        else if (m.t === "error") setError(m.message);
      },
      setStatus,
      () => sync.send({ t: "open", path }),
    );
    syncRef.current = sync;

    api<{ libraryItems: LibraryItems }>("GET", "/api/library")
      .then(({ libraryItems }) => {
        libraryHash.current = JSON.stringify(libraryItems ?? []);
        return excalidraw.updateLibrary({ libraryItems: libraryItems ?? [], merge: false });
      })
      .catch((e: Error) => excalidraw.setToast({ message: `Could not load your library: ${e.message}`, duration: 6000, closable: true }));
    refreshLinks();

    // Cmd/Ctrl+S: we autosave, so just flush and confirm instead of opening a save dialog.
    const onKey = (e: KeyboardEvent) => {
      // ⇧⌘A / Ctrl+Shift+A: show or hide the assistant, even from inside it.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        e.stopPropagation();
        toggleOnce();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && !e.shiftKey) {
        // Editors in the side panel (settings JSON) save themselves.
        if ((e.target as Element | null)?.closest?.("[data-lfx-own-save]")) return;
        e.preventDefault();
        e.stopPropagation();
        flush();
        excalidraw.setToast({ message: "Saved", duration: 900, closable: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Only flush if an edit is still waiting in the debounce window.
    const onUnload = () => {
      if (saveTimer.current !== undefined) flush();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      // Switching drawings in place: don't drop an edit still in the debounce window.
      onUnload();
      sync.close();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [excalidraw, path, applyRemote, flush, toggleOnce, refreshLinks, onMoved]);

  const onChange = useCallback(
    (_els: readonly unknown[], appState: any) => {
      try {
        localStorage.setItem(THEME_KEY, appState.theme);
      } catch {
        // storage unavailable
      }
      if (appState.theme !== liveTheme) {
        setLiveTheme(appState.theme);
        onTheme?.(appState.theme);
      }
      const ids = Object.keys(appState.selectedElementIds ?? {}).filter((k) => appState.selectedElementIds[k]);
      const key = ids.join(",");
      if (key !== selectionKey.current) {
        selectionKey.current = key;
        setSelectionCount(ids.length);
      }
      if (!excalidraw || !loaded.current) return;
      const h = hashElementsVersion(excalidraw.getSceneElementsIncludingDeleted());
      if (h === lastHash.current && appState.viewBackgroundColor === lastBg.current) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [excalidraw, flush, liveTheme, onTheme],
  );

  const bridge = useMemo<ChatBridge>(
    () => ({
      send: (msg) => syncRef.current?.send({ path, ...msg }),
      subscribe: (fn) => {
        chatListeners.current.add(fn);
        syncRef.current?.send({ t: "chat-history" });
        return () => chatListeners.current.delete(fn);
      },
      selection: () => (selectionKey.current ? selectionKey.current.split(",") : []),
      addToLibrary: (items) => {
        if (!excalidraw) return;
        excalidraw.updateLibrary({
          libraryItems: items.map((it) => ({
            id: Math.random().toString(36).slice(2),
            status: "unpublished" as const,
            created: Date.now(),
            name: it.name,
            elements: restoreElements(it.elements, null) as any,
          })),
          merge: true,
          openLibraryMenu: true,
        });
      },
      snapshot: async (ids) => {
        if (!excalidraw) return undefined;
        const set = new Set(ids);
        const elements = excalidraw
          .getSceneElements()
          .filter((e: any) => set.has(e.id) || (e.containerId && set.has(e.containerId)));
        if (!elements.length) return undefined;
        await ensureFonts(elements as any[]);
        const blob = await exportToBlob({
          elements,
          appState: { ...excalidraw.getAppState(), exportBackground: true, exportWithDarkMode: false } as any,
          files: excalidraw.getFiles(),
          mimeType: "image/png",
          exportPadding: 16,
          maxWidthOrHeight: 1024,
        });
        return { data: toBase64(new Uint8Array(await blob.arrayBuffer())), mime: "image/png" };
      },
    }),
    [excalidraw, path],
  );

  const onLibraryChange = useCallback((items: LibraryItems) => {
    const s = JSON.stringify(items);
    if (s === libraryHash.current) return;
    libraryHash.current = s;
    api("PUT", "/api/library", { libraryItems: items }).catch((e: Error) => {
      // Forget the hash so the next change retries the save.
      libraryHash.current = "";
      excalidraw?.setToast({ message: `Could not save your library: ${e.message}`, duration: 6000, closable: true });
    });
  }, [excalidraw]);

  return (
    <div className={`lfx-editor${chatOpen ? " lfx-with-chat" : ""}`} data-theme={liveTheme}>
      <div className="lfx-canvas" ref={canvasRef}>
      <Excalidraw
        excalidrawAPI={setExcalidraw}
        initialData={{ appState: { theme } }}
        onChange={onChange}
        onLibraryChange={onLibraryChange}
        onLinkOpen={onLinkOpen}
        onScrollChange={(scrollX, scrollY, zoom) => highlight && setView({ scrollX, scrollY, zoom: zoom.value })}
        aiEnabled={false}
        validateEmbeddable={() => false}
        UIOptions={{
          canvasActions: { saveToActiveFile: false, loadScene: false, toggleTheme: true, export: { saveFileToDisk: true } },
        }}
        renderTopRightUI={() => (
          <div className="lfx-top-right">
            {sidebar && !sidebar.open && (
              <button type="button" className="lfx-badge lfx-ai-toggle lfx-sidebar-toggle" onClick={sidebar.toggle} title={`Show the drawings sidebar (${MOD}B)`} aria-label="Show the drawings sidebar">
                <svg viewBox="0 0 16 16" aria-hidden>
                  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                  <path d="M6 2.5v11" />
                </svg>
              </button>
            )}
            <div className="lfx-badge" title={path}>
              <span className={`lfx-dot lfx-${status}`} title={status === "live" ? "Synced to disk" : status} />
              <a
                href="/"
                className="lfx-files"
                onClick={(e) => {
                  if (!onNavigate) return;
                  e.preventDefault();
                  onNavigate(null);
                }}
              >
                {basename(path)}
              </a>
            </div>
            {stale.length > 0 && (
              <div className="lfx-badge lfx-links" role="group" aria-label="Code links">
                <button
                  type="button"
                  className="lfx-links-btn"
                  onClick={() => select(stale.map((l) => l.id))}
                  title={stale.map((l) => `${l.path}${l.line ? `#L${l.line}` : ""}: ${l.state}`).join("\n")}
                >
                  <span className="lfx-dot lfx-connecting" aria-hidden />
                  {linksLabel(stale)}
                </button>
                <button
                  type="button"
                  className="lfx-links-btn lfx-links-review"
                  onClick={reviewLinks}
                  aria-label="Mark as reviewed"
                  title="Mark as reviewed: the diagram is up to date with this code"
                >
                  <svg viewBox="0 0 20 20" aria-hidden>
                    <path d="M4 10.5l4 4 8-9" />
                  </svg>
                </button>
              </div>
            )}
            {!chatOpen && (
              <button type="button" className="lfx-badge lfx-ai-toggle" onClick={() => toggleChat(true)} title="Open the assistant">
                <svg viewBox="0 0 20 20" aria-hidden>
                  <path d="M10 2l1.8 4.6L16.5 8l-4.7 1.6L10 14l-1.8-4.4L3.5 8l4.7-1.4z" />
                  <path d="M15.5 13l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
                </svg>
                Assistant
                <kbd className="lfx-kbd">{navigator.platform.startsWith("Mac") ? "⇧⌘A" : "Ctrl+Shift+A"}</kbd>
              </button>
            )}
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => go(null)}>All drawings</MainMenu.Item>
          {sidebar && (
            <MainMenu.Item onSelect={sidebar.toggle} shortcut={`${MOD}B`}>
              {sidebar.open ? "Hide sidebar" : "Show sidebar"}
            </MainMenu.Item>
          )}
          <MainMenu.Item onSelect={() => toggleChat()} shortcut={navigator.platform.startsWith("Mac") ? "⇧⌘A" : "Ctrl+Shift+A"}>
            {chatOpen ? "Hide assistant" : "Show assistant"}
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.Item onSelect={() => void fileAction("rename")}>Rename…</MainMenu.Item>
          <MainMenu.Item onSelect={() => void fileAction("duplicate")}>Duplicate</MainMenu.Item>
          <MainMenu.Item onSelect={() => void fileAction("move")}>Move to folder…</MainMenu.Item>
          <MainMenu.Item onSelect={() => void fileAction("trash")}>Move to trash</MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      {highlight && (
        <div className="lfx-highlights" key={highlight.key} aria-hidden>
          {highlight.boxes.map((b, i) => (
            <div
              key={i}
              className="lfx-highlight"
              style={{
                left: (b.x + view.scrollX) * view.zoom - 6,
                top: (b.y + view.scrollY) * view.zoom - 6,
                width: b.w * view.zoom + 12,
                height: b.h * view.zoom + 12,
              }}
            />
          ))}
        </div>
      )}
      {agentEdit && (
        // Pointer events stay here, or the canvas treats the click as one on empty space and deselects.
        <div className="lfx-toast" role="status" key={agentEdit.key} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
          {agentEdit.who} edited {agentEdit.ids.length} element{agentEdit.ids.length === 1 ? "" : "s"}
          <button
            type="button"
            onClick={() => {
              const ids = agentEdit.ids;
              setAgentEdit(null);
              requestAnimationFrame(() => select(ids));
            }}
          >
            Select
          </button>
          <button type="button" className="lfx-toast-close" aria-label="Dismiss" onClick={() => setAgentEdit(null)}>
            ×
          </button>
        </div>
      )}
      </div>
      {chatOpen && <Chat path={path} bridge={bridge} selectionCount={selectionCount} dark={liveTheme === "dark"} onClose={() => toggleChat(false)} />}
      {deleted && (
        <div className="lfx-error" role="alert">
          This drawing was deleted or moved on disk. Edits are not being saved.{" "}
          <button
            onClick={() => {
              deletedRef.current = false;
              setDeleted(false);
              createNext.current = true;
              lastHash.current = null;
              sentFiles.current.clear();
              flush();
            }}
          >
            Restore it
          </button>
        </div>
      )}
      {offline && !deleted && (
        <div className="lfx-error lfx-offline-banner" role="alert">
          Not connected to the daemon. Edits are kept in this tab and saved when it reconnects.
        </div>
      )}
      {error && (
        <div className="lfx-error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss the error">
            Dismiss
          </button>
        </div>
      )}
      {dialog}
    </div>
  );
}
