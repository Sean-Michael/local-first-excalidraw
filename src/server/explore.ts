/**
 * Code exploration for the drawing assistant, on top of code.ts: a project overview, file
 * outlines and symbol lookup. Outlines come from small per-language regular expressions, not a
 * parser, so they find the declarations a diagram needs (classes, functions, types, routes)
 * and can miss unusual formatting. Same confinement as code.ts: read-only, inside the root,
 * no ignored or secret files.
 */
import fs from "node:fs";
import path from "node:path";
import { CodeError, isBinary, resolveInRoot, walk, type WalkEntry } from "./code.js";

const MAX_OUTLINE_BYTES = 512 * 1024;

export interface CodeSymbol {
  line: number;
  kind: string;
  name: string;
  /** 0 for top level, 1 for a member of a class or impl. */
  depth: number;
}

interface Rule {
  kind: string;
  re: RegExp;
  /** Only counts inside a class body (depth 1). */
  member?: boolean;
}

const JS_RULES: Rule[] = [
  { kind: "class", re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/ },
  { kind: "enum", re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: "function", re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/ },
  { kind: "const", re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
  { kind: "namespace", re: /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*\{/ },
  {
    kind: "method",
    member: true,
    re: /^\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*(?:\*\s*)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b|constructor\b)([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\((?!.*;\s*$)/,
  },
];

const RULES: Record<string, Rule[]> = {
  ts: JS_RULES,
  py: [
    { kind: "class", re: /^class\s+([A-Za-z_]\w*)/ },
    { kind: "function", re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: "method", member: true, re: /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: "const", re: /^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=/ },
  ],
  go: [
    { kind: "type", re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)?/ },
    { kind: "method", re: /^func\s+\([^)]*?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\)\s+([A-Za-z_]\w*)/ },
    { kind: "function", re: /^func\s+([A-Za-z_]\w*)/ },
    { kind: "const", re: /^(?:const|var)\s+([A-Za-z_]\w*)/ },
  ],
  rs: [
    { kind: "struct", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: "enum", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: "trait", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/ },
    { kind: "impl", re: /^impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)/ },
    { kind: "type", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/ },
    { kind: "mod", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/ },
    { kind: "function", re: /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: "method", member: true, re: /^\s+(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: "const", re: /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z_][A-Z0-9_]*)/ },
  ],
  java: [
    { kind: "class", re: /^\s*(?:(?:public|private|protected|abstract|final|static|sealed|open|data|internal|inner|enum|annotation)\s+)*(class|interface|enum|record|object)\s+([A-Za-z_]\w*)/ },
    { kind: "function", re: /^(?:(?:public|private|internal|suspend|inline|override)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/ },
    { kind: "method", member: true, re: /^\s+(?:(?:public|private|protected|internal|override|suspend|open|inline|operator)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/ },
    {
      kind: "method",
      member: true,
      re: /^\s+(?:@\w+\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|override|suspend|open|internal)\s+)+(?:fun\s+)?(?:<[^>]*>\s*)?(?:[\w<>[\],.?\s]+\s+)?([A-Za-z_]\w*)\s*\(/,
    },
  ],
  cs: [
    { kind: "namespace", re: /^\s*namespace\s+([\w.]+)/ },
    { kind: "class", re: /^\s*(?:(?:public|private|protected|internal|abstract|sealed|static|partial|readonly|ref)\s+)*(class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/ },
    {
      kind: "method",
      member: true,
      re: /^\s+(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|new)\s+)+[\w<>[\],.?\s]+?\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/,
    },
  ],
  rb: [
    { kind: "module", re: /^\s*module\s+([A-Z][\w:]*)/ },
    { kind: "class", re: /^\s*class\s+([A-Z][\w:]*)/ },
    { kind: "method", re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/ },
  ],
};

const LANG_OF: Record<string, keyof typeof RULES> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  py: "py", pyi: "py",
  go: "go",
  rs: "rs",
  java: "java", kt: "java", kts: "java", scala: "java",
  cs: "cs",
  rb: "rb",
};

/** Human names for the languages project_overview reports, by extension. */
const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin", scala: "Scala", cs: "C#", rb: "Ruby", php: "PHP",
  swift: "Swift", m: "Objective-C", c: "C", h: "C/C++ header", cc: "C++", cpp: "C++", hpp: "C++", ex: "Elixir", exs: "Elixir", erl: "Erlang",
  clj: "Clojure", hs: "Haskell", dart: "Dart", lua: "Lua", sh: "Shell", sql: "SQL", proto: "Protocol Buffers", graphql: "GraphQL", gql: "GraphQL",
  tf: "Terraform", vue: "Vue", svelte: "Svelte", html: "HTML", css: "CSS", scss: "SCSS", yaml: "YAML", yml: "YAML", md: "Markdown",
};

