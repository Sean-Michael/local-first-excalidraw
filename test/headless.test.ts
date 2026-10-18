import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { browserArgs, findBrowser, headlessMode } from "../src/server/headless.js";
import { el } from "./fixtures.js";

// dist/test -> repository root
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repo, "dist", "src", "server", "cli.js");
const webIndex = path.join(repo, "dist", "web", "index.html");

test("LFX_HEADLESS defaults to auto", () => {
  assert.equal(headlessMode({}), "auto");
  assert.equal(headlessMode({ LFX_HEADLESS: "off" }), "off");
  assert.equal(headlessMode({ LFX_HEADLESS: "ALWAYS" }), "always");
  assert.equal(headlessMode({ LFX_HEADLESS: "nonsense" }), "auto");
});

test("LFX_BROWSER wins, and a missing binary means no headless browser", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-hb-"));
  const bin = path.join(dir, "my-chrome");
  fs.writeFileSync(bin, "");
  assert.equal(findBrowser({ LFX_BROWSER: bin }, "linux"), bin);
  assert.equal(findBrowser({ LFX_BROWSER: path.join(dir, "nope") }, "linux"), undefined);
  assert.equal(findBrowser({ PATH: dir }, "linux"), undefined);
  fs.renameSync(bin, path.join(dir, "chromium"));
  assert.equal(findBrowser({ PATH: dir }, "linux"), path.join(dir, "chromium"));
});

test("the headless browser runs offline with a throwaway profile", () => {
  const args = browserArgs("/tmp/profile", "http://127.0.0.1:1/login?code=x");
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--user-data-dir=/tmp/profile"));
  assert.ok(args.includes("--no-proxy-server"));
  assert.ok(args.some((a) => a.startsWith("--host-resolver-rules=MAP * ~NOTFOUND")));
  assert.equal(args.at(-1), "http://127.0.0.1:1/login?code=x");
});

// Every daemon started here is stopped at the end, even if its test failed halfway.
const daemons = new Set<TestDaemon>();
after(() => {
  for (const d of daemons) d.stop();
});

/** A daemon on a random port with its own state and root, never the user's. */
class TestDaemon {
  readonly port = 20000 + Math.floor(Math.random() * 20000);
  readonly url = `http://127.0.0.1:${this.port}`;
  readonly state = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-hl-state-"));
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lfx-hl-root-")));
  readonly drawing = path.join(this.root, "architecture.excalidraw");
  proc!: ChildProcess;
  token = "";

