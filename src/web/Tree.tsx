/**
 * The drawing tree: drawings grouped by root and by their real folders, like a code editor's
 * explorer. The editor's sidebar and the drawing list both show it. It reloads when the daemon
 * reports a change to the drawing set, so drawings made or moved by agents appear on their own.
 */
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ancestorFolders, buildTree, displayName, type FolderNode, type Row, sepOf, type TreeNode, visibleRows } from "../shared/tree";
import { dirOf, type FileList, files, folderOptions, useDialog } from "./FileActions";
import { api, fileEvents } from "./sync";

type GitState = "modified" | "untracked" | "staged" | "conflict";

const GIT_REFRESH_MS = 10_000;
const GIT_LABEL: Record<GitState, [string, string]> = {
  modified: ["M", "Modified since the last commit"],
  untracked: ["U", "Untracked: not in git yet"],
  staged: ["S", "Staged for the next commit"],
  conflict: ["C", "Merge conflict"],
};

const EXPANDED_KEY = "lfx-tree-expanded";
const ALL_FOLDERS_KEY = "lfx-tree-all-folders";
const RECENT_KEY = "lfx-recent";
const RECENT_MAX = 8;
const DRAG_TYPE = "application/x-lfx-drawing";
const isMac = navigator.platform.startsWith("Mac");

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable
  }
}

// ---- recently opened drawings ------------------------------------------------------------

const recentEvents = new EventTarget();

export function recentDrawings(): string[] {
  const r = readStored<unknown>(RECENT_KEY, []);
  return Array.isArray(r) ? r.filter((p): p is string => typeof p === "string") : [];
}

/** Puts `path` first in the recent list; with `from`, the drawing moved there from `from`. */
export function rememberRecent(path: string, from?: string) {
  const list = recentDrawings().filter((p) => p !== path && p !== from);
  store(RECENT_KEY, [path, ...list].slice(0, RECENT_MAX));
  recentEvents.dispatchEvent(new Event("change"));
}

/** Rewrites recent entries after a rename or move, keeping their order. */
function moveRecent(from: string, to: string) {
  const isDir = !from.endsWith(".excalidraw");
  const list = recentDrawings().map((p) => (p === from ? to : isDir && p.startsWith(from + sepOf(from)) ? to + p.slice(from.length) : p));
  store(RECENT_KEY, list);
  recentEvents.dispatchEvent(new Event("change"));
}