/** Route registrations, in any language: Express/Koa/Fastify, Flask/FastAPI, Go net/http, gin/echo/chi, Spring, ASP.NET, Rails. */
const ROUTE_RES = [
  /\b(?:app|router|server|api|http|r|e|g|mux|route|routes|fastify)\s*\.\s*(get|post|put|patch|delete|all|use|route|handle|handlefunc|GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc)\s*\(\s*["'`]([^"'`]+)["'`]/,
  /^\s*@(?:\w+\.)?(get|post|put|patch|delete|route|api_route|websocket)\s*\(\s*["']([^"']+)["']/i,
  /^\s*@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']/,
  /^\s*\[(Http(?:Get|Post|Put|Patch|Delete)|Route)\s*\(\s*"([^"]+)"/,
  /^\s*(get|post|put|patch|delete|resources?)\s+["':]([^"'\s,]+)/,
];

export function languageOf(file: string): keyof typeof RULES | undefined {
  return LANG_OF[path.extname(file).slice(1).toLowerCase()];
}

/** Top-level declarations, class members and routes in source text, in file order. */
export function outlineText(text: string, lang: keyof typeof RULES): CodeSymbol[] {
  const rules = RULES[lang];
  const out: CodeSymbol[] = [];
  const lines = text.split("\n");
  // The class/impl bodies we're in, innermost last, so members can be told from code inside
  // their bodies: a member sits at the indentation of the body's first line.
  const stack: { indent: number; member?: number }[] = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlockComment = true;
      continue;
    }
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || (trimmed.startsWith("#") && lang !== "ts")) continue;
    // A brace on its own line (C#, Java) opens the body above; it doesn't end anything.
    if (trimmed === "{") continue;
    const indent = line.length - line.trimStart().length;
    let closing = false;
    while (stack.length && indent <= stack[stack.length - 1].indent) {
      // `}` or `end` closes the body; a `)` continuing a declaration doesn't.
      if (/^\)/.test(trimmed)) break;
      stack.pop();
      closing ||= /^(}|\]|end\b)/.test(trimmed);
    }
    if (closing) continue;
    const container = stack[stack.length - 1];
    if (container && container.member === undefined) container.member = indent;
    for (const r of ROUTE_RES) {
      const m = r.exec(line);
      if (m && m[2].length < 200 && (m[2].startsWith("/") || lang === "rb")) {
        out.push({ line: i + 1, kind: "route", name: `${m[1].toUpperCase()} ${m[2]}`, depth: Math.min(stack.length, 1) });
        break;
      }
    }
    for (const r of rules) {
      if (r.member && (!container || indent !== container.member)) continue;
      if (!r.member && container && lang !== "rb" && lang !== "cs" && lang !== "java") continue;
      const m = r.re.exec(line);
      if (!m) continue;
      // Rules with two groups capture a keyword first (class|interface…) or a receiver (Go methods).
      let kind = r.kind;
      let name = m[1];
      if (m[2]) {
        if (lang === "go") name = `${m[1]}.${m[2]}`;
        else {
          kind = m[1];
          name = m[2];
        }
      }
      if (!name || /^(if|for|while|switch|catch|return|else|do|try)$/.test(name)) continue;
      const depth = container && (r.member || indent > container.indent) ? 1 : 0;
      out.push({ line: i + 1, kind, name, depth });
      // Namespaces and modules don't make their contents members.
      if (/^(class|interface|struct|enum|record|object|impl|trait)$/.test(kind) && !/;\s*$/.test(trimmed)) stack.push({ indent });
      break;
    }
  }
  return out;
}

function readText(abs: string): string | undefined {
  try {
    if (fs.statSync(abs).size > MAX_OUTLINE_BYTES) return undefined;
    const buf = fs.readFileSync(abs);
    return isBinary(buf) ? undefined : buf.toString("utf8");
  } catch {
    return undefined;
  }
}

/** outline_file: a file's symbols as `line  kind name`, members indented. */
export function outlineFile(root: string, file: string): string {
  const { abs, rel } = resolveInRoot(root, file);
  if (fs.statSync(abs).isDirectory()) throw new CodeError(`${rel} is a directory; use project_overview with dir`);
  const lang = languageOf(rel);
  if (!lang) throw new CodeError(`No outline for ${path.extname(rel) || "this kind of"} file; read it with read_file`);
  const text = readText(abs);
  if (text === undefined) throw new CodeError(`${rel} is binary or larger than 512 KB; read part of it with read_file`);
  const syms = outlineText(text, lang);
  const total = text.split("\n").length;
  if (!syms.length) return `${rel} (${total} lines): no declarations found; read it with read_file.`;
  const body = syms.map((s) => `${String(s.line).padStart(5)}  ${"  ".repeat(s.depth)}${s.kind} ${s.name}`).join("\n");
  return `${rel} (${total} lines, ${syms.length} symbols)\n${body}`;
}

export interface SymbolHit extends CodeSymbol {
  rel: string;
  /** The line the symbol ends on, approximately: the line before the next symbol at its depth or above. */
  end: number;
  score: number;
}

const IDENT = /^[A-Za-z_$#][\w$]*(?:[.:#]{1,2}[A-Za-z_$][\w$]*)?[?!]?$/;
const KIND_RANK: Record<string, number> = { class: 0, interface: 0, struct: 0, trait: 0, type: 1, enum: 1, record: 1, object: 1, module: 1, function: 2, impl: 3, method: 3, const: 4, route: 5 };

/**
 * Definitions of a symbol across the project, best first: exact-case names, then types and
 * classes before functions, then a file named after the symbol. `Class.method` narrows to
 * that class's member.
 */
export function findDefinitions(
  root: string,
  query: string,
  opts: { dir?: string; glob?: (rel: string) => boolean; limit?: number; /** Names starting with the query also match (the mention picker). */ prefix?: boolean } = {},
): SymbolHit[] {
  if (!IDENT.test(query)) throw new CodeError("Give a symbol name such as OrderRepository, placeOrder or OrderRepository.markPaid");
  const realRoot = fs.realpathSync.native(root);
  const start = resolveInRoot(realRoot, opts.dir ?? ".").abs;
  const parts = query.replace(/[?!]$/, "").split(/[.:#]+/);
  const name = parts[parts.length - 1];
  const parent = parts.length > 1 ? parts[0] : undefined;
  const lower = name.toLowerCase();
  const hits: SymbolHit[] = [];
  for (const f of walk(realRoot, start)) {
    const lang = languageOf(f.rel);
    if (!lang || (opts.glob && !opts.glob(f.rel))) continue;
    const text = readText(f.abs);
    if (!text || !text.toLowerCase().includes(lower)) continue;
    const syms = outlineText(text, lang);
    const total = text.split("\n").length;
    syms.forEach((s, i) => {
      const short = s.name.split(".").pop()!;
      const shortLower = short.toLowerCase();
      if (shortLower !== lower && !(opts.prefix && shortLower.startsWith(lower) && s.kind !== "route")) return;
      let owner: string | undefined;
      for (let j = i - 1; j >= 0 && s.depth > 0; j--) if (syms[j].depth < s.depth) {
        owner = syms[j].name;
        break;
      }
      if (lang === "go" && s.name.includes(".")) owner = s.name.split(".")[0];
      if (parent && owner?.toLowerCase() !== parent.toLowerCase()) return;
      const next = syms.slice(i + 1).find((n) => n.depth <= s.depth);
      const base = path.basename(f.rel).replace(/\.[^.]+$/, "").toLowerCase().replace(/[-_]/g, "");
      const score =
        (short === name ? 0 : shortLower === lower ? 10 : 20) +
        (KIND_RANK[s.kind] ?? 3) +
        (base === lower.replace(/[-_]/g, "") ? -1 : 0) +
        (/(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\./.test(f.rel) ? 5 : 0) +
        (/\.d\.ts$/.test(f.rel) ? 3 : 0);
      hits.push({ ...s, name: owner && !s.name.includes(".") ? `${owner}.${s.name}` : s.name, rel: f.rel, end: next ? Math.max(s.line, next.line - 1) : total, score });
    });
  }
  hits.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length || a.line - b.line);
  return hits.slice(0, opts.limit ?? 20);
}

/** Lines that mention the symbol as a whole word, outside its definitions. */
const DRAWING = /\.excalidraw(lib)?(\.(svg|png))?$/i;

function findReferences(root: string, start: string, name: string, skip: Set<string>, max: number): { lines: string[]; more: boolean } {
  const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
  const lines: string[] = [];
  for (const f of walk(root, start) as Generator<WalkEntry>) {
    // A drawing names its nodes after the code; a match there is the diagram, not a use.
    if (DRAWING.test(f.rel)) continue;
    const text = readText(f.abs);
    if (!text || !text.includes(name)) continue;
    const all = text.split("\n");
    for (let i = 0; i < all.length; i++) {
      if (!word.test(all[i]) || skip.has(`${f.rel}:${i + 1}`)) continue;
      if (lines.length >= max) return { lines, more: true };
      const t = all[i].trim();
      lines.push(`${f.rel}:${i + 1}: ${t.length > 200 ? `${t.slice(0, 200)}…` : t}`);
    }
  }
  return { lines, more: false };
}

/** find_symbol: where a symbol is defined, with its signature line, and optionally where it is used. */
export function findSymbol(root: string, opts: { name: string; references?: boolean; dir?: string; max_references?: number }): string {
  const realRoot = fs.realpathSync.native(root);
  const defs = findDefinitions(realRoot, opts.name, { dir: opts.dir, limit: 15 });
  const out: string[] = [];
  if (!defs.length) out.push(`No definition of ${opts.name} found. Try search_files with the name, or a different spelling.`);
  else {
    out.push(`Definitions of ${opts.name} (best first):`);
    for (const d of defs) {
      const text = readText(path.join(realRoot, d.rel));
      const sig = text?.split("\n")[d.line - 1]?.trim() ?? "";
      out.push(`${d.rel}:${d.line}-${d.end}  ${d.kind} ${d.name}  ${sig.length > 160 ? `${sig.slice(0, 160)}…` : sig}`);
    }
    out.push("Read one with read_file and start_line/end_line.");
  }
  if (opts.references) {
    const name = opts.name.split(/[.:#]+/).pop()!.replace(/[?!]$/, "");
    const start = resolveInRoot(realRoot, opts.dir ?? ".").abs;
    const refs = findReferences(realRoot, start, name, new Set(defs.map((d) => `${d.rel}:${d.line}`)), Math.min(opts.max_references ?? 60, 200));
    out.push("", refs.lines.length ? `References (${refs.lines.length}${refs.more ? "+" : ""}):` : "No references found.");
    out.push(...refs.lines);
    if (refs.more) out.push("… more references (narrow with dir)");
  }
  return out.join("\n");
}

// ---- project overview -------------------------------------------------------------------------

const MANIFESTS: [RegExp, string][] = [
  [/^package\.json$/, "npm package"],
  [/^(pnpm-workspace\.yaml|lerna\.json|nx\.json|turbo\.json)$/, "JS monorepo"],
  [/^go\.mod$/, "Go module"],
  [/^(pyproject\.toml|setup\.py|setup\.cfg|requirements(-\w+)?\.txt|Pipfile)$/, "Python project"],
  [/^Cargo\.toml$/, "Rust crate"],
  [/^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/, "JVM build"],
  [/\.(csproj|fsproj|sln)$/, ".NET project"],
  [/^Gemfile$/, "Ruby bundle"],
  [/^composer\.json$/, "PHP package"],
  [/^(mix\.exs|Package\.swift|pubspec\.yaml|deno\.jsonc?)$/, "package manifest"],
  [/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/, "Docker Compose"],
  [/^(Dockerfile|Containerfile)(\..+)?$|\.Dockerfile$/, "Dockerfile"],
  [/^(Chart\.yaml|kustomization\.ya?ml|skaffold\.ya?ml|Tiltfile)$/, "Kubernetes"],
  [/\.proto$/, "protobuf"],
  [/\.(graphql|gql)$/, "GraphQL schema"],
  [/^(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i, "OpenAPI"],
  [/\.tf$/, "Terraform"],
  [/^(serverless\.ya?ml|template\.ya?ml|samconfig\.toml|cdk\.json|fly\.toml|vercel\.json|netlify\.toml|app\.ya?ml|Procfile)$/, "deployment config"],
  [/^Makefile$/, "Makefile"],
];

const ENTRY_POINTS = [
  /(^|\/)(main|index|server|app|cli)\.(ts|js|mjs|tsx)$/,
  /(^|\/)main\.go$/,
  /(^|\/)(__main__|main|app|manage|wsgi|asgi|server)\.py$/,
  /(^|\/)src\/(main|lib)\.rs$/,
  /(^|\/)Program\.cs$/,
  /(^|\/)\w*Application\.(java|kt)$/,
  /(^|\/)config\.ru$/,
];

/** Service names from a Compose file: the keys directly under `services:`. */
function composeServices(text: string): string[] {
  const out: string[] = [];
  let inServices = false;
  let indent = -1;
  for (const line of text.split("\n")) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line)) break;
    const m = /^(\s+)([\w.-]+):\s*(#.*)?$/.exec(line);
    if (!m) continue;
    if (indent < 0) indent = m[1].length;
    if (m[1].length === indent) out.push(m[2]);
  }
  return out;
}

/** What a YAML or JSON file describes, judged from its first few KB: Kubernetes kinds or OpenAPI. */
function sniffConfig(abs: string): string | undefined {
  let head: string;
  try {
    const fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch {
    return undefined;
  }
  if (/^\s*["']?(openapi|swagger)["']?\s*:/m.test(head)) return "OpenAPI";
  if (/^apiVersion:\s*\S+/m.test(head)) {
    const kinds = [...new Set([...head.matchAll(/^kind:\s*(\w+)/gm)].map((m) => m[1]))];
    if (kinds.length) return `Kubernetes ${kinds.slice(0, 4).join(", ")}`;
  }
  return undefined;
}

function readmeHeadline(abs: string): string | undefined {
  const text = readText(abs);
  if (!text) return undefined;
  const lines = text.split("\n").map((l) => l.trim());
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, "");
  const para = lines.find((l) => l && !/^(#|!\[|\[!\[|<|```|---|\||>)/.test(l));
  const s = [title, para].filter(Boolean).join(": ");
  return s ? (s.length > 300 ? `${s.slice(0, 300)}…` : s) : undefined;
}

