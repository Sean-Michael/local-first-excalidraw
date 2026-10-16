/**
 * Deterministic graders over .excalidraw JSON. Pure functions: everything they need (the
 * final scene, the baseline, the project's file list) is passed in, so saved results can be
 * re-graded later without re-running the agent.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type El, measureText } from "../src/server/scene.js";
import type { Checks, Synonyms } from "./scenarios.js";

export interface SceneLike {
  elements: El[];
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Grade {
  pass: boolean;
  /** Passed checks / all checks. */
  score: number;
  checks: CheckResult[];
  metrics: Metrics;
  baselineMetrics?: Metrics;
}

export interface Metrics {
  elements: number;
  shapes: number;
  arrows: number;
  boundArrows: number;
  boundRatio: number;
  overlaps: string[];
  overflow: string[];
  minFontSize: number | null;
  nonFinite: string[];
  texts: string[];
  edges: { from: string; to: string; bidirectional: boolean }[];
  links: { id: string; link: string }[];
}

const SHAPES = new Set(["rectangle", "ellipse", "diamond", "image"]);
const LINEAR = new Set(["arrow", "line"]);

const live = (els: El[]) => els.filter((e) => e && !e.isDeleted);

// ---- label matching ---------------------------------------------------------------------------

const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const squash = (s: string) => words(s).replace(/ /g, "");

/** Case- and punctuation-insensitive substring match against any synonym. */
export function matches(text: string, syns: Synonyms): boolean {
  const w = ` ${words(text)} `;
  const sq = squash(text);
  return syns.some((s) => {
    const sw = words(s);
    return !!sw && (w.includes(` ${sw} `) || w.includes(` ${sw}`) || sq.includes(squash(s)));
  });
}

/** The text that names each element: its bound label, a frame's name, or its group's caption. */
export function labelIndex(els: El[]): Map<string, string> {
  const all = live(els);
  const out = new Map<string, string>();
  const byGroup = new Map<string, string[]>();
  for (const e of all) {
    if (e.type === "text" && !e.containerId) {
      for (const g of e.groupIds ?? []) byGroup.set(g, [...(byGroup.get(g) ?? []), e.text ?? ""]);
    }
  }
  for (const e of all) {
    if (e.type === "text") {
      out.set(e.id, e.text ?? "");
      if (e.containerId) out.set(e.containerId, [out.get(e.containerId), e.text].filter(Boolean).join(" "));
    } else if (e.type === "frame" && e.name) out.set(e.id, e.name);
  }
  for (const e of all) {
    if (out.get(e.id) || e.type === "text") continue;
    // Library icons: the caption is a free text element in the same (innermost) group.
    const g = (e.groupIds ?? [])[0];
    const caps = g ? byGroup.get(g) : undefined;
    if (caps?.length) out.set(e.id, caps.join(" "));
  }
  return out;
}

// ---- geometry -------------------------------------------------------------------------------

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const box = (e: El): Box => ({ x0: e.x, y0: e.y, x1: e.x + e.width, y1: e.y + e.height });
const inter = (a: Box, b: Box) => ({ w: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h: Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) });
const contains = (a: Box, b: Box, tol = 1) => a.x0 - tol <= b.x0 && a.y0 - tol <= b.y0 && a.x1 + tol >= b.x1 && a.y1 + tol >= b.y1;
const sameGroup = (a: El, b: El) => (a.groupIds ?? []).some((g: string) => (b.groupIds ?? []).includes(g));

/**
 * Pairs that collide: shapes overlapping partially, free text crossing a shape's border, and
 * free text on free text. A shape fully inside another is a deliberate container, not a
 * collision; elements of the same group (library icons) are one thing.
 */
