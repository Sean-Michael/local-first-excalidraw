/**
 * Code exploration for the assistant: .gitignore handling, search context, outlines, symbol
 * lookup, the project overview, git_changes, @-mentions, and the in-app tool loop using them
 * with a scripted (fake) OpenAI-compatible model. Everything runs in temporary directories.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { applyChatEvent, type ChatItem } from "../src/shared/chat.js";
import { mentionLabel, mentionTokens, parseMentionQuery } from "../src/shared/mentions.js";
import { CodeError, listFiles, searchFiles } from "../src/server/code.js";
import type { Config } from "../src/server/config.js";
import { startDaemon } from "../src/server/daemon.js";
import { findDefinitions, findSymbol, outlineFile, outlineText, projectOverview } from "../src/server/explore.js";
import { gitChanges, parseChanges } from "../src/server/git-changes.js";
import { changedFiles } from "../src/server/git.js";
import { mentionContext, suggestMentions, typedMentions } from "../src/server/mentions.js";
import { codeTools, sharedCodeTools } from "../src/server/tools.js";

const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lfx-${name}-`)));

function write(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });

const ORDERS = `import type { Pool } from "pg";

export type OrderStatus = "pending" | "paid" | "payment_failed";

export interface OrderRow {
  id: string;
  status: OrderStatus;
}

/** Orders in Postgres. */
export class OrderRepository {
  constructor(private pool: Pool) {}

  async insertPending(userId: string, items: { sku: string; qty: number }[]) {
    return this.pool.query("insert into orders (status) values ('pending')");
  }

  async markPaid(id: string) {
    await this.pool.query("update orders set status = 'paid' where id = $1", [id]);
  }
}

export const MAX_ITEMS = 50;

