/**
 * Prepares a scenario's project: copies the fixture into a fresh git repository, draws any
 * starting diagrams through the daemon (the same operations the MCP tools use), and applies
 * the scenario's code change.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EvalDaemon } from "./daemon.js";
import { REPO_ROOT, type Scenario, type SetupStep } from "./scenarios.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=lfx-evals", "-c", "user.email=evals@localhost", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Copies evals/fixtures/<name> to `dest` and commits it as the first commit. */
export function initProject(fixture: string, dest: string): void {
  const src = path.join(REPO_ROOT, "evals", "fixtures", fixture);
  if (!fs.existsSync(src)) throw new Error(`No fixture ${fixture}`);
  fs.cpSync(src, dest, { recursive: true });
  git(dest, "init", "-q", "-b", "main");
  git(dest, "add", "-A");
  git(dest, "commit", "-q", "-m", "Initial import");
}

/** Applies evals/fixtures/<fixture>.patches/<name>.patch and commits it. */
export function applyPatch(project: string, fixture: string, name: string): void {
  const file = path.join(REPO_ROOT, "evals", "fixtures", `${fixture}.patches`, `${name}.patch`);
  git(project, "apply", "--whitespace=nowarn", file);
  git(project, "add", "-A");
  const subject = name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  git(project, "commit", "-q", "-m", subject);
}

/** Project-relative paths of every file, skipping VCS data and build output. */
export function listProjectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(path.join(dir, d.name));
      } else out.push(path.relative(root, path.join(dir, d.name)).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

export async function runSetup(daemon: EvalDaemon, project: string, s: Scenario, graphs: Record<string, unknown>): Promise<string[]> {
  const touched = new Set<string>();
  const defaultPath = s.drawing ?? "docs/diagrams/architecture.excalidraw";
  for (const step of s.setup ?? []) await runStep(daemon, project, step, defaultPath, graphs, touched);
  return [...touched];
}

async function runStep(daemon: EvalDaemon, project: string, step: SetupStep, defaultPath: string, graphs: Record<string, unknown>, touched: Set<string>) {
  const rel = step.path ?? defaultPath;
  const file = path.resolve(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  touched.add(rel);
  if (step.op === "move") {
    // A user dragging an element: relative, so the scenario needn't know the layout.
    const r = await daemon.op<{ scene: { elements: { id: string; x: number; y: number }[] } }>({ op: "read", path: file, full: true });
    const el = r.scene.elements.find((e) => e.id === step.id);
    if (!el) throw new Error(`setup move: no element ${step.id}`);
    await daemon.op({ op: "update", path: file, updates: [{ id: step.id, x: el.x + (step.dx ?? 0), y: el.y + (step.dy ?? 0) }] });
    return;
  }
  const body: Record<string, unknown> = { ...step, path: file };
  if (typeof step.graph === "string") body.graph = structuredClone(graphs[step.graph]);
  await daemon.op(body);
}
