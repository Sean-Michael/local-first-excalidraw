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
import { GUIDE } from "./guide.js";
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
  })
  .describe("Simplified Excalidraw element; any raw Excalidraw property is also accepted");

const PATH_HELP =
  'Drawing path, relative to the project root (e.g. "docs/diagrams/auth-flow.excalidraw"). A bare name like "auth-flow" goes to docs/diagrams/.';

export function resolveDrawing(ctx: ToolContext, p: string | undefined): string {
  if (!p) {
    if (ctx.currentDrawing) return ctx.currentDrawing;
    throw new Error("path is required");
  }
  let rel = p.trim();
  if (!rel.endsWith(".excalidraw")) rel += ".excalidraw";
  if (!path.isAbsolute(rel) && !rel.includes("/") && !rel.includes(path.sep)) {
    // A bare name goes next to the open drawing in the assistant (so its own name means that
    // drawing), and into docs/diagrams/ for MCP agents.
    return ctx.currentDrawing ? path.join(path.dirname(ctx.currentDrawing), rel) : path.resolve(ctx.projectRoot, DEFAULT_DIR, rel);
  }
  return path.resolve(ctx.projectRoot, rel);
}

export function relPath(ctx: ToolContext, abs: string): string {
  const r = path.relative(ctx.projectRoot, abs);
  return r.startsWith("..") ? abs : r;
}

const other = (ctx: ToolContext, file: string) => (file !== ctx.currentDrawing ? file : undefined);