export function overlaps(els: El[]): string[] {
  const all = live(els);
  const shapes = all.filter((e) => SHAPES.has(e.type));
  const texts = all.filter((e) => e.type === "text" && !e.containerId);
  const out: string[] = [];
  const hit = (a: El, b: El, partialOnly: boolean) => {
    if (sameGroup(a, b)) return;
    const ba = box(a);
    const bb = box(b);
    const i = inter(ba, bb);
    if (i.w <= 2 || i.h <= 2) return;
    if (partialOnly && (contains(ba, bb) || contains(bb, ba))) return;
    out.push(`${a.id}~${b.id}`);
  };
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) hit(shapes[i], shapes[j], true);
  for (const t of texts) for (const s of shapes) hit(t, s, true);
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) hit(texts[i], texts[j], false);
  return out;
}

/** Excalidraw fits bound text in the inscribed box: ~70% of an ellipse, half a diamond. */
const INNER: Record<string, number> = { ellipse: 0.7, diamond: 0.5 };
const PAD = 5;

/** Labels whose estimated size doesn't fit inside their container. */
export function textOverflow(els: El[]): string[] {
  const all = live(els);
  const byId = new Map(all.map((e) => [e.id, e]));
  const out: string[] = [];
  for (const t of all) {
    if (t.type !== "text" || !t.containerId) continue;
    const c = byId.get(t.containerId);
    if (!c || LINEAR.has(c.type)) continue;
    const f = INNER[c.type] ?? 1;
    const m = measureText(String(t.text ?? ""), Number(t.fontSize) || 20, Number(t.fontFamily) || 5);
    const tol = 4;
    if (m.width > c.width * f - 2 * PAD + tol || m.height > c.height * f - 2 * PAD + tol) out.push(`${t.containerId}: "${String(t.text).slice(0, 40)}"`);
  }
  return out;
}

/** Elements with a NaN or infinite coordinate, size or point. */
export function nonFinite(els: El[]): string[] {
  const bad: string[] = [];
  for (const e of live(els)) {
    const nums = [e.x, e.y, e.width, e.height, ...((e.points as number[][] | undefined) ?? []).flat()];
    if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) bad.push(e.id);
  }
  return bad;
}

export function measure(scene: SceneLike): Metrics {
  const all = live(scene.elements ?? []);
  const labels = labelIndex(all);
  const arrows = all.filter((e) => e.type === "arrow");
  const ids = new Set(all.map((e) => e.id));
  const bound = arrows.filter((a) => ids.has(a.startBinding?.elementId) && ids.has(a.endBinding?.elementId));
  const fonts = all.filter((e) => e.type === "text" && typeof e.fontSize === "number").map((e) => e.fontSize as number);
  return {
    elements: all.length,
    shapes: all.filter((e) => SHAPES.has(e.type)).length,
    arrows: arrows.length,
    boundArrows: bound.length,
    boundRatio: arrows.length ? bound.length / arrows.length : 1,
    overlaps: overlaps(all),
    overflow: textOverflow(all),
    minFontSize: fonts.length ? Math.min(...fonts) : null,
    nonFinite: nonFinite(all),
    texts: [...all.filter((e) => e.type === "text").map((e) => String(e.text ?? "")), ...all.filter((e) => e.type === "frame" && e.name).map((e) => String(e.name))],
    edges: bound.map((a) => ({
      from: labels.get(a.startBinding.elementId) ?? "",
      to: labels.get(a.endBinding.elementId) ?? "",
      bidirectional: !!a.startArrowhead && !!a.endArrowhead,
    })),
    links: all.filter((e) => typeof e.link === "string" && e.link && !(e.type === "text" && e.containerId)).map((e) => ({ id: e.id, link: e.link as string })),
  };
}

// ---- links and ids --------------------------------------------------------------------------

/**
 * The project-relative file a link points at, or null for web links. Accepts relative paths,
 * absolute paths, file:// and vscode://file/ URLs, with optional #L12 or :12:3 suffixes.
 */
