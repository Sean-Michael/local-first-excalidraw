/**
 * Notices when the set of drawings and folders under the roots changes (a drawing created,
 * renamed, moved or deleted, a folder added) by whoever made the change: the editor, an agent,
 * git or the Finder. It only runs while someone is listening, rescans on a nudge or a file
 * system event, and calls back once per burst when the set really changed.
 *
 * macOS and Windows get a recursive fs.watch per root (cheap there). Elsewhere recursive
 * watching means one inotify watch per directory, node_modules included, so it polls with a
 * bounded scan instead.
 */
import fs from "node:fs";
import { listFolders } from "./files.js";
import { listDrawings, SKIP_DIRS } from "./store.js";

const DEBOUNCE_MS = 150;
const RECURSIVE = process.platform === "darwin" || process.platform === "win32";

export interface DrawingSetWatcherOptions {
  debounceMs?: number;
  /** Rescan this often while active, as a safety net (or the only mechanism without recursive watch). */
  intervalMs?: number;
}

/** True for a changed path worth a rescan: a drawing, or something that could be a folder. */
export function relevantChange(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p.startsWith(".") || SKIP_DIRS.has(p))) return false;
  const last = parts[parts.length - 1];
  return last.endsWith(".excalidraw") || !last.includes(".");
}

export class DrawingSetWatcher {
  private known = new Set<string>();
  private signature = "";
  private watchers = new Map<string, fs.FSWatcher>();
  private timer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private readonly debounceMs: number;
  private readonly intervalMs: number;

  constructor(
    private roots: () => string[],
    private onChange: () => void,
    opts: DrawingSetWatcherOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.intervalMs = opts.intervalMs ?? (RECURSIVE ? 15_000 : 2_000);
  }

  get active(): boolean {
    return this.interval !== undefined;
  }

  /** Starts or stops watching; the set is re-read when it starts so a later change is a change. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    if (!on) {
      clearInterval(this.interval);
      clearTimeout(this.timer);
      this.interval = this.timer = undefined;
      for (const w of this.watchers.values()) w.close();
      this.watchers.clear();
      return;
    }
    this.scan(false);
    this.interval = setInterval(() => this.scan(true), this.intervalMs);
    this.interval.unref();
  }

  /** Something may have changed the set: rescan soon. */
  nudge(): void {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.scan(true), this.debounceMs);
    this.timer.unref();
  }

  /** A drawing was written: only a path we haven't seen can change the set. */
  saw(file: string): void {
    if (!this.known.has(file)) this.nudge();
  }

  private scan(notify: boolean): void {
    const roots = this.roots();
    if (RECURSIVE) this.watchRoots(roots);
    const drawings = listDrawings(roots).map((d) => d.path);
    const folders = listFolders(roots).map((f) => `${f.path}/`);
    const signature = [...roots.map((r) => `root:${r}`), ...drawings.sort(), ...folders].join("\n");
    this.known = new Set(drawings);
    if (signature === this.signature) return;
    this.signature = signature;
    if (notify) this.onChange();
  }

  private watchRoots(roots: string[]): void {
    for (const [r, w] of this.watchers) {
      if (roots.includes(r)) continue;
      w.close();
      this.watchers.delete(r);
    }
    for (const r of roots) {
      if (this.watchers.has(r)) continue;
      try {
        const w = fs.watch(r, { recursive: true }, (_evt, name) => {
          if (!name || relevantChange(name.toString())) this.nudge();
        });
        w.on("error", () => {
          w.close();
          this.watchers.delete(r);
        });
        this.watchers.set(r, w);
      } catch {
        // Root missing or not watchable: the interval scan still covers it.
      }
    }
  }
}
