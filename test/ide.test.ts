/**
 * The "IDE for diagrams" features: code links (opening, staleness), drawing file management,
 * git badges and agent-edit tagging. Unit tests first, then a real daemon on a random port
 * with its own state, roots, trash and a fake editor.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { applyChatEvent, type ChatItem, revertSummary } from "../src/shared/chat.js";
import { checkLinks, hashFile, refreshLinks, stampCodeLinks, summarizeLinks } from "../src/server/codelinks.js";
import { copyName, duplicateFile, FileOpError, listFolders, moveFile, moveToTrash } from "../src/server/files.js";
import { drawingStatus, parsePorcelain } from "../src/server/git.js";
import { editorCommand } from "../src/server/open-code.js";
import { el } from "./fixtures.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server", "cli.js");
const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lfx-${name}-`)));
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "ignore" });

// ---------------------------------------------------------------------------
// Code links
// ---------------------------------------------------------------------------

test("new and retargeted code links record the file's hash; URL links drop it", () => {
  const root = tmp("stamp");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "a\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "b\n");
  const box = el("n1", "rectangle", 0, 0, 10, 10, { link: "src/a.ts#L1" }) as any;
  const plain = el("n2", "rectangle", 0, 0, 10, 10);
  const first = stampCodeLinks([box, plain], root);
  assert.equal(first.stamped, 1);
  const stamped = first.elements[0];
  assert.deepEqual(stamped.customData?.lfxCode, { path: "src/a.ts", line: 1, sha: hashFile(path.join(root, "src", "a.ts")) });
  assert.equal(stamped.version, box.version + 1);
  assert.equal(first.elements[1], plain);
  // Idempotent.
  assert.equal(stampCodeLinks(first.elements, root).stamped, 0);
  // Retarget.
  const moved = stampCodeLinks([{ ...stamped, link: "src/b.ts" }], root).elements[0];
  assert.equal((moved.customData?.lfxCode as { path: string }).path, "src/b.ts");
  // No longer a code link.
  const url = stampCodeLinks([{ ...stamped, link: "https://example.com" }], root).elements[0];
  assert.equal(url.customData, undefined);
  // A link to a file that doesn't exist yet has no hash, and isn't restamped until it does.
  const pending = stampCodeLinks([el("n3", "rectangle", 0, 0, 1, 1, { link: "src/new.ts" })], root).elements[0];
  assert.deepEqual(pending.customData?.lfxCode, { path: "src/new.ts" });
  assert.equal(stampCodeLinks([pending], root).stamped, 0);
});

test("checkLinks reports ok, changed and missing, and refreshLinks marks them reviewed", () => {
  const root = tmp("check");
  fs.writeFileSync(path.join(root, "a.ts"), "one\ntwo\n");
  fs.writeFileSync(path.join(root, "b.ts"), "b\n");
  const { elements } = stampCodeLinks(
    [
      el("ok", "rectangle", 0, 0, 1, 1, { link: "a.ts#L2" }),
      el("chg", "rectangle", 0, 0, 1, 1, { link: "b.ts" }),
      el("gone", "rectangle", 0, 0, 1, 1, { link: "a.ts#L40" }),
      el("dead", "rectangle", 0, 0, 1, 1, { link: "b.ts", isDeleted: true }),
    ],
    root,
  );
  fs.writeFileSync(path.join(root, "b.ts"), "b changed\n");
  const reports = checkLinks(elements, root);
  assert.deepEqual(
    reports.map((r) => [r.id, r.state]),
    [["ok", "ok"], ["chg", "changed"], ["gone", "missing"]],
  );
  assert.match(summarizeLinks(reports), /^3 code links: 1 ok, 1 changed, 1 missing\.\n\[chg\] b\.ts: changed\n\[gone\] a\.ts#L40: missing$/);
  assert.equal(summarizeLinks([]), "No code links.");
  const reviewed = refreshLinks(elements, root, ["chg"]);
  assert.deepEqual(reviewed.map((e) => e.id), ["chg"]);
  assert.equal(checkLinks(reviewed, root)[0].state, "ok");
  assert.equal(refreshLinks(elements, root).length, 1, "only links whose file changed are refreshed");
});

test("editor commands for VS Code, its URL fallback, Zed, JetBrains, $EDITOR and templates", () => {
  const none = () => undefined;
  const found = (b: string) => `/bin/${b}`;
  assert.deepEqual(editorCommand("/p/a.ts", 4, "vscode", { find: found }), { cmd: "/bin/code", args: ["-g", "/p/a.ts:4"], via: "vscode" });
  assert.deepEqual(editorCommand("/p/my a.ts", 4, "vscode", { find: none, platform: "darwin" }), { cmd: "open", args: ["vscode://file/p/my%20a.ts:4"], via: "url" });
  assert.deepEqual(editorCommand("/p/a.ts", undefined, "cursor", { find: none, platform: "linux" }), { cmd: "xdg-open", args: ["cursor://file/p/a.ts"], via: "url" });
  assert.deepEqual(editorCommand("/p/a.ts", 4, "zed", { find: found }), { cmd: "/bin/zed", args: ["/p/a.ts:4"], via: "zed" });
  assert.deepEqual(editorCommand("/p/a.ts", 4, "jetbrains", { find: found }), { cmd: "/bin/idea", args: ["--line", "4", "/p/a.ts"], via: "idea" });
  assert.deepEqual(editorCommand("/p/a.ts", 4, "$EDITOR", { env: { EDITOR: "subl -n" } }), { cmd: "subl", args: ["-n", "+4", "/p/a.ts"], via: "$EDITOR" });
  assert.throws(() => editorCommand("/p/a.ts", 4, "$EDITOR", { env: {} }), /neither VISUAL nor EDITOR/);
  assert.deepEqual(editorCommand("/p/a.ts", 4, "nvim-qt --line {line} {file}", {}), { cmd: "nvim-qt", args: ["--line", "4", "/p/a.ts"], via: "template" });
  assert.deepEqual(editorCommand("/p/a.ts", 4, "subl", {}), { cmd: "subl", args: ["/p/a.ts:4"], via: "subl" });
});

// ---------------------------------------------------------------------------
// Files and git
// ---------------------------------------------------------------------------

test("file helpers refuse to overwrite, name copies, and list folders", () => {
  const root = tmp("files");
  const a = path.join(root, "a.excalidraw");
  fs.writeFileSync(a, "{}");
  fs.writeFileSync(path.join(root, "b.excalidraw"), "{}");
  assert.throws(() => moveFile(a, path.join(root, "b.excalidraw")), (e: unknown) => e instanceof FileOpError && e.status === 409);
  assert.equal(copyName(a), path.join(root, "a copy.excalidraw"));
  duplicateFile(a, copyName(a));
  assert.equal(copyName(a), path.join(root, "a copy 2.excalidraw"));
  assert.throws(() => duplicateFile(a, path.join(root, "b.excalidraw")), /already exists/);
  moveFile(a, path.join(root, "sub", "dir", "a.excalidraw"));
  assert.ok(fs.existsSync(path.join(root, "sub", "dir", "a.excalidraw")));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, ".hidden"));
  assert.deepEqual(listFolders([root]).map((f) => path.relative(root, f.path)), ["sub", path.join("sub", "dir")]);
});

test("trash: LFX_TRASH_DIR with unique names, and the XDG layout on Linux", () => {
  const root = tmp("trash");
  const trash = tmp("trash-dir");
  for (let i = 0; i < 2; i++) {
    fs.writeFileSync(path.join(root, "a.excalidraw"), String(i));
    moveToTrash(path.join(root, "a.excalidraw"), { LFX_TRASH_DIR: trash });
  }
  assert.deepEqual(fs.readdirSync(trash).sort(), ["a 2.excalidraw", "a.excalidraw"]);
  const xdg = tmp("xdg");
  fs.writeFileSync(path.join(root, "b.excalidraw"), "{}");
  // With no gio (or gio failing on a temp dir), this falls back to the XDG trash.
  const dest = moveToTrash(path.join(root, "b.excalidraw"), { XDG_DATA_HOME: xdg, PATH: "" }, "linux");
  assert.equal(dest, path.join(xdg, "Trash", "files", "b.excalidraw"));
  assert.match(fs.readFileSync(path.join(xdg, "Trash", "info", "b.excalidraw.trashinfo"), "utf8"), /^\[Trash Info\]\nPath=.*b\.excalidraw\nDeletionDate=\d{4}-/);
  assert.ok(!fs.existsSync(path.join(root, "b.excalidraw")));
});

test("git porcelain parsing", () => {
  const m = parsePorcelain(["?? new.excalidraw", " M edited.excalidraw", "M  staged.excalidraw", "MM both.excalidraw", "R  renamed.excalidraw", "old.excalidraw", "UU conflict.excalidraw", ""].join("\0"));
  assert.deepEqual(Object.fromEntries(m), {
    "new.excalidraw": "untracked",
    "edited.excalidraw": "modified",
    "staged.excalidraw": "staged",
    "both.excalidraw": "modified",
    "renamed.excalidraw": "staged",
    "conflict.excalidraw": "conflict",
  });
});

test("drawing git status in a real repository; none outside one", { skip: !hasGit && "git not installed" }, async () => {
  const repo = tmp("repo");
  gitIn(repo, "init", "-q");
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "docs", "clean.excalidraw"), "{}");
  fs.writeFileSync(path.join(repo, "docs", "edited.excalidraw"), "{}");
  fs.writeFileSync(path.join(repo, "notes.md"), "x");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(repo, "docs", "edited.excalidraw"), '{"a":1}');
  fs.writeFileSync(path.join(repo, "docs", "new.excalidraw"), "{}");
  fs.writeFileSync(path.join(repo, "docs", "staged.excalidraw"), "{}");
  gitIn(repo, "add", "docs/staged.excalidraw");
  fs.writeFileSync(path.join(repo, "notes.md"), "y");
  const docs = path.join(repo, "docs");
  assert.deepEqual(await drawingStatus([docs]), {
    [path.join(docs, "edited.excalidraw")]: "modified",
    [path.join(docs, "new.excalidraw")]: "untracked",
    [path.join(docs, "staged.excalidraw")]: "staged",
  });
  assert.deepEqual(await drawingStatus([tmp("nogit")]), {});
});

test("revert summary says what was kept", () => {
  assert.equal(revertSummary({ revertedCount: 3, keptCount: 0 }), "Changes reverted");
  let items: ChatItem[] = [{ kind: "assistant", id: "t", endpoint: "", parts: [], status: "done", revertable: true, changed: 4 }];
  items = applyChatEvent(items, { type: "reverted", id: "t", restored: 3, skipped: 1 });
  const it = items[0];
  assert.ok(it.kind === "assistant" && it.reverted);
  assert.equal(revertSummary(it), "Reverted 3, kept 1 you edited since");
});

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

let port: number;
let root: string;
let trash: string;
let opened: string;
let daemon: ChildProcess;
let token: string;
let cookie: string;

function call(method: string, route: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { Host: `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json" } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {} }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
const asApp = (method: string, route: string, body?: unknown) => call(method, route, { Cookie: cookie, Origin: `http://127.0.0.1:${port}` }, body);
const asAgent = (body: unknown, agent?: string) => call("POST", "/api/op", { Authorization: `Bearer ${token}`, ...(agent ? { "X-Lfx-Agent": agent } : {}) }, body);

/** An editor tab: a WebSocket that has opened `file`, collecting what the daemon sends. */
async function tab(file: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` } });
  const msgs: any[] = [];
  ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ t: "open", path: file }));
  const next = async (pred: (m: any) => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const i = msgs.findIndex(pred);
      if (i >= 0) return msgs.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out waiting for a message");
  };
  await next((m) => m.t === "scene");
  return { ws, next, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

before(async () => {
  port = await freePort();
  const stateDir = tmp("ide-state");
  root = tmp("ide-root");
  trash = tmp("ide-trash");
  const web = tmp("ide-web");
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>lfx</title>");
  // The "editor": records what it was asked to open.
  opened = path.join(tmp("ide-out"), "opened.txt");
  const fake = path.join(path.dirname(opened), "editor.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(opened)}, process.argv.slice(2).join(" ") + "\\n");`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LFX_PORT: String(port),
    LFX_STATE_DIR: stateDir,
    LFX_ROOTS: root,
    LFX_WEB_DIR: web,
    LFX_NO_BROWSER: "1",
    LFX_HEADLESS: "off",
    LFX_TRASH_DIR: trash,
    LFX_EDITOR: `${process.execPath} ${fake} {file} {line}`,
    LFX_URL: undefined,
    LFX_TOKEN: undefined,
    LFX_IDLE_EXIT_MIN: undefined,
    LFX_ON_DEMAND: undefined,
    LFX_PARENT_PID: String(process.pid),
  };
  daemon = spawn(process.execPath, [CLI, "serve"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  daemon.stderr!.on("data", (c) => (log += c));
  for (let i = 0; i < 100 && !log.includes("listening on"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(log, /listening on/);
  token = fs.readFileSync(path.join(stateDir, "token"), "utf8").trim();
  const { body } = await call("POST", "/api/login-code", { Authorization: `Bearer ${token}` }, {});
  const res = await new Promise<http.IncomingMessage>((resolve) =>
    http.get({ host: "127.0.0.1", port, path: `/login?code=${body.code}`, headers: { Host: `127.0.0.1:${port}` } }, resolve),
  );
  cookie = String(res.headers["set-cookie"]![0]).split(";")[0];
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "repo.ts"), "export const a = 1;\nexport const b = 2;\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
});

after(() => {
  daemon.kill();
});

test("open-code opens the file at the line, and refuses escapes, secrets and URLs", async () => {
  const drawing = path.join(root, "links.excalidraw");
  const ok = await asApp("POST", "/api/open-code", { drawing, link: "src/repo.ts#L2" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.editor, "template");
  for (let i = 0; i < 50 && !fs.existsSync(opened); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readFileSync(opened, "utf8").trim(), `${path.join(root, "src", "repo.ts")} 2`);
  assert.equal((await asApp("POST", "/api/open-code", { drawing, link: "../etc/passwd" })).status, 400);
  assert.equal((await asApp("POST", "/api/open-code", { drawing, link: "https://example.com" })).status, 400);
  assert.equal((await asApp("POST", "/api/open-code", { drawing, link: ".env" })).status, 403);
  assert.equal((await asApp("POST", "/api/open-code", { drawing, link: "src/nope.ts" })).status, 404);
  assert.equal((await call("POST", "/api/open-code", {}, { drawing, link: "src/repo.ts" })).status, 401);
});

test("links made by an agent or typed in the editor are hashed, then go stale and can be reviewed", async () => {
  const drawing = path.join(root, "stale.excalidraw");
  await asAgent({ op: "create", path: drawing, elements: [{ type: "rectangle", id: "repo", x: 0, y: 0, width: 100, height: 60, link: "src/repo.ts#L1" }] });
  let r = await asApp("GET", `/api/links?path=${encodeURIComponent(drawing)}`);
  assert.deepEqual(r.body.links.map((l: any) => [l.id, l.state]), [["repo", "ok"]]);

  // A link typed in the editor: the saving tab gets the hashed element back.
  const t = await tab(drawing);
  const scene = (await asAgent({ op: "read", path: drawing, full: true })).body.scene;
  const typed = { ...el("typed", "rectangle", 200, 0, 50, 50), link: "src/repo.ts" };
  t.send({ t: "save", path: drawing, elements: [...scene.elements, typed], appState: {}, files: {} });
  const echo = await t.next((m) => m.t === "scene" && m.quiet);
  assert.ok(echo.scene.elements.find((e: any) => e.id === "typed").customData.lfxCode.sha);

  fs.appendFileSync(path.join(root, "src", "repo.ts"), "export const c = 3;\n");
  r = await asApp("GET", `/api/links?path=${encodeURIComponent(drawing)}`);
  assert.deepEqual(r.body.links.map((l: any) => l.state), ["changed", "changed"]);
  const read = await asAgent({ op: "read", path: drawing });
  assert.match(read.body.summary, /2 code links: 2 changed\./);

  r = await asApp("POST", "/api/links/review", { path: drawing, ids: ["repo"] });
  assert.equal(r.body.reviewed, 1);
  r = await asAgent({ op: "check_links", path: drawing });
  assert.deepEqual(r.body.links.map((l: any) => [l.id, l.state]).sort(), [["repo", "ok"], ["typed", "changed"]]);
  t.ws.close();
});

test("MCP edits reach open tabs as agent edits, named after the client", async () => {
  const drawing = path.join(root, "agent.excalidraw");
  await asAgent({ op: "create", path: drawing, elements: [] });
  const t = await tab(drawing);
  await asAgent({ op: "add", path: drawing, elements: [{ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }] }, "claude-code");
  const m = await t.next((x) => x.t === "scene");
  assert.equal(m.agent, true);
  assert.equal(m.by, "claude-code");
  t.send({ t: "ping" });
  await t.next((x) => x.t === "pong");
  t.ws.close();
});

test("rename, move, duplicate, trash and new folder, with tabs following", async () => {
  const a = path.join(root, "plan.excalidraw");
  await asAgent({ op: "create", path: a, elements: [{ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }] });
  const t = await tab(a);

  const renamed = path.join(root, "roadmap.excalidraw");
  let r = await asApp("POST", "/api/files/rename", { path: a, to: renamed });
  assert.equal(r.status, 200);
  assert.equal(r.body.path, renamed);
  assert.deepEqual(await t.next((m) => m.t === "moved"), { t: "moved", path: a, to: renamed });
  assert.ok(!fs.existsSync(a) && fs.existsSync(renamed));
  t.ws.close();

  assert.equal((await asApp("POST", "/api/files/rename", { path: renamed, to: path.join(root, "x.txt") })).status, 403);
  assert.equal((await asApp("POST", "/api/files/rename", { path: renamed, to: "/tmp/escape.excalidraw" })).status, 403);

  r = await asApp("POST", "/api/files/duplicate", { path: renamed });
  assert.equal(r.body.path, path.join(root, "roadmap copy.excalidraw"));
  assert.equal(fs.readFileSync(r.body.path, "utf8"), fs.readFileSync(renamed, "utf8"));
  assert.equal((await asApp("POST", "/api/files/rename", { path: r.body.path, to: renamed })).status, 409);

  r = await asApp("POST", "/api/files/folder", { path: path.join(root, "archive") });
  assert.equal(r.status, 200);
  assert.equal((await asApp("POST", "/api/files/folder", { path: path.join(root, "archive") })).status, 409);
  assert.equal((await asApp("POST", "/api/files/folder", { path: "/tmp/lfx-escape" })).status, 403);
  const listed = await asApp("GET", "/api/files");
  assert.ok(listed.body.folders.some((f: any) => f.path === path.join(root, "archive")));

  r = await asApp("POST", "/api/files/move", { path: renamed, dir: path.join(root, "archive") });
  const inArchive = path.join(root, "archive", "roadmap.excalidraw");
  assert.equal(r.body.path, inArchive);
  assert.ok(fs.existsSync(inArchive));

  const t2 = await tab(inArchive);
  r = await asApp("POST", "/api/files/trash", { path: inArchive });
  assert.equal(r.status, 200);
  assert.equal(r.body.trashed, path.join(trash, "roadmap.excalidraw"));
  assert.ok(!fs.existsSync(inArchive));
  await t2.next((m) => m.t === "deleted");
  t2.ws.close();
  assert.equal((await asApp("POST", "/api/files/trash", { path: inArchive })).status, 404);
  assert.equal((await call("POST", "/api/files/trash", {}, { path: inArchive })).status, 401);
});

test("git badges for drawings in the roots", { skip: !hasGit && "git not installed" }, async () => {
  gitIn(root, "init", "-q");
  const r = await asApp("GET", "/api/files/git");
  assert.equal(r.status, 200);
  assert.equal(r.body.status[path.join(root, "stale.excalidraw")], "untracked");
});
