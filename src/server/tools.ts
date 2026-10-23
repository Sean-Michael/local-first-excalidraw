/**
 * Drawing tools, defined once and used by both the MCP server (over the daemon's HTTP API)
 * and the in-app assistant (in-process). Each tool is a zod input shape plus a handler over
 * a small context, so the two front ends can't drift apart.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./config.js";
import { listFiles, readFile, searchFiles } from "./code.js";
import { findSymbol, outlineFile, projectOverview } from "./explore.js";
import { gitChanges } from "./git-changes.js";
import { GUIDE } from "./guide.js";
import { RELATIONS, type Relation } from "./layout.js";
import { type LibraryShape, searchShapes, slug } from "./library.js";
import { readTopic, topicIndex } from "./references.js";
import { normalizeUpdates } from "./scene.js";
import { resolveSafePath } from "./security.js";

export const DEFAULT_DIR = process.env.LFX_DEFAULT_DIR ?? "docs/diagrams";

export interface ToolOutput {
  text: string;
  image?: { data: string; mime: string };
  /** Absolute path of a drawing the call created or changed. */
  drawing?: string;
}

export interface ToolContext {
  projectRoot: string;
  /** The drawing the user has open (assistant only); tools default to it. */
  currentDrawing?: string;
  op(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Like op, for operations that need an editor tab (render, mermaid). */
  withEditor(file: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(root: string): Promise<{ path: string; mtime: number; size: number }[]>;
  /** Opens a drawing for the user (MCP only). */
  open?(file: string): Promise<string>;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  readOnly?: boolean;
  destructive?: boolean;
  /** Fixes common mistakes in raw arguments before validation; returns a note for each fix. */
  normalize?(args: Record<string, unknown>): string[];
  run(args: any, ctx: ToolContext): Promise<ToolOutput>;
}

const color = z
  .string()
  .optional()
  .describe("Palette name (blue, cyan, teal, green, yellow, orange, red, pink, violet, gray, black)");

const label = z
  .union([z.string(), z.looseObject({ text: z.string(), fontSize: z.number().optional(), strokeColor: z.string().optional() })])
  .optional()
  .describe("Centred text inside a shape or on an arrow");

const skeleton = z
  .looseObject({
    type: z.string().describe("rectangle | ellipse | diamond | text | arrow | line | frame (or any raw Excalidraw type)"),
    id: z.string().optional().describe("Your own id, so arrows/frames/updates can refer to it"),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    text: z.string().optional().describe("For text elements"),
    label,
    color,
    rounded: z.boolean().optional(),
    start: z.object({ id: z.string() }).optional().describe("Arrow: bind start to this element id"),
    end: z.object({ id: z.string() }).optional().describe("Arrow: bind end to this element id"),
    points: z.array(z.tuple([z.number(), z.number()])).optional(),
    name: z.string().optional().describe("Frame title"),
    children: z.array(z.string()).optional().describe("Frame: ids to put inside"),
    code: z.string().optional().describe('Shape: project file it stands for, optionally with a line ("src/orders/repo.ts" or "src/orders/repo.ts:42"); stored as a code link'),
  })
  .describe("Simplified Excalidraw element; any raw Excalidraw property is also accepted");

const arrowhead = z
  .enum(["arrow", "bar", "dot", "circle", "circle_outline", "triangle", "triangle_outline", "diamond", "diamond_outline", "crowfoot_one", "crowfoot_many", "crowfoot_one_or_many"])
  .nullable()
  .optional();

const ifRev = z
  .string()
  .optional()
  .describe("The rev read_drawing returned. The write fails, changing nothing, if the drawing changed since (for example the user edited it)");

const updateItem = z.looseObject({
  id: z.string(),
  label: z.union([label, z.null()]),
  text: z.string().optional(),
  color,
  code: z.union([z.string(), z.null()]).optional().describe("Project file (and :line) this element stands for; null removes the link"),
});

/** " Rev abc123." for a write's result, plus any notes the daemon made. */
function after(r: Record<string, unknown>, notes: string[] = []): string {
  const all = [...notes, ...((r.notes as string[] | undefined) ?? [])];
  return (r.contentRev ? ` Rev ${String(r.contentRev)}.` : "") + (all.length ? `\nNotes:\n- ${all.join("\n- ")}` : "");
}

const PATH_HELP =
  'Drawing path, relative to the project root (e.g. "docs/diagrams/auth-flow.excalidraw"). A bare name like "auth-flow" goes to docs/diagrams/.';

/** Path help for the assistant, where `path` defaults to the open drawing and bare names go next to it. */
const CURRENT_PATH_HELP =
  'Leave out to use the drawing the user has open, which is almost always what you want. Pass it only to read or create a different drawing: a path relative to the project root, or a bare name like "auth-flow", which goes next to the open drawing.';

export function resolveDrawing(ctx: ToolContext, p: string | undefined): string {
  if (!p) {
    if (ctx.currentDrawing) return ctx.currentDrawing;
    throw new Error("path is required");
  }
  let rel = p.trim();
  if (!rel.endsWith(".excalidraw")) rel += ".excalidraw";
  const cur = ctx.currentDrawing;
  let file: string;
  if (!path.isAbsolute(rel) && !rel.includes("/") && !rel.includes(path.sep)) {
    // A bare name goes next to the open drawing in the assistant (so its own name means that
    // drawing), and into docs/diagrams/ for MCP agents.
    file = cur ? path.join(path.dirname(cur), rel) : path.resolve(ctx.projectRoot, DEFAULT_DIR, rel);
  } else {
    file = path.resolve(ctx.projectRoot, rel);
  }
  // Models told drawings live in docs/diagrams/ put the open drawing's name there and edit a
  // different (often new) file. An absolute path is taken as deliberate.
  if (cur && file !== cur && path.basename(file) === path.basename(cur) && !path.isAbsolute(rel)) {
    throw new Error(
      `${relPath(ctx, file)} is not the open drawing: the user has ${relPath(ctx, cur)} open. Leave out path to use the open drawing (or pass the absolute path ${file} if you really mean that other file).`,
    );
  }
  return file;
}

export function relPath(ctx: ToolContext, abs: string): string {
  const r = path.relative(ctx.projectRoot, abs);
  return r.startsWith("..") ? abs : r;
}

const other = (ctx: ToolContext, file: string) => (file !== ctx.currentDrawing ? file : undefined);

/** Drawing tools. `currentDrawing` makes `path` optional (it defaults to the open drawing). */
const NODE_SHAPES = new Set(["rectangle", "ellipse", "diamond", "initial", "final", "bar"]);
const SEQUENCE_RELATIONS = new Set(["message", "async-message", "reply"]);
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Repairs the graph mistakes weaker models make with create_diagram: edges listed under `nodes`,
 * nodes under `edges`, `type` where the schema says `shape` or `relation`. Each repair is reported
 * back so the model learns the real field names.
 */
export function normalizeGraphArgs(a: Obj): string[] {
  const notes: string[] = [];
  const nodes = Array.isArray(a.nodes) ? (a.nodes as unknown[]) : [];
  const edges = Array.isArray(a.edges) ? (a.edges as unknown[]) : [];
  const keptNodes: unknown[] = [];
  const keptEdges: unknown[] = [];
  const moved: string[] = [];
  for (const n of nodes) {
    if (isObj(n) && typeof n.from === "string" && typeof n.to === "string") {
      keptEdges.push(n);
      moved.push(String(n.id ?? `${n.from}->${n.to}`));
    } else keptNodes.push(n);
  }
  if (moved.length) notes.push(`Moved ${moved.join(", ")} from nodes to edges: entries with from and to are edges.`);
  const nodeIds = new Set(keptNodes.filter(isObj).map((n) => n.id));
  const asNodes: string[] = [];
  const dropped: string[] = [];
  for (const e of edges) {
    // An "edge" with no target but an id and a label is a node written in the wrong list.
    if (isObj(e) && e.to === undefined && typeof e.id === "string" && typeof e.label === "string") {
      if (nodeIds.has(e.id)) dropped.push(e.id);
      else {
        const shape = e.shape ?? e.type;
        keptNodes.push({ id: e.id, label: e.label, ...(typeof shape === "string" && NODE_SHAPES.has(shape) ? { shape } : {}) });
        nodeIds.add(e.id);
        asNodes.push(e.id);
      }
    } else keptEdges.push(e);
  }
  if (asNodes.length) notes.push(`Moved ${asNodes.join(", ")} from edges to nodes: an edge needs from and to node ids.`);
  if (dropped.length) notes.push(`Dropped edges ${dropped.join(", ")}: they had no \`to\` and repeat nodes already listed.`);
  const shapes: string[] = [];
  for (const n of keptNodes) {
    if (isObj(n) && typeof n.type === "string" && n.shape === undefined) {
      if (n.type !== "rectangle") n.shape = n.type;
      delete n.type;
      shapes.push(String(n.id));
    }
  }
  if (shapes.length) notes.push(`Read \`type\` as \`shape\` on nodes ${shapes.join(", ")}.`);
  const relations: string[] = [];
  for (const e of keptEdges) {
    if (!isObj(e) || typeof e.type !== "string") continue;
    if (e.type in RELATIONS && e.relation === undefined) {
      e.relation = e.type;
      relations.push(`${e.from}->${e.to}`);
    }
    if (e.type in RELATIONS || e.type === "arrow" || e.type === "line") delete e.type;
  }
  if (relations.length) notes.push(`Read \`type\` as \`relation\` on edges ${relations.join(", ")}.`);
  if (moved.length || asNodes.length || dropped.length) {
    a.nodes = keptNodes;
    a.edges = keptEdges;
  }
  if (keptEdges.some((e) => isObj(e) && typeof e.relation === "string" && SEQUENCE_RELATIONS.has(e.relation))) {
    notes.push(
      "Message edges draw a communication diagram. For a sequence diagram (lifelines, messages in order, alt and loop) use mermaid_to_drawing with a sequenceDiagram instead.",
    );
  }
  return notes;
}

export function drawingTools(opts: { currentDrawing: boolean }): ToolDef[] {
  const pathArg = opts.currentDrawing ? z.string().optional().describe(CURRENT_PATH_HELP) : z.string().describe(PATH_HELP);
  const newPathHelp = opts.currentDrawing
    ? 'Path relative to the project root, or a bare name like "auth-flow", which goes next to the open drawing. To add to the open drawing, use the other tools instead.'
    : PATH_HELP;
  const openArg: z.ZodRawShape = opts.currentDrawing ? {} : { open: z.boolean().optional().describe("Also open it in the user's browser") };

  const defs: ToolDef[] = [
    {
      name: "excalidraw_guide",
      title: "Excalidraw element guide",
      description:
        "The drawing guide: which tool to use, the simplified element format, sizing and spacing rules, layout anti-patterns, the check-after-every-batch list, error recovery and the update-after-a-code-change workflow. Read it once per session before your first edit.",
      input: {},
      readOnly: true,
      run: async () => ({ text: GUIDE }),
    },
    {
      name: "diagram_reference",
      title: "Diagram reference",
      description:
        "Notes on what each kind of architecture or design diagram is for, its notation, and how to draw it here: choosing a diagram for an audience and question; C4 (context, container, component, deployment, dynamic); all 14 UML diagrams (class, object, package, component, composite structure, deployment, use case, activity, state machine, sequence, communication, interaction overview, timing); ER; data flow and threat models; infrastructure; messaging; visual principles; keeping diagrams in step with code. " +
        'Pass a topic name or just describe the diagram in your own words ("uml class diagram", "use case", "erd"): the best-matching notes come back. Omit topic for the list.',
      input: { topic: z.string().optional().describe('A topic name from the list, or a description of the diagram, e.g. "uml-overview", "class diagram", "use case diagram"') },
      readOnly: true,
      run: async ({ topic }, ctx) => {
        const text = topic?.trim() ? readTopic(topic) : topicIndex();
        // The recipes name a docs/diagrams/ file for MCP agents; the assistant copies that path
        // and draws in a new file instead of the open one.
        return { text: ctx.currentDrawing ? text.replace(/^[ \t]*"path": "[^"]*",?\n/gm, "") : text };
      },
    },
    {
      name: "list_drawings",
      title: "List drawings",
      description: "Lists .excalidraw files in the project (most recently modified first).",
      input: { dir: z.string().optional().describe("Sub-directory to search (default: whole project)") },
      readOnly: true,
      run: async ({ dir }, ctx) => {
        const root = dir ? path.resolve(ctx.projectRoot, dir) : ctx.projectRoot;
        const drawings = await ctx.list(root);
        if (!drawings.length) return { text: `No drawings under ${relPath(ctx, root) || "."}` };
        return {
          text: drawings
            .map((d) => `${relPath(ctx, d.path)}  (${new Date(d.mtime).toISOString().slice(0, 16)}, ${Math.round(d.size / 1024)} KB)`)
            .join("\n"),
        };
      },
    },
    {
      name: "read_drawing",
      title: "Read drawing",
      description:
        "Compact description of a drawing and its `rev`: every element's id, type, position, size, label, colours, frame and code link (`code=src/foo.ts#L42`); arrows as `[id] arrow from -> to`. " +
        "Filter a big drawing with query (label, text or link substring), ids or type; matches bring the arrows attached to them. Pass the rev to a later write's if_rev. Set include_json for raw Excalidraw elements.",
      input: {
        path: pathArg,
        query: z.string().optional().describe('Only elements whose label, text, frame name or link contains this (case-insensitive), e.g. "orders"'),
        ids: z.array(z.string()).optional().describe("Only these elements"),
        type: z.string().optional().describe("Only this element type (rectangle, arrow, frame, text, ...)"),
        include_json: z.boolean().optional(),
      },
      readOnly: true,
      run: async ({ path: p, include_json, query, ids, type }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = (await ctx.op({ op: "read", path: file, full: include_json, query, ids, type })) as {
          summary: string;
          contentRev: string;
          matched?: number;
          total: number;
          scene?: { elements: unknown[] };
        };
        const filtered = r.matched !== undefined ? ` (filtered: ${r.matched} of ${r.total} elements match)` : "";
        let out = `${relPath(ctx, file)} rev ${r.contentRev}${filtered}: ${r.summary}`;
        if (r.matched === 0) out += "\nNothing matches. Try a shorter query, or read without filters.";
        if (include_json) out += `\n\nelements:\n${JSON.stringify(r.scene?.elements)}`;
        return { text: out };
      },
    },
    {
      name: "create_drawing",
      title: "Create drawing",
      description: "Creates a new .excalidraw file, optionally with initial elements (simplified format, see excalidraw_guide).",
      input: {
        path: z.string().describe(newPathHelp),
        elements: z.array(skeleton).optional(),
        overwrite: z.boolean().optional().describe("Replace an existing drawing"),
        ...openArg,
      },
      run: async ({ path: p, elements, overwrite, open }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.op({ op: "create", path: file, elements: elements ?? [], overwrite });
        let msg = `Created ${relPath(ctx, file)} with ${(r.created as string[]).length} elements.${after(r)}`;
        if (open && ctx.open) msg += " " + (await ctx.open(file));
        return { text: msg, drawing: other(ctx, file) };
      },
    },
    {
      name: "create_diagram",
      title: "Create diagram from a graph",
      description:
        "Draws nodes and edges with automatic layered layout: the fastest way to a clean architecture, flow, state, dependency, UML (class, object, use case, component, package, deployment, communication) or ER diagram. Creates the file if needed; otherwise appends to the right of existing content. " +
        "For UML and ER notation give edges a `relation` (inheritance, composition, include, one-to-many, …) multiplicities as `startLabel`/`endLabel`, and class nodes `attributes`/`operations`/`stereotype` instead of restyling afterwards. " +
        "replace: true swaps the whole drawing for this one (only when the user asks to start over: it discards their edits). Node ids become element ids, so later edits can refer to them.",
      input: {
        path: pathArg,
        nodes: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              shape: z
                .string()
                .optional()
                .describe(
                  'rectangle (default), ellipse, diamond; UML symbols "initial" (● start), "final" (◉ end) and "bar" (fork/join), which take no label (pass ""); or a library shape key from list_shapes (drawn as that icon; the label replaces its caption or goes below)',
                ),
              color,
              group: z.string().optional().describe("Group id; members are drawn inside a labelled frame"),
              code: z.string().optional().describe('Project file the node stands for, optionally with a line ("src/orders/repo.ts:42"); stored as a code link'),
              stereotype: z.string().optional().describe('UML stereotype shown as «…» above the label: "interface", "abstract", "enumeration", "device", "executionEnvironment", "artifact", "component", "actor"'),
              attributes: z.array(z.string()).optional().describe('UML class attributes, one per line, under a rule: "+id: UUID", "-total: Money"'),
              operations: z.array(z.string()).optional().describe('UML class operations, under a second rule: "+place(): void"'),
            }),
          )
          .min(1),
        edges: z
          .array(
            z.object({
              from: z.string().describe("id of the node the edge starts at"),
              to: z.string().describe("id of the node the edge points to"),
              label: z.string().optional().describe("Only when the meaning isn't obvious from the two ends; 12 characters or fewer"),
              startLabel: z
                .string()
                .optional()
                .describe('Small text beside the `from` end: UML multiplicity or role ("1", "0..*", "+owner"), ER cardinality. Put multiplicities here, not in `label`'),
              endLabel: z.string().optional().describe('Small text beside the `to` end, e.g. "0..*"'),
              style: z.enum(["solid", "dashed", "dotted"]).optional().describe("dashed for async or optional flows"),
              bidirectional: z.boolean().optional(),
              relation: z
                .enum(Object.keys(RELATIONS) as [Relation, ...Relation[]])
                .optional()
                .describe(
                  "What the edge means; sets the standard arrowheads and line style. UML: association (plain line), directed-association, dependency (dashed, open arrow), inheritance (from child to parent, hollow triangle; the parent is laid out first), realization (class to interface, dashed, hollow triangle), aggregation (from whole to part, hollow diamond), composition (from whole to part, filled diamond), include / extend (use cases, dashed, labelled «include»/«extend»), message / async-message / reply (sequence and communication). ER crow's foot: one-to-one, one-to-many, many-to-many, one-to-one-or-many. Omit for a plain arrow.",
                ),
              startArrowhead: arrowhead.describe("Override the arrowhead at `from`"),
              endArrowhead: arrowhead.describe("Override the arrowhead at `to`"),
            }),
          )
          .optional(),
        groups: z.array(z.object({ id: z.string(), label: z.string().optional() })).optional(),
        direction: z.enum(["LR", "TB"]).optional().describe("LR = left to right (default), TB = top to bottom"),
        title: z.string().optional(),
        replace: z.boolean().optional().describe("Replace everything in the drawing with this diagram (one atomic write)"),
        ...openArg,
      },
      normalize: normalizeGraphArgs,
      run: async ({ path: p, nodes, edges, groups, direction, title, replace, open }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.op({ op: "diagram", path: file, replace: !!replace, graph: { nodes, edges, groups, direction, title } });
        let msg = `Drew ${nodes.length} nodes and ${edges?.length ?? 0} edges in ${relPath(ctx, file)}. Element ids: ${(r.created as string[]).join(", ")}.${after(r)}`;
        if (open && ctx.open) msg += " " + (await ctx.open(file));
        return { text: msg, drawing: other(ctx, file) };
      },
    },
    {
      name: "list_shapes",
      title: "List library shapes",
      description:
        "Searches reusable shapes (icons, components, figures) from the built-in starter libraries, libraries the user installed, .excalidrawlib files in the project, and the user's Excalidraw library. Use a key with insert_shape or as a create_diagram node shape. Without a query you get a summary of the libraries.",
      input: {
        query: z.string().optional().describe('Words to look for, e.g. "database", "stick figure", "s3"'),
        library: z.string().optional().describe("Only this library (name or id)"),
        preview: z.boolean().optional().describe("Also return a picture of the matching shapes (up to 30), to tell unnamed or similar items apart. Needs a model that accepts images."),
      },
      readOnly: true,
      run: async ({ query, library, preview }, ctx) => {
        const file = ctx.currentDrawing ?? path.join(ctx.projectRoot, "_.excalidraw");
        const r = (await ctx.op({ op: "shapes", path: file })) as {
          libraries: { id: string; name: string; origin: string; items: number; enabled: boolean }[];
          shapes: LibraryShape[];
        };
        const enabled = r.libraries.filter((l) => l.enabled && l.items > 0);
        if (!r.shapes.length) {
          return { text: "No library shapes are available. The user can add libraries in the assistant's Shapes view, or put an .excalidrawlib file in the project." };
        }
        let pool = r.shapes;
        if (library) {
          // Shape keys start with the library's slug, so models often pass that.
          const l = library.toLowerCase();
          const ls = slug(library);
          pool = pool.filter((s) => s.library.toLowerCase() === l || s.libraryName.toLowerCase().includes(l) || slug(s.libraryName) === ls);
          if (!pool.length) return { text: `No library matches "${library}". Libraries: ${enabled.map((x) => x.name).join(", ")}` };
        }
        const hits = query ? searchShapes(pool, query) : pool;
        if (!query && !library && pool.length > 60) {
          const lines = enabled.map((l) => {
            const sample = r.shapes.filter((s) => s.library === l.id).slice(0, 6).map((s) => s.name);
            return `- ${l.name} (${l.origin}, ${l.items} shapes): ${sample.join(", ")}${l.items > 6 ? ", …" : ""}`;
          });
          return { text: `${r.shapes.length} shapes in ${enabled.length} libraries. Search with query (and optionally library):\n${lines.join("\n")}` };
        }
        if (!hits.length) return { text: `No shapes match "${query}". Try other words, or call list_shapes without a query to see the libraries.` };
        const shown = hits.slice(0, 150);
        const groups = new Map<string, LibraryShape[]>();
        for (const s of shown) groups.set(s.libraryName, [...(groups.get(s.libraryName) ?? []), s]);
        const text = [...groups]
          .map(([lib, items]) => `## ${lib}\n${items.map((s) => `${s.key}: "${s.name}" ${s.width}x${s.height} - ${s.description}`).join("\n")}`)
          .join("\n\n");
        const more = hits.length > shown.length ? `\n… ${hits.length - shown.length} more; narrow the query` : "";
        if (!preview) return { text: text + more };
        const img = (await ctx.withEditor(file, { op: "shapes_preview", path: file, keys: hits.slice(0, 30).map((s) => s.key) })) as { data: string; mime: string };
        return { text: `${text}${more}\n\nThe picture shows the first ${Math.min(30, hits.length)} matches, each labelled with its name.`, image: img };
      },
    },
    {
      name: "insert_shape",
      title: "Insert library shape",
      description:
        "Places a library shape (from list_shapes) into the drawing as a grouped copy, with an optional label (it replaces the shape's own caption, or goes below). Returns the id to bind arrows to (pass `id` to choose it).",
      input: {
        path: pathArg,
        shape: z.string().describe("Shape key or name from list_shapes"),
        x: z.number().optional().describe("Left edge; default: right of existing content"),
        y: z.number().optional().describe("Top edge"),
        next_to: z
          .object({
            id: z.string().describe("An existing element's id"),
            side: z.enum(["left", "right", "above", "below"]).optional().describe("Default right"),
            gap: z.number().optional().describe("Space between them (default 100)"),
          })
          .optional()
          .describe("Place it beside an existing element instead of giving x/y"),
        width: z.number().nonnegative().optional().describe("Scale to this width (keeps proportions with height)"),
        height: z.number().nonnegative().optional(),
        label: z.string().optional().describe("Caption shown under the shape (replaces the icon's own caption if it has one)"),
        id: z.string().optional().describe("Id for the shape, so arrows and updates can refer to it"),
      },
      run: async ({ path: p, ...args }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = (await ctx.op({ op: "insert_shape", path: file, ...args })) as {
          shape: string;
          anchor: string;
          created: string[];
          bounds: { x: number; y: number; width: number; height: number };
        };
        const b = r.bounds;
        return {
          text: `Inserted ${r.shape} into ${relPath(ctx, file)} at (${Math.round(b.x)},${Math.round(b.y)}) size ${Math.round(b.width)}x${Math.round(b.height)}. Bind arrows to id "${r.anchor}". All ids: ${r.created.join(", ")}.${after(r)}`,
          drawing: other(ctx, file),
        };
      },
    },
    {
      name: "add_elements",
      title: "Add elements",
      description:
        "Adds elements in the simplified format (see excalidraw_guide): shapes with labels, arrows bound by start/end id, free text, frames. Give your own ids so later edits and arrows can refer to them. Creates the drawing if it doesn't exist.",
      input: {
        path: pathArg,
        elements: z.array(skeleton).min(1),
        placement: z
          .enum(["absolute", "right", "below"])
          .optional()
          .describe("absolute (default) uses your coordinates; right/below shifts the batch next to existing content"),
        if_rev: ifRev,
      },
      run: async ({ path: p, elements, placement, if_rev }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.op({ op: "add", path: file, elements, placement: placement ?? "absolute", if_rev });
        return {
          text: `Added ${(r.created as string[]).length} elements to ${relPath(ctx, file)}: ${(r.created as string[]).join(", ")}.${after(r)}`,
          drawing: other(ctx, file),
        };
      },
    },
    {
      name: "connect_elements",
      title: "Connect elements",
      description:
        "Draws an arrow from one element to another (by id). The arrow stays attached when either end moves. Pass the id of an existing arrow to attach that arrow to from and to instead of drawing a new one (it is re-routed straight between them).",
      input: {
        path: pathArg,
        from: z.string().describe("Id of the element the arrow starts at"),
        to: z.string().describe("Id of the element the arrow points to"),
        label: z.string().optional(),
        style: z.enum(["solid", "dashed", "dotted"]).optional(),
        bidirectional: z.boolean().optional().describe("Arrowheads at both ends"),
        id: z.string().optional().describe("Id for the new arrow, or the id of an existing arrow to attach"),
      },
      run: async ({ path: p, from, to, label, style, bidirectional, id }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.op({ op: "connect", path: file, from, to, id, label, style, bidirectional });
        const what = r.rebound ? "Attached existing arrow" : "Connected";
        return { text: `${what} ${from} -> ${to} in ${relPath(ctx, file)} (arrow id ${String(r.id)}).${after(r)}`, drawing: other(ctx, file) };
      },
    },
    {
      name: "update_elements",
      title: "Update elements",
      description:
        "Changes existing elements by id: position, size, label (null removes it), text, color, code link, type (switch between rectangle, ellipse and diamond in place), frameId, or any raw property. " +
        "Labels re-centre, bound arrows re-route, and a moved frame or grouped shape takes its children or group along. Prefer this over deleting and re-adding: it keeps the id, the arrows and the user's styling.",
      input: {
        path: pathArg,
        updates: z.array(updateItem).min(1),
        if_rev: ifRev,
      },
      run: async ({ path: p, updates: raw, if_rev }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const { updates, notes } = normalizeUpdates(raw);
        const r = await ctx.op({ op: "update", path: file, updates, if_rev });
        return { text: `Updated ${updates.length} element(s) in ${relPath(ctx, file)}.${after(r, notes)}`, drawing: other(ctx, file) };
      },
    },
    {
      name: "delete_elements",
      title: "Delete elements",
      description:
        "Deletes elements by id. Their labels go too; arrows attached to them are detached, not deleted, so delete those arrows as well when the connection no longer exists.",
      input: { path: pathArg, ids: z.array(z.string()).min(1), if_rev: ifRev },
      destructive: true,
      run: async ({ path: p, ids, if_rev }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.op({ op: "delete", path: file, ids, if_rev });
        return { text: `Deleted ${(r.deleted as string[]).length} element(s) from ${relPath(ctx, file)}.${after(r)}`, drawing: other(ctx, file) };
      },
    },
    {
      name: "apply_changes",
      title: "Apply changes",
      description:
        "Adds, updates and deletes elements in one call and one revision: deletes first, then adds, then updates (which may refer to the new ids). " +
        "Use it for a planned set of edits, such as bringing a diagram up to date after a code change. Same formats as add_elements, update_elements and delete_elements; nothing changes if any part fails.",
      input: {
        path: pathArg,
        add: z.array(skeleton).optional(),
        update: z.array(updateItem).optional(),
        delete: z.array(z.string()).optional().describe("Ids to delete"),
        placement: z.enum(["absolute", "right", "below"]).optional().describe("For add (default absolute)"),
        if_rev: ifRev,
      },
      destructive: true,
      run: async ({ path: p, add, update, delete: del, placement, if_rev }, ctx) => {
        const file = resolveDrawing(ctx, p);
        if (!add?.length && !update?.length && !del?.length) throw new Error("Nothing to do: pass add, update or delete");
        const norm = update?.length ? normalizeUpdates(update) : { updates: [], notes: [] };
        const r = await ctx.op({ op: "apply", path: file, add, update: norm.updates, delete: del, placement, if_rev });
        const created = (r.created as string[]) ?? [];
        const deleted = (r.deleted as string[]) ?? [];
        const parts = [
          created.length ? `added ${created.length} (${created.join(", ")})` : "",
          norm.updates.length ? `updated ${norm.updates.length}` : "",
          deleted.length ? `deleted ${deleted.length}` : "",
        ].filter(Boolean);
        return { text: `In ${relPath(ctx, file)}: ${parts.join(", ")}.${after(r, norm.notes)}`, drawing: other(ctx, file) };
      },
    },
    {
      name: "arrange_elements",
      title: "Align or distribute elements",
      description:
        "Aligns elements (left, center, right, top, middle, bottom) or spaces them evenly (horizontal, vertical) by id. Each moves with its label, its group (a library shape) or, for a frame, its children; bound arrows re-route. Distribute keeps the two outermost in place.",
      input: {
        path: pathArg,
        ids: z.array(z.string()).min(2),
        align: z.enum(["left", "center", "right", "top", "middle", "bottom"]).optional(),
        distribute: z.enum(["horizontal", "vertical"]).optional().describe("Equal gaps between neighbours (needs three or more)"),
        if_rev: ifRev,
      },
      run: async ({ path: p, ids, align, distribute, if_rev }, ctx) => {
        const file = resolveDrawing(ctx, p);
        if (!align === !distribute) throw new Error("Pass either align or distribute");
        const r = await ctx.op({ op: "arrange", path: file, ids, align, distribute, if_rev });
        const how = align ? `Aligned ${ids.length} elements (${align})` : `Distributed ${ids.length} elements ${distribute}ly`;
        return { text: `${how} in ${relPath(ctx, file)}.${after(r)}`, drawing: other(ctx, file) };
      },
    },
    {
      name: "snapshot_drawing",
      title: "Snapshot drawing",
      description:
        "Saves the drawing's current state (kept outside the project, newest 20 per drawing) so restore_drawing can put it back. Take one before a large or risky edit.",
      input: { path: pathArg, name: z.string().optional().describe('e.g. "before sync"') },
      run: async ({ path: p, name }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = (await ctx.op({ op: "snapshot", path: file, name })) as { snapshot: { id: string; name: string; elements: number; rev: string } };
        const s = r.snapshot;
        return { text: `Saved snapshot ${s.id} "${s.name}" of ${relPath(ctx, file)} (${s.elements} elements, rev ${s.rev}).` };
      },
    },
    {
      name: "list_snapshots",
      title: "List snapshots",
      description: "Lists a drawing's saved snapshots, newest first.",
      input: { path: pathArg },
      readOnly: true,
      run: async ({ path: p }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = (await ctx.op({ op: "snapshots", path: file })) as { snapshots: { id: string; name: string; created: number; elements: number; rev: string }[] };
        if (!r.snapshots.length) return { text: `${relPath(ctx, file)} has no snapshots.` };
        return {
          text: r.snapshots.map((s) => `${s.id}  "${s.name}"  ${new Date(s.created).toISOString().slice(0, 19)}  ${s.elements} elements  rev ${s.rev}`).join("\n"),
        };
      },
    },
    {
      name: "restore_drawing",
      title: "Restore snapshot",
      description:
        "Puts the drawing back to a snapshot (by id or name; default the newest) in one revision. The current state is snapshotted first, so a restore can itself be undone.",
      input: { path: pathArg, snapshot: z.string().optional().describe("Snapshot id or name from list_snapshots") },
      destructive: true,
      run: async ({ path: p, snapshot }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = (await ctx.op({ op: "restore", path: file, snapshot })) as Record<string, unknown> & {
          restored: { id: string; name: string };
          saved: { id: string };
        };
        return {
          text: `Restored ${relPath(ctx, file)} to snapshot ${r.restored.id} "${r.restored.name}". The state before is snapshot ${r.saved.id}.${after(r)}`,
          drawing: other(ctx, file),
        };
      },
    },
    {
      name: "mermaid_to_drawing",
      title: "Mermaid to drawing",
      description:
        "Converts Mermaid into Excalidraw elements, appended to the drawing. Only flowchart and sequenceDiagram become editable shapes and arrows; " +
        "classDiagram, erDiagram, stateDiagram and the rest arrive as a single uneditable image, so draw those with create_diagram instead. Runs in an open tab of the drawing, else in a local headless browser.",
      input: { path: pathArg, mermaid: z.string().describe("Mermaid source (flowchart or sequenceDiagram)") },
      run: async ({ path: p, mermaid }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.withEditor(file, { op: "mermaid", path: file, text: mermaid });
        const created = r.created as string[];
        const kind = /^\s*(?:%%.*\n\s*)*(\w+)/.exec(mermaid)?.[1] ?? "";
        const image = !/^(flowchart|graph|sequenceDiagram)$/i.test(kind)
          ? ` A ${kind || "diagram"} of this kind converts to an image, which can't be edited: delete it and use create_diagram if the user will want to change it.`
          : "";
        return { text: `Converted Mermaid into ${created.length} elements in ${relPath(ctx, file)}.${image}${after(r)}`, drawing: other(ctx, file) };
      },
    },
    {
      name: "render_drawing",
      title: "Render drawing",
      description:
        "Returns a PNG of the drawing so you can check your work: run it after every batch of edits, fix what you see, and render again. Rendered locally, in a headless browser when no tab is open. " +
        "Big drawings are scaled down to fit max_size, so small text may be unreadable in the overview; pass element_ids or region to render a close-up at full size.",
      input: {
        path: pathArg,
        element_ids: z
          .array(z.string())
          .optional()
          .describe("Render only these elements, plus their labels, the rest of their group, a frame's children, and arrows attached to any of them"),
        region: z
          .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
          .optional()
          .describe("Render only elements overlapping this canvas rectangle (coordinates as in read_drawing)"),
        max_size: z.number().int().min(200).max(4000).optional().describe("Longest side in px (default 1600)"),
        dark: z.boolean().optional(),
      },
      readOnly: true,
      run: async ({ path: p, element_ids, region, max_size, dark }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = (await ctx.withEditor(file, {
          op: "render",
          path: file,
          elementIds: element_ids,
          region,
          opts: { format: "png", maxSize: max_size ?? 1600, dark: !!dark },
        })) as { data: string; mime: string; scale?: number; minFont?: number; missing?: string[]; elements?: number };
        const close = element_ids?.length || region;
        const lines = [`Rendered ${close ? `${r.elements ?? "some"} elements of ` : ""}${relPath(ctx, file)}${r.scale ? ` at ${+r.scale.toFixed(2)}x` : ""}.`];
        if (r.missing?.length) lines.push(`Not found: ${r.missing.join(", ")}.`);
        if (r.scale && r.minFont) {
          const px = r.minFont * r.scale;
          lines.push(
            `Smallest text is ${r.minFont}px, about ${+px.toFixed(1)}px in this image.` +
              (px < 10 ? " That's too small to judge here: render a close-up with element_ids or region before calling text unreadable." : ""),
          );
        }
        return { text: lines.join(" "), image: { data: r.data, mime: r.mime } };
      },
    },
    {
      name: "export_drawing",
      title: "Export drawing",
      description:
        "Writes an image next to the drawing (or to `output`). SVG/PNG exports embed the scene, so `name.excalidraw.svg` can be shown in a README and re-opened for editing.",
      input: {
        path: pathArg,
        format: z.enum(["svg", "png"]).optional().describe("Default svg"),
        output: z.string().optional().describe("Output path relative to the project root"),
        dark: z.boolean().optional(),
        embed_scene: z.boolean().optional().describe("Embed the editable scene (default true)"),
      },
      run: async ({ path: p, format, output, dark, embed_scene }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const fmt = format ?? "svg";
        const out = resolveSafePath(path.resolve(ctx.projectRoot, output ?? `${file}.${fmt}`), [ctx.projectRoot], [`.${fmt}`]);
        const r = (await ctx.withEditor(file, {
          op: "render",
          path: file,
          opts: { format: fmt, dark: !!dark, embedScene: embed_scene ?? true, scale: fmt === "png" ? 2 : 1 },
        })) as { data: string; mime: string };
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (fmt === "svg") writeFileAtomic(out, Buffer.from(r.data, "base64").toString("utf8"));
        else {
          const tmp = `${out}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
          fs.writeFileSync(tmp, Buffer.from(r.data, "base64"));
          fs.renameSync(tmp, out);
        }
        return { text: `Wrote ${relPath(ctx, out)}. Markdown: ![${path.basename(file, ".excalidraw")}](${relPath(ctx, out)})` };
      },
    },
    {
      name: "open_drawing",
      title: "Open drawing",
      description: "Opens the drawing in the user's browser in the local live editor. Changes made by either side sync instantly.",
      input: { path: z.string().describe(PATH_HELP) },
      run: async ({ path: p }, ctx) => {
        const file = resolveDrawing(ctx, p);
        if (!fs.existsSync(file)) await ctx.op({ op: "create", path: file, elements: [] });
        if (!ctx.open) return { text: `Opened ${relPath(ctx, file)}.`, drawing: other(ctx, file) };
        return { text: await ctx.open(file) };
      },
    },
    // ---- code links (WS5) ----
    {
      name: "check_code_links",
      title: "Check code links",
      description:
        "Reports each code-linked element (link like \"src/a.ts#L42\") as ok, changed (the file changed since the link was made or reviewed), missing (file gone or line past the end) or unknown. After updating the diagram for the change, pass mark_reviewed to record the files' current state.",
      input: {
        path: pathArg,
        mark_reviewed: z.boolean().optional().describe("Record the linked files' current hashes as reviewed"),
        ids: z.array(z.string()).optional().describe("With mark_reviewed: only these elements (default: all)"),
      },
      run: async ({ path: p, mark_reviewed, ids }, ctx) => {
        const file = resolveDrawing(ctx, p);
        let note = "";
        if (mark_reviewed) {
          const r = await ctx.op({ op: "review_links", path: file, ids });
          note = `Marked ${r.reviewed as number} link${r.reviewed === 1 ? "" : "s"} as reviewed.\n`;
        }
        const r = await ctx.op({ op: "check_links", path: file });
        return { text: `${relPath(ctx, file)}: ${note}${r.summary as string}`, drawing: mark_reviewed ? other(ctx, file) : undefined };
      },
    },
  ];
  if (!opts.currentDrawing) return defs;
  // Say so when a write went to another drawing, so a model that passed the wrong path notices.
  return defs.map((d) => ({
    ...d,
    run: async (args, ctx) => {
      const out = await d.run(args, ctx);
      if (!out.drawing || !ctx.currentDrawing) return out;
      const note = `Note: this changed ${relPath(ctx, out.drawing)}, not the drawing the user has open (${relPath(ctx, ctx.currentDrawing)}). If you meant the open drawing, leave out path.`;
      return { ...out, text: `${out.text}\n${note}` };
    },
  }));
}

/** A map of the project: the first call when asked to diagram it. Also served over MCP. */
const projectOverviewTool: ToolDef = {
  name: "project_overview",
  title: "Project overview",
  description:
    "A compact map of the project (read-only): directory tree with file counts, languages, manifests and deployment files (package.json, go.mod, pyproject, Cargo.toml, Compose services, Dockerfiles, Kubernetes manifests, .proto, OpenAPI), likely entry points, the README's headline and existing drawings. Call it first when asked to diagram a project or an unfamiliar folder.",
  input: {
    dir: z.string().optional().describe("Folder relative to the project root (default: the whole project)"),
    depth: z.number().int().min(1).max(6).optional().describe("Directory levels in the tree (default 3)"),
  },
  readOnly: true,
  run: async (args, ctx) => ({ text: projectOverview(ctx.projectRoot, args) }),
};

/** What changed in the code, for updating a diagram after a change. Also served over MCP. */
const gitChangesTool: ToolDef = {
  name: "git_changes",
  title: "Git changes",
  description:
    "What changed in the project's code, from git (read-only). Default: uncommitted changes (working tree and staged, plus untracked files) against HEAD. `last: N` lists the last N commits with their files; `from` (and `to`) compares refs (`main`, `HEAD~3`, `v1.2..HEAD`). Each lists files as added/modified/deleted/renamed with +/- line counts. `diff: true` adds the unified diff, capped; pass `path` for one file or folder. Use it to update a diagram after a code change.",
  input: {
    last: z.number().int().min(1).max(50).optional().describe("The last N commits instead of uncommitted changes"),
    from: z.string().optional().describe("Base ref; alone it compares with the working tree. `A..B` is accepted"),
    to: z.string().optional().describe("Target ref (default: the working tree)"),
    path: z.string().optional().describe("Only this file or folder"),
    diff: z.boolean().optional().describe("Include the unified diff (capped at 20K characters)"),
  },
  readOnly: true,
  run: async (args, ctx) => ({ text: await gitChanges(ctx.projectRoot, args) }),
};

/** Code tools that coding agents don't already have: served over MCP as well as to the assistant. */
export function sharedCodeTools(): ToolDef[] {
  return [projectOverviewTool, gitChangesTool];
}

/** Read-only project exploration for the assistant. Confined to the project root. */
export function codeTools(): ToolDef[] {
  return [
    projectOverviewTool,
    {
      name: "list_files",
      title: "List project files",
      description:
        "Lists files in the project (read-only), skipping build output, dependencies, VCS data and anything .gitignored. Use a glob like \"**/*.ts\" or \"src/**/*.{go,proto}\" to narrow it.",
      input: {
        dir: z.string().optional().describe("Directory relative to the project root (default: the root)"),
        glob: z.string().optional().describe("Glob; without a slash it matches file names"),
        limit: z.number().int().min(1).max(2000).optional(),
      },
      readOnly: true,
      run: async (args, ctx) => ({ text: listFiles(ctx.projectRoot, args) }),
    },
    {
      name: "search_files",
      title: "Search project files",
      description:
        "Searches file contents in the project (like grep), skipping .gitignored, vendored and secret files. Returns `path:line: text` matches; `context` adds lines around each (`path-line- text`, hunks split by `--`); `files_only` lists just the matching files with counts, a cheap first pass.",
      input: {
        pattern: z.string().min(1).describe("Text to find (or a regular expression with regex: true)"),
        regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        glob: z.string().optional().describe("Only search files matching this glob"),
        dir: z.string().optional(),
        context: z.number().int().min(0).max(10).optional().describe("Lines of context before and after each match"),
        files_only: z.boolean().optional().describe("Only list matching files, with match counts"),
        max_results: z.number().int().min(1).max(400).optional(),
      },
      readOnly: true,
      run: async (args, ctx) => ({ text: await searchFiles(ctx.projectRoot, args) }),
    },
    {
      name: "outline_file",
      title: "Outline a file",
      description:
        "Lists a source file's declarations with line numbers: classes, interfaces, types, functions, methods, exported constants and HTTP routes (TS/JS, Python, Go, Rust, Java/Kotlin, C#, Ruby). Cheaper than reading the whole file; read_file the lines you need after.",
      input: { path: z.string().describe("Path relative to the project root") },
      readOnly: true,
      run: async (args, ctx) => ({ text: outlineFile(ctx.projectRoot, args.path) }),
    },
    {
      name: "find_symbol",
      title: "Find a symbol",
      description:
        "Where a class, function, type or method is defined, best match first, as `path:start-end kind name signature`. `Class.method` narrows to a member. `references: true` also lists the lines that use it.",
      input: {
        name: z.string().min(1).max(200).describe("Symbol name, e.g. OrderRepository, placeOrder or OrderRepository.markPaid"),
        references: z.boolean().optional().describe("Also list references (whole-word matches outside the definition)"),
        dir: z.string().optional().describe("Only look in this folder"),
        max_references: z.number().int().min(1).max(200).optional(),
      },
      readOnly: true,
      run: async (args, ctx) => ({ text: findSymbol(ctx.projectRoot, args) }),
    },
    {
      name: "read_file",
      title: "Read project file",
      description: "Reads a text file in the project with line numbers (up to 2000 lines per call; use start_line/end_line for more).",
      input: {
        path: z.string().describe("Path relative to the project root"),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      readOnly: true,
      run: async (args, ctx) => ({ text: readFile(ctx.projectRoot, args) }),
    },
    gitChangesTool,
  ];
}

/** JSON Schema for a tool's input, for providers that take raw schemas. */
export function jsonSchema(def: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(def.input), { unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
