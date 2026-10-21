#!/usr/bin/env node
/**
 * Eval runner: for each scenario and run, a fresh copy of the fixture project, an isolated
 * daemon, and a headless Claude Code session with this repo's MCP server and plugin skills.
 * The resulting drawing is graded and everything lands in evals/results/<timestamp>/.
 *
 *   npm run evals -- [--scenario id[,id]] [--model X] [--runs N] [--judge] [--keep]
 *   npm run evals -- --regrade evals/results/<timestamp>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assistantSettings, ollamaModel, runAssistant, summariseChat, traceFileFor } from "./assistant.js";
import { runClaude, summariseTranscript, type TranscriptSummary } from "./claude.js";
import { baseEnv, CLI, EvalDaemon, freePort, isolatedEnv } from "./daemon.js";
import { grade, type SceneLike } from "./grade.js";
import { judge } from "./judge.js";
import { type RunResult, summaryMarkdown } from "./report.js";
import { loadScenarios, REPO_ROOT, type Scenario } from "./scenarios.js";
import { applyPatch, git, initProject, listProjectFiles, runSetup } from "./setup.js";

interface Options {
  scenarios: string[];
  model?: string;
  runs: number;
  judge: boolean;
  keep: boolean;
  timeoutSec?: number;
  budgetUsd?: string;
  out?: string;
  regrade?: string;
  list: boolean;
  /** Who does the work: Claude Code over MCP (`claude -p`), or the daemon's in-app assistant. */
  via: "claude" | "assistant";
}

const HELP = `Usage: npm run evals -- [options]

  --scenario ID[,ID]   Only these scenarios (repeatable). Default: all
  --via claude|assistant
                       claude: claude -p over MCP with the plugin (default).
                       assistant: the daemon's in-app assistant with a Claude Code endpoint
  --model NAME         Model for Claude Code (default: Claude Code's own choice).
                       With --via assistant, ollama:NAME runs a local Ollama model instead
  --runs N             Runs per scenario (default 1)
  --judge              Also render the result and ask an LLM judge to score it
  --timeout SEC        Per-run time limit (default: the scenario's, else 900)
  --max-budget-usd N   Passed to claude: stop a run past this spend
  --out DIR            Results directory (default evals/results/<timestamp>)
  --keep               Keep each run's temporary project and daemon state
  --regrade DIR        Re-grade saved results with the current graders (no agent runs)
  --list               List scenarios and exit
`;

function parseArgs(argv: string[]): Options {
  const o: Options = { scenarios: [], runs: 1, judge: false, keep: false, list: false, via: "claude" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--scenario") o.scenarios.push(...val().split(",").filter(Boolean));
    else if (a === "--model") o.model = val();
    else if (a === "--via") {
      const v = val();
      if (v !== "claude" && v !== "assistant") throw new Error("--via is claude or assistant");
      o.via = v;
    }
    else if (a === "--runs") o.runs = Math.max(1, Number.parseInt(val(), 10) || 1);
    else if (a === "--judge") o.judge = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--timeout") o.timeoutSec = Number(val());
    else if (a === "--max-budget-usd") o.budgetUsd = val();
    else if (a === "--out") o.out = val();
    else if (a === "--regrade") o.regrade = val();
    else if (a === "--list") o.list = true;
    else if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else throw new Error(`Unknown option ${a}\n\n${HELP}`);
  }
  if (ollamaModel(o.model) && o.via !== "assistant") throw new Error("An ollama: model runs only --via assistant");
  return o;
}

/** Tool calls as saved in results: names and errors, plus the input of failed calls to spot repeats. */
const slimCalls = (calls: TranscriptSummary["toolCalls"]) => calls.map((c) => ({ name: c.name, error: c.error, ...(c.error ? { input: c.input } : {}) }));

/** Tools the agent may use without asking. Everything else is denied (permission mode dontAsk). */
export const ALLOWED_TOOLS = [
  "mcp__excalidraw",
  "Read",
  "Grep",
  "Glob",
  "Skill",
  "TodoWrite",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(ls:*)",
];

const readScene = (file: string): SceneLike | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SceneLike;
  } catch {
    return null;
  }
};

/** A copy of the plugin without its .mcp.json, so only our isolated MCP server is configured. */
function pluginCopy(dest: string): string {
  fs.cpSync(path.join(REPO_ROOT, "plugin"), dest, { recursive: true });
  fs.rmSync(path.join(dest, ".mcp.json"), { force: true });
  return dest;
}

