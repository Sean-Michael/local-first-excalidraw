/**
 * Named snapshots of drawings, kept in the state directory (never in the project), so an
 * agent can save a drawing before a risky edit and put it back afterwards. Each drawing
 * keeps its most recent few; older ones are pruned.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./config.js";
import { contentRev, type El, live, type Scene } from "./scene.js";

export const MAX_SNAPSHOTS = 20;

export interface SnapshotInfo {
  id: string;
  name: string;
  created: number;
  elements: number;
  rev: string;
}

interface SnapshotFile extends SnapshotInfo {
  path: string;
  content: El[];
  files: Record<string, unknown>;
}

export class Snapshots {
  constructor(private stateDir: string) {}

  private dir(drawing: string): string {
    const key = crypto.createHash("sha256").update(drawing).digest("hex").slice(0, 20);
    return path.join(this.stateDir, "snapshots", key);
  }

  private read(file: string): SnapshotFile | undefined {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotFile;
    } catch {
      return undefined;
    }
  }

  /** Newest first. */
  list(drawing: string): SnapshotInfo[] {
    const dir = this.dir(drawing);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((n) => this.read(path.join(dir, n)))
      .filter((s): s is SnapshotFile => !!s && s.path === drawing)
      .map(({ id, name, created, elements, rev }) => ({ id, name, created, elements, rev }))
      .sort((a, b) => b.created - a.created);
  }

  save(drawing: string, scene: Scene, name?: string): SnapshotInfo {
    const dir = this.dir(drawing);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const els = live(scene.elements);
    // Strictly after the newest, so "newest first" holds even within one millisecond.
    const created = Math.max(Date.now(), (this.list(drawing)[0]?.created ?? 0) + 1);
    const id = `${created.toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
    const info: SnapshotInfo = { id, name: name?.trim() || new Date(created).toISOString().slice(0, 19).replace("T", " "), created, elements: els.filter((e) => !(e.type === "text" && e.containerId)).length, rev: contentRev(els) };
    const data: SnapshotFile = { ...info, path: drawing, content: els, files: scene.files ?? {} };
    writeFileAtomic(path.join(dir, `${id}.json`), JSON.stringify(data), 0o600);
    for (const old of this.list(drawing).slice(MAX_SNAPSHOTS)) fs.rmSync(path.join(dir, `${old.id}.json`), { force: true });
    return info;
  }

  /** By id or name (the newest with that name); the newest snapshot when `which` is omitted. */
  get(drawing: string, which?: string): { info: SnapshotInfo; elements: El[]; files: Record<string, unknown> } | undefined {
    const all = this.list(drawing);
    const hit = which ? (all.find((s) => s.id === which) ?? all.find((s) => s.name === which)) : all[0];
    if (!hit) return undefined;
    const data = this.read(path.join(this.dir(drawing), `${hit.id}.json`));
    return data ? { info: hit, elements: data.content, files: data.files } : undefined;
  }
}
