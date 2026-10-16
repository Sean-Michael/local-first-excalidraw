import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeFileAtomic } from "./config.js";
import {
  assertFinite,
  emptyScene,
  type El,
  live,
  mergeElements,
  parseScene,
  type Scene,
  serializeScene,
  tombstonesFor,
  wins,
} from "./scene.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
// Deleted ids remembered across restarts, per drawing.
const TOMBSTONE_TTL_MS = 7 * 24 * 3600 * 1000;
const TOMBSTONE_MAX = 2000;

/** The file exists but isn't a drawing we can read (e.g. git conflict markers). */
export class InvalidDrawingError extends Error {}

/** Drawing path -> element id -> [deleted version, time deleted]. */
type Tombstones = Record<string, Record<string, [number, number]>>;

interface Doc {
  path: string;
  /** Includes tombstones, so deletions propagate to every client. */
  scene: Scene;
  /** Hash of what is on disk as far as we know (ours or an external writer's). */
  diskHash: string | null;
  rev: number;
  watcher?: fs.FSWatcher;
  watchers: number;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

export interface SceneChange {
  path: string;
  rev: number;
  scene: Scene;
  /** Client that caused the change, so it can skip its own echo. */
  origin?: string;
}

/**
 * Single source of truth for open drawings. Every write is a merge (newer element
 * versions win) so the browser, agents and external editors never clobber each other.
 */
export class DocStore extends EventEmitter {
  private docs = new Map<string, Doc>();
  private tombFile?: string;
  private tombs: Tombstones = {};

  /**
   * `stateDir` keeps a sidecar of recently deleted ids, so a stale editor tab can't bring
   * deleted elements back after a daemon restart (files on disk hold no tombstones).
   */
  constructor(opts: { stateDir?: string } = {}) {
    super();
    if (opts.stateDir) {
      this.tombFile = path.join(opts.stateDir, "tombstones.json");
      this.tombs = readJson<Tombstones>(this.tombFile, {});
    }
  }

  /** Records the drawing's deleted ids (and forgets ids that are live again), then persists. */
  private remember(p: string, els: El[]): void {
    if (!this.tombFile) return;
    const t = (this.tombs[p] ??= {});
    let dirty = false;
    const now = Date.now();
    for (const e of els) {
      const known = t[e.id];
      if (e.isDeleted && (!known || known[0] < e.version)) {
        t[e.id] = [e.version, now];
        dirty = true;
      } else if (!e.isDeleted && known) {
        delete t[e.id];
        dirty = true;
      }
    }
    if (!dirty) return;
    // Prune: drop old entries, keep the newest per drawing.
    for (const [file, ids] of Object.entries(this.tombs)) {
      const kept = Object.entries(ids)
        .filter(([, [, at]]) => now - at < TOMBSTONE_TTL_MS)
        .sort((a, b) => b[1][1] - a[1][1])
        .slice(0, TOMBSTONE_MAX);
      if (kept.length) this.tombs[file] = Object.fromEntries(kept);
      else delete this.tombs[file];
    }
    try {
      writeFileAtomic(this.tombFile, JSON.stringify(this.tombs), 0o600);
    } catch {
      // Best effort: losing the sidecar only weakens protection against stale tabs.
    }
  }

  /** Elements an editor sends that we deleted before a restart (so no longer hold) stay deleted. */
  private bury(p: string, current: El[], incoming: El[]): El[] {
    const t = this.tombs[p];
    if (!t) return incoming;
    const held = new Set(current.map((e) => e.id));
    return incoming.map((e) => {
      const dead = t[e.id];
      if (held.has(e.id) || !dead || e.isDeleted || e.version > dead[0]) return e;
      // Outrank the tab's copy so the tab drops it too.
      return { ...e, isDeleted: true, version: Math.max(dead[0], e.version + 1) };
    });
  }

