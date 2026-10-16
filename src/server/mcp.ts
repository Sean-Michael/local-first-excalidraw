import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient, DaemonError, openInBrowser } from "./client.js";
import { type Config, VERSION } from "./config.js";
import { SERVER_INSTRUCTIONS } from "./guide.js";
import { contentAttrs, contextFromEnv, markError, withSpan } from "./telemetry.js";
import { drawingTools, type ToolContext, type ToolOutput } from "./tools.js";

function toResult(out: ToolOutput): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: out.text }];
  if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mime });
  return { content };
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
      // Session-scoped: the daemon forgets it on restart instead of keeping every project forever.
      await client.request("POST", "/api/roots", { path: projectRoot, session: true }).catch((e: DaemonError) => {
        // Locked roots (e.g. Docker) are fine as long as the project is inside one of them.
        if (e.status !== 403) throw e;
      });
    })().catch((e) => {
      ready = undefined;
      throw e;
    }));

  /** Calls the daemon, starting it again if it stopped since (idle, or the app quit). */
  const call = async <T>(f: () => Promise<T>): Promise<T> => {
    await ensure();
    try {
      return await f();
    } catch (e) {
      // A daemon restarted since (the macOS app, say) has forgotten this session's root.
      const lostRoot = e instanceof DaemonError && e.code === "outside-roots";
      if (!lostRoot && (e instanceof DaemonError || (await client.healthy()))) throw e;
      ready = undefined;
      await ensure();
      return f();
    }
  };

  const op = (body: Record<string, unknown>) => call(() => client.request<Record<string, unknown>>("POST", "/api/op", body));

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
  // Tool calls wait for the answer, so the first one doesn't run against cwd.
  let rootsKnown: Promise<void> = Promise.resolve();
  server.server.oninitialized = () => {
    if (opts.root || process.env.LFX_PROJECT_ROOT) return;
    if (!server.server.getClientCapabilities()?.roots) return;
    rootsKnown = (async () => {
      try {
        const { roots } = await server.server.listRoots();
        const first = roots.find((r) => r.uri.startsWith("file://"));
        if (first) {
          // fileURLToPath, not URL.pathname: that would keep %20 and other escapes.
          projectRoot = fileURLToPath(first.uri);
          ready = undefined;
        }
      } catch {
        // keep cwd
      }
    })();
  };

  const openMsg = async (file: string) => {
    const url = await call(() => client.loginUrl(file));
    const r = path.relative(projectRoot, file);
    const name = r.startsWith("..") ? file : r;
    return openInBrowser(url)
      ? `Opened ${name} in the browser.`
      : `Open this link to view it (valid 2 minutes, single use): ${url}`;
  };

  const ctx: ToolContext = {
    get projectRoot() {
      return projectRoot;
    },
    op,
    withEditor,
    list: async (root) => {
      const { drawings } = await call(() => client.request<{ drawings: { path: string; mtime: number; size: number }[] }>("POST", "/api/list", { root }));
      return drawings;
    },
    open: openMsg,
  };

  // Started by the in-app assistant (through Claude Code), tool spans join the turn's trace.
  const parent = contextFromEnv();
  for (const def of drawingTools({ currentDrawing: false })) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: def.readOnly ? { readOnlyHint: true } : def.destructive ? { destructiveHint: true } : undefined,
      },
      (args: Record<string, unknown>) => {
        const attrs = {
          "gen_ai.operation.name": "execute_tool",
          "openinference.span.kind": "TOOL",
          "gen_ai.tool.name": def.name,
          "tool.name": def.name,
          "gen_ai.tool.type": "function",
          ...contentAttrs({ "gen_ai.tool.call.arguments": args, "input.value": args }),
        };
        return withSpan(
          `execute_tool ${def.name}`,
          attrs,
          async (span) => {
            try {
              await rootsKnown;
              const out = await def.run(args, ctx);
              span.setAttributes({ "lfx.tool.result_chars": out.text.length, "lfx.tool.image": !!out.image, ...contentAttrs({ "gen_ai.tool.call.result": out.text, "output.value": out.text }) });
              return toResult(out);
            } catch (e) {
              markError(span, "tool_error", (e as Error).message);
              return fail(e);
            }
          },
          { parent },
        );
      },
    );
  }

  await server.connect(new StdioServerTransport());
}
