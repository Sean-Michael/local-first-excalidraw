import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { dirOf, type Folder, files, folderOptions, useDialog } from "./FileActions";
import { api, basename } from "./sync";

interface Drawing {
  path: string;
  root: string;
  size: number;
  mtime: number;
}

type GitState = "modified" | "untracked" | "staged" | "conflict";

const GIT_REFRESH_MS = 10_000;
const GIT_LABEL: Record<GitState, [string, string]> = {
  modified: ["M", "Modified since the last commit"],
  untracked: ["U", "Untracked: not in git yet"],
  staged: ["S", "Staged for the next commit"],
  conflict: ["C", "Merge conflict"],
};

const open = (p: string) => (location.href = `/?file=${encodeURIComponent(p)}`);

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Git badges for the listed drawings, refreshed on focus and every 10 s while the page is visible. */
function useGitStatus(): [Record<string, GitState>, () => void] {
  const [status, setStatus] = useState<Record<string, GitState>>({});
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
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
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [tick]);
  return [status, refresh];
}

export function FileBrowser() {
  const [data, setData] = useState<{ roots: string[]; drawings: Drawing[]; folders: Folder[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [dialog, ask] = useDialog();
  const [git, refreshGit] = useGitStatus();

  const reload = useCallback(
    () =>
      files
        .list()
        .then((d) => {
          setData(d);
          setRoot((r) => r || (d.roots[0] ?? ""));
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );

  useEffect(() => {
    document.title = "Drawings · Excalidraw";
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element).closest?.(".lfx-row-menu")) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const groups = useMemo(() => {
    const m = new Map<string, Drawing[]>();
    for (const r of data?.roots ?? []) m.set(r, []);
    const needle = q.toLowerCase();
    for (const d of data?.drawings ?? []) {
      if (needle && !d.path.toLowerCase().includes(needle)) continue;
      m.get(d.root)?.push(d);
    }
    return [...m.entries()];
  }, [data, q]);

  const run = async (what: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await what();
      if (done) setNotice(done);
      await reload();
      refreshGit();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim().replace(/\.excalidraw$/, "");
    if (!clean || !root) return;
    try {
      const { path } = await api<{ path: string }>("POST", "/api/new", { path: `${root}/${clean}.excalidraw` });
      open(path);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const newFolder = async () => {
    const v = await ask({ title: "New folder", value: "", confirm: "Create", message: `In ${root}. Use a/b for nested folders.` });
    if (v) await run(() => files.folder(`${root}/${v.trim()}`), `Created folder ${v.trim()}`);
  };

  const actions = (d: Drawing): [string, () => Promise<void>, boolean?][] => [
    [
      "Rename…",
      async () => {
        const v = await ask({ title: "Rename drawing", value: basename(d.path), confirm: "Rename" });
        if (v && v !== basename(d.path)) await run(() => files.rename(d.path, v));
      },
    ],
    ["Duplicate", () => run(() => files.duplicate(d.path))],
    [
      "Move to folder…",
      async () => {
        const options = folderOptions(data?.roots ?? [], data?.folders ?? [], dirOf(d.path));
        if (!options.length) return setError("There is no other folder to move it to. Create one first.");
        const v = await ask({ title: `Move ${basename(d.path)} to`, options, confirm: "Move" });
        if (v) await run(() => files.move(d.path, v));
      },
    ],
    [
      "Move to trash",
      async () => {
        const ok = await ask({ title: `Move ${basename(d.path)} to the trash?`, message: "You can restore it from the system trash.", confirm: "Move to trash", danger: true });
        if (ok) await run(() => files.trash(d.path), `Moved ${basename(d.path)} to the trash`);
      },
      true,
    ],
  ];

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

  return (
    <main className="lfx-browser">
      <header>
        <h1>Drawings</h1>
        <p className="lfx-sub">Local files only. Nothing leaves this machine.</p>
      </header>

      <form className="lfx-new" onSubmit={create}>
        <select value={root} onChange={(e) => setRoot(e.target.value)} aria-label="Folder">
          {data?.roots.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new-drawing or sub/dir/name" aria-label="Name" />
        <button type="submit" disabled={!name.trim()}>
          New drawing
        </button>
        <button type="button" className="lfx-secondary" onClick={newFolder} disabled={!root}>
          New folder
        </button>
      </form>

      <input className="lfx-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="Filter" />

      {error && (
        <p className="lfx-error-inline" role="alert">
          {error}{" "}
          <button type="button" className="lfx-text-btn" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {notice && !error && (
        <p className="lfx-notice" role="status">
          {notice}{" "}
          <button type="button" className="lfx-text-btn" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      {!data && !error && <p className="lfx-sub">Loading…</p>}

      {groups.map(([r, items]) => (
        <section key={r}>
          <h2 title={r}>{r}</h2>
          {items.length === 0 ? (
            <p className="lfx-empty">No drawings yet.</p>
          ) : (
            <ul>
              {items.map((d) => (
                <li key={d.path} className="lfx-row">
                  <a href={`/?file=${encodeURIComponent(d.path)}`}>
                    <span className="lfx-name">
                      {basename(d.path)}
                      {badge(d.path)}
                    </span>
                    <span className="lfx-rel">{d.path.slice(r.length + 1)}</span>
                    <span className="lfx-time">{ago(d.mtime)}</span>
                  </a>
                  <div className="lfx-row-menu">
                    <button
                      type="button"
                      className="lfx-more"
                      aria-label={`Actions for ${basename(d.path)}`}
                      aria-haspopup="menu"
                      aria-expanded={menu === d.path}
                      onClick={() => setMenu(menu === d.path ? null : d.path)}
                    >
                      ⋯
                    </button>
                    {menu === d.path && (
                      <div className="lfx-menu" role="menu">
                        {actions(d).map(([label, fn, danger]) => (
                          <button
                            key={label}
                            type="button"
                            role="menuitem"
                            className={danger ? "lfx-danger-text" : undefined}
                            onClick={() => {
                              setMenu(null);
                              void fn();
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {dialog}
    </main>
  );
}