  async start(env: Record<string, string>) {
    const docs = path.join(repo, "docs", "diagrams", "architecture.excalidraw");
    if (fs.existsSync(docs)) fs.copyFileSync(docs, this.drawing);
    else {
      // Docker builds don't copy docs/: a small drawing with text does.
      const elements = [el("box", "rectangle", 0, 0, 600, 300), el("t", "text", 40, 40, 300, 25, { text: "Headless", originalText: "Headless", fontSize: 20, fontFamily: 5, groupIds: [] })];
      fs.writeFileSync(this.drawing, JSON.stringify({ type: "excalidraw", version: 2, elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} }));
    }
    daemons.add(this);
    this.proc = spawn(process.execPath, [cli, "serve"], {
      env: {
        ...process.env,
        LFX_PORT: String(this.port),
        LFX_STATE_DIR: this.state,
        LFX_ROOTS: this.root,
        LFX_NO_BROWSER: "1",
        LFX_HEADLESS_START_MS: "10000",
        // If this test process dies, its daemons (and their browsers) go too.
        LFX_PARENT_PID: String(process.pid),
        ...env,
      },
      stdio: ["ignore", "ignore", process.env.LFX_TEST_VERBOSE ? "inherit" : "ignore"],
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${this.url}/api/health`)).ok) break;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.token = fs.readFileSync(path.join(this.state, "token"), "utf8").trim();
  }

  async call(route: string, body?: Record<string, unknown>) {
    const res = await fetch(this.url + route, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  }

  async op(body: Record<string, unknown>) {
    const { status, data } = await this.call("/api/op", body);
    assert.equal(status, 200, String(data.error));
    return data;
  }

  async browserPid(): Promise<number | null> {
    return (await this.call("/api/status")).data.headless.pid;
  }

  stop() {
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGTERM");
  }
}

const gone = async (pid: number, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const browser = findBrowser();
const built = fs.existsSync(webIndex);
// An editor bundle built before renderer mode existed loads, but never connects as a renderer.
const assets = path.join(repo, "dist", "web", "assets");
const hasRenderer = built && fs.existsSync(assets) && fs.readdirSync(assets).some((f) => f.endsWith(".js") && fs.readFileSync(path.join(assets, f), "utf8").includes("Renderer · Excalidraw"));
const skip = !browser ? "no Chrome/Chromium found (install one or set LFX_BROWSER)" : !built ? "editor not built (run npm run build)" : false;
if (skip) console.log(`# skipping headless rendering tests: ${skip}`);

test("the built editor has renderer mode", { skip }, () => {
  assert.ok(hasRenderer, "dist/web is older than the source: run npm run build");
});

// Each test is short; these timeouts make a hung browser fail the test instead of the whole run.
const RENDER_TIMEOUT = 25_000;

describe("headless rendering", { skip: skip || (!hasRenderer && "dist/web is stale") }, () => {
  const d = new TestDaemon();
  before(() => d.start({ LFX_HEADLESS: "always" }), { timeout: 15_000 });
  after(() => d.stop());

  test("renders a PNG without a visible tab, and leaves the drawing alone", { timeout: RENDER_TIMEOUT }, async () => {
    const before = fs.readFileSync(d.drawing, "utf8");
    const out = await d.op({ op: "render", path: d.drawing, opts: { format: "png", maxSize: 1600 } });
    assert.equal(out.mime, "image/png");
    const png = Buffer.from(String(out.data), "base64");
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.ok(png.readUInt32BE(16) > 400 && png.readUInt32BE(20) > 200, "a full-size image");
    if (process.env.LFX_TEST_RENDER_OUT) fs.writeFileSync(process.env.LFX_TEST_RENDER_OUT, png);
    assert.equal(fs.readFileSync(d.drawing, "utf8"), before);
    const { data } = await d.call("/api/status");
    assert.deepEqual(data.editors, [], "the renderer is not an editor");
    assert.ok(data.headless.connected && data.headless.pid);
  });

  test("exports SVG with the bundled fonts embedded", { timeout: RENDER_TIMEOUT }, async () => {
    const out = await d.op({ op: "render", path: d.drawing, opts: { format: "svg" } });
    const svg = Buffer.from(String(out.data), "base64").toString("utf8");
    assert.match(svg, /^<svg/);
    assert.match(svg, /@font-face/);
    assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/, "no remote URLs");
  });

  test("converts Mermaid", { timeout: RENDER_TIMEOUT }, async () => {
    const file = path.join(d.root, "flow.excalidraw");
    await d.op({ op: "create", path: file, elements: [] });
    const out = await d.op({ op: "mermaid", path: file, text: "flowchart LR\n  A[Client] --> B[Server]" });
    assert.ok((out.created as string[]).length >= 3, "two nodes and an arrow");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { elements: { type: string }[] };
    assert.ok(saved.elements.some((e) => e.type === "arrow"));
  });

  test("the browser goes away with the daemon", { timeout: 20_000 }, async () => {
    const pid = (await d.browserPid())!;
    await d.call("/api/shutdown", {});
    assert.ok(await gone(pid), "headless browser still running after the daemon exited");
  });
});

describe("headless browser lifetime", { skip: skip || (!hasRenderer && "dist/web is stale") }, () => {
  test("stops after the idle timeout", { timeout: RENDER_TIMEOUT }, async () => {
    const d = new TestDaemon();
    await d.start({ LFX_HEADLESS: "always", LFX_HEADLESS_IDLE_MIN: "0.02" });
    try {
      await d.op({ op: "render", path: d.drawing });
      const pid = (await d.browserPid())!;
      assert.ok(pid);
      assert.ok(await gone(pid, 15_000), "still running after the idle timeout");
      assert.equal(await d.browserPid(), null);
      // The next request starts a new one.
      await d.op({ op: "render", path: d.drawing });
      assert.ok(await d.browserPid());
    } finally {
      d.stop();
    }
  });

  test("a launch or render that outlasts the idle timeout still completes", { timeout: RENDER_TIMEOUT }, async () => {
    // ~60 ms idle: shorter than any browser start, as on a cold CI runner.
    const d = new TestDaemon();
    await d.start({ LFX_HEADLESS: "always", LFX_HEADLESS_IDLE_MIN: "0.001" });
    try {
      await d.op({ op: "render", path: d.drawing });
      const pid = (await d.browserPid())!;
      assert.ok(pid);
      assert.ok(await gone(pid, 15_000), "the idle shutdown still runs once the request is done");
    } finally {
      d.stop();
    }
  });

  test("does not outlive a daemon that was killed", { timeout: RENDER_TIMEOUT }, async () => {
    const d = new TestDaemon();
    await d.start({ LFX_HEADLESS: "always" });
    await d.op({ op: "render", path: d.drawing });
    const pid = (await d.browserPid())!;
    d.proc.kill("SIGKILL");
    assert.ok(await gone(pid), "headless browser leaked after SIGKILL");
  });
});

describe("a headless page that never connects", { skip: browser ? false : "no Chrome/Chromium found" }, () => {
  // A page without renderer mode, like a stale dist/web: the browser starts but nothing connects.
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-hl-web-"));
  fs.writeFileSync(path.join(stub, "index.html"), "<!doctype html><title>stub</title>");
  const env = { LFX_WEB_DIR: stub, LFX_HEADLESS_START_MS: "1500" };

  test("falls back to asking for a visible editor, once", { timeout: 20_000 }, async () => {
    const d = new TestDaemon();
    await d.start({ ...env, LFX_HEADLESS: "auto" });
    try {
      const first = await d.call("/api/op", { op: "render", path: d.drawing });
      assert.equal(first.status, 409);
      assert.equal(first.data.code, "no-editor");
      assert.equal(first.data.headless, "failed");
      assert.match(first.data.error, /did not connect in time/);
      assert.equal(await d.browserPid(), null, "the stuck browser was stopped");
      // The failure is remembered: the next request doesn't wait for another launch.
      const started = Date.now();
      const again = await d.call("/api/op", { op: "render", path: d.drawing });
      assert.equal(again.status, 409);
      assert.ok(Date.now() - started < 1500 + 3_500, "no second launch");
      assert.equal(await d.browserPid(), null);
    } finally {
      d.stop();
    }
  });

  test("is an error straight away with LFX_HEADLESS=always", { timeout: 20_000 }, async () => {
    const d = new TestDaemon();
    await d.start({ ...env, LFX_HEADLESS: "always" });
    try {
      const first = await d.call("/api/op", { op: "render", path: d.drawing });
      assert.equal(first.status, 502);
      assert.equal(first.data.code, "headless-failed");
      const started = Date.now();
      assert.equal((await d.call("/api/op", { op: "render", path: d.drawing })).status, 502);
      assert.ok(Date.now() - started < 1000);
    } finally {
      d.stop();
    }
  });
});

describe("LFX_HEADLESS=off", () => {
  test("asks for a visible editor instead of rendering headless", { timeout: 20_000 }, async () => {
    const d = new TestDaemon();
    await d.start({ LFX_HEADLESS: "off" });
    try {
      const { status, data } = await d.call("/api/op", { op: "render", path: d.drawing });
      assert.equal(status, 409);
      assert.equal(data.code, "no-editor");
      assert.equal(data.headless, "off");
      assert.equal(await d.browserPid(), null);
    } finally {
      d.stop();
    }
  });
});
