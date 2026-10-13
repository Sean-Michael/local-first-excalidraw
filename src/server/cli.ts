#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DaemonClient, openInBrowser } from "./client.js";
import { baseUrl, loadConfig, VERSION } from "./config.js";

const HELP = `lfx ${VERSION} - local-first Excalidraw

Usage:
  lfx open [file.excalidraw]   Open the editor (starts the daemon if needed)
  lfx url [file.excalidraw]    Print a one-time sign-in link instead of opening a browser
  lfx serve                    Run the daemon in the foreground
  lfx mcp [--root DIR]         MCP server over stdio (for coding agents)
  lfx status                   Show daemon status
  lfx stop                     Stop the daemon
  lfx proxy LISTEN_PORT TARGET_HOST:PORT
                               Forward TCP (used by the Docker egress-isolation setup)

Environment:
  LFX_PORT (7467)  LFX_STATE_DIR (~/.local-first-excalidraw)  LFX_ROOTS (~/Excalidraw)
  LFX_DEFAULT_DIR (docs/diagrams)  LFX_NO_BROWSER=1  LFX_LOCK_ROOTS=1
`;

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  const cfg = loadConfig();

  switch (cmd) {
    case "serve": {
      const { startDaemon } = await import("./daemon.js");
      try {
        await startDaemon(cfg);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
          console.error(`Port ${cfg.port} is already in use (is the daemon already running? try \`lfx status\`).`);
          process.exit(1);
        }
        throw e;
      }
      console.error(`local-first-excalidraw ${VERSION} listening on ${baseUrl(cfg)} (state: ${cfg.stateDir})`);
      const stop = () => process.exit(0);
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "mcp": {
      const { runMcp } = await import("./mcp.js");
      await runMcp(cfg, { root: argValue(args, "--root") });
      return;
    }
    case "open":
    case "url": {
      const client = new DaemonClient(cfg);
      await client.ensure();
      let file: string | undefined;
      if (args[0]) {
        file = path.resolve(args[0].endsWith(".excalidraw") ? args[0] : `${args[0]}.excalidraw`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await client.request("POST", "/api/roots", { path: path.dirname(file) }).catch(() => {});
        if (!fs.existsSync(file)) await client.request("POST", "/api/op", { op: "create", path: file, elements: [] });
      }
      const url = await client.loginUrl(file);
      if (cmd === "url" || !openInBrowser(url)) console.log(url);
      return;
    }
    case "status": {
      const client = new DaemonClient(cfg);
      if (!(await client.healthy())) {
        console.log("Daemon is not running.");
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await client.request("GET", "/api/status"), null, 2));
      return;
    }
    case "stop": {
      const client = new DaemonClient(cfg);
      if (await client.healthy()) {
        await client.request("POST", "/api/shutdown", {});
        for (let i = 0; i < 30 && (await client.healthy()); i++) await new Promise((r) => setTimeout(r, 100));
      }
      console.log("Stopped.");
      return;
    }
    case "proxy": {
      const listen = Number(args[0]);
      const [host, port] = (args[1] ?? "").split(":");
      if (!listen || !host || !port) throw new Error("Usage: lfx proxy LISTEN_PORT TARGET_HOST:PORT");
      net
        .createServer((src) => {
          const dst = net.connect(Number(port), host);
          src.pipe(dst).pipe(src);
          const close = () => {
            src.destroy();
            dst.destroy();
          };
          src.on("error", close);
          dst.on("error", close);
        })
        .listen(listen, "0.0.0.0", () => console.error(`proxy :${listen} -> ${host}:${port}`));
      return;
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`lfx: ${(e as Error).message}`);
  process.exit(1);
});