/** Drawing tools. `currentDrawing` makes `path` optional (it defaults to the open drawing). */
export function drawingTools(opts: { currentDrawing: boolean }): ToolDef[] {
  const pathArg = opts.currentDrawing
    ? z.string().optional().describe(`${PATH_HELP} Omit to use the drawing the user has open.`)
    : z.string().describe(PATH_HELP);
  const openArg: z.ZodRawShape = opts.currentDrawing ? {} : { open: z.boolean().optional().describe("Also open it in the user's browser") };

  return [
    {
      name: "excalidraw_guide",
      title: "Excalidraw element guide",
      description: "Element format, colours and layout tips. Read once before hand-placing elements.",
      input: {},
      readOnly: true,
      run: async () => ({ text: GUIDE }),
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
        "Compact description of a drawing: every element's id, type, position, size, label and colours; arrows as `from -> to`. Set include_json for raw Excalidraw elements.",
      input: { path: pathArg, include_json: z.boolean().optional() },
      readOnly: true,
      run: async ({ path: p, include_json }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = (await ctx.op({ op: "read", path: file, full: include_json })) as { summary: string; scene?: { elements: unknown[] } };
        let out = `${relPath(ctx, file)}: ${r.summary}`;
        if (include_json) out += `\n\nelements:\n${JSON.stringify(r.scene?.elements)}`;
        return { text: out };
      },
    },
    {
      name: "create_drawing",
      title: "Create drawing",
      description: "Creates a new .excalidraw file, optionally with initial elements (simplified format, see excalidraw_guide).",
      input: {
        path: z.string().describe(PATH_HELP),
        elements: z.array(skeleton).optional(),
        overwrite: z.boolean().optional().describe("Replace an existing drawing"),
        ...openArg,
      },
      run: async ({ path: p, elements, overwrite, open }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.op({ op: "create", path: file, elements: elements ?? [], overwrite });
        let msg = `Created ${relPath(ctx, file)} with ${(r.created as string[]).length} elements.`;
        if (open && ctx.open) msg += " " + (await ctx.open(file));
        return { text: msg, drawing: other(ctx, file) };
      },
    },
    {
      name: "create_diagram",
      title: "Create diagram from a graph",
      description:
        "Draws nodes and edges with automatic layered layout - the fastest way to make architecture, flow and dependency diagrams. Creates the file if needed; otherwise appends next to existing content (or replaces it with replace: true).",
      input: {
        path: pathArg,
        nodes: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
              color,
              group: z.string().optional().describe("Group id; members are drawn inside a labelled frame"),
            }),
          )
          .min(1),
        edges: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              label: z.string().optional(),
              style: z.enum(["solid", "dashed", "dotted"]).optional(),
              bidirectional: z.boolean().optional(),
            }),
          )
          .optional(),
        groups: z.array(z.object({ id: z.string(), label: z.string().optional() })).optional(),
        direction: z.enum(["LR", "TB"]).optional().describe("LR = left to right (default), TB = top to bottom"),
        title: z.string().optional(),
        replace: z.boolean().optional().describe("Clear the drawing first"),
        ...openArg,
      },
      run: async ({ path: p, nodes, edges, groups, direction, title, replace, open }, ctx) => {
        const file = resolveDrawing(ctx, p);
        if (replace) await ctx.op({ op: "clear", path: file });
        const r = await ctx.op({ op: "diagram", path: file, graph: { nodes, edges, groups, direction, title } });
        let msg = `Drew ${nodes.length} nodes and ${edges?.length ?? 0} edges in ${relPath(ctx, file)}. Element ids: ${(r.created as string[]).join(", ")}.`;
        if (open && ctx.open) msg += " " + (await ctx.open(file));
        return { text: msg, drawing: other(ctx, file) };
      },
    },
    {
      name: "add_elements",
      title: "Add elements",
      description: "Adds elements in the simplified format (labels, bound arrows, frames). Creates the drawing if it doesn't exist.",
      input: {
        path: pathArg,
        elements: z.array(skeleton).min(1),
        placement: z
          .enum(["absolute", "right", "below"])
          .optional()
          .describe("absolute (default) uses your coordinates; right/below shifts the batch next to existing content"),
      },
      run: async ({ path: p, elements, placement }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.op({ op: "add", path: file, elements, placement: placement ?? "absolute" });
        return {
          text: `Added ${(r.created as string[]).length} elements to ${relPath(ctx, file)}: ${(r.created as string[]).join(", ")}`,
          drawing: other(ctx, file),
        };
      },
    },
    {
      name: "update_elements",
      title: "Update elements",
      description:
        "Changes existing elements by id: position, size, label (null removes it), text, color, or any raw property. Labels re-centre and bound arrows re-route automatically.",
      input: {
        path: pathArg,
        updates: z
          .array(z.looseObject({ id: z.string(), label: z.union([label, z.null()]), text: z.string().optional(), color }))
          .min(1),
      },
      run: async ({ path: p, updates: raw }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const { updates, notes } = normalizeUpdates(raw);
        await ctx.op({ op: "update", path: file, updates });
        const msg = `Updated ${updates.length} element(s) in ${relPath(ctx, file)}.`;
        return { text: notes.length ? `${msg}\nNotes:\n- ${notes.join("\n- ")}` : msg, drawing: other(ctx, file) };
      },
    },
    {
      name: "delete_elements",
      title: "Delete elements",
      description: "Deletes elements by id (their labels go too; arrows attached to them are detached).",
      input: { path: pathArg, ids: z.array(z.string()).min(1) },
      destructive: true,
      run: async ({ path: p, ids }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.op({ op: "delete", path: file, ids });
        return { text: `Deleted ${(r.deleted as string[]).length} element(s) from ${relPath(ctx, file)}.`, drawing: other(ctx, file) };
      },
    },
    {
      name: "mermaid_to_drawing",
      title: "Mermaid to drawing",
      description:
        "Converts Mermaid (flowchart, sequence, class diagrams) into editable Excalidraw elements, appended to the drawing. Runs in the local editor tab, which is opened if needed.",
      input: { path: pathArg, mermaid: z.string().describe("Mermaid source") },
      run: async ({ path: p, mermaid }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = await ctx.withEditor(file, { op: "mermaid", path: file, text: mermaid });
        return { text: `Converted Mermaid into ${(r.created as string[]).length} elements in ${relPath(ctx, file)}.`, drawing: other(ctx, file) };
      },
    },
    {
      name: "render_drawing",
      title: "Render drawing",
      description: "Returns a PNG of the drawing so you can check layout and readability. Rendered by the local editor tab (opened if needed).",
      input: {
        path: pathArg,
        max_size: z.number().int().min(200).max(4000).optional().describe("Longest side in px (default 1600)"),
        dark: z.boolean().optional(),
      },
      readOnly: true,
      run: async ({ path: p, max_size, dark }, ctx) => {
        const file = resolveDrawing(ctx, p);
        const r = (await ctx.withEditor(file, {
          op: "render",
          path: file,
          opts: { format: "png", maxSize: max_size ?? 1600, dark: !!dark },
        })) as { data: string; mime: string };
        return { text: `Rendered ${relPath(ctx, file)}.`, image: { data: r.data, mime: r.mime } };
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
          const tmp = `${out}.tmp`;
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
  ];
}

/** Read-only project search for the assistant. Confined to the project root. */
export function codeTools(): ToolDef[] {
  return [
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
      description: "Searches file contents in the project (like grep). Returns `path:line: text` matches.",
      input: {
        pattern: z.string().min(1).describe("Text to find (or a regular expression with regex: true)"),
        regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        glob: z.string().optional().describe("Only search files matching this glob"),
        dir: z.string().optional(),
        max_results: z.number().int().min(1).max(400).optional(),
      },
      readOnly: true,
      run: async (args, ctx) => ({ text: searchFiles(ctx.projectRoot, args) }),
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
  ];
}

/** JSON Schema for a tool's input, for providers that take raw schemas. */
export function jsonSchema(def: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(def.input), { unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
