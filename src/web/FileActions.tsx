/**
 * Rename, duplicate, move and delete for drawings, shared by the drawing list and the editor
 * menu, plus the small modal they ask through.
 */
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { api, basename } from "./sync";

export interface Folder {
  path: string;
  root: string;
  /** Nothing inside at all (a folder just made with New folder). */
  empty?: boolean;
}

const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));

export const files = {
  rename: (path: string, name: string) => {
    const clean = name.trim().replace(/\.excalidraw$/, "");
    return api<{ path: string }>("POST", "/api/files/rename", { path, to: `${dirOf(path)}/${clean}.excalidraw` });
  },
  duplicate: (path: string) => api<{ path: string }>("POST", "/api/files/duplicate", { path }),
  move: (path: string, dir: string) => api<{ path: string }>("POST", "/api/files/move", { path, dir }),
  trash: (path: string) => api<{ path: string; trashed: string }>("POST", "/api/files/trash", { path }),
  folder: (path: string) => api<{ path: string }>("POST", "/api/files/folder", { path }),
  renameFolder: (path: string, name: string) => api<{ path: string }>("POST", "/api/files/rename-folder", { path, name: name.trim() }),
  /** Shows a drawing or folder in the Finder (macOS only). */
  reveal: (path: string) => api<{ path: string }>("POST", "/api/files/reveal", { path }),
  list: () => api<FileList>("GET", "/api/files"),
};

export interface FileList {
  roots: string[];
  drawings: { path: string; root: string; size: number; mtime: number }[];
  folders: Folder[];
}

interface Ask {
  title: string;
  /** Text input with this initial value; omitted for a plain confirmation. */
  value?: string;
  /** A folder picker instead of a text input. */
  options?: { value: string; label: string }[];
  confirm: string;
  danger?: boolean;
  message?: string;
}

/** A promise-returning modal: `await ask({...})` resolves to the value, or null when cancelled. */
export function useDialog(): [ReactElement | null, (a: Ask) => Promise<string | null>] {
  const [state, setState] = useState<(Ask & { resolve: (v: string | null) => void }) | null>(null);
  const ask = useCallback((a: Ask) => new Promise<string | null>((resolve) => setState({ ...a, resolve })), []);
  const el = state ? <Dialog {...state} onDone={(v) => (state.resolve(v), setState(null))} /> : null;
  return [el, ask];
}

function Dialog(props: Ask & { onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(props.value ?? props.options?.[0]?.value ?? "");
  // The input, picker or confirm button, whichever the dialog has.
  const first = useRef<any>(null);
  useEffect(() => {
    first.current?.focus();
    if (first.current instanceof HTMLInputElement) first.current.select();
  }, []);
  const text = props.value !== undefined;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text && !value.trim()) return;
    props.onDone(text || props.options ? value : "ok");
  };
  return (
    <div className="lfx-modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onDone(null)}>
      <form
        className="lfx-modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onSubmit={submit}
        onKeyDown={(e) => {
          // Keep keys away from the canvas shortcuts underneath.
          e.stopPropagation();
          if (e.key === "Escape") props.onDone(null);
        }}
      >
        <h2>{props.title}</h2>
        {props.message && <p>{props.message}</p>}
        {text && <input ref={first} value={value} onChange={(e) => setValue(e.target.value)} aria-label={props.title} />}
        {props.options && (
          <select ref={first} value={value} onChange={(e) => setValue(e.target.value)} aria-label={props.title}>
            {props.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <div className="lfx-modal-actions">
          <button type="button" className="lfx-modal-cancel" onClick={() => props.onDone(null)}>
            Cancel
          </button>
          <button type="submit" ref={!text && !props.options ? first : undefined} className={props.danger ? "lfx-danger" : undefined}>
            {props.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Folder choices for "Move to folder": every root and folder under it, shown relative to its root. */
export function folderOptions(roots: string[], folders: Folder[], current?: string) {
  const all = [...roots.map((r) => ({ path: r, root: r })), ...folders];
  return all
    .filter((f) => f.path !== current)
    .map((f) => ({ value: f.path, label: f.path === f.root ? f.root : `${basename(f.root)}/${f.path.slice(f.root.length + 1)}` }));
}

export { dirOf };
