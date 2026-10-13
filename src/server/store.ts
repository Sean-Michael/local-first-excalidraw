import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./config.js";
import {
  emptyScene,
  type El,
  live,
  mergeElements,
  parseScene,
  type Scene,
  serializeScene,
  tombstonesFor,
} from "./scene.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024;

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

  private readDisk(p: string): { scene: Scene; hash: string } | null {
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
    return { scene: parseScene(raw), hash: sha(raw) };
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
    const disk = this.readDisk(doc.path);
    if (!disk) {
      if (doc.diskHash === null) return false;
      // Deleted or moved on disk: forget our copy so nothing resurrects it implicitly.
      doc.diskHash = null;
      doc.scene = emptyScene();
      doc.rev++;
      this.emit("deleted", doc.path);
      return false;
    }
    if (disk.hash === doc.diskHash) return false;
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
   */
  apply(
    p: string,
    change: { elements?: El[]; appState?: Record<string, unknown>; files?: Record<string, unknown>; replace?: boolean },
    origin?: string,
  ): { rev: number; scene: Scene } {
    const doc = this.load(p);
    let elements = doc.scene.elements;
    if (change.elements) {
      const incoming = change.replace
        ? [...change.elements, ...tombstonesFor(elements, change.elements)]
        : change.elements;
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

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", ".venv", "venv", "__pycache__"]);

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
