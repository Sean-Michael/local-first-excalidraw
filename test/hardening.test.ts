import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claudeCodeArgs, claudeCodeSettings } from "../src/server/ai/claude-code.js";
import { compareVersions } from "../src/server/client.js";
import { CodeError, globToRegExp, isSecretFile, readFile, SECRET_GLOB_EXCEPTIONS, SECRET_GLOBS, searchFiles } from "../src/server/code.js";
import { type Config, loadOrCreateToken, writeFileAtomic } from "../src/server/config.js";
import { resolveSafePath } from "../src/server/security.js";

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lfx-${name}-`));

const SECRETS = [
  ".git/config", "repo/.git/hooks/pre-commit", ".kube/config", "home/.docker/config.json", "prod.tfvars", "vars.auto.tfvars.json",
  ".envrc", ".vault-token", ".netrc", ".pgpass", "id_ed25519", "id_rsa_work", "keys/id_ecdsa.pub", "tls/server.key", "cert.p12",
  "credentials.json", ".npmrc", "kubeconfig", ".config/gh/hosts.yml", "service-account-prod.json",
];

test("secret refusal covers git, cluster, container, Terraform and shell credentials", () => {
  for (const f of SECRETS) assert.ok(isSecretFile(f), f);
  for (const f of [".env.example", "docker/config.json", "src/kube.ts", "id_card.md", "gitconfig.md", "variables.tf"]) assert.ok(!isSecretFile(f), f);
  const root = tmp("secret");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "config"), "[remote]\nurl = https://token@example.com\n");
  assert.throws(() => readFile(root, { path: ".git/config" }), /looks like a secret/);
});

test("Claude Code's file tools are denied the same secrets through its permission settings", () => {
  // Every name isSecretFile refuses is matched by a glob handed to Claude Code.
  const res = SECRET_GLOBS.map((g) => globToRegExp(g));
  for (const f of [...SECRETS, ".env", ".env.local", "config/.env.production", "terraform.tfstate", "a/.ssh/id"]) {
    assert.ok(res.some((re) => re.test(f)), `${f} has no deny glob`);
  }
  const deny = claudeCodeSettings().permissions.deny;
  assert.ok(deny.includes("Read(**/.env)"));
  assert.ok(deny.includes("Read(**/.git/**)"));
  // Carve-outs come after the rules they carve from.
  assert.ok(deny.indexOf(`Read(!${SECRET_GLOB_EXCEPTIONS[0]})`) > deny.indexOf("Read(**/.env.*)"));
  const args = claudeCodeArgs({ bin: "claude", cwd: "/p", systemPrompt: "", mcpEnv: {}, codeAccess: true, signal: new AbortController().signal });
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]), claudeCodeSettings());
});

test("a catastrophic regex times out without blocking the event loop", async () => {
  const root = tmp("redos");
  fs.writeFileSync(path.join(root, "a.txt"), "a".repeat(40) + "!\n");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const started = Date.now();
  await assert.rejects(searchFiles(root, { pattern: "(a+)+$", regex: true }, 400), (e: Error) => e instanceof CodeError && /timed out/.test(e.message));
  clearInterval(timer);
  assert.ok(Date.now() - started < 3000);
  assert.ok(ticks >= 5, `event loop ticked ${ticks} times`);
  await assert.rejects(searchFiles(root, { pattern: "a".repeat(501), regex: true }), /too long/);
  await assert.rejects(searchFiles(root, { pattern: "(", regex: true }), /Invalid regex/);
  assert.equal(await searchFiles(root, { pattern: "a{40}!", regex: true }), `a.txt:1: ${"a".repeat(40)}!`);
});

test("writeFileAtomic keeps the file's mode, and leaves no temp file behind on failure", () => {
  const dir = tmp("atomic");
  const file = path.join(dir, "x.json");
  fs.writeFileSync(file, "old");
  fs.chmodSync(file, 0o600);
  writeFileAtomic(file, "new");
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeFileAtomic(path.join(dir, "fresh.json"), "x");
  assert.equal(fs.statSync(path.join(dir, "fresh.json")).mode & 0o777, 0o644);
  // Renaming over a non-empty directory fails.
  const blocked = path.join(dir, "blocked");
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, "inside"), "");
  assert.throws(() => writeFileAtomic(blocked, "data"));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("concurrent processes creating the token agree on it and never read it half-written", async () => {
  const stateDir = tmp("token");
  const config = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server", "config.js");
  const script = `import(${JSON.stringify(config)}).then((m) => console.log(m.loadOrCreateToken(m.loadConfig())))`;
  const run = promisify(execFile);
  const outs = await Promise.all(
    Array.from({ length: 8 }, () => run(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, LFX_STATE_DIR: stateDir } })),
  );
  const tokens = new Set(outs.map((o) => o.stdout.trim()));
  assert.equal(tokens.size, 1);
  assert.equal([...tokens][0].length, 43);
  assert.equal(fs.statSync(path.join(stateDir, "token")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(stateDir), ["token"]);
  assert.equal(loadOrCreateToken({ stateDir } as Config), [...tokens][0]);
});

test("path errors name the allowed roots", () => {
  assert.throws(() => resolveSafePath("/elsewhere/x.excalidraw", ["/r/one", "/r/two"]), /Allowed roots: \/r\/one, \/r\/two/);
});

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.1.1", "0.1.10"), -1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), 0);
});