export interface OverviewOptions {
  dir?: string;
  /** Directory levels shown in the tree (default 3). */
  depth?: number;
}

/**
 * project_overview: a compact map of the project (or one folder) for deciding where to look:
 * a tree with file counts, languages, manifests and deployment files, entry points, the
 * README's headline and existing drawings.
 */
export function projectOverview(root: string, opts: OverviewOptions = {}): string {
  const realRoot = fs.realpathSync.native(root);
  const { abs: start, rel: startRel } = resolveInRoot(realRoot, opts.dir ?? ".");
  if (!fs.statSync(start).isDirectory()) throw new CodeError(`${startRel} is a file; use outline_file or read_file`);
  const depth = Math.max(1, Math.min(opts.depth ?? 3, 6));
  const prefix = startRel === "." ? "" : `${startRel}/`;

  const dirCounts = new Map<string, number>();
  const langs = new Map<string, number>();
  const manifests: string[] = [];
  const entries: string[] = [];
  const drawings: string[] = [];
  const sniffed: string[] = [];
  const topFiles: string[] = [];
  let files = 0;
  let sniffBudget = 300;
  let readme: string | undefined;
  let readmeDepth = Infinity;

  for (const f of walk(realRoot, start)) {
    files++;
    const sub = f.rel.slice(prefix.length);
    const parts = sub.split("/");
    // Count the file in each ancestor directory down to the tree's depth.
    for (let i = 1; i < parts.length && i <= depth; i++) {
      const d = parts.slice(0, i).join("/");
      dirCounts.set(d, (dirCounts.get(d) ?? 0) + 1);
    }
    const base = parts[parts.length - 1];
    const ext = path.extname(base).slice(1).toLowerCase();
    if (ext === "excalidraw") {
      drawings.push(f.rel);
      continue;
    }
    if (parts.length === 1) topFiles.push(base);
    const lang = LANGUAGE_NAMES[ext];
    if (lang && !["Markdown", "YAML"].includes(lang)) langs.set(lang, (langs.get(lang) ?? 0) + 1);
    const manifest = MANIFESTS.find(([re]) => re.test(base));
    if (manifest) {
      let note = manifest[1];
      if (base === "package.json") {
        const name = /"name"\s*:\s*"([^"]+)"/.exec(readText(f.abs) ?? "")?.[1];
        if (name) note += ` ${name}`;
      } else if (manifest[1] === "Docker Compose") {
        const services = composeServices(readText(f.abs) ?? "");
        if (services.length) note += `: services ${services.join(", ")}`;
      }
      manifests.push(`${f.rel} (${note})`);
    } else if ((ext === "yaml" || ext === "yml" || ext === "json") && sniffBudget-- > 0) {
      const kind = sniffConfig(f.abs);
      if (kind) sniffed.push(`${f.rel} (${kind})`);
    }
    if (ENTRY_POINTS.some((re) => re.test(f.rel)) && parts.length <= 4) entries.push(f.rel);
    if (/^readme(\.\w+)?$/i.test(base) && parts.length < readmeDepth) {
      readmeDepth = parts.length;
      readme = f.rel;
    }
  }

  const out: string[] = [`${startRel === "." ? "Project" : startRel} — ${files} files (ignored, vendored and secret files left out)`];
  if (readme) {
    const h = readmeHeadline(path.join(realRoot, readme));
    if (h) out.push(`README (${readme}): ${h}`);
  }
  if (langs.size) {
    out.push(`Languages: ${[...langs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, n]) => `${l} ${n}`).join(", ")}`);
  }
  const cap = <T>(xs: T[], n: number, label: string) => (xs.length > n ? [...xs.slice(0, n), `… ${xs.length - n} more ${label}` as T] : xs);
  if (manifests.length || sniffed.length) {
    out.push("", "Manifests and deployment:");
    out.push(...cap([...manifests, ...sniffed].sort(), 40, "files").map((m) => `  ${m}`));
  }
  if (entries.length) out.push("", "Likely entry points:", ...cap(entries.sort(), 25, "files").map((e) => `  ${e}`));
  out.push("", `Tree (directories to depth ${depth}, with file counts):`);
  const dirs = [...dirCounts.keys()].sort();
  const tree = dirs.map((d) => `${"  ".repeat(d.split("/").length)}${d.split("/").pop()}/ (${dirCounts.get(d)})`);
  out.push(...cap(tree, 150, "directories (raise dir or lower depth)"));
  if (topFiles.length) out.push(`  files here: ${cap(topFiles.sort(), 30, "").join(", ")}`);
  out.push("", drawings.length ? `Drawings: ${cap(drawings.sort(), 20, "drawings").join(", ")}` : "Drawings: none yet");
  out.push("", "Next: outline_file or find_symbol for the key names, search_files to trace calls, then read_file for the few files that matter.");
  return out.join("\n");
}