export async function placeOrder(repo: OrderRepository) {
  const order = await repo.insertPending("u", []);
  await repo.markPaid(order.id);
}
`;

/** A small multi-language project with ignored, vendored and secret files. */
function fixture(): string {
  const root = tmp("explore");
  write(root, {
    "README.md": "# Shop\n\n![badge](x.svg)\n\nA tiny shop split into services.\n",
    "package.json": '{ "name": "shop", "workspaces": ["services/*"] }',
    "docker-compose.yml": "services:\n  orders:\n    build: services/orders\n  db:\n    image: postgres\nvolumes:\n  data:\n",
    "services/orders/package.json": '{ "name": "orders" }',
    "services/orders/Dockerfile": "FROM node:20\n",
    "services/orders/src/server.ts": 'import { placeOrder } from "./repo/orderRepository.js";\napp.post("/orders", placeOrder);\n',
    "services/orders/src/repo/orderRepository.ts": ORDERS,
    "services/orders/src/repo/orderRepository.test.ts": "import { OrderRepository } from './orderRepository';\ntest('x', () => new OrderRepository(pool));\n",
    "services/billing/main.go":
      'package main\n\ntype Server struct {\n\tdb *DB\n}\n\nfunc (s *Server) Charge(w http.ResponseWriter) {\n}\n\nfunc main() {\n\thttp.HandleFunc("/charge", nil)\n}\n',
    "services/billing/go.mod": "module billing\n",
    "tools/report.py": 'import os\n\nMAX_ROWS = 10\n\nclass Report:\n    """A report."""\n\n    def render(self):\n        def inner():\n            pass\n        return 1\n\n@app.get("/report")\ndef handler():\n    pass\n',
    "deploy/k8s/orders.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: orders\n",
    "api/openapi.yaml": "openapi: 3.0.0\ninfo:\n  title: Shop\n",
    "proto/orders.proto": 'syntax = "proto3";\n',
    "docs/diagrams/arch.excalidraw": '{"type":"excalidraw","elements":[]}',
    ".gitignore": "generated/\n*.log\n!keep.log\n",
    "services/.gitignore": "/billing/tmp/\n",
    "services/billing/tmp/cache.go": "package tmp\nfunc OrderRepository() {}\n",
    "generated/out.ts": "export class OrderRepository {}\n",
    "debug.log": "OrderRepository\n",
    "keep.log": "kept OrderRepository\n",
    "node_modules/pg/index.js": "class OrderRepository {}\n",
    ".env": "SECRET=hunter2 OrderRepository\n",
    "config/secrets.yaml": "token: OrderRepository\n",
  });
  return root;
}

// ---------------------------------------------------------------------------
// search and .gitignore
// ---------------------------------------------------------------------------

test(".gitignore: nested files, anchored patterns and negation are respected", () => {
  const root = fixture();
  const files = listFiles(root, {}).split("\n");
  assert.ok(files.includes("keep.log"), "negated pattern re-includes keep.log");
  for (const f of ["debug.log", "generated/out.ts", "services/billing/tmp/cache.go", "node_modules/pg/index.js", ".env", "config/secrets.yaml"]) {
    assert.ok(!files.includes(f), `${f} hidden`);
  }
  assert.ok(files.includes("services/billing/main.go"));
  // A walk that starts below the root still applies the root's rules.
  assert.equal(listFiles(root, { dir: "services/billing" }), "services/billing/go.mod\nservices/billing/main.go");
});

test("search_files: context lines, files_only, and nothing ignored or secret", async () => {
  const root = fixture();
  const files = await searchFiles(root, { pattern: "OrderRepository", files_only: true });
  assert.deepEqual(files.split("\n").sort(), [
    "keep.log (1 match)",
    "services/orders/src/repo/orderRepository.test.ts (2 matches)",
    "services/orders/src/repo/orderRepository.ts (2 matches)",
    "services/orders/src/server.ts (1 match)",
  ]);
  const ctx = await searchFiles(root, { pattern: "markPaid", context: 1, glob: "orderRepository.ts" });
  assert.equal(
    ctx,
    [
      "services/orders/src/repo/orderRepository.ts-17- ",
      "services/orders/src/repo/orderRepository.ts:18:   async markPaid(id: string) {",
      "services/orders/src/repo/orderRepository.ts-19-     await this.pool.query(\"update orders set status = 'paid' where id = $1\", [id]);",
      "--",
      "services/orders/src/repo/orderRepository.ts-26-   const order = await repo.insertPending(\"u\", []);",
      "services/orders/src/repo/orderRepository.ts:27:   await repo.markPaid(order.id);",
      "services/orders/src/repo/orderRepository.ts-28- }",
    ].join("\n"),
  );
  assert.match(await searchFiles(root, { pattern: "status", max_results: 2 }), /stopped at 2 matches/);
});

// ---------------------------------------------------------------------------
// outlines and symbols
// ---------------------------------------------------------------------------

test("outline_file lists declarations, members and routes with line numbers", () => {
  const root = fixture();
  const ts = outlineFile(root, "services/orders/src/repo/orderRepository.ts");
  assert.equal(
    ts.split("\n").slice(1).join("\n"),
    [
      "    3  type OrderStatus",
      "    5  interface OrderRow",
      "   11  class OrderRepository",
      "   14    method insertPending",
      "   18    method markPaid",
      "   23  const MAX_ITEMS",
      "   25  function placeOrder",
    ].join("\n"),
  );
  assert.match(outlineFile(root, "services/orders/src/server.ts"), /2  route POST \/orders/);
  const go = outlineFile(root, "services/billing/main.go");
  assert.match(go, /3  type Server/);
  assert.match(go, /7  method Server\.Charge/);
  assert.match(go, /10  function main/);
  assert.match(go, /11  route HANDLEFUNC \/charge/);
  const py = outlineFile(root, "tools/report.py");
  assert.match(py, /3  const MAX_ROWS/);
  assert.match(py, /5  class Report\n\s+8    method render\n/);
  assert.doesNotMatch(py, /inner/, "nested functions aren't members");
  assert.match(py, /13  route GET \/report\n\s+14  function handler/);
  assert.throws(() => outlineFile(root, "README.md"), CodeError);
  assert.throws(() => outlineFile(root, ".env"), /secret/);
});

test("outlines for Rust, Java, Kotlin, C# and Ruby", () => {
  const names = (text: string, lang: Parameters<typeof outlineText>[1]) => outlineText(text, lang).map((s) => `${s.depth}${s.kind} ${s.name}`);
  assert.deepEqual(names("pub struct Order {\n    id: u64,\n}\n\nimpl Order {\n    pub fn new() -> Self {\n        todo!()\n    }\n}\n\npub fn main() {}\n", "rs"), [
    "0struct Order",
    "0impl Order",
    "1method new",
    "0function main",
  ]);
  assert.deepEqual(names("package a;\n\npublic class OrderService {\n    private final Repo repo;\n\n    public Order place(String id) {\n        return repo.find(id);\n    }\n}\n", "java"), [
    "0class OrderService",
    "1method place",
  ]);
  assert.deepEqual(names("class OrderService(val repo: Repo) {\n    fun place(id: String): Order {\n        return repo.find(id)\n    }\n}\n", "java"), ["0class OrderService", "1method place"]);
  assert.deepEqual(names("namespace Shop.Orders\n{\n    public class OrderService\n    {\n        public async Task<Order> Place(string id)\n        {\n        }\n    }\n}\n", "cs"), [
    "0namespace Shop.Orders",
    "0class OrderService",
    "1method Place",
  ]);
  assert.deepEqual(names("module Shop\n  class Order\n    def paid?\n    end\n  end\nend\n", "rb"), ["0module Shop", "0class Order", "1method paid?"]);
});

test("find_symbol ranks the definition first, narrows Class.method, and lists references", () => {
  const root = fixture();
  const defs = findDefinitions(root, "OrderRepository");
  assert.equal(defs.length, 1, "ignored, vendored and secret copies don't count");
  assert.deepEqual([defs[0].rel, defs[0].line, defs[0].end, defs[0].kind], ["services/orders/src/repo/orderRepository.ts", 11, 22, "class"]);
  const member = findSymbol(root, { name: "OrderRepository.markPaid" });
  assert.match(member, /orderRepository\.ts:18-22 {2}method OrderRepository\.markPaid {2}async markPaid\(id: string\) \{/);
  const withRefs = findSymbol(root, { name: "OrderRepository", references: true });
  assert.match(withRefs, /References \(4\):/);
  assert.match(withRefs, /orderRepository\.test\.ts:1:/);
  assert.doesNotMatch(withRefs, /orderRepository\.ts:11:/, "the definition isn't a reference");
  assert.match(findSymbol(root, { name: "Nope" }), /No definition of Nope/);
  assert.throws(() => findSymbol(root, { name: "a b(" }), CodeError);
  // Prefix matching for the mention picker.
  assert.deepEqual(findDefinitions(root, "Order", { prefix: true }).map((d) => d.name).sort(), ["OrderRepository", "OrderRow", "OrderStatus"]);
});

test("project_overview shows the tree, languages, manifests, entry points, README and drawings", () => {
  const root = fixture();
  const o = projectOverview(root);
  assert.match(o, /^Project — \d+ files/);
  assert.match(o, /README \(README\.md\): Shop: A tiny shop split into services\./);
  assert.match(o, /Languages: TypeScript 3, Go 2, Python 1|Languages: TypeScript 3, .*Go/);
  assert.match(o, /docker-compose\.yml \(Docker Compose: services orders, db\)/);
  assert.match(o, /services\/orders\/package\.json \(npm package orders\)/);
  assert.match(o, /services\/billing\/go\.mod \(Go module\)/);
  assert.match(o, /services\/orders\/Dockerfile \(Dockerfile\)/);
  assert.match(o, /deploy\/k8s\/orders\.yaml \(Kubernetes Deployment\)/);
  assert.match(o, /api\/openapi\.yaml \(OpenAPI\)/);
  assert.match(o, /proto\/orders\.proto \(protobuf\)/);
  assert.match(o, /Likely entry points:\n {2}services\/billing\/main\.go\n {2}services\/orders\/src\/server\.ts/);
  assert.match(o, /\n {2}services\/ \(\d+\)\n {4}billing\/ \(2\)\n {4}orders\/ \(5\)/);
  assert.match(o, /Drawings: docs\/diagrams\/arch\.excalidraw/);
  assert.doesNotMatch(o, /generated|node_modules|secrets\.yaml|\.env\b/);
  const sub = projectOverview(root, { dir: "services/orders", depth: 1 });
  assert.match(sub, /^services\/orders — 5 files/);
  assert.match(sub, /\n {2}src\/ \(3\)/);
  assert.throws(() => projectOverview(root, { dir: "../" }), CodeError);
});

// ---------------------------------------------------------------------------
// git_changes
// ---------------------------------------------------------------------------

function repo(): string {
  const root = tmp("git");
  git(root, "init", "-q");
  write(root, { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n", "README.md": "# r\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "First");
  write(root, { "src/c.ts": "export const c = 1;\n" });
  fs.rmSync(path.join(root, "src/b.ts"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Add c, drop b");
  return root;
}

test("git_changes: uncommitted changes, untracked files, and secrets left out", async () => {
  const root = repo();
  write(root, { "src/a.ts": "export const a = 2;\nexport const aa = 3;\n", "src/new.ts": "x\n", ".env": "SECRET=1\n", "keys/id_rsa": "k\n" });
  git(root, "add", ".env");
  const out = await gitChanges(root);
  assert.match(out, /^Uncommitted changes \(working tree and staged, against HEAD \w+ Add c, drop b on main\)/);
  assert.match(out, /2 files changed \(1 modified, 1 untracked\), \+2 -1/);
  assert.match(out, /\n {2}M src\/a\.ts \+2 -1/);
  assert.match(out, /\n {2}\? src\/new\.ts/);
  assert.doesNotMatch(out, /\.env|id_rsa/);
  const diff = await gitChanges(root, { path: "src/a.ts", diff: true });
  assert.match(diff, /-export const a = 1;\n\+export const a = 2;/);
  await assert.rejects(gitChanges(root, { path: ".env", diff: true }), /looks like a secret/);
  await assert.rejects(gitChanges(root, { path: "../x" }), /outside the project/);
  const sub = await gitChanges(path.join(root, "src"));
  assert.match(sub, /\n {2}M a\.ts/, "paths are relative to the project root");
});

test("git_changes: the last N commits, ref ranges, and bad input", async () => {
  const root = repo();
  const last = await gitChanges(root, { last: 1 });
  assert.match(last, /^Last 1 commit, newest first:\n\n\w+ \d{4}-\d\d-\d\d Test: Add c, drop b\n {2}2 files changed \(1 deleted, 1 added\), \+1 -1\n {4}D src\/b\.ts \+0 -1\n {4}A src\/c\.ts \+1 -0/);
  const both = await gitChanges(root, { last: 5 });
  assert.match(both, /Last 5 commits[\s\S]*Add c, drop b[\s\S]*First\n {2}3 files changed \(3 added\)/);
  const range = await gitChanges(root, { from: "HEAD~1", to: "HEAD" });
  assert.match(range, /^Changes from HEAD~1 to HEAD\n2 files changed/);
  assert.equal(await gitChanges(root, { from: "HEAD~1..HEAD" }), range);
  const withDiff = await gitChanges(root, { last: 1, diff: true, path: "src/c.ts" });
  assert.match(withDiff, /\+export const c = 1;/);
  assert.doesNotMatch(withDiff, /b\.ts/);
  await assert.rejects(gitChanges(root, { from: "--output=/tmp/x" }), /Not a valid git ref/);
  await assert.rejects(gitChanges(root, { from: "nope" }), CodeError);
  assert.match(await gitChanges(root), /No changes\.\nTo see what the last commits changed/);
  await assert.rejects(gitChanges(tmp("nogit")), /isn't a git repository/);
});

test("git changes parsing joins name-status and numstat, renames included", () => {
  const files = parseChanges("M\0a.ts\0R087\0old.ts\0new.ts\0A\0.env\0", "3\t1\ta.ts\0" + "2\t2\t\0old.ts\0new.ts\0" + "-\t-\tlogo.png\0");
  assert.deepEqual(files, [
    { status: "M", path: "a.ts", added: 3, deleted: 1 },
    { status: "R", from: "old.ts", path: "new.ts", added: 2, deleted: 2 },
  ]);
});

// ---------------------------------------------------------------------------
// mentions
// ---------------------------------------------------------------------------

test("mention syntax: folders, line ranges, symbols and typed tokens", () => {
  assert.deepEqual(parseMentionQuery("src/orders/"), { target: "src/orders/", lines: undefined, folder: true, symbol: false });
  assert.deepEqual(parseMentionQuery("src/a.ts:10-40"), { target: "src/a.ts", lines: [10, 40], folder: false, symbol: false });
  assert.deepEqual(parseMentionQuery("src/a.ts#L40-L10").lines, [10, 40]);
  assert.deepEqual(parseMentionQuery("@src/a.ts:7").lines, [7, 7]);
  assert.deepEqual(parseMentionQuery("a.ts:1-100000").lines, [1, 400], "ranges are capped");
  assert.equal(parseMentionQuery("OrderRepository").symbol, true);
  assert.equal(parseMentionQuery("OrderRepository.markPaid").symbol, true);
  assert.equal(parseMentionQuery("server.ts").symbol, false);
  assert.deepEqual(mentionTokens("Explain @services/orders/ and @a.ts:3-9, then @OrderRepository. Mail me@example.com (@b.ts)"), [
    "services/orders/",
    "a.ts:3-9",
    "OrderRepository",
    "b.ts",
  ]);
  assert.equal(mentionLabel({ kind: "folder", path: "/p/src/orders", rel: "src/orders/" }), "orders/");
  assert.equal(mentionLabel({ kind: "file", path: "/p/src/a.ts", lines: [3, 9] }), "a.ts:3-9");
  assert.equal(mentionLabel({ kind: "symbol", path: "/p/x.ts", symbol: "OrderRepository" }), "OrderRepository");
});

test("mention suggestions: folders, symbols, line ranges, and changed files first", () => {
  const root = fixture();
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  for (const f of listFiles(root, {}).split("\n")) fs.utimesSync(path.join(root, f), old, old);
  const changed = new Set(["services/orders/src/server.ts"]);
  const plain = suggestMentions(root, "", { limit: 50 }).filter((s) => s.kind === "file");
  const boosted = suggestMentions(root, "", { changed, limit: 50 }).filter((s) => s.kind === "file");
  assert.notEqual(plain[0].rel, "services/orders/src/server.ts");
  assert.equal(boosted[0].rel, "services/orders/src/server.ts");
  assert.equal(boosted[0].changed, true);
  // A recently edited file outranks an old one with an equal match.
  fs.utimesSync(path.join(root, "tools/report.py"), new Date(), new Date());
  const recent = suggestMentions(root, "", { limit: 50 }).filter((s) => s.kind === "file");
  assert.equal(recent[0].rel, "tools/report.py");

  const folders = suggestMentions(root, "orders/");
  assert.deepEqual(folders.map((s) => `${s.kind} ${s.rel}`), ["folder services/orders/"]);
  const lines = suggestMentions(root, "server.ts:2-3");
  assert.deepEqual(lines.map((s) => [s.kind, s.rel, s.lines]), [["file", "services/orders/src/server.ts", [2, 3]]]);
  const sym = suggestMentions(root, "OrderRepo");
  assert.deepEqual(sym[0], {
    kind: "symbol",
    path: path.join(root, "services/orders/src/repo/orderRepository.ts"),
    rel: "services/orders/src/repo/orderRepository.ts",
    lines: [11, 22],
    symbol: "OrderRepository",
    detail: "class · services/orders/src/repo/orderRepository.ts:11",
  });
  assert.ok(!suggestMentions(root, "").some((s) => s.rel.includes("generated") || s.rel === ".env"));
});

test("typed mentions resolve paths, suffixes, ranges and symbols; context is bounded", () => {
  const root = fixture();
  const found = typedMentions(root, "@orders/ @services/orders/src/server.ts:1-1 @OrderRepository @nothing-here @billing/main.go", []);
  assert.deepEqual(
    found.map((m) => [m.kind, path.relative(root, m.path), m.lines, m.symbol]),
    [
      ["folder", "services/orders", undefined, undefined],
      ["file", "services/orders/src/server.ts", [1, 1], undefined],
      ["symbol", "services/orders/src/repo/orderRepository.ts", [11, 22], "OrderRepository"],
      ["file", "services/billing/main.go", undefined, undefined],
    ],
  );
  // Already picked from the list: not attached twice.
  assert.equal(typedMentions(root, "@services/billing/main.go", [{ kind: "file", path: path.join(root, "services/billing/main.go") }]).length, 0);
  assert.equal(typedMentions(root, "@.env @config/secrets.yaml @missing.ts", []).length, 0);

  const folder = mentionContext(root, found[0], 40_000);
  assert.match(folder, /^Mentioned folder services\/orders\/ \(an overview, not every file\):\n<folder>\nservices\/orders — 5 files/);
  assert.match(folder, /services\/orders\/src\/repo\/orderRepository\.ts: type OrderStatus:3; interface OrderRow:5; class OrderRepository:11 \(insertPending, markPaid\); const MAX_ITEMS:23; function placeOrder:25/);
  assert.doesNotMatch(folder, /export class/, "an overview, not the files");
  const sym = mentionContext(root, found[2], 40_000);
  assert.match(sym, /^Mentioned symbol OrderRepository, its definition:\n<file>\nservices\/orders\/src\/repo\/orderRepository\.ts \(lines 11-22 of 29\)/);
  assert.match(mentionContext(root, found[1], 40_000), /lines 1-1 of 3\)\n {4}1 {2}import/);
  assert.match(mentionContext(root, found[0], 200), /… truncated/);
});

test("changedFiles lists uncommitted files relative to a root inside the repository", async () => {
  const root = repo();
  write(root, { "src/a.ts": "changed\n", "src/z.ts": "new\n", "README.md": "changed\n" });
  assert.deepEqual([...(await changedFiles(path.join(root, "src")))].sort(), ["a.ts", "z.ts"]);
  assert.deepEqual([...(await changedFiles(tmp("plain")))], []);
});

test("project_overview and git_changes are the code tools shared with MCP", () => {
  assert.deepEqual(sharedCodeTools().map((t) => t.name), ["project_overview", "git_changes"]);
  const names = codeTools().map((t) => t.name);
  for (const n of ["project_overview", "list_files", "search_files", "outline_file", "find_symbol", "read_file", "git_changes"]) assert.ok(names.includes(n), n);
  assert.ok(codeTools().every((t) => t.readOnly));
});

// ---------------------------------------------------------------------------
// The in-app assistant with a non-Claude-Code endpoint, driven by a scripted model
// ---------------------------------------------------------------------------

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const oaChunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (id: string, name: string, args: unknown) => [oaChunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), "data: [DONE]\n\n"];

/** An OpenAI-compatible server that answers each request with the next scripted reply. */
async function fakeModel(script: ((n: number) => string[])) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of script(requests.length)) res.write(chunk);
      res.end();
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
}

let cfg: Config;
let daemon: http.Server;
let project: string;
let cookie: string;
const base = () => `http://127.0.0.1:${cfg.port}`;

