import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { browserArgs, findBrowser, headlessMode } from "../src/server/headless.js";

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
    fs.copyFileSync(path.join(repo, "docs", "diagrams", "architecture.excalidraw"), this.drawing);
    this.proc = spawn(process.execPath, [cli, "serve"], {
      env: { ...process.env, LFX_PORT: String(this.port), LFX_STATE_DIR: this.state, LFX_ROOTS: this.root, LFX_NO_BROWSER: "1", ...env },
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
const skip = !browser ? "no Chrome/Chromium found (install one or set LFX_BROWSER)" : !built ? "editor not built (run npm run build)" : false;
if (skip) console.log(`# skipping headless rendering tests: ${skip}`);

describe("headless rendering", { skip }, () => {
  const d = new TestDaemon();
  before(() => d.start({ LFX_HEADLESS: "always" }));
  after(() => d.stop());

  test("renders a PNG without a visible tab, and leaves the drawing alone", { timeout: 60_000 }, async () => {
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

  test("exports SVG with the bundled fonts embedded", { timeout: 60_000 }, async () => {
    const out = await d.op({ op: "render", path: d.drawing, opts: { format: "svg" } });
    const svg = Buffer.from(String(out.data), "base64").toString("utf8");
    assert.match(svg, /^<svg/);
    assert.match(svg, /@font-face/);
    assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/, "no remote URLs");
  });

  test("converts Mermaid", { timeout: 60_000 }, async () => {
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

describe("headless browser lifetime", { skip }, () => {
  test("stops after the idle timeout", { timeout: 60_000 }, async () => {
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

  test("does not outlive a daemon that was killed", { timeout: 60_000 }, async () => {
    const d = new TestDaemon();
    await d.start({ LFX_HEADLESS: "always" });
    await d.op({ op: "render", path: d.drawing });
    const pid = (await d.browserPid())!;
    d.proc.kill("SIGKILL");
    assert.ok(await gone(pid), "headless browser leaked after SIGKILL");
  });
});

describe("LFX_HEADLESS=off", { skip: built ? false : "editor not built" }, () => {
  test("asks for a visible editor instead of rendering headless", { timeout: 30_000 }, async () => {
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
