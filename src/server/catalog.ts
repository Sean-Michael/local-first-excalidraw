/**
 * The public Excalidraw library catalog (github.com/excalidraw/excalidraw-libraries, MIT).
 * Fetched by the daemon only when the user opens the catalog or installs from it; nothing
 * else in the app talks to the network. Requests go to one fixed host and repository path.
 */
const BASE = "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main";
const TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;

export interface CatalogEntry {
  /** Path inside the repository's libraries/ folder, e.g. "youritjang/stick-figures.excalidrawlib". */
  source: string;
  name: string;
  description: string;
  authors: string[];
  downloads: number;
  updated?: string;
  itemNames?: string[];
  url: string;
}

let cached: { at: number; entries: CatalogEntry[] } | undefined;

async function get(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("Library is larger than 20 MB");
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("Library is larger than 20 MB");
  return text;
}

/** The catalog, most downloaded first. Cached for an hour. */
export async function fetchCatalog(): Promise<CatalogEntry[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.entries;
  const [libs, stats] = await Promise.all([get(`${BASE}/libraries.json`, 15_000), get(`${BASE}/stats.json`, 15_000).catch(() => "{}")]);
  const counts = JSON.parse(stats) as Record<string, { total?: number }>;
  const entries = (JSON.parse(libs) as any[])
    .filter((l) => typeof l?.source === "string" && /^[\w.-]+\/[\w.-]+\.excalidrawlib$/.test(l.source))
    .map((l): CatalogEntry => ({
      source: l.source,
      name: String(l.name ?? l.source),
      description: String(l.description ?? ""),
      authors: Array.isArray(l.authors) ? l.authors.map((a: any) => String(a?.name ?? "")).filter(Boolean) : [],
      downloads: counts[l.source.replace("/", "-").replace(/\.excalidrawlib$/, "")]?.total ?? 0,
      updated: typeof l.updated === "string" ? l.updated : undefined,
      itemNames: Array.isArray(l.itemNames) ? l.itemNames.map(String) : undefined,
      url: `https://github.com/excalidraw/excalidraw-libraries/blob/main/libraries/${l.source}`,
    }))
    .sort((a, b) => b.downloads - a.downloads);
  cached = { at: Date.now(), entries };
  return entries;
}

/** Downloads one catalog library. Only sources listed in the catalog are accepted. */
export async function fetchCatalogLibrary(source: string): Promise<{ entry: CatalogEntry; content: string }> {
  const entry = (await fetchCatalog()).find((e) => e.source === source);
  if (!entry) throw new Error(`"${source}" is not in the Excalidraw library catalog`);
  return { entry, content: await get(`${BASE}/libraries/${entry.source}`, 60_000) };
}