async function runOne(s: Scenario, graphs: Record<string, unknown>, n: number, o: Options, outDir: string): Promise<RunResult> {
  const runDir = path.join(outDir, `${s.id}-${n}`);
  fs.mkdirSync(runDir, { recursive: true });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lfx-eval-")));
  const project = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const port = await freePort();
  const env = isolatedEnv(port, stateDir, project);
  if (o.via === "assistant") {
    // The daemon traces each turn, which is where Claude Code's cost and turn count are reported.
    env.LFX_TRACE_FILE = traceFileFor(runDir);
    if (process.env.CLAUDE_BIN) env.LFX_CLAUDE_BIN = process.env.CLAUDE_BIN;
  }
  const daemon = new EvalDaemon(port, stateDir, env);
  const startedAt = new Date().toISOString();
  const result: RunResult = {
    scenario: s.id,
    run: n,
    model: o.model,
    startedAt,
    wallMs: 0,
    exitCode: null,
    timedOut: false,
    drawings: [],
    projectRoot: project,
    projectFiles: [],
    grade: grade({ final: null, checks: s.checks, projectRoot: project, projectFiles: new Set() }),
    transcript: summariseTranscript([]),
  };
  const save = () => fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));

  try {
    initProject(s.fixture, project);
    if (o.via === "assistant") {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(stateDir, "ai.json"), JSON.stringify(assistantSettings(o.model), null, 2), { mode: 0o600 });
    }
    await daemon.start(path.join(runDir, "daemon.log"));
    await daemon.request("/api/roots", { path: project });

    // Starting drawings, committed so they are part of the project, then the code change.
    const touched = await runSetup(daemon, project, s, graphs);
    if (touched.length && s.commitSetup !== false) {
      git(project, "add", "-A");
      git(project, "commit", "-q", "-m", "Add architecture diagram");
    }
    const baselineFile = s.drawing ? path.join(project, s.drawing) : touched[0] ? path.join(project, touched[0]) : undefined;
    const baseline = baselineFile ? readScene(baselineFile) : null;
    if (baseline) fs.writeFileSync(path.join(runDir, "baseline.excalidraw"), JSON.stringify(baseline, null, 2));
    if (s.patch) applyPatch(project, s.fixture, s.patch);
    const before = new Map(listProjectFiles(project).filter((f) => f.endsWith(".excalidraw")).map((f) => [f, fs.statSync(path.join(project, f)).mtimeMs]));

    const transcriptFile = path.join(runDir, "transcript.jsonl");
    const timeoutSec = o.timeoutSec ?? s.timeoutSec ?? 900;
    if (o.via === "assistant") {
      // The in-app assistant works on the drawing open in its tab: the scenario's, or a new one.
      const drawing = path.join(project, s.drawing ?? `docs/diagrams/${s.id}.excalidraw`);
      fs.writeFileSync(path.join(runDir, "command.json"), JSON.stringify({ via: "assistant", cwd: project, drawing, prompt: s.prompt, settings: assistantSettings(o.model) }, null, 2));
      console.log(`[${s.id} #${n}] running the in-app assistant (port ${port}, timeout ${timeoutSec}s)…`);
      const run = await runAssistant(daemon, drawing, s.prompt, { transcriptFile, timeoutSec });
      Object.assign(result, { exitCode: run.status === "done" ? 0 : 1, timedOut: run.status === "timeout", wallMs: run.wallMs, stderr: run.error });
      // The trace is written as spans end; the turn's span ends just after its last event.
      await new Promise((r) => setTimeout(r, 500));
      const sum = summariseChat(fs.readFileSync(transcriptFile, "utf8").split("\n"), traceFileFor(runDir));
      result.model = sum.model ?? o.model;
      result.transcript = { ...sum, toolCalls: slimCalls(sum.toolCalls) };
    } else {
      // MCP server and plugin, both pointing at this run's daemon only.
      const mcpConfig = path.join(tmp, "mcp.json");
      fs.writeFileSync(
        mcpConfig,
        JSON.stringify({ mcpServers: { excalidraw: { command: process.execPath, args: [CLI, "mcp", "--root", project], env } } }, null, 2),
      );
      const plugin = pluginCopy(path.join(tmp, "plugin"));
      const args = [
        "-p", s.prompt,
        "--output-format", "stream-json", "--verbose",
        "--mcp-config", mcpConfig, "--strict-mcp-config",
        "--plugin-dir", plugin,
        "--setting-sources", "project",
        "--permission-mode", "dontAsk",
        "--allowedTools", ...ALLOWED_TOOLS,
        "--no-session-persistence",
        ...(o.model ? ["--model", o.model] : []),
        ...(o.budgetUsd ? ["--max-budget-usd", o.budgetUsd] : []),
      ];
      fs.writeFileSync(path.join(runDir, "command.json"), JSON.stringify({ cwd: project, args }, null, 2));
      console.log(`[${s.id} #${n}] running claude (port ${port}, timeout ${timeoutSec}s)…`);
      const run = await runClaude(args, { cwd: project, env: { ...baseEnv(), ...env }, transcriptFile, timeoutSec });
      Object.assign(result, { exitCode: run.exitCode, timedOut: run.timedOut, wallMs: run.wallMs, stderr: run.stderr || undefined });
      const sum = summariseTranscript(fs.readFileSync(transcriptFile, "utf8").split("\n"));
      result.model = sum.model ?? o.model;
      result.transcript = { ...sum, toolCalls: slimCalls(sum.toolCalls) };
    }

    // Which drawing to grade: the named one, else whichever changed most recently.
    const files = listProjectFiles(project);
    result.projectFiles = files;
    result.drawings = files.filter((f) => f.endsWith(".excalidraw"));
    const changed = result.drawings
      .map((f) => ({ f, t: fs.statSync(path.join(project, f)).mtimeMs }))
      .filter((d) => before.get(d.f) !== d.t)
      .sort((a, b) => b.t - a.t);
    result.drawing = s.drawing && result.drawings.includes(s.drawing) ? s.drawing : changed[0]?.f;
    const drawingsDir = path.join(runDir, "drawings");
    for (const d of result.drawings) {
      fs.mkdirSync(path.dirname(path.join(drawingsDir, d)), { recursive: true });
      fs.copyFileSync(path.join(project, d), path.join(drawingsDir, d));
    }
    const final = result.drawing ? readScene(path.join(project, result.drawing)) : null;
    if (final) fs.writeFileSync(path.join(runDir, "final.excalidraw"), JSON.stringify(final, null, 2));
    result.grade = grade({ final, baseline, checks: s.checks, projectRoot: project, projectFiles: new Set(files) });

    if (o.judge && result.drawing) {
      console.log(`[${s.id} #${n}] judging…`);
      // An Ollama model can't judge; the judge then uses Claude Code's default model.
      result.judge = await judge({ daemon, drawing: path.join(project, result.drawing), runDir, prompt: s.prompt, expected: s.expected_output, model: ollamaModel(o.model) ? undefined : o.model, env: { ...baseEnv(), ...env } });
    }
  } catch (e) {
    result.error = (e as Error).stack ?? String(e);
  } finally {
    await daemon.stop();
    save();
    if (o.keep) console.log(`[${s.id} #${n}] kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = result.grade.checks.filter((c) => !c.pass).map((c) => c.name);
  console.log(`[${s.id} #${n}] ${result.error ? "ERROR" : result.grade.pass ? "pass" : `FAIL (${failed.join(", ")})`} in ${Math.round(result.wallMs / 1000)}s`);
  return result;
}

/** Re-grades every result.json under `dir` from its saved drawings. */
function regrade(dir: string): RunResult[] {
  const data = loadScenarios();
  const runs: RunResult[] = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, d, "result.json");
    if (!fs.existsSync(file)) continue;
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as RunResult;
    const s = data.scenarios.find((x) => x.id === r.scenario);
    if (!s) continue;
    const final = readScene(path.join(dir, d, "final.excalidraw"));
    const baseline = readScene(path.join(dir, d, "baseline.excalidraw"));
    r.grade = grade({ final, baseline, checks: s.checks, projectRoot: r.projectRoot, projectFiles: new Set(r.projectFiles) });
    fs.writeFileSync(file, JSON.stringify(r, null, 2));
    runs.push(r);
  }
  return runs;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const data = loadScenarios();
  if (o.list) {
    for (const s of data.scenarios) console.log(`${s.id.padEnd(24)} ${s.title}`);
    return;
  }
  if (o.regrade) {
    const runs = regrade(o.regrade);
    fs.writeFileSync(path.join(o.regrade, "summary.md"), summaryMarkdown(`Eval results (re-graded ${new Date().toISOString()})`, runs));
    console.log(`Re-graded ${runs.length} runs; see ${path.join(o.regrade, "summary.md")}`);
    return;
  }
  if (!fs.existsSync(CLI)) throw new Error(`${CLI} is missing; run npm run build first`);
  const unknown = o.scenarios.filter((id) => !data.scenarios.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(", ")}. Try --list.`);
  const picked = o.scenarios.length ? data.scenarios.filter((s) => o.scenarios.includes(s.id)) : data.scenarios;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const outDir = path.resolve(o.out ?? path.join(REPO_ROOT, "evals", "results", stamp));
  fs.mkdirSync(outDir, { recursive: true });
  const runs: RunResult[] = [];
  for (const s of picked) for (let n = 1; n <= o.runs; n++) runs.push(await runOne(s, data.graphs, n, o, outDir));

  const title = `Eval results ${stamp}${o.via === "assistant" ? " via the in-app assistant" : ""}${o.model ? ` (${o.model})` : ""}`;
  fs.writeFileSync(path.join(outDir, "summary.md"), summaryMarkdown(title, runs));
  console.log(`\nResults: ${path.join(outDir, "summary.md")}`);
  process.exitCode = runs.every((r) => r.grade.pass && !r.error) ? 0 : 1;
}

main().catch((e) => {
  console.error(`evals: ${(e as Error).message}`);
  process.exit(2);
});