before(async () => {
  project = fixture();
  git(project, "init", "-q");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "Initial");
  const port = await freePort();
  cfg = { stateDir: tmp("state"), host: "127.0.0.1", port, allowedHosts: new Set([`127.0.0.1:${port}`]), defaultRoots: [project], allowRootRegistration: true, webDir: tmp("web") };
  daemon = await startDaemon(cfg);
  const token = fs.readFileSync(path.join(cfg.stateDir, "token"), "utf8").trim();
  const { code } = (await (await fetch(`${base()}/api/login-code`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" })).json()) as { code: string };
  const login = await fetch(`${base()}/login?code=${code}`, { redirect: "manual" });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
});

after(() => {
  daemon.closeAllConnections();
  daemon.close();
});

const api = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(base() + route, { method, headers: { Cookie: cookie, Origin: base(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
};

/** An editor tab on `file` that sends one chat message and waits for its turn to end. */
async function chat(file: string, text: string, extra: Record<string, unknown> = {}): Promise<ChatItem[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws`, { headers: { Cookie: cookie, Origin: base() } });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  let items: ChatItem[] = [];
  let session = "";
  const done = new Promise<void>((resolve, reject) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "chat-error") reject(new Error(m.message));
      if (m.t !== "chat") return;
      if (m.ev.type === "history") {
        if (!session) {
          session = m.ev.session;
          ws.send(JSON.stringify({ t: "chat-send", path: file, text, selection: [], mentions: [], ...extra }));
        }
        items = m.ev.items;
      } else if (m.session === session) items = applyChatEvent(items, m.ev);
      if (m.ev.type === "turn-end") resolve();
    });
  });
  ws.send(JSON.stringify({ t: "open", path: file }));
  await done;
  ws.close();
  return items;
}

test("in-app assistant: a non-Claude-Code model explores with the code tools, then draws with code links", async () => {
  write(project, { "services/orders/src/server.ts": 'import { placeOrder } from "./repo/orderRepository.js";\napp.post("/orders", placeOrder);\napp.get("/orders/:id", getOrder);\n' });
  const model = await fakeModel((n) => {
    if (n === 1) return call("c1", "project_overview", {});
    if (n === 2) return call("c2", "find_symbol", { name: "OrderRepository" });
    if (n === 3) return call("c3", "git_changes", {});
    if (n === 4) return call("c4", "outline_file", { path: "services/orders/src/repo/orderRepository.ts" });
    if (n === 5)
      return call("c5", "create_diagram", {
        nodes: [
          { id: "server", label: "orders server", code: "services/orders/src/server.ts:2" },
          { id: "repo", label: "OrderRepository", code: "services/orders/src/repo/orderRepository.ts:11" },
        ],
        edges: [{ from: "server", to: "repo" }],
      });
    return [oaChunk({ content: "Drew the orders service." }, "stop"), "data: [DONE]\n\n"];
  });
  try {
    await api("PUT", "/api/ai/settings", { enabled: true, active: "m", endpoints: [{ id: "m", kind: "openai", baseUrl: model.url, model: "local" }] });
    const file = path.join(project, "docs", "diagrams", "orders.excalidraw");
    const items = await chat(file, "Diagram the orders service");
    const turn = items.find((i) => i.kind === "assistant");
    assert.ok(turn && turn.kind === "assistant" && turn.status === "done", JSON.stringify(turn));
    const tools = turn.parts.filter((p) => p.type === "tool");
    assert.deepEqual(tools.map((p) => p.type === "tool" && `${p.name}:${p.status}`), ["project_overview:ok", "find_symbol:ok", "git_changes:ok", "outline_file:ok", "create_diagram:ok"]);

    const first = model.requests[0];
    const offered = first.tools.map((t: any) => t.function.name);
    for (const n of ["project_overview", "find_symbol", "outline_file", "git_changes", "search_files"]) assert.ok(offered.includes(n), n);
    assert.match(first.messages[0].content, /project_overview, find_symbol, outline_file/);
    assert.match(first.messages[0].content, /Budget about 10-15 exploration calls/);
    // Each tool's result went back to the model.
    const result = (n: number) => model.requests[n].messages.filter((m: any) => m.role === "tool").pop().content as string;
    assert.match(result(1), /Docker Compose: services orders, db/);
    assert.match(result(2), /orderRepository\.ts:11-22 {2}class OrderRepository/);
    assert.match(result(3), /M services\/orders\/src\/server\.ts \+1 -0/);
    assert.match(result(4), /18 {4}method markPaid/);

    // The nodes link to the code they stand for.
    const els = JSON.parse(fs.readFileSync(file, "utf8")).elements;
    assert.ok(els.some((e: any) => e.link === "services/orders/src/repo/orderRepository.ts#L11"));

    // Asking about the selected node attaches its linked code; typed mentions attach a folder and a symbol.
    const repoNode = els.find((e: any) => e.link === "services/orders/src/repo/orderRepository.ts#L11");
    await chat(file, "What does this do? Compare with @billing/ and @placeOrder", { selection: [repoNode.id] });
    const ctx: string = model.requests[model.requests.length - 1].messages.filter((m: any) => m.role === "user").pop().content;
    assert.match(ctx, /Code linked from selected \[\w+\] \(services\/orders\/src\/repo\/orderRepository\.ts:11\):\n<file>\nservices\/orders\/src\/repo\/orderRepository\.ts \(lines 8-29 of 29\)/);
    assert.match(ctx, /Mentioned folder services\/billing\/ \(an overview, not every file\)/);
    assert.match(ctx, /Mentioned symbol placeOrder, its definition:\n<file>\nservices\/orders\/src\/repo\/orderRepository\.ts \(lines 25-29 of 29\)/);
  } finally {
    model.close();
  }
});

test("the mention picker endpoint ranks git-modified files first and offers folders and symbols", async () => {
  const file = path.join(project, "docs", "diagrams", "orders.excalidraw");
  const q = async (s: string) => (await api("GET", `/api/ai/mentions?path=${encodeURIComponent(file)}&q=${encodeURIComponent(s)}`)).body.items as any[];
  const files = (await q("")).filter((i) => i.kind === "file");
  assert.equal(files[0].rel, "services/orders/src/server.ts", "modified in the previous test");
  assert.equal(files[0].changed, true);
  assert.deepEqual((await q("billing/")).map((i: any) => `${i.kind} ${i.rel}`), ["folder services/billing/"]);
  assert.ok((await q("placeOrd")).some((i: any) => i.kind === "symbol" && i.symbol === "placeOrder"));
});