  /** The file's scene and hash; just the hash (no parse) when it matches `known`. */
  private readDisk(p: string): { scene: Scene; hash: string } | null;
  private readDisk(p: string, known: string | null): { scene: Scene | null; hash: string } | null;
  private readDisk(p: string, known?: string | null): { scene: Scene | null; hash: string } | null {
    let raw: string;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error(`${p} is not a file`);
      if (st.size > MAX_FILE_BYTES) throw new Error(`${p} is larger than ${MAX_FILE_BYTES} bytes`);
      raw = fs.readFileSync(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const hash = sha(raw);
    if (hash === known) return { scene: null, hash };
    try {
      return { scene: parseScene(raw), hash };
    } catch (e) {
      const conflict = /^(<{7}|>{7}|={7})( |$)/m.test(raw) ? " It has git conflict markers." : "";
      throw new InvalidDrawingError(
        `${p} is not valid Excalidraw JSON (merge conflict?): ${(e as Error).message}.${conflict} ` +
          "Fix the file, or replace it with create_drawing overwrite: true.",
      );
    }
  }

  /**
   * Forgets the content of a drawing that can't be parsed, so it can be overwritten.
   * Does nothing for a readable or missing file.
   */
  discardInvalid(p: string): void {
    try {
      this.load(p);
    } catch (e) {
      if (!(e instanceof InvalidDrawingError)) throw e;
      const diskHash = sha(fs.readFileSync(p, "utf8"));
      const doc = this.docs.get(p);
      if (doc) Object.assign(doc, { scene: emptyScene(), diskHash, rev: doc.rev + 1 });
      else this.docs.set(p, { path: p, scene: emptyScene(), diskHash, rev: 0, watchers: 0 });
    }
  }

  private load(p: string): Doc {
    let doc = this.docs.get(p);
    if (doc) {
      this.syncFromDisk(doc);
      return doc;
    }
    const disk = this.readDisk(p);
    doc = {
      path: p,
      scene: disk?.scene ?? emptyScene(),
      diskHash: disk?.hash ?? null,
      rev: 0,
      watchers: 0,
    };
    this.docs.set(p, doc);
    return doc;
  }

  /** Picks up edits made outside the daemon (agent Edit tool, git checkout, another editor). */
  private syncFromDisk(doc: Doc): boolean {
    const disk = this.readDisk(doc.path, doc.diskHash);
    if (!disk) {
      if (doc.diskHash === null) return false;
      // Deleted or moved on disk: forget our copy so nothing resurrects it implicitly.
      doc.diskHash = null;
      doc.scene = emptyScene();
      doc.rev++;
      this.emit("deleted", doc.path);
      return false;
    }
    if (!disk.scene) return false; // unchanged since we last read or wrote it
    const prev = doc.scene.elements;
    const next = disk.scene.elements;
    const prevById = new Map(prev.map((e) => [e.id, e]));
    // An external writer may have edited JSON without bumping versions. Treat any element
    // whose content differs as a newer version so it wins the merge.
    const adopted = next.map((e) => {
      const old = prevById.get(e.id);
      if (!old || JSON.stringify(old) === JSON.stringify(e)) return e;
      return e.version > old.version ? e : { ...e, version: old.version + 1 };
    });
    doc.scene = {
      ...disk.scene,
      elements: mergeElements([...adopted, ...tombstonesFor(prev, next)], []),
    };
    doc.diskHash = disk.hash;
    doc.rev++;
    this.remember(doc.path, doc.scene.elements);
    return true;
  }

  exists(p: string): boolean {
    return fs.existsSync(p);
  }

  get(p: string): { scene: Scene; rev: number; exists: boolean } {
    const doc = this.load(p);
    return { scene: doc.scene, rev: doc.rev, exists: doc.diskHash !== null };
  }

  /** Live (non-deleted) view for agents and exports. */
  getLive(p: string): { scene: Scene; rev: number; exists: boolean } {
    const r = this.get(p);
    return { ...r, scene: { ...r.scene, elements: live(r.scene.elements) } };
  }

  /**
   * Merges `elements` into the document and persists it.
   * `replace` treats the incoming list as authoritative: missing elements are deleted.
   * `fromEditor` marks a save from an editor tab, which may still hold elements deleted
   * before a daemon restart; those stay deleted.
   */
  apply(
    p: string,
    change: {
      elements?: El[];
      appState?: Record<string, unknown>;
      files?: Record<string, unknown>;
      replace?: boolean;
      fromEditor?: boolean;
    },
    origin?: string,
  ): { rev: number; scene: Scene } {
    const doc = this.load(p);
    let elements = doc.scene.elements;
    if (change.elements) {
      let incoming = change.replace
        ? [...change.elements, ...tombstonesFor(elements, change.elements)]
        : change.elements;
      if (change.fromEditor) incoming = this.bury(p, elements, incoming);
      // Only what changes is checked, so an old file with odd values can still be edited.
      const byId = new Map(elements.map((e) => [e.id, e]));
      assertFinite(incoming.filter((e) => byId.get(e.id)?.version !== e.version && wins(e, byId.get(e.id))));
      elements = mergeElements(elements, incoming);
    }
    doc.scene = {
      ...doc.scene,
      elements,
      appState: change.appState ? { ...doc.scene.appState, ...change.appState } : doc.scene.appState,
      files: change.files ? { ...doc.scene.files, ...change.files } : doc.scene.files,
    };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const raw = serializeScene(doc.scene);
    writeFileAtomic(p, raw);
    doc.diskHash = sha(raw);
    doc.rev++;
    this.remember(p, doc.scene.elements);
    this.emit("change", { path: p, rev: doc.rev, scene: doc.scene, origin } satisfies SceneChange);
    return { rev: doc.rev, scene: doc.scene };
  }

  /** Watch a file while at least one editor has it open. */
  watch(p: string): () => void {
    const doc = this.load(p);
    doc.watchers++;
    if (!doc.watcher) {
      let timer: NodeJS.Timeout | undefined;
      try {
        // Watch the directory: atomic saves replace the file's inode.
        doc.watcher = fs.watch(path.dirname(p), (_evt, name) => {
          if (name && name.toString() !== path.basename(p)) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            try {
              if (this.syncFromDisk(doc)) {
                this.emit("change", { path: p, rev: doc.rev, scene: doc.scene } satisfies SceneChange);
              }
            } catch {
              // Half-written or invalid JSON from an external editor: wait for the next event.
            }
          }, 120);
        });
      } catch {
        // Directory may not exist yet for a brand-new drawing; edits through us still sync.
      }
    }
    return () => {
      doc.watchers--;
      if (doc.watchers <= 0) {
        doc.watcher?.close();
        doc.watcher = undefined;
        doc.watchers = 0;
      }
    };
  }
}

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", ".venv", "venv", "__pycache__"]);

export interface DrawingInfo {
  path: string;
  root: string;
  size: number;
  mtime: number;
}

/** Finds .excalidraw files under the roots (bounded depth and count). */
export function listDrawings(roots: string[], maxDepth = 6, limit = 500): DrawingInfo[] {
  const out: DrawingInfo[] = [];
  const walk = (root: string, dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(root, full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".excalidraw")) {
        const st = fs.statSync(full);
        out.push({ path: full, root, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  for (const r of roots) walk(r, r, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}