function useRecent(): string[] {
  const [list, setList] = useState(recentDrawings);
  useEffect(() => {
    const update = () => setList(recentDrawings());
    recentEvents.addEventListener("change", update);
    window.addEventListener("storage", update);
    return () => {
      recentEvents.removeEventListener("change", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return list;
}

// ---- data ------------------------------------------------------------------------------------

/** The drawing list, reloaded when the daemon reports a change and when the window regains focus. */
export function useFileList(): { data: FileList | null; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<FileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      files.list().then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    void reload();
    const onChange = () => void reload();
    fileEvents.addEventListener("change", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      fileEvents.removeEventListener("change", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [reload]);
  return { data, error, reload };
}

/** Git badges for the listed drawings, refreshed on focus, on file changes and every 10 s while visible. */
export function useGitStatus(): Record<string, GitState> {
  const [status, setStatus] = useState<Record<string, GitState>>({});
  useEffect(() => {
    let stopped = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      api<{ status: Record<string, GitState> }>("GET", "/api/files/git")
        .then((r) => !stopped && setStatus(r.status))
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, GIT_REFRESH_MS);
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    fileEvents.addEventListener("change", load);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
      fileEvents.removeEventListener("change", load);
    };
  }, []);
  return status;
}

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** "~/code/app" style label for a root: its last two segments. */
export function rootLabel(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || root;
}

// ---- icons -------------------------------------------------------------------------------------

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`lfx-tree-chevron${open ? " lfx-open" : ""}`} viewBox="0 0 16 16" aria-hidden>
    <path d="M6 4l4 4-4 4" />
  </svg>
);
const FolderIcon = () => (
  <svg className="lfx-tree-icon" viewBox="0 0 16 16" aria-hidden>
    <path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
  </svg>
);
const DrawingIcon = () => (
  <svg className="lfx-tree-icon" viewBox="0 0 16 16" aria-hidden>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M4.5 10.5l2.5-3 2 2 2.5-3.5" />
  </svg>
);

// ---- the tree ------------------------------------------------------------------------------------

interface Menu {
  node: TreeNode;
  x: number;
  y: number;
}

export function DrawingTree({
  data,
  reload,
  current,
  onOpen,
  variant,
}: {
  data: FileList | null;
  reload: () => Promise<void>;
  /** The open drawing: highlighted, and its folders expanded. */
  current?: string;
  onOpen: (path: string | null) => void;
  variant: "sidebar" | "page";
}) {
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(() => readStored(ALL_FOLDERS_KEY, false));
  // Open folders, and roots the user closed (roots start open).
  const [open, setOpen] = useState<{ folders: string[]; closedRoots: string[] }>(() => {
    const v = readStored<{ folders?: unknown; closedRoots?: unknown }>(EXPANDED_KEY, {});
    return { folders: Array.isArray(v.folders) ? v.folders : [], closedRoots: Array.isArray(v.closedRoots) ? v.closedRoots : [] };
  });
  const [focus, setFocus] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, ask] = useDialog();
  const git = useGitStatus();
  const recent = useRecent();
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => store(EXPANDED_KEY, open), [open]);
  useEffect(() => store(ALL_FOLDERS_KEY, showAll), [showAll]);

  const tree = useMemo(() => (data ? buildTree(data, { showAll, filter }) : []), [data, showAll, filter]);
  const roots = useMemo(() => new Set(tree.map((r) => r.path)), [tree]);
  const filtering = filter.trim() !== "";
  const isOpen = useCallback(
    (p: string) => filtering || (roots.has(p) ? !open.closedRoots.includes(p) : open.folders.includes(p)),
    [filtering, roots, open],
  );
  const rows = useMemo(() => visibleRows(tree, isOpen), [tree, isOpen]);

  const setFolder = useCallback((p: string, want: boolean) => {
    setOpen((o) => {
      if (roots.has(p)) {
        const closedRoots = o.closedRoots.filter((x) => x !== p);
        return { ...o, closedRoots: want ? closedRoots : [...closedRoots, p] };
      }
      const folders = o.folders.filter((x) => x !== p);
      return { ...o, folders: want ? [...folders, p] : folders };
    });
  }, [roots]);

  // Reveal the open drawing: expand its folders and bring it into view.
  const drawingRoot = current ? tree.find((r) => current.startsWith(r.path + sepOf(r.path)))?.path : undefined;
  useEffect(() => {
    if (!current || !drawingRoot) return;
    const need = ancestorFolders(drawingRoot, current);
    setOpen((o) => {
      const folders = [...new Set([...o.folders, ...need.slice(1)])];
      const closedRoots = o.closedRoots.filter((r) => r !== drawingRoot);
      return folders.length === o.folders.length && closedRoots.length === o.closedRoots.length ? o : { folders, closedRoots };
    });
    setFocus((f) => f ?? current);
  }, [current, drawingRoot]);
  useEffect(() => {
    if (!current) return;
    const el = treeRef.current?.querySelector(`[data-path="${CSS.escape(current)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [current, rows.length]);

  // Close the menu on a click elsewhere or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element).closest?.(".lfx-tree-menu")) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const run = async (what: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await what();
      if (done) setNotice(done);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // ---- actions ----
  const renameDrawing = async (path: string) => {
    const v = await ask({ title: "Rename drawing", value: displayName(path), confirm: "Rename" });
    if (!v || v.trim() === displayName(path)) return;
    await run(async () => {
      const r = await files.rename(path, v);
      moveRecent(path, r.path);
      setFocus(r.path);
    });
  };
  const moveDrawing = async (path: string, dir?: string) => {
    let to = dir;
    if (!to) {
      const options = folderOptions(data?.roots ?? [], data?.folders ?? [], dirOf(path));
      if (!options.length) return setError("There is no other folder to move it to. Create one first.");
      to = (await ask({ title: `Move ${displayName(path)} to`, options, confirm: "Move" })) ?? undefined;
    }
    if (!to || to === dirOf(path)) return;
    const target = to;
    await run(async () => {
      const r = await files.move(path, target);
      moveRecent(path, r.path);
      setFocus(r.path);
      setFolder(target, true);
    });
  };
  const trashDrawing = async (path: string) => {
    const ok = await ask({ title: `Move ${displayName(path)} to the trash?`, message: "You can restore it from the system trash.", confirm: "Move to trash", danger: true });
    if (!ok) return;
    await run(async () => {
      await files.trash(path);
      if (path === current) onOpen(null);
    }, `Moved ${displayName(path)} to the trash`);
  };
  const newDrawing = async (folder: FolderNode) => {
    const v = await ask({ title: "New drawing", value: "", confirm: "Create", message: `In ${folder.isRoot ? folder.path : folder.rel}. Use a/b to make folders too.` });
    const clean = v?.trim().replace(/\.excalidraw$/, "");
    if (!clean) return;
    await run(async () => {
      const sep = sepOf(folder.path);
      const { path } = await api<{ path: string }>("POST", "/api/new", { path: `${folder.path}${sep}${clean.split("/").join(sep)}.excalidraw` });
      onOpen(path);
    });
  };
  const newFolder = async (folder: FolderNode) => {
    const v = await ask({ title: "New folder", value: "", confirm: "Create", message: `In ${folder.isRoot ? folder.path : folder.rel}. Use a/b for nested folders.` });
    const clean = v?.trim();
    if (!clean) return;
    await run(async () => {
      const sep = sepOf(folder.path);
      const r = await files.folder(`${folder.path}${sep}${clean.split("/").join(sep)}`);
      setFolder(folder.path, true);
      setFocus(r.path);
    }, `Created folder ${clean}`);
  };
  const renameFolder = async (folder: FolderNode) => {
    const v = await ask({ title: "Rename folder", value: folder.name, confirm: "Rename", message: "Drawings inside keep their names; open tabs follow." });
    if (!v || v.trim() === folder.name) return;
    await run(async () => {
      const r = await files.renameFolder(folder.path, v);
      moveRecent(folder.path, r.path);
      setOpen((o) => ({ ...o, folders: o.folders.map((p) => (p === folder.path || p.startsWith(folder.path + sepOf(p)) ? r.path + p.slice(folder.path.length) : p)) }));
      setFocus(r.path);
    });
  };
  const reveal = (path: string) => void files.reveal(path).catch((e: Error) => setError(e.message));

  const actionsFor = (node: TreeNode): [string, () => unknown, boolean?][] => {
    if (node.kind === "drawing") {
      return [
        ["Open", () => onOpen(node.path)],
        ["Rename…", () => renameDrawing(node.path)],
        ["Duplicate", () => run(async () => onOpen((await files.duplicate(node.path)).path))],
        ["Move to folder…", () => moveDrawing(node.path)],
        ...(isMac ? [["Reveal in Finder", () => reveal(node.path)] as [string, () => unknown]] : []),
        ["Move to trash", () => trashDrawing(node.path), true],
      ];
    }
    return [
      ["New drawing here…", () => newDrawing(node)],
      ["New folder…", () => newFolder(node)],
      ...(!node.isRoot ? [["Rename folder…", () => renameFolder(node)] as [string, () => unknown]] : []),
      ...(isMac ? [["Reveal in Finder", () => reveal(node.path)] as [string, () => unknown]] : []),
    ];
  };

  // ---- keyboard ----
  const focusIndex = Math.max(0, rows.findIndex((r) => r.node.path === focus));
  const moveFocus = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    setFocus(r.node.path);
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(r.node.path)}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  const menuAt = (row: Row) => {
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.node.path)}"]`);
    const box = el?.getBoundingClientRect();
    setMenu({ node: row.node, x: (box?.left ?? 0) + 24, y: box?.bottom ?? 0 });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keep keys away from the canvas shortcuts.
    e.stopPropagation();
    const row = rows[focusIndex];
    if (!row) return;
    const n = row.node;
    const handled = () => e.preventDefault();
    switch (e.key) {
      case "ArrowDown":
        handled();
        return moveFocus(focusIndex + 1);
      case "ArrowUp":
        handled();
        return moveFocus(focusIndex - 1);
      case "Home":
        handled();
        return moveFocus(0);
      case "End":
        handled();
        return moveFocus(rows.length - 1);
      case "ArrowRight":
        handled();
        if (n.kind !== "folder") return;
        if (!isOpen(n.path)) return setFolder(n.path, true);
        if (n.children.length) return moveFocus(focusIndex + 1);
        return;
      case "ArrowLeft":
        handled();
        if (n.kind === "folder" && isOpen(n.path) && !filtering) return setFolder(n.path, false);
        if (row.parent) return moveFocus(rows.findIndex((r) => r.node.path === row.parent));
        return;
      case "Enter":
      case " ":
        handled();
        if (n.kind === "drawing") return onOpen(n.path);
        return setFolder(n.path, !isOpen(n.path));
      case "F2":
        handled();
        if (n.kind === "drawing") return void renameDrawing(n.path);
        if (!n.isRoot) return void renameFolder(n);
        return;
      case "Delete":
        if (n.kind === "drawing") {
          handled();
          void trashDrawing(n.path);
        }
        return;
      case "ContextMenu":
        handled();
        return menuAt(row);
      case "F10":
        if (e.shiftKey) {
          handled();
          menuAt(row);
        }
        return;
    }
  };

  // ---- drag and drop: drawings onto folders ----
  const dropProps = (folder: FolderNode) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropTarget !== folder.path) setDropTarget(folder.path);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDropTarget((t) => (t === folder.path ? null : t));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const p = e.dataTransfer.getData(DRAG_TYPE);
      if (p && dirOf(p) !== folder.path) void moveDrawing(p, folder.path);
    },
  });

  const badge = (p: string): ReactElement | null => {
    const s = git[p];
    if (!s) return null;
    const [letter, title] = GIT_LABEL[s];
    return (
      <span className={`lfx-git lfx-git-${s}`} title={title} aria-label={title}>
        {letter}
      </span>
    );
  };

  const existing = useMemo(() => new Set(data?.drawings.map((d) => d.path) ?? []), [data]);
  const recentShown = filtering ? [] : recent.filter((p) => existing.has(p)).slice(0, RECENT_MAX);

  return (
    <div className={`lfx-tree-pane lfx-tree-${variant}`}>
      <div className="lfx-tree-tools">
        <input
          className="lfx-tree-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setFilter("");
            if (e.key === "ArrowDown" && rows.length) {
              e.preventDefault();
              moveFocus(rows.findIndex((r) => r.node.kind === "drawing"));
            }
          }}
          placeholder="Filter drawings"
          aria-label="Filter drawings by name or folder"
          type="search"
        />
        <button
          type="button"
          className={`lfx-tree-tool${showAll ? " lfx-on" : ""}`}
          aria-pressed={showAll}
          onClick={() => setShowAll((v) => !v)}
          title={showAll ? "Showing every folder. Click to show only folders with drawings." : "Show all folders, including those without drawings"}
        >
          <FolderIcon />
          <span className="lfx-sr">Show all folders</span>
        </button>
      </div>

      {error && (
        <p className="lfx-tree-msg lfx-tree-error" role="alert">
          {error}{" "}
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {notice && !error && (
        <p className="lfx-tree-msg" role="status">
          {notice}{" "}
          <button type="button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}

      <div className="lfx-tree-scroll">
        {recentShown.length > 0 && (
          <section className="lfx-recent" aria-label="Recent drawings">
            <h3>Recent</h3>
            <ul>
              {recentShown.map((p) => (
                <li key={p}>
                  <button type="button" className={p === current ? "lfx-current" : undefined} onClick={() => onOpen(p)} title={p}>
                    <DrawingIcon />
                    <span className="lfx-tree-name">{displayName(p)}</span>
                    {badge(p)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!data && <p className="lfx-tree-msg">Loading…</p>}
        <div className="lfx-tree" role="tree" aria-label="Drawings" ref={treeRef} onKeyDown={onKeyDown}>
          {rows.map((row, i) => {
            const n = row.node;
            const folder = n.kind === "folder" ? n : null;
            const expanded = folder ? isOpen(n.path) : undefined;
            const selected = n.path === current;
            const tabbable = i === focusIndex;
            return (
              <div
                key={n.path}
                data-path={n.path}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={expanded}
                aria-selected={selected}
                tabIndex={tabbable ? 0 : -1}
                className={[
                  "lfx-tree-row",
                  folder ? "lfx-tree-folder" : "lfx-tree-drawing",
                  folder?.isRoot ? "lfx-tree-root" : "",
                  selected ? "lfx-current" : "",
                  dropTarget === n.path ? "lfx-drop" : "",
                  menu?.node.path === n.path ? "lfx-menu-open" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ paddingLeft: `${0.4 + row.depth * 0.85}rem` }}
                title={n.path}
                onFocus={() => setFocus(n.path)}
                onClick={() => {
                  setFocus(n.path);
                  if (folder) setFolder(n.path, !expanded);
                  else onOpen(n.path);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFocus(n.path);
                  setMenu({ node: n, x: e.clientX, y: e.clientY });
                }}
                draggable={!folder}
                onDragStart={
                  folder
                    ? undefined
                    : (e) => {
                        e.dataTransfer.setData(DRAG_TYPE, n.path);
                        e.dataTransfer.setData("text/plain", n.path);
                        e.dataTransfer.effectAllowed = "move";
                      }
                }
                {...(folder ? dropProps(folder) : {})}
              >
                {folder ? <Chevron open={!!expanded} /> : <span className="lfx-tree-chevron-space" />}
                {folder ? <FolderIcon /> : <DrawingIcon />}
                <span className="lfx-tree-name">{folder?.isRoot ? rootLabel(n.path) : n.name}</span>
                {!folder && badge(n.path)}
                <span className="lfx-tree-gap" />
                {folder && folder.count > 0 && <span className="lfx-tree-count">{folder.count}</span>}
                {folder?.isRoot && folder.count === 0 && <span className="lfx-tree-count">{filtering ? "no matches" : "empty"}</span>}
                {variant === "page" && n.kind === "drawing" && n.mtime !== undefined && <span className="lfx-tree-time">{ago(n.mtime)}</span>}
                <button
                  type="button"
                  className="lfx-tree-more"
                  tabIndex={-1}
                  aria-label={`Actions for ${folder?.isRoot ? rootLabel(n.path) : n.name}`}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu(menu?.node.path === n.path ? null : { node: n, x: box.left, y: box.bottom });
                  }}
                >
                  ⋯
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {menu && (
        <TreeMenu
          x={menu.x}
          y={menu.y}
          items={actionsFor(menu.node)}
          label={menu.node.kind === "drawing" ? menu.node.name : rootLabel(menu.node.path)}
          onDone={() => {
            const p = menu.node.path;
            setMenu(null);
            treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)?.focus();
          }}
        />
      )}
      {dialog}
    </div>
  );
}

function TreeMenu({ x, y, items, label, onDone }: { x: number; y: number; items: [string, () => unknown, boolean?][]; label: string; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Keep the menu on screen.
    const box = el.getBoundingClientRect();
    setPos({ left: Math.min(x, window.innerWidth - box.width - 8), top: Math.min(y, window.innerHeight - box.height - 8) });
    el.querySelector<HTMLElement>("button")?.focus();
  }, [x, y]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onDone();
    }
  };
  return (
    <div ref={ref} className="lfx-tree-menu" role="menu" aria-label={`Actions for ${label}`} style={pos} onKeyDown={onKeyDown}>
      {items.map(([text, fn, danger]) => (
        <button
          key={text}
          type="button"
          role="menuitem"
          className={danger ? "lfx-danger-text" : undefined}
          onClick={() => {
            onDone();
            void fn();
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