export function linkTarget(link: string, projectRoot: string): string | null {
  let p = link.trim();
  if (/^vscode:\/\/file\//i.test(p)) p = p.replace(/^vscode:\/\/file/i, "");
  else if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p.replace(/#.*$/, ""));
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null;
  p = p.replace(/#.*$/, "").replace(/(:\d+){1,2}$/, "");
  const abs = path.resolve(projectRoot, p);
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** Ids worth keeping across an edit: everything except labels (which belong to their container). */
const keyIds = (els: El[]) => live(els).filter((e) => !(e.type === "text" && e.containerId)).map((e) => e.id);

export function idPreservation(baseline: SceneLike, final: SceneLike): { ratio: number; lost: string[] } {
  const before = keyIds(baseline.elements);
  const after = new Set(keyIds(final.elements));
  const lost = before.filter((id) => !after.has(id));
  return { ratio: before.length ? (before.length - lost.length) / before.length : 1, lost };
}

// ---- grading --------------------------------------------------------------------------------

export interface GradeInput {
  final: SceneLike | null;
  baseline?: SceneLike | null;
  checks: Checks;
  /** Project root the links resolve against (only used to normalise absolute links). */
  projectRoot: string;
  /** Project-relative paths of the files in the project after the run. */
  projectFiles: Set<string>;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const list = (xs: string[], n = 5) => (xs.length ? `: ${xs.slice(0, n).join(", ")}${xs.length > n ? `, … (${xs.length})` : ""}` : "");

export function grade(input: GradeInput): Grade {
  const { checks: c } = input;
  const out: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail: string) => out.push({ name, pass, detail });

  if (!input.final) {
    add("drawing", false, "no drawing was produced");
    return { pass: false, score: 0, checks: out, metrics: measure({ elements: [] }) };
  }
  const m = measure(input.final);
  const base = input.baseline ? measure(input.baseline) : undefined;
  const texts = m.texts;

  add("finite", m.nonFinite.length === 0, `${m.nonFinite.length} elements with NaN/Infinity${list(m.nonFinite)}`);

  if (c.requiredLabels) {
    const missing = c.requiredLabels.filter((syn) => !texts.some((t) => matches(t, syn))).map((s) => s[0]);
    add("required-labels", missing.length === 0, `${c.requiredLabels.length - missing.length}/${c.requiredLabels.length} present${missing.length ? `; missing ${missing.join(", ")}` : ""}`);
  }
  if (c.forbiddenLabels) {
    const found = c.forbiddenLabels.filter((f) => texts.some((t) => matches(t, [f])));
    add("forbidden-labels", found.length === 0, found.length ? `still present: ${found.join(", ")}` : "none present");
  }
  if (c.requiredEdges) {
    const missing = c.requiredEdges.filter(
      (e) =>
        !m.edges.some(
          (a) =>
            (matches(a.from, e.from) && matches(a.to, e.to)) ||
            ((e.undirected || a.bidirectional) && matches(a.from, e.to) && matches(a.to, e.from)),
        ),
    );
    add(
      "required-edges",
      missing.length === 0,
      `${c.requiredEdges.length - missing.length}/${c.requiredEdges.length} present${missing.length ? `; missing ${missing.map((e) => `${e.from[0]}->${e.to[0]}`).join(", ")}` : ""}`,
    );
  }
  if (c.minShapes !== undefined) add("min-shapes", m.shapes >= c.minShapes, `${m.shapes} shapes (min ${c.minShapes})`);
  if (c.minArrows !== undefined) add("min-arrows", m.arrows >= c.minArrows, `${m.arrows} arrows (min ${c.minArrows})`);
  if (c.minBoundRatio !== undefined) {
    add("bound-arrows", m.boundRatio >= c.minBoundRatio, `${m.boundArrows}/${m.arrows} bound at both ends (min ${fmt(c.minBoundRatio * 100)}%)`);
  }
  if (c.maxOverlaps !== undefined) add("overlaps", m.overlaps.length <= c.maxOverlaps, `${m.overlaps.length} overlapping pairs (max ${c.maxOverlaps})${list(m.overlaps)}`);
  if (c.maxOverflow !== undefined) add("text-fit", m.overflow.length <= c.maxOverflow, `${m.overflow.length} labels overflow (max ${c.maxOverflow})${list(m.overflow, 3)}`);
  if (c.minFontSize !== undefined) {
    add("min-font", m.minFontSize === null || m.minFontSize >= c.minFontSize, `smallest text ${m.minFontSize ?? "-"}px (min ${c.minFontSize})`);
  }

  if (c.minIdPreservation !== undefined) {
    if (!input.baseline) add("id-preservation", false, "no baseline to compare with");
    else {
      const p = idPreservation(input.baseline, input.final);
      add("id-preservation", p.ratio >= c.minIdPreservation, `${fmt(p.ratio * 100)}% of baseline ids kept (min ${fmt(c.minIdPreservation * 100)}%)${p.lost.length ? `; lost${list(p.lost)}` : ""}`);
    }
  }

  if (c.preserve) {
    const now = new Map(live(input.final.elements).map((e) => [e.id, e]));
    const was = new Map(live(input.baseline?.elements ?? []).map((e) => [e.id, e]));
    const problems: string[] = [];
    for (const id of c.preserve.ids ?? []) {
      const a = was.get(id);
      const b = now.get(id);
      if (!a) problems.push(`${id} not in baseline`);
      else if (!b) problems.push(`${id} deleted`);
      else {
        for (const p of c.preserve.props ?? []) {
          const same = typeof a[p] === "number" && typeof b[p] === "number" ? Math.abs(a[p] - b[p]) <= 1 : JSON.stringify(a[p]) === JSON.stringify(b[p]);
          if (!same) problems.push(`${id}.${p} ${JSON.stringify(a[p])} -> ${JSON.stringify(b[p])}`);
        }
      }
    }
    for (const t of c.preserve.texts ?? []) if (!texts.some((x) => x.includes(t))) problems.push(`text "${t}" gone`);
    add("user-edits", problems.length === 0, problems.length ? problems.slice(0, 6).join("; ") : "all preserved");
  }

  if (c.links) {
    const shapes = m.links;
    const broken = shapes.filter((l) => {
      const t = linkTarget(l.link, input.projectRoot);
      // A link to a directory counts when some file lives under it.
      return !t || (!input.projectFiles.has(t) && ![...input.projectFiles].some((f) => f.startsWith(t + "/")));
    });
    const ok = shapes.length - broken.length;
    const minOk = c.links.minLinked === undefined || ok >= c.links.minLinked;
    const allOk = !c.links.allExist || broken.length === 0;
    add("links", minOk && allOk, `${ok} links to existing files${c.links.minLinked !== undefined ? ` (min ${c.links.minLinked})` : ""}, ${broken.length} broken${list(broken.map((b) => b.link), 3)}`);
  }

  if (c.improve) {
    if (!base) add("improves", false, "no baseline to compare with");
    else {
      const worse: string[] = [];
      if (c.improve.overlaps && !(m.overlaps.length < base.overlaps.length || m.overlaps.length === 0)) worse.push(`overlaps ${base.overlaps.length} -> ${m.overlaps.length}`);
      if (c.improve.boundRatio && !(m.boundRatio > base.boundRatio || m.boundRatio === 1)) worse.push(`bound ${fmt(base.boundRatio)} -> ${fmt(m.boundRatio)}`);
      if (c.improve.minFontSize && !((m.minFontSize ?? 0) > (base.minFontSize ?? 0))) worse.push(`min font ${base.minFontSize} -> ${m.minFontSize}`);
      if (c.improve.overflow && !(m.overflow.length < base.overflow.length || m.overflow.length === 0)) worse.push(`overflow ${base.overflow.length} -> ${m.overflow.length}`);
      add(
        "improves",
        worse.length === 0,
        worse.length
          ? `not improved: ${worse.join(", ")}`
          : `overlaps ${base.overlaps.length} -> ${m.overlaps.length}, bound ${fmt(base.boundRatio)} -> ${fmt(m.boundRatio)}, min font ${base.minFontSize} -> ${m.minFontSize}`,
      );
    }
  }

  const passed = out.filter((x) => x.pass).length;
  return { pass: passed === out.length, score: out.length ? passed / out.length : 0, checks: out, metrics: m, baselineMetrics: base };
}
