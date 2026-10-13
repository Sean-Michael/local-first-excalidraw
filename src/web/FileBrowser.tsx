import { useEffect, useMemo, useState } from "react";
import { api, basename } from "./sync";

interface Drawing {
  path: string;
  root: string;
  size: number;
  mtime: number;
}

const open = (p: string) => (location.href = `/?file=${encodeURIComponent(p)}`);

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function FileBrowser() {
  const [data, setData] = useState<{ roots: string[]; drawings: Drawing[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");

  useEffect(() => {
    document.title = "Drawings · Excalidraw";
    api<{ roots: string[]; drawings: Drawing[] }>("GET", "/api/files")
      .then((d) => {
        setData(d);
        setRoot(d.roots[0] ?? "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

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
      </form>

      <input className="lfx-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="Filter" />

      {error && <p className="lfx-error-inline">{error}</p>}
      {!data && !error && <p className="lfx-sub">Loading…</p>}

      {groups.map(([r, items]) => (
        <section key={r}>
          <h2 title={r}>{r}</h2>
          {items.length === 0 ? (
            <p className="lfx-empty">No drawings yet.</p>
          ) : (
            <ul>
              {items.map((d) => (
                <li key={d.path}>
                  <a href={`/?file=${encodeURIComponent(d.path)}`}>
                    <span className="lfx-name">{basename(d.path)}</span>
                    <span className="lfx-rel">{d.path.slice(r.length + 1)}</span>
                    <span className="lfx-time">{ago(d.mtime)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </main>
  );
}
