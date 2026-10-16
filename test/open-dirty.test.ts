/**
 * Opening a drawing in the real editor (headless Chrome) must not write it: the editor
 * normalizes text with real font metrics on load, and that is not an edit. An agent's edit
 * that arrives while the drawing is open is still saved, with the editor's fixes.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { browserArgs, findBrowser } from "../src/server/headless.js";
import { el } from "./fixtures.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repo, "dist", "src", "server", "cli.js");
const built = fs.existsSync(path.join(repo, "dist", "web", "index.html"));
const browser = findBrowser();
const skip = !browser ? "no Chrome/Chromium found (install one or set LFX_BROWSER)" : !built ? "editor not built (run npm run build)" : false;

const IDLE_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A two-line arrow label stored where Excalidraw's first normalization pass leaves it: the
 * height of two lines, but centred as if it had one. The editor used to "fix" and save it.
 */
function halfNormalizedLabel(): string {
  const arrow = el("arr", "arrow", 0, 100, 300, 0, { points: [[0, 0], [300, 0]], boundElements: [{ id: "lbl", type: "text" }] });
  const label = el("lbl", "text", 60, 91, 177, 40, {
    text: "save scene (debounced\n250 ms)",
    originalText: "save scene (debounced\n250 ms)",
    fontSize: 16,
    fontFamily: 5,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: "arr",
    autoResize: true,
    lineHeight: 1.25,
    groupIds: [],
  });
  return JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: [arrow, label], appState: { viewBackgroundColor: "#ffffff" }, files: {} }, null, 2);
}

describe("opening drawings in the editor", { skip }, () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const url = `http://127.0.0.1:${port}`;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-open-state-"));
  // A copy of docs/diagrams (when present) plus a synthetic case; never the repository's files.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lfx-open-root-")));
  const browsers: ChildProcess[] = [];
  let daemon: ChildProcess;
  let token = "";

  const call = async (route: string, body?: Record<string, unknown>) => {
    const res = await fetch(url + route, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await res.json()) as Record<string, any>;
  };

  /** Opens `file` in a fresh headless editor tab and waits until it is connected to it. */
  const open = async (file: string) => {
    const { code } = await call("/api/login-code", { path: file });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-open-profile-"));
    const child = spawn(browser!, browserArgs(profile, `${url}/login?code=${encodeURIComponent(code)}`), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    browsers.push(child);
    for (let i = 0; i < 200; i++) {
      const { editors } = await call("/api/status");
      if ((editors as { path: string | null }[]).some((e) => e.path === file)) return;
      await sleep(100);
    }
    throw new Error(`the editor never opened ${file}`);
  };

  before(async () => {
    const docs = path.join(repo, "docs", "diagrams");
    if (fs.existsSync(docs)) for (const f of fs.readdirSync(docs)) if (f.endsWith(".excalidraw")) fs.copyFileSync(path.join(docs, f), path.join(root, f));
    fs.writeFileSync(path.join(root, "half-normalized.excalidraw"), halfNormalizedLabel());
    daemon = spawn(process.execPath, [cli, "serve"], {
      env: { ...process.env, LFX_PORT: String(port), LFX_STATE_DIR: state, LFX_ROOTS: root, LFX_NO_BROWSER: "1", LFX_HEADLESS: "off", LFX_PARENT_PID: String(process.pid) },
      stdio: ["ignore", "ignore", process.env.LFX_TEST_VERBOSE ? "inherit" : "ignore"],
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${url}/api/health`)).ok) break;
      } catch {
        // not listening yet
      }
      await sleep(100);
    }
    token = fs.readFileSync(path.join(state, "token"), "utf8").trim();
  });

  after(() => {
    for (const b of browsers) b.kill("SIGTERM");
    daemon?.kill("SIGTERM");
  });

  test("viewing leaves every drawing's bytes alone", { timeout: 60_000 }, async () => {
    const files = fs.readdirSync(root).filter((f) => f.endsWith(".excalidraw")).map((f) => path.join(root, f));
    const before = new Map(files.map((f) => [f, fs.readFileSync(f)]));
    await Promise.all(files.map(open));
    await sleep(IDLE_MS);
    for (const f of files) assert.ok(fs.readFileSync(f).equals(before.get(f)!), `${path.basename(f)} was rewritten just by opening it`);
  });

  test("an agent's edit while the drawing is open is saved, with real font metrics", { timeout: 60_000 }, async () => {
    const file = path.join(root, "half-normalized.excalidraw");
    const out = await call("/api/op", { op: "add", path: file, elements: [{ type: "rectangle", id: "box", x: 0, y: 300, width: 120, height: 60, label: "A label long enough to wrap" }] });
    assert.deepEqual(out.created?.includes("box"), true, JSON.stringify(out));
    // The editor re-measures the agent's label with the real font and saves that fix.
    let label: Record<string, any> | undefined;
    for (let i = 0; i < 100; i++) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { elements: Record<string, any>[] };
      label = saved.elements.find((e) => e.containerId === "box");
      if (label && label.version > 1) break;
      await sleep(100);
    }
    assert.ok(label && label.version > 1, "the editor's re-measured label was saved");
    assert.match(String(label.text), /\n/, "wrapped to the box with real metrics");
  });
});
