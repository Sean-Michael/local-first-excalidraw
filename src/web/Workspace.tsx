/**
 * The page shell: the drawing list when no drawing is open, else the sidebar tree beside the
 * editor. Switching drawings is client-side (history.pushState), so the sidebar stays put and
 * only the editor (with its socket and assistant panel) is swapped for the new drawing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Editor, storedTheme } from "./Editor";
import { FileBrowser } from "./FileBrowser";
import { DrawingTree, rememberRecent, useFileList } from "./Tree";

const OPEN_KEY = "lfx-sidebar-open";
const WIDTH_KEY = "lfx-sidebar-width";
const MIN_WIDTH = 180;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 260;

/** The macOS app has its own sidebar and sets this before the page loads. */
const embedded = !!(window as { lfxEmbedded?: boolean }).lfxEmbedded;

const fileFromUrl = () => new URLSearchParams(location.search).get("file");

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // storage unavailable
  }
}

export function Workspace() {
  const [path, setPath] = useState(fileFromUrl);
  const [theme, setTheme] = useState(storedTheme);
  const [open, setOpen] = useState(() => !embedded && stored(OPEN_KEY) !== "0");
  const [width, setWidth] = useState(() => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(stored(WIDTH_KEY)) || DEFAULT_WIDTH)));
  const files = useFileList();

  const navigate = useCallback((p: string | null, replace = false) => {
    const url = p ? `/?file=${encodeURIComponent(p)}` : "/";
    if (p !== fileFromUrl()) history[replace ? "replaceState" : "pushState"](null, "", url);
    setPath(p);
  }, []);

  /** The open drawing was renamed or moved: follow it without a history entry. */
  const moved = useCallback((from: string, to: string) => {
    rememberRecent(to, from);
    navigate(to, true);
  }, [navigate]);

  useEffect(() => {
    const onPop = () => setPath(fileFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (path) rememberRecent(path);
  }, [path]);

  const toggle = useCallback(() => {
    if (embedded) return;
    setOpen((v) => {
      save(OPEN_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  // ⌘B / Ctrl+B shows or hides the sidebar, except while typing text on the canvas.
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "b") return;
      const t = e.target as Element | null;
      if (t?.closest?.(".excalidraw-textEditorContainer, .lfx-chat")) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggle]);

  // Drag the sidebar's edge to resize it.
  const drag = useRef<{ x: number; w: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, w: width };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.current.w + e.clientX - drag.current.x)));
  };
  const onResizeUp = () => {
    if (!drag.current) return;
    drag.current = null;
    save(WIDTH_KEY, String(width));
  };

  if (!path) {
    return (
      <div className="lfx-shell lfx-home" data-theme={theme}>
        <FileBrowser onOpen={navigate} />
      </div>
    );
  }
  return (
    <div className="lfx-shell" data-theme={theme}>
      {open && (
        <aside className="lfx-sidebar" style={{ width }} aria-label="Drawings sidebar">
          <div className="lfx-sidebar-head">
            <a
              href="/"
              className="lfx-sidebar-title"
              onClick={(e) => {
                e.preventDefault();
                navigate(null);
              }}
            >
              Drawings
            </a>
            <button type="button" className="lfx-tree-tool" onClick={toggle} title={`Hide the sidebar (${navigator.platform.startsWith("Mac") ? "⌘B" : "Ctrl+B"})`}>
              <SidebarIcon />
              <span className="lfx-sr">Hide the sidebar</span>
            </button>
          </div>
          <DrawingTree data={files.data} reload={files.reload} current={path} onOpen={navigate} variant="sidebar" />
          <div
            className="lfx-sidebar-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the sidebar"
            aria-valuenow={width}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            tabIndex={0}
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              e.stopPropagation();
              const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width + (e.key === "ArrowLeft" ? -20 : 20)));
              setWidth(w);
              save(WIDTH_KEY, String(w));
            }}
          />
        </aside>
      )}
      <Editor key={path} path={path} onNavigate={navigate} onMoved={moved} onTheme={setTheme} sidebar={embedded ? undefined : { open, toggle }} />
    </div>
  );
}

export const SidebarIcon = () => (
  <svg className="lfx-tree-icon" viewBox="0 0 16 16" aria-hidden>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <path d="M6 2.5v11" />
  </svg>
);
