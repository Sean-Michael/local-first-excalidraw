import { exportToSvg, restoreElements } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./sync";

interface LibraryInfo {
  id: string;
  name: string;
  origin: "built-in" | "installed" | "project" | "personal";
  description?: string;
  authors?: string[];
  url?: string;
  file?: string;
  items: number;
  enabled: boolean;
}

interface Item {
  key: string;
  name: string;
  itemId: string;
  elements: any[];
}

interface CatalogEntry {
  source: string;
  name: string;
  description: string;
  authors: string[];
  downloads: number;
  installed: boolean;
}

const SECTIONS: { origin: LibraryInfo["origin"]; title: string; hint: string }[] = [
  { origin: "built-in", title: "Built in", hint: "Starter libraries that ship with the app (MIT, from the Excalidraw library catalog)." },
  { origin: "installed", title: "Installed", hint: "Libraries you imported or installed from the catalog." },
  { origin: "project", title: "In this project", hint: ".excalidrawlib files in the project, shared with everyone who clones it." },
  { origin: "personal", title: "Your Excalidraw library", hint: "What's in the canvas Library sidebar." },
];

const PAGE = 48;

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** An item preview, rendered with Excalidraw's own exporter. */
function Thumb({ elements, dark }: { elements: any[]; dark: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const restored = restoreElements(elements, null);
    exportToSvg({
      elements: restored,
      appState: { exportBackground: false, viewBackgroundColor: "transparent", exportWithDarkMode: dark } as any,
      files: null,
      exportPadding: 6,
      skipInliningFonts: true,
    } as any)
      .then((svg: SVGSVGElement) => {
        if (cancelled || !ref.current) return;
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        ref.current.replaceChildren(svg);
      })
      .catch(() => ref.current?.replaceChildren(document.createTextNode("?")));
    return () => {
      cancelled = true;
    };
  }, [elements, dark]);
  return <div className="lfx-thumb" ref={ref} aria-hidden />;
}

function ItemName({ item, onRename }: { item: Item; onRename: (name: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.name);
  if (!editing) {
    return (
      <button type="button" className="lfx-item-name" title={`${item.name}\nClick to rename (${item.key})`} onClick={() => setEditing(true)}>
        {item.name}
      </button>
    );
  }
  return (
    <input
      className="lfx-item-input"
      autoFocus
      value={value}
      aria-label="Shape name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (value.trim() !== item.name) onRename(value.trim() || null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setValue(item.name);
          setEditing(false);
        }
        e.stopPropagation();
      }}
    />
  );
}

