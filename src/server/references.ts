/**
 * The architecture-diagrams skill's reference files (plugin/skills/architecture-diagrams/
 * references/*.md), served by the diagram_reference tool so the in-app assistant gets the
 * same diagram knowledge as a Claude Code agent with the plugin. The files ship with the
 * npm package and the macOS app at the same place relative to the compiled code.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REL = path.join("plugin", "skills", "architecture-diagrams", "references");

let cached: string | null | undefined;

/** The references directory: LFX_REFERENCES_DIR, else the nearest `plugin/…/references` above this file. */
export function referencesDir(): string | null {
  if (cached !== undefined) return cached;
  const env = process.env.LFX_REFERENCES_DIR;
  if (env && fs.existsSync(env)) return (cached = env);
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, REL);
    if (fs.existsSync(candidate)) return (cached = candidate);
    if (path.dirname(dir) === dir) return (cached = null);
  }
}

export interface Topic {
  topic: string;
  title: string;
}

/** Topics (file names without `.md`) and their headings. */
export function listTopics(dir = referencesDir()): Topic[] {
  if (!dir) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const first = fs.readFileSync(path.join(dir, f), "utf8").split("\n").find((l) => l.startsWith("# "));
      return { topic: f.slice(0, -3), title: first ? first.slice(2).trim() : f.slice(0, -3) };
    });
}

/** One topic's Markdown. Only names from listTopics are accepted, so no path can escape the directory. */
export function readTopic(topic: string, dir = referencesDir()): string {
  const topics = listTopics(dir);
  const want = topic.trim().toLowerCase().replace(/\.md$/, "");
  const hit = topics.find((t) => t.topic === want) ?? topics.find((t) => t.topic.includes(want) || t.title.toLowerCase().includes(want));
  if (!hit || !dir) {
    throw new Error(`No reference "${topic}". Topics: ${topics.map((t) => t.topic).join(", ") || "(none installed)"}`);
  }
  return fs.readFileSync(path.join(dir, `${hit.topic}.md`), "utf8");
}
