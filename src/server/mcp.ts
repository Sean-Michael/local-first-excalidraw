import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DaemonClient, DaemonError, openInBrowser } from "./client.js";
import { type Config, VERSION, writeFileAtomic } from "./config.js";
import { GUIDE, SERVER_INSTRUCTIONS } from "./guide.js";
import { resolveSafePath } from "./security.js";

const DEFAULT_DIR = process.env.LFX_DEFAULT_DIR ?? "docs/diagrams";

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

const pathArg = z
  .string()
  .describe('Drawing path, relative to the project root (e.g. "docs/diagrams/auth-flow.excalidraw"). A bare name like "auth-flow" goes to docs/diagrams/.');

function text(s: string): CallToolResult {
  return { content: [{ type: "text", text: s }] };
}

function fail(e: unknown): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
}

export async function runMcp(cfg: Config, opts: { root?: string }): Promise<void> {
  const client = new DaemonClient(cfg);
  let projectRoot = path.resolve(opts.root ?? process.env.LFX_PROJECT_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

  let ready: Promise<void> | undefined;
  const ensure = () =>
    (ready ??= (async () => {
      await client.ensure();
      await client.request("POST", "/api/roots", { path: projectRoot }).catch((e: DaemonError) => {
        // Locked roots (e.g. Docker) are fine as long as the project is inside one of them.
        if (e.status !== 403) throw e;
      });
    })().catch((e) => {
      ready = undefined;
      throw e;
    }));

  const resolveDrawing = (p: string) => {
    let rel = p.trim();
    if (!rel.endsWith(".excalidraw")) rel += ".excalidraw";
    if (!path.isAbsolute(rel) && !rel.includes("/") && !rel.includes(path.sep)) rel = path.join(DEFAULT_DIR, rel);
    return path.resolve(projectRoot, rel);
  };
  const rel = (abs: string) => {
    const r = path.relative(projectRoot, abs);
    return r.startsWith("..") ? abs : r;
  };

  const op = async (body: Record<string, unknown>) => {
    await ensure();
    return client.request<Record<string, unknown>>("POST", "/api/op", body);
  };

  /** Runs a browser-backed op, opening the editor first if no tab is connected. */
  const withEditor = async (file: string, body: Record<string, unknown>) => {
    try {
      return await op(body);
    } catch (e) {
      if (!(e instanceof DaemonError && e.code === "no-editor")) throw e;
      const url = await client.loginUrl(file);
      if (!openInBrowser(url)) {
        throw new Error(`No editor is open. Ask the user to open this link (valid 2 minutes): ${url}`);
      }
      return op({ ...body, waitMs: 20_000 });
    }
  };

  const server = new McpServer(
    { name: "local-first-excalidraw", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Prefer the client's declared workspace root (MCP roots) when it provides one.
  server.server.oninitialized = async () => {
    if (opts.root || process.env.LFX_PROJECT_ROOT) return;
    if (!server.server.getClientCapabilities()?.roots) return;
    try {
      const { roots } = await server.server.listRoots();
      const first = roots.find((r) => r.uri.startsWith("file://"));
      if (first) {
        projectRoot = new URL(first.uri).pathname;
        ready = undefined;
      }
    } catch {
      // keep cwd
    }
  };

  server.registerTool(
    "excalidraw_guide",
    {
      title: "Excalidraw element guide",
      description: "Element format, colours and layout tips. Read once before hand-placing elements.",
      annotations: { readOnlyHint: true },
    },
    async () => text(GUIDE),
  );

  server.registerTool(
    "list_drawings",
    {
      title: "List drawings",
      description: "Lists .excalidraw files in the project (most recently modified first).",
      inputSchema: { dir: z.string().optional().describe("Sub-directory to search (default: whole project)") },
      annotations: { readOnlyHint: true },
    },
    async ({ dir }) => {
      try {
        await ensure();
        const root = dir ? path.resolve(projectRoot, dir) : projectRoot;
        const { drawings } = await client.request<{ drawings: { path: string; mtime: number; size: number }[] }>(
          "POST",
          "/api/list",
          { root },
        );
        if (!drawings.length) return text(`No drawings under ${rel(root) || "."}`);
        return text(drawings.map((d) => `${rel(d.path)}  (${new Date(d.mtime).toISOString().slice(0, 16)}, ${Math.round(d.size / 1024)} KB)`).join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "read_drawing",
    {
      title: "Read drawing",
      description:
        "Compact description of a drawing: every element's id, type, position, size, label and colours; arrows as `from -> to`. Set include_json for raw Excalidraw elements.",
      inputSchema: { path: pathArg, include_json: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ path: p, include_json }) => {
      try {
        const file = resolveDrawing(p);
        const r = (await op({ op: "read", path: file, full: include_json })) as { summary: string; scene?: { elements: unknown[] } };
        let out = `${rel(file)}: ${r.summary}`;
        if (include_json) out += `\n\nelements:\n${JSON.stringify(r.scene?.elements)}`;
        return text(out);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_drawing",
    {
      title: "Create drawing",
      description: "Creates a new .excalidraw file, optionally with initial elements (simplified format, see excalidraw_guide).",
      inputSchema: {
        path: pathArg,
        elements: z.array(skeleton).optional(),
        overwrite: z.boolean().optional().describe("Replace an existing drawing"),
        open: z.boolean().optional().describe("Also open it in the user's browser"),
      },
    },
    async ({ path: p, elements, overwrite, open }) => {
      try {
        const file = resolveDrawing(p);
        const r = await op({ op: "create", path: file, elements: elements ?? [], overwrite });
        let msg = `Created ${rel(file)} with ${(r.created as string[]).length} elements.`;
        if (open) msg += " " + (await openMsg(file));
        return text(msg);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_diagram",
    {
      title: "Create diagram from a graph",
      description:
        "Draws nodes and edges with automatic layered layout - the fastest way to make architecture, flow and dependency diagrams. Creates the file if needed; otherwise appends next to existing content (or replaces it with replace: true).",
      inputSchema: {
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
        open: z.boolean().optional().describe("Also open it in the user's browser"),
      },
    },
    async ({ path: p, nodes, edges, groups, direction, title, replace, open }) => {
      try {
        const file = resolveDrawing(p);
        if (replace) await op({ op: "clear", path: file });
        const r = await op({ op: "diagram", path: file, graph: { nodes, edges, groups, direction, title } });
        let msg = `Drew ${nodes.length} nodes and ${edges?.length ?? 0} edges in ${rel(file)}. Element ids: ${(r.created as string[]).join(", ")}.`;
        if (open) msg += " " + (await openMsg(file));
        return text(msg);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_elements",
    {
      title: "Add elements",
      description: "Adds elements in the simplified format (labels, bound arrows, frames). Creates the drawing if it doesn't exist.",
      inputSchema: {
        path: pathArg,
        elements: z.array(skeleton).min(1),
        placement: z
          .enum(["absolute", "right", "below"])
          .optional()
          .describe("absolute (default) uses your coordinates; right/below shifts the batch next to existing content"),
      },
    },
    async ({ path: p, elements, placement }) => {
      try {
        const file = resolveDrawing(p);
        const r = await op({ op: "add", path: file, elements, placement: placement ?? "absolute" });
        return text(`Added ${(r.created as string[]).length} elements to ${rel(file)}: ${(r.created as string[]).join(", ")}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_elements",
    {
      title: "Update elements",
      description:
        "Changes existing elements by id: position, size, label (null removes it), text, color, or any raw property. Labels re-centre and bound arrows re-route automatically.",
      inputSchema: {
        path: pathArg,
        updates: z
          .array(z.looseObject({ id: z.string(), label: z.union([label, z.null()]), text: z.string().optional(), color }))
          .min(1),
      },
    },
    async ({ path: p, updates }) => {
      try {
        const file = resolveDrawing(p);
        await op({ op: "update", path: file, updates });
        return text(`Updated ${updates.length} element(s) in ${rel(file)}.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_elements",
    {
      title: "Delete elements",
      description: "Deletes elements by id (their labels go too; arrows attached to them are detached).",
      inputSchema: { path: pathArg, ids: z.array(z.string()).min(1) },
      annotations: { destructiveHint: true },
    },
    async ({ path: p, ids }) => {
      try {
        const file = resolveDrawing(p);
        const r = await op({ op: "delete", path: file, ids });
        return text(`Deleted ${(r.deleted as string[]).length} element(s) from ${rel(file)}.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "mermaid_to_drawing",
    {
      title: "Mermaid to drawing",
      description:
        "Converts Mermaid (flowchart, sequence, class diagrams) into editable Excalidraw elements, appended to the drawing. Runs in the local editor tab, which is opened if needed.",
      inputSchema: { path: pathArg, mermaid: z.string().describe("Mermaid source") },
    },
    async ({ path: p, mermaid }) => {
      try {
        const file = resolveDrawing(p);
        const r = await withEditor(file, { op: "mermaid", path: file, text: mermaid });
        return text(`Converted Mermaid into ${(r.created as string[]).length} elements in ${rel(file)}.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "render_drawing",
    {
      title: "Render drawing",
      description: "Returns a PNG of the drawing so you can check layout and readability. Rendered by the local editor tab (opened if needed).",
      inputSchema: {
        path: pathArg,
        max_size: z.number().int().min(200).max(4000).optional().describe("Longest side in px (default 1600)"),
        dark: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: p, max_size, dark }) => {
      try {
        const file = resolveDrawing(p);
        const r = (await withEditor(file, {
          op: "render",
          path: file,
          opts: { format: "png", maxSize: max_size ?? 1600, dark: !!dark },
        })) as { data: string; mime: string };
        return { content: [{ type: "image", data: r.data, mimeType: r.mime }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "export_drawing",
    {
      title: "Export drawing",
      description:
        "Writes an image next to the drawing (or to `output`). SVG/PNG exports embed the scene, so `name.excalidraw.svg` can be shown in a README and re-opened for editing.",
      inputSchema: {
        path: pathArg,
        format: z.enum(["svg", "png"]).optional().describe("Default svg"),
        output: z.string().optional().describe("Output path relative to the project root"),
        dark: z.boolean().optional(),
        embed_scene: z.boolean().optional().describe("Embed the editable scene (default true)"),
      },
    },
    async ({ path: p, format, output, dark, embed_scene }) => {
      try {
        const file = resolveDrawing(p);
        const fmt = format ?? "svg";
        const out = resolveSafePath(path.resolve(projectRoot, output ?? `${file}.${fmt}`), [projectRoot], [`.${fmt}`]);
        const r = (await withEditor(file, {
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
        return text(`Wrote ${rel(out)}. Markdown: ![${path.basename(file, ".excalidraw")}](${rel(out)})`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  const openMsg = async (file: string) => {
    await ensure();
    const url = await client.loginUrl(file);
    return openInBrowser(url)
      ? `Opened ${rel(file)} in the browser.`
      : `Open this link to view it (valid 2 minutes, single use): ${url}`;
  };

  server.registerTool(
    "open_drawing",
    {
      title: "Open drawing",
      description: "Opens the drawing in the user's browser in the local live editor. Changes made by either side sync instantly.",
      inputSchema: { path: pathArg },
    },
    async ({ path: p }) => {
      try {
        const file = resolveDrawing(p);
        if (!fs.existsSync(file)) await op({ op: "create", path: file, elements: [] });
        return text(await openMsg(file));
      } catch (e) {
        return fail(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