function LibraryRow({
  lib,
  path,
  dark,
  onChanged,
  onAddToCanvas,
}: {
  lib: LibraryInfo;
  path: string;
  dark: boolean;
  onChanged: () => void;
  onAddToCanvas: (items: { name: string; elements: any[] }[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ items: Item[] }>("GET", `/api/libraries/items?id=${encodeURIComponent(lib.id)}&path=${encodeURIComponent(path)}`).then(
      (r) => setItems(r.items),
      (e: Error) => setError(e.message),
    );
  }, [lib.id, path]);

  useEffect(() => {
    if (open && !items) load();
  }, [open, items, load]);

  const toggle = async (enabled: boolean) => {
    await api("POST", "/api/libraries/update", { id: lib.id, enabled }).catch((e: Error) => setError(e.message));
    onChanged();
  };

  return (
    <li className="lfx-lib">
      <div className="lfx-lib-row">
        <input
          type="checkbox"
          checked={lib.enabled}
          onChange={(e) => toggle(e.target.checked)}
          title={lib.enabled ? "The assistant uses this library" : "The assistant ignores this library"}
          aria-label={`Let the assistant use ${lib.name}`}
        />
        <button type="button" className="lfx-lib-name" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span>{lib.name}</span>
          <small>
            {lib.items} {lib.items === 1 ? "shape" : "shapes"}
            {lib.authors?.length ? ` · ${lib.authors.join(", ")}` : ""}
            {lib.file ? ` · ${lib.file}` : ""}
          </small>
        </button>
        <span className="lfx-lib-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div className="lfx-lib-body">
          {lib.description && <p className="lfx-muted">{lib.description}</p>}
          <div className="lfx-row lfx-lib-actions">
            {lib.origin !== "personal" && (
              <button
                type="button"
                className="lfx-link"
                disabled={!items}
                onClick={() => items && onAddToCanvas(items.map((i) => ({ name: i.name, elements: i.elements })))}
                title="Copy these shapes into the canvas Library sidebar, to drag them in by hand"
              >
                Add to canvas library
              </button>
            )}
            {lib.origin === "installed" && (
              <button
                type="button"
                className="lfx-link lfx-danger"
                onClick={async () => {
                  if (!confirm(`Remove ${lib.name}?`)) return;
                  await api("POST", "/api/libraries/remove", { id: lib.id }).catch((e: Error) => setError(e.message));
                  onChanged();
                }}
              >
                Remove
              </button>
            )}
          </div>
          {error && <p className="lfx-error-inline">{error}</p>}
          {!items ? (
            <p className="lfx-muted">Loading…</p>
          ) : (
            <>
              <ul className="lfx-items">
                {items.slice(0, shown).map((it) => (
                  <li key={it.key}>
                    <Thumb elements={it.elements} dark={dark} />
                    <ItemName
                      item={it}
                      onRename={async (name) => {
                        await api("POST", "/api/libraries/update", { id: lib.id, rename: { itemId: it.itemId, name } }).catch((e: Error) => setError(e.message));
                        load();
                      }}
                    />
                  </li>
                ))}
              </ul>
              {items.length > shown && (
                <button type="button" className="lfx-btn lfx-more" onClick={() => setShown(shown + PAGE)}>
                  Show {Math.min(PAGE, items.length - shown)} more
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Catalog({ onInstalled }: { onInstalled: () => void }) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ entries: CatalogEntry[] }>("GET", "/api/libraries/catalog").then(
      (r) => setEntries(r.entries),
      (e: Error) => setError(e.message),
    );
  }, []);

  const q = query.toLowerCase();
  const shown = (entries ?? []).filter((e) => !q || `${e.name} ${e.description} ${e.authors.join(" ")}`.toLowerCase().includes(q)).slice(0, 80);

  return (
    <div className="lfx-catalog">
      <p className="lfx-note">
        From the public catalog at libraries.excalidraw.com (github.com/excalidraw/excalidraw-libraries, MIT), most downloaded first. Installing downloads the
        library once; after that it works offline.
      </p>
      <input className="lfx-search-input" placeholder="Search libraries (aws, kubernetes, ui, people…)" value={query} onChange={(e) => setQuery(e.target.value)} />
      {error && <p className="lfx-error-inline">{error}</p>}
      {!entries && !error && <p className="lfx-muted">Loading the catalog…</p>}
      <ul className="lfx-catalog-list">
        {shown.map((e) => (
          <li key={e.source}>
            <div>
              <strong>{e.name}</strong>
              <small>
                {compact(e.downloads)} downloads{e.authors.length ? ` · ${e.authors.join(", ")}` : ""}
              </small>
              {e.description && <p>{e.description}</p>}
            </div>
            {e.installed ? (
              <span className="lfx-muted">Installed</span>
            ) : (
              <button
                type="button"
                className="lfx-btn"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(e.source);
                  setError(null);
                  try {
                    await api("POST", "/api/libraries/install", { source: e.source });
                    setEntries((list) => list?.map((x) => (x.source === e.source ? { ...x, installed: true } : x)) ?? null);
                    onInstalled();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === e.source ? "Installing…" : "Install"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Shapes({
  path,
  dark,
  onAddToCanvas,
}: {
  path: string;
  dark: boolean;
  onAddToCanvas: (items: { name: string; elements: any[] }[]) => void;
}) {
  const [libs, setLibs] = useState<LibraryInfo[] | null>(null);
  const [view, setView] = useState<"mine" | "catalog">("mine");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api<{ libraries: LibraryInfo[] }>("GET", `/api/libraries?path=${encodeURIComponent(path)}`).then(
      (r) => setLibs(r.libraries),
      (e: Error) => setError(e.message),
    );
  }, [path]);

  useEffect(refresh, [refresh]);

  const importFiles = async (files: FileList | File[]) => {
    setError(null);
    const done: string[] = [];
    for (const f of [...files]) {
      try {
        const r = await api<{ library: LibraryInfo }>("POST", "/api/libraries/import", { fileName: f.name, content: await f.text() });
        done.push(`${r.library.name} (${r.library.items})`);
      } catch (e) {
        setError(`${f.name}: ${(e as Error).message}`);
      }
    }
    if (done.length) setMessage(`Imported ${done.join(", ")}.`);
    refresh();
  };

  return (
    <div
      className={`lfx-shapes${dragging ? " lfx-dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        importFiles(e.dataTransfer.files);
      }}
    >
      <div className="lfx-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view === "mine"} className={view === "mine" ? "lfx-on" : ""} onClick={() => setView("mine")}>
          My libraries
        </button>
        <button type="button" role="tab" aria-selected={view === "catalog"} className={view === "catalog" ? "lfx-on" : ""} onClick={() => setView("catalog")}>
          Browse catalog
        </button>
        <button type="button" className="lfx-btn" onClick={() => fileRef.current?.click()}>
          Import…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".excalidrawlib,application/json"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) importFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {message && (
        <p className="lfx-ok" role="status" onClick={() => setMessage(null)}>
          {message}
        </p>
      )}
      {error && <p className="lfx-error-inline">{error}</p>}
      {view === "catalog" ? (
        <Catalog
          onInstalled={() => {
            refresh();
            setMessage("Installed. It's under My libraries.");
          }}
        />
      ) : (
        <>
          <p className="lfx-note">Checked libraries are available to the assistant. Click a name to rename it; good names help the assistant find the right shape. Drop .excalidrawlib files here to import them.</p>
          {SECTIONS.map((sec) => {
            const list = (libs ?? []).filter((l) => l.origin === sec.origin);
            if (!list.length) return null;
            return (
              <section key={sec.origin}>
                <p className="lfx-settings-sub" title={sec.hint}>
                  {sec.title}
                </p>
                <ul className="lfx-libs">
                  {list.map((l) => (
                    <LibraryRow key={l.id} lib={l} path={path} dark={dark} onChanged={refresh} onAddToCanvas={(items) => {
                      onAddToCanvas(items);
                      setMessage(`Added ${items.length} shapes from ${l.name} to the canvas Library sidebar.`);
                    }} />
                  ))}
                </ul>
              </section>
            );
          })}
          {libs && !libs.some((l) => l.origin === "installed") && (
            <p className="lfx-muted">
              Nothing installed yet. Browse the catalog, or import .excalidrawlib files you've downloaded (drag them onto this panel).
            </p>
          )}
        </>
      )}
    </div>
  );
}
