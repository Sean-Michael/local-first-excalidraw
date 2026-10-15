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
function storedTheme(): "light" | "dark" {
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

/** Restores agent-authored elements with real font metrics; bumps any whose geometry changed so the fix is saved. */
async function normalize(elements: any[]): Promise<{ elements: any[]; fixed: number }> {
  await ensureFonts(elements);
  const before = new Map(elements.map((e) => [e.id, e]));
  const restored = restoreElements(elements, null, { refreshDimensions: true, repairBindings: true });
  let fixed = 0;
  const out = restored.map((el: any) => {
    const o = before.get(el.id);
    if (
      o &&
      el.type === "text" &&
      !el.isDeleted &&
      ["x", "y", "width", "height"].some((k) => Math.abs((o[k] ?? 0) - el[k]) > 0.5)
    ) {
      fixed++;
      return bumpVersion({ ...el });
    }
    return el;
  });
  return { elements: out, fixed };
}

async function render(scene: SceneData, opts: RenderOpts): Promise<{ data: string; mime: string; scale?: number }> {
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

async function mermaid(text: string): Promise<{ elements: any[]; files: Record<string, unknown> }> {
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const { elements, files } = await parseMermaidToExcalidraw(text, { themeVariables: { fontSize: "16px" } } as any);
  return { elements: convertToExcalidrawElements(elements as any, { regenerateIds: true }) as any[], files: files ?? {} };
}

export function Editor({ path }: { path: string }) {
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

  // The macOS app toggles the panel from its toolbar.
  useEffect(() => {
    (window as any).lfx = { toggleChat: () => toggleChat() };
  }, [toggleChat]);

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

  const applyRemote = useCallback(
    async (scene: SceneData, first: boolean, agent = false) => {
      const x = excalidraw!;
      const { elements: remote, fixed } = await normalize(scene.elements);
      const local = x.getSceneElementsIncludingDeleted();
      const wasEmpty = !local.some((e) => !e.isDeleted);
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
      if (fixed === 0) lastHash.current = hashElementsVersion(x.getSceneElementsIncludingDeleted());
      if (first) {
        loaded.current = true;
        // Wait a frame so the canvas has its real size before fitting.
        if (merged.some((e) => !e.isDeleted)) {
          requestAnimationFrame(() => x.scrollToContent(undefined, { fitToContent: true, animate: false }));
        }
      } else if (!agent) {
        x.setToast({ message: "Drawing updated", duration: 1200, closable: false });
      } else if (wasEmpty && merged.some((e) => !e.isDeleted)) {
        // The assistant just drew on a blank canvas: bring its work into view.
        requestAnimationFrame(() => x.scrollToContent(undefined, { fitToContent: true, animate: true }));
      }
      if (fixed > 0) flush();
    },
    [excalidraw, flush],
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
          chain = chain.then(() => applyRemote(m.scene, isFirst, !!m.agent)).catch((e: Error) => setError(e.message));
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
      .catch(() => {});

    // Cmd/Ctrl+S: we autosave, so just flush and confirm instead of opening a save dialog.
    const onKey = (e: KeyboardEvent) => {
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
      sync.close();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [excalidraw, path, applyRemote, flush]);

  const onChange = useCallback(
    (_els: readonly unknown[], appState: any) => {
      try {
        localStorage.setItem(THEME_KEY, appState.theme);
      } catch {
        // storage unavailable
      }
      if (appState.theme !== liveTheme) setLiveTheme(appState.theme);
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
    [excalidraw, flush, liveTheme],
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
    api("PUT", "/api/library", { libraryItems: items }).catch(() => {});
  }, []);

  return (
    <div className={`lfx-editor${chatOpen ? " lfx-with-chat" : ""}`} data-theme={liveTheme}>
      <div className="lfx-canvas">
      <Excalidraw
        excalidrawAPI={setExcalidraw}
        initialData={{ appState: { theme } }}
        onChange={onChange}
        onLibraryChange={onLibraryChange}
        aiEnabled={false}
        validateEmbeddable={() => false}
        UIOptions={{
          canvasActions: { saveToActiveFile: false, loadScene: false, toggleTheme: true, export: { saveFileToDisk: true } },
        }}
        renderTopRightUI={() => (
          <div className="lfx-top-right">
            <div className="lfx-badge" title={path}>
              <span className={`lfx-dot lfx-${status}`} title={status === "live" ? "Synced to disk" : status} />
              <a href="/" className="lfx-files">
                {basename(path)}
              </a>
            </div>
            {!chatOpen && (
              <button type="button" className="lfx-badge lfx-ai-toggle" onClick={() => toggleChat(true)} title="Open the assistant">
                <svg viewBox="0 0 20 20" aria-hidden>
                  <path d="M10 2l1.8 4.6L16.5 8l-4.7 1.6L10 14l-1.8-4.4L3.5 8l4.7-1.4z" />
                  <path d="M15.5 13l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
                </svg>
                Assistant
              </button>
            )}
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => (location.href = "/")}>All drawings</MainMenu.Item>
          <MainMenu.Item onSelect={() => toggleChat()}>{chatOpen ? "Hide assistant" : "Show assistant"}</MainMenu.Item>
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
      {error && (
        <div className="lfx-error" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
}
