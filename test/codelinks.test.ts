import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatCodeLink, hashFile, linkState, parseCodeLink } from "../src/server/codelinks.js";

test("code links parse paths with optional lines and reject URLs and escapes", () => {
  assert.deepEqual(parseCodeLink("src/a.ts"), { path: "src/a.ts" });
  assert.deepEqual(parseCodeLink("src/a.ts#L42"), { path: "src/a.ts", line: 42 });
  assert.deepEqual(parseCodeLink("src/a.ts#L42-L50"), { path: "src/a.ts", line: 42 });
  assert.deepEqual(parseCodeLink("./src/a.ts:7"), { path: "src/a.ts", line: 7 });
  for (const bad of ["https://x.com/a.ts", "/etc/passwd", "../secret.ts", "", "#L4", "vscode://file/a"]) assert.equal(parseCodeLink(bad), undefined, bad);
  assert.equal(formatCodeLink({ path: "src/a.ts", line: 3 }), "src/a.ts#L3");
});

test("link state tracks changes, deletions and lines past the end", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-links-"));
  fs.writeFileSync(path.join(root, "a.ts"), "one\ntwo\n");
  const sha = hashFile(path.join(root, "a.ts"));
  assert.equal(linkState(root, { path: "a.ts", sha }), "ok");
  assert.equal(linkState(root, { path: "a.ts" }), "unknown");
  assert.equal(linkState(root, { path: "a.ts", line: 99, sha }), "missing");
  fs.writeFileSync(path.join(root, "a.ts"), "changed\n");
  assert.equal(linkState(root, { path: "a.ts", sha }), "changed");
  assert.equal(linkState(root, { path: "gone.ts", sha }), "missing");
  assert.equal(linkState(root, { path: "../x", sha }), "missing");
});
