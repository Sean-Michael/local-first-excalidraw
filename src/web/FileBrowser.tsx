import { useEffect, useState } from "react";
import { DrawingTree, rootLabel, useFileList } from "./Tree";
import { api, Sync } from "./sync";

/** The drawing list (no drawing open): a new-drawing form above the same tree the sidebar shows. */
export function FileBrowser({ onOpen }: { onOpen: (path: string | null) => void }) {
  const { data, error: loadError, reload } = useFileList();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");

  useEffect(() => {
    document.title = "Drawings · Excalidraw";
  }, []);
  useEffect(() => {
    if (data && !root) setRoot(data.roots[0] ?? "");
  }, [data, root]);

  // No editor socket on this page: open one just to hear about drawings changing.
  useEffect(() => {
    const sync = new Sync(
      () => {},
      () => {},
      () => {},
    );
    return () => sync.close();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim().replace(/\.excalidraw$/, "");
    if (!clean || !root) return;
    try {
      const { path } = await api<{ path: string }>("POST", "/api/new", { path: `${root}/${clean}.excalidraw` });
      onOpen(path);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const shown = error ?? loadError;
  return (
    <main className="lfx-browser">
      <header>
        <h1>Drawings</h1>
        <p className="lfx-sub">Local files only. Nothing leaves this machine. Right-click a drawing or folder for more.</p>
      </header>

      <form className="lfx-new" onSubmit={create}>
        <select value={root} onChange={(e) => setRoot(e.target.value)} aria-label="Folder">
          {data?.roots.map((r) => (
            <option key={r} value={r} title={r}>
              {rootLabel(r)}
            </option>
          ))}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new-drawing or sub/dir/name" aria-label="Name" />
        <button type="submit" disabled={!name.trim()}>
          New drawing
        </button>
      </form>

      {shown && (
        <p className="lfx-error-inline" role="alert">
          {shown}{" "}
          <button type="button" className="lfx-text-btn" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}

      <DrawingTree data={data} reload={reload} onOpen={onOpen} variant="page" />
    </main>
  );
}
