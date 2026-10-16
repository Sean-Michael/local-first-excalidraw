import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { REPO_ROOT } from "../evals/scenarios.js";

const json = (p: string) => JSON.parse(fs.readFileSync(`${REPO_ROOT}/${p}`, "utf8"));

test("the plugin and the package share a version", () => {
  assert.equal(json("plugin/.claude-plugin/plugin.json").version, json("package.json").version);
});
