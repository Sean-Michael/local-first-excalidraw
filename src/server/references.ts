/**
 * The architecture-diagrams skill's reference files (plugin/skills/architecture-diagrams/
 * references/*.md), served by the diagram_reference tool so the in-app assistant gets the
 * same diagram knowledge as a Claude Code agent with the plugin. The files ship with the
 * npm package and the macOS app at the same place relative to the compiled code.
 *
 * Models ask for topics in their own words ("uml class diagram", "use-case", "ERD"), so a
 * topic is found by what it covers (its headings and a `<!-- keywords: … -->` line), not only
 * by its file name.
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
  /** The diagrams and subjects it covers: its `##` headings. */
  covers: string[];
  /** Extra search words from the file's `<!-- keywords: … -->` line. */
  keywords: string[];
}

const KEYWORDS = /^<!--\s*keywords:\s*([\s\S]*?)-->\s*\n?/m;

/** Topics (file names without `.md`), their headings and keywords. */
export function listTopics(dir = referencesDir()): Topic[] {
  if (!dir) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const lines = text.split("\n");
      const first = lines.find((l) => l.startsWith("# "));
      const kw = KEYWORDS.exec(text)?.[1] ?? "";
      return {
        topic: f.slice(0, -3),
        title: first ? first.slice(2).trim() : f.slice(0, -3),
        covers: lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim()),
        keywords: kw.split(",").map((k) => k.trim()).filter(Boolean),
      };
    });
}

/** Words that say nothing about which topic is meant. */
const NOISE = new Set(["a", "an", "the", "of", "for", "and", "or", "to", "in", "on", "with", "me", "my", "i", "want", "please", "can", "you", "what", "which", "draw", "make", "create", "show", "how", "diagram", "diagrams", "chart", "notation", "recipe", "recipes"]);

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const stem = (w: string) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
const tokens = (s: string) => norm(s).split(" ").filter((w) => w && !NOISE.has(w)).map(stem);

export interface TopicMatch {
  topic: Topic;
  /** The `##` section that matched best, when one did. */
  section?: string;
  score: number;
}

/**
 * Ranks topics against a free-form query. A topic scores by its best phrase (a heading or
 * keyword), so a specific match ("uml class") beats several generic ones ("uml"): a phrase that
 * appears whole in the query counts by its length, a partly shared one a little.
 */
export function findTopics(query: string, topics = listTopics()): TopicMatch[] {
  const q = ` ${tokens(query).join(" ")} `;
  const qWords = new Set(q.trim().split(" ").filter(Boolean));
  if (!qWords.size) return [];
  const phrasesOf = (t: Topic): { text: string; section?: string; weight: number }[] => [
    { text: t.topic, weight: 3 },
    { text: t.title, weight: 1 },
    ...t.covers.map((c) => ({ text: c, section: c, weight: 2 })),
    ...t.keywords.map((k) => ({ text: k, weight: 2 })),
  ];
  // A word most topics share ("uml", "diagram") says less than one only a single topic has ("state").
  const df = new Map<string, number>();
  for (const t of topics) for (const w of new Set(phrasesOf(t).flatMap((p) => tokens(p.text)))) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => 1 / (df.get(w) ?? 1);
  const out: TopicMatch[] = [];
  for (const t of topics) {
    let top = 0;
    let sum = 0;
    let section: string | undefined;
    let best = 0;
    for (const p of phrasesOf(t)) {
      const words = tokens(p.text);
      if (!words.length) continue;
      const whole = q.includes(` ${words.join(" ")} `);
      const info = words.reduce((n, w) => n + idf(w), 0);
      const shared = words.filter((w) => qWords.has(w)).reduce((n, w) => n + idf(w), 0);
      const s = whole ? p.weight * (1 + info) : shared / words.length;
      top = Math.max(top, s);
      sum += s;
      if (p.section && s > best) [best, section] = [s, p.section];
    }
    // Ties on the best phrase go to the topic with more matches.
    const score = top + sum / 100;
    if (score > 0) out.push({ topic: t, section, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

const listing = (topics: Topic[]) =>
  topics.map((t) => `- ${t.topic}: ${t.title}${t.covers.length ? ` (sections: ${t.covers.join("; ")})` : ""}`).join("\n");

/** The topic list, with what each one covers, for the tool's no-argument call. */
export function topicIndex(dir = referencesDir()): string {
  const topics = listTopics(dir);
  if (!topics.length) return "The diagram reference files aren't installed with this copy of Local-first Excalidraw.";
  return `Topics (pass a topic name, or just describe the diagram, e.g. "uml class diagram"):\n${listing(topics)}`;
}

/**
 * One topic's Markdown, found by name or by description. Only files from listTopics are
 * read, so no path can escape the directory. A query that matches nothing returns the topic
 * list rather than an error, so the caller can pick from it.
 */
export function readTopic(query: string, dir = referencesDir()): string {
  const topics = listTopics(dir);
  if (!dir || !topics.length) return "The diagram reference files aren't installed with this copy of Local-first Excalidraw.";
  const want = norm(query).replace(/ /g, "-");
  const exact = topics.find((t) => t.topic === want);
  const ranked = exact ? [{ topic: exact, score: Infinity } as TopicMatch] : findTopics(query, topics);
  const hit = ranked[0];
  if (!hit) return `No reference topic matches "${query}". ${topicIndex(dir)}`;
  const text = fs.readFileSync(path.join(dir, `${hit.topic.topic}.md`), "utf8").replace(KEYWORDS, "");
  const notes: string[] = [];
  if (!exact) notes.push(`Best match for "${query}": ${hit.topic.topic}${hit.section ? `, section "${hit.section}"` : ""}.`);
  const others = ranked.slice(1, 3).filter((m) => m.score >= hit.score / 2);
  if (!exact && others.length) notes.push(`Also relevant: ${others.map((m) => m.topic.topic + (m.section ? ` ("${m.section}")` : "")).join(", ")}.`);
  return notes.length ? `(${notes.join(" ")})\n\n${text}` : text;
}
